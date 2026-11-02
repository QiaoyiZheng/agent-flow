// An agent pane, rendered: finished output from the agent's own transcript as markdown + LaTeX, tool calls
// folded into step groups, and our own composer (paste or drop images and files). The live terminal
// appears only when it is needed: the agent waits for an answer, a slash command opened a menu, or the
// user asks for it.

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ChatBlock, ChatEntry, ChatOp, ChatSource } from "@af/core";
import { TOKEN, api, fileUrl, onChat, send } from "./store";
import { Terminal } from "./Terminal";
import { onHighlighterReady, renderMarkdown } from "./markdown";
import { basename } from "./view";

type Tool = Extract<ChatBlock, { kind: "tool" }>;
let seq = 0;

/** Entries plus an index so tool results can find their call. */
class Log {
  entries: ChatEntry[] = [];
  private tools = new Map<string, Tool>();
  private early = new Map<string, { output: string; error?: boolean }>();
  apply(ops: ChatOp[]) {
    for (const o of ops) {
      if (o.op === "add") {
        const b = { ...o.entry.block } as ChatBlock;
        if (b.kind === "tool") {
          const r = this.early.get(b.id);
          if (r) Object.assign(b, { output: r.output, error: r.error, done: true });
          this.tools.set(b.id, b);
        }
        this.entries.push({ ...o.entry, block: b });
      } else {
        const t = this.tools.get(o.id);
        if (t) {
          // replace the object so memoized rows notice the change
          const next = { ...t, output: o.output, error: o.error, done: true };
          this.tools.set(o.id, next);
          const i = this.entries.findIndex((e) => e.block === t);
          if (i >= 0) this.entries[i] = { ...this.entries[i]!, block: next };
        } else this.early.set(o.id, { output: o.output, error: o.error });
      }
    }
  }
}

type Segment = { kind: "entry"; entry: ChatEntry } | { kind: "steps"; key: string; tools: Tool[] };

/** Consecutive tool calls become one folded "steps" group. */
function segments(entries: ChatEntry[]): Segment[] {
  const out: Segment[] = [];
  for (const e of entries) {
    const last = out.at(-1);
    if (e.block.kind === "tool") {
      if (last?.kind === "steps") last.tools.push(e.block);
      else out.push({ kind: "steps", key: e.key, tools: [e.block] });
    } else out.push({ kind: "entry", entry: e });
  }
  return out;
}

export function AgentView({ paneId, agent, status, focused }: { paneId: string; agent: string; status?: string; focused: boolean }) {
  const [source, setSource] = useState<ChatSource | null | undefined>(undefined);
  const [reason, setReason] = useState<string>();
  const log = useRef(new Log());
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [height, setHeight] = useState(0);
  const [showTerm, setShowTerm] = useState(false);
  const [hl, setHl] = useState(0);
  useEffect(() => onHighlighterReady(() => setHl(1)), []);

  useEffect(() => {
    const id = `c${++seq}`;
    log.current = new Log();
    setSource(undefined);
    const off = onChat(id, (m) => {
      if (m.type === "chat.reset") {
        log.current = new Log();
        setSource(m.source);
        setReason(m.reason);
      }
      log.current.apply(m.ops);
      bump();
    });
    send({ type: "chat.open", id, paneId });
    return () => {
      off();
      send({ type: "chat.close", id });
    };
  }, [paneId]);

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // keep the newest output in view unless the user scrolled up
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [version, source, showTerm]);

  const blocked = status === "blocked";
  const termVisible = blocked || showTerm;
  const stripH = Math.round(Math.min(height * 0.7, Math.max(180, height * (blocked ? 0.55 : 0.4))));
  const segs = useMemo(() => segments(log.current.entries), [version]);

  if (source === null)
    return (
      <div ref={box} className="agent-view">
        <div className="agent-banner">Showing the plain terminal: {reason ?? "no transcript found"}.</div>
        <div style={{ flex: 1, position: "relative" }}>
          <Terminal key="full" paneId={paneId} autoFocus={focused} />
        </div>
      </div>
    );

  return (
    <div ref={box} className="agent-view">
      <div
        ref={list}
        className="chat"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {source === undefined && <div className="chat-empty">Loading transcript…</div>}
        {source && !segs.length && <div className="chat-empty">Nothing yet. Send a message below.</div>}
        {segs.map((s) =>
          s.kind === "steps" ? (
            <Steps key={s.key} tools={s.tools} sig={s.tools.map((t) => (t.done ? (t.error ? "x" : "d") : "r")).join("")} />
          ) : (
            <Entry key={s.entry.key} block={s.entry.block} hl={hl} />
          ),
        )}
        {source?.how === "folder" && <div className="chat-note">Transcript matched by folder: {source.path}</div>}
      </div>
      {termVisible && height > 0 && (
        <div className={`live ${blocked ? "blocked" : ""}`}>
          <Terminal key="strip" paneId={paneId} autoFocus={focused && blocked} strip={{ fullHeight: height, viewHeight: stripH }} />
        </div>
      )}
      <div className={`agent-status ${status ?? ""}`}>
        <span className={`live-dot ${status ?? ""}`} />
        <span>{blocked ? "waiting for your answer in the terminal" : status === "working" ? "working…" : status === "done" ? "done" : "idle"}</span>
        <span className="spacer" />
        {status === "working" && (
          <button title="Interrupt (Esc)" onClick={() => api("POST", "/keys", { pane: paneId, keys: ["esc"] }).catch((e) => alert(e.message))}>
            ■ Stop
          </button>
        )}
        {!blocked && (
          <button className={showTerm ? "on" : ""} onClick={() => setShowTerm((v) => !v)} title="Show the agent's live terminal (menus, approvals, output in progress)">
            {showTerm ? "hide terminal" : "terminal"}
          </button>
        )}
      </div>
      <Composer paneId={paneId} agent={agent} focused={focused && !blocked} disabled={blocked} onSlash={() => setShowTerm(true)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const ATTACH_HEAD = /^Read these attached files first:\n((?:- .+\n?)+)\n?/;

const Entry = memo(
  function Entry({ block, hl }: { block: ChatBlock; hl: number }) {
    switch (block.kind) {
      case "user":
        return <UserMessage text={block.text} />;
      case "text":
        return <Prose text={block.text} hl={hl} />;
      case "notice":
        return <div className="c-notice">{block.text}</div>;
      case "tool":
        return <ToolCard t={block} />;
    }
  },
  (a, b) => a.block === b.block && a.hl === b.hl,
);

function UserMessage({ text }: { text: string }) {
  const m = text.match(ATTACH_HEAD);
  const files = m ? m[1]!.trim().split("\n").map((l) => l.replace(/^- /, "")) : [];
  const body = m ? text.slice(m[0].length) : text;
  const long = body.split("\n").length > 5 || body.length > 420;
  const [open, setOpen] = useState(false);
  return (
    <div className="c-user">
      <span className="c-caret">›</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {files.length > 0 && (
          <div className="c-files">
            {files.map((f) => (
              <AttachmentChip key={f} path={f} />
            ))}
          </div>
        )}
        <div className={`c-user-text ${long && !open ? "clamp" : ""}`}>{body}</div>
        {long && (
          <button className="c-more" onClick={() => setOpen((o) => !o)}>
            {open ? "show less" : "show more"}
          </button>
        )}
      </div>
    </div>
  );
}

const isImage = (p: string) => /\.(png|jpe?g|gif|webp|svg)$/i.test(p);

function AttachmentChip({ path, onRemove, preview, busy }: { path: string; onRemove?: () => void; preview?: string; busy?: boolean }) {
  const src = preview ?? (isImage(path) && path.includes("/attachments/") ? fileUrl(path) : undefined);
  return (
    <span className={`chip ${busy ? "busy" : ""}`} title={path}>
      {src ? <img src={src} alt="" /> : <span className="chip-ic">≡</span>}
      <span className="chip-name">{basename(path).replace(/^[a-z0-9]{6}-/, "")}</span>
      {onRemove && (
        <button onClick={onRemove} title="Remove">
          ✕
        </button>
      )}
    </span>
  );
}

export function Prose({ text, hl }: { text: string; hl: number }) {
  const html = useMemo(() => renderMarkdown(text), [text, hl]);
  return <div className="c-text md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A folded group of tool calls: "4 steps · Bash ×3 · Edit calc.js". */
const Steps = memo(
  function Steps({ tools }: { tools: Tool[]; sig: string }) {
    const [open, setOpen] = useState(false);
    const running = tools.some((t) => !t.done);
    const failed = tools.filter((t) => t.error).length;
    const counts = new Map<string, number>();
    for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    const edits = tools.filter((t) => t.edit || t.patch).map((t) => basename(t.edit?.path ?? t.summary.split(" — ")[0] ?? ""));
    const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
    const label = tools.length === 1 ? `${tools[0]!.name} ${tools[0]!.summary}` : `${tools.length} steps · ${parts.join(" · ")}`;
    return (
      <div className={`c-steps ${open ? "open" : ""}`}>
        <div className="c-steps-head" onClick={() => setOpen((o) => !o)}>
          <span className="c-tool-caret">{open ? "▾" : "▸"}</span>
          <span className={`c-tool-icon ${running ? "run" : failed ? "err" : "ok"}`}>{running ? "◌" : failed ? "✗" : "✓"}</span>
          <span className="c-steps-label">{label}</span>
          {tools.length > 1 && edits.length > 0 && <span className="c-steps-edits">edited {[...new Set(edits)].slice(0, 3).join(", ")}</span>}
        </div>
        {open && (
          <div className="c-steps-body">
            {tools.map((t) => (
              <ToolCard key={t.id} t={t} />
            ))}
          </div>
        )}
      </div>
    );
  },
  (a, b) => a.tools.length === b.tools.length && a.sig === b.sig,
);

function ToolCard({ t }: { t: Tool }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(t.input || t.patch || t.edit || t.output);
  const icon = !t.done ? "◌" : t.error ? "✗" : "✓";
  return (
    <div className={`c-tool ${open ? "open" : ""} ${t.error ? "err" : ""}`}>
      <div className="c-tool-head" onClick={() => hasDetail && setOpen((o) => !o)}>
        <span className={`c-tool-icon ${t.done ? (t.error ? "err" : "ok") : "run"}`}>{icon}</span>
        <span className="c-tool-name">{t.name}</span>
        <span className="c-tool-sum">{t.summary}</span>
        {hasDetail && <span className="c-tool-caret">{open ? "▾" : "▸"}</span>}
      </div>
      {open && (
        <div className="c-tool-body">
          {t.input && <pre className="c-pre">{t.input}</pre>}
          {t.edit && <EditDiff before={t.edit.before} after={t.edit.after} />}
          {t.patch && <Patch text={t.patch} />}
          {t.output && <pre className="c-pre out">{t.output}</pre>}
        </div>
      )}
    </div>
  );
}

function EditDiff({ before, after }: { before: string; after: string }) {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  return (
    <div className="diff c-diff">
      {a.map((l, i) => (
        <div key={`a${i}`} className="del">
          -{l}
        </div>
      ))}
      {b.map((l, i) => (
        <div key={`b${i}`} className="add">
          +{l}
        </div>
      ))}
    </div>
  );
}

function Patch({ text }: { text: string }) {
  return (
    <div className="diff c-diff">
      {text.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") || l.startsWith("***") ? "hunk" : ""}>
          {l || " "}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

interface Pending {
  id: number;
  name: string;
  preview?: string;
  path?: string;
  error?: string;
}

let fileSeq = 0;

function Composer({ paneId, agent, focused, disabled, onSlash }: { paneId: string; agent: string; focused: boolean; disabled: boolean; onSlash: () => void }) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focused) ta.current?.focus();
  }, [focused]);
  useLayoutEffect(() => {
    const el = ta.current!;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [text]);

  const upload = (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      const id = ++fileSeq;
      const preview = f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined;
      setFiles((fs) => [...fs, { id, name: f.name || "pasted image", preview }]);
      fetch(`/api/upload?token=${TOKEN}&pane=${encodeURIComponent(paneId)}&name=${encodeURIComponent(f.name || "")}`, {
        method: "POST",
        headers: { "content-type": f.type || "application/octet-stream" },
        body: f,
      })
        .then(async (r) => {
          const j = await r.json();
          if (!r.ok) throw new Error(j.error?.message ?? r.statusText);
          setFiles((fs) => fs.map((x) => (x.id === id ? { ...x, path: j.path } : x)));
        })
        .catch((e) => setFiles((fs) => fs.map((x) => (x.id === id ? { ...x, error: e.message } : x))));
    }
  };

  const uploading = files.some((f) => !f.path && !f.error);
  const ready = files.filter((f) => f.path);
  const canSend = !disabled && !sending && !uploading && (text.trim().length > 0 || ready.length > 0);

  const submit = () => {
    if (!canSend) return;
    setSending(true);
    const body = text;
    api("POST", "/prompt", { pane: paneId, text: body, attachments: ready.map((f) => f.path) })
      .then(() => {
        setText("");
        files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
        setFiles([]);
        if (body.trim().startsWith("/")) onSlash();
      })
      .catch((e) => alert(e.message))
      .finally(() => {
        setSending(false);
        ta.current?.focus();
      });
  };

  return (
    <div
      className={`composer ${drag ? "drag" : ""} ${disabled ? "disabled" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDrag(false);
        upload(e.dataTransfer.files);
      }}
    >
      {files.length > 0 && (
        <div className="c-files composer-files">
          {files.map((f) => (
            <span key={f.id} style={{ display: "contents" }}>
              <AttachmentChip
                path={f.path ?? f.name}
                preview={f.preview}
                busy={!f.path && !f.error}
                onRemove={() => {
                  if (f.preview) URL.revokeObjectURL(f.preview);
                  setFiles((fs) => fs.filter((x) => x.id !== f.id));
                }}
              />
              {f.error && <span className="chip-err">{f.error}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="composer-row">
        <button className="composer-attach" title="Attach files" onClick={() => picker.current?.click()} disabled={disabled}>
          ＋
        </button>
        <input ref={picker} type="file" multiple hidden onChange={(e) => (e.target.files && upload(e.target.files), (e.target.value = ""))} />
        <textarea
          ref={ta}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={disabled ? "Answer the question in the terminal above" : `Message ${agent} — Enter to send, Shift+Enter for a new line, paste or drop images and files`}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const fl = e.clipboardData.files;
            if (fl.length) {
              e.preventDefault();
              upload(fl);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="composer-send" disabled={!canSend} onClick={submit} title="Send (Enter)">
          {sending ? "…" : "↑"}
        </button>
      </div>
    </div>
  );
}
