// An agent pane, rendered: finished output from the agent's own transcript as markdown + LaTeX, tool calls
// folded into step groups, and our own composer (paste or drop images and files). The live terminal
// appears only when it is needed: the agent waits for an answer, a slash command opened a menu, or the
// user asks for it.

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ChatBlock, ChatEntry, ChatOp, ChatSource } from "@af/core";
import { TOKEN, api, failed, fileUrl, notify, onChat, send } from "./store";
import { Terminal } from "./Terminal";
import { onHighlighterReady, renderMarkdown } from "./markdown";
import { basename } from "./view";

type Tool = Extract<ChatBlock, { kind: "tool" }>;
let seq = 0;

/** Same normalization as the server: compare texts without whitespace or markdown marks. */
const norm = (t: string) => t.replace(/[\s*_`#>|$\\~•●⏺❯›⎿]+/g, "").toLowerCase();

/** A tiny per-pane store that outlives the component, so drafts and sent messages survive switching panes. */
function paneStore<T>(initial: (pane: string) => T, persist?: (pane: string, v: T) => void) {
  const values = new Map<string, T>();
  const subs = new Map<string, Set<() => void>>();
  const get = (pane: string) => {
    if (!values.has(pane)) values.set(pane, initial(pane));
    return values.get(pane)!;
  };
  const update = (pane: string, fn: (v: T) => T) => {
    const v = fn(get(pane));
    values.set(pane, v);
    persist?.(pane, v);
    subs.get(pane)?.forEach((f) => f());
  };
  const use = (pane: string) => {
    const [, force] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
      const set = subs.get(pane) ?? new Set();
      subs.set(pane, set);
      set.add(force);
      return () => void set.delete(force);
    }, [pane]);
    return get(pane);
  };
  return { get, update, use };
}

interface PendingFile {
  id: number;
  name: string;
  preview?: string;
  path?: string;
  error?: string;
}
interface Draft {
  text: string;
  files: PendingFile[];
}
const drafts = paneStore<Draft>(
  (pane) => ({ text: localStorage.getItem(`af-draft:${pane}`) ?? "", files: [] }),
  (pane, d) => (d.text ? localStorage.setItem(`af-draft:${pane}`, d.text) : localStorage.removeItem(`af-draft:${pane}`)),
);

interface Outgoing {
  id: number;
  /** What the user typed. */
  body: string;
  files: string[];
  /** The full prompt sent to the agent (with the attachments line). */
  prompt: string;
  at: number;
  state: "sending" | "sent" | "failed";
  error?: string;
}
const outbox = paneStore<Outgoing[]>(() => []);
let outSeq = 0;

function sendOutgoing(pane: string, o: Outgoing) {
  outbox.update(pane, (list) => list.map((x) => (x.id === o.id ? { ...x, state: "sending", error: undefined } : x)));
  api<{ sent: string }>("POST", "/prompt", { pane, text: o.body, attachments: o.files })
    .then((r) => outbox.update(pane, (list) => list.map((x) => (x.id === o.id ? { ...x, state: "sent", prompt: r.sent, at: Date.now() } : x))))
    .catch((e) => outbox.update(pane, (list) => list.map((x) => (x.id === o.id ? { ...x, state: "failed", error: e.message } : x))));
}

const entryTime = (at: unknown) => (typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN);

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

export function AgentView({ paneId, agent, status, focused, onForked }: { paneId: string; agent: string; status?: string; focused: boolean; onForked?: (paneId: string) => void }) {
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
  const out = outbox.use(paneId);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!out.length) return;
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, [out.length]);

  // a sent message leaves the outbox once the agent's own conversation records it
  useEffect(() => {
    const list = outbox.get(paneId);
    if (!list.some((o) => o.state === "sent")) return;
    const users = log.current.entries.filter((e) => e.block.kind === "user") as (ChatEntry & { block: { kind: "user"; text: string } })[];
    const claimed = new Set<string>();
    const done = new Set<number>();
    for (const o of list) {
      if (o.state !== "sent") continue;
      const key = norm(o.prompt).slice(0, 60);
      const hit = users.find((e) => {
        if (claimed.has(e.key)) return false;
        const t = entryTime(e.at);
        if (!Number.isNaN(t) && t < o.at - 10 * 60_000) return false;
        const n = norm(e.block.text);
        return n.includes(key) || (n.length >= 8 && key.includes(n.slice(0, 60)));
      });
      if (hit) {
        claimed.add(hit.key);
        done.add(o.id);
      }
    }
    if (done.size) outbox.update(paneId, (l) => l.filter((o) => !done.has(o.id)));
  }, [version, out]);

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

  const blocked = status === "blocked";
  const menu = useMenu(paneId, blocked);
  // claude and omp can fork at a message; codex forks the whole conversation
  const forkable = source?.agent === "claude" || source?.agent === "omp";
  const [forking, setForking] = useState(false);
  const fork = (before?: number, prefill?: string) => {
    setForking(true);
    api<{ paneId: string; started: boolean }>("POST", "/pane/fork", { pane: paneId, before })
      .then((r) => {
        if (prefill) drafts.update(r.paneId, () => ({ text: prefill.replace(ATTACH_HEAD, ""), files: [] }));
        if (!r.started) notify("warn", "The forked agent did not report ready yet", "Look at its pane; it may still be starting.");
        onForked?.(r.paneId);
      })
      .catch(failed("Could not fork the conversation"))
      .finally(() => setForking(false));
  };
  const forkAt = (ref: number, text: string) => () => fork(ref, text);

  // keep the newest output in view unless the user scrolled up
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [version, source, showTerm, out.length, !!menu]);
  // the live terminal is only needed for prompts we cannot draw ourselves
  const termVisible = (blocked && !menu) || showTerm;
  const stripH = Math.round(Math.min(height * 0.7, Math.max(180, height * (blocked ? 0.55 : 0.4))));
  const segs = useMemo(() => segments(log.current.entries), [version]);

  if (source === null)
    return (
      <div ref={box} className="agent-view">
        <div className="agent-banner">Showing the plain terminal: {reason ?? "no transcript found"}.</div>
        {/* a startup prompt (folder trust, update, login) before there is any transcript: answer it here too */}
        {blocked && menu && (
          <div style={{ padding: "0 16px", flex: "none" }}>
            <MenuCard key={menu.options.map((o) => o.label).join("|")} pane={paneId} menu={menu} focused={focused} />
          </div>
        )}
        <div style={{ flex: 1, position: "relative" }}>
          <Terminal key="full" paneId={paneId} autoFocus={focused && !(blocked && menu)} />
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
            <Entry
              key={s.entry.key}
              block={s.entry.block}
              hl={hl}
              onFork={forkable && s.entry.block.kind === "user" && s.entry.ref !== undefined ? forkAt(s.entry.ref, s.entry.block.text) : undefined}
            />
          ),
        )}
        {out.map((o) => (
          <OutgoingMessage key={o.id} o={o} pane={paneId} working={status === "working"} stale={o.state === "sent" && now - o.at > 30_000 && status !== "working"} onTerminal={() => setShowTerm(true)} />
        ))}
        {menu && blocked && <MenuCard key={menu.options.map((o) => o.label).join("|")} pane={paneId} menu={menu} focused={focused} />}
        {source?.how === "folder" && <div className="chat-note">Transcript matched by folder: {source.path}</div>}
        {source?.how === "screen" && <div className="chat-note">Transcript matched by screen content: {source.path}</div>}
      </div>
      {termVisible && height > 0 && (
        <div className={`live ${blocked ? "blocked" : ""}`}>
          <Terminal key="strip" paneId={paneId} autoFocus={focused && blocked} strip={{ fullHeight: height, viewHeight: stripH }} />
        </div>
      )}
      <div className={`agent-status ${status ?? ""}`}>
        <span className={`live-dot ${status ?? ""}`} />
        <span>{blocked ? (menu ? "waiting for your choice" : "waiting for your answer in the terminal") : status === "working" ? "working…" : status === "done" ? "done" : "idle"}</span>
        <span className="spacer" />
        {status === "working" && (
          <button title="Interrupt (Esc)" onClick={() => api("POST", "/keys", { pane: paneId, keys: ["esc"] }).catch(failed("That did not work"))}>
            ■ Stop
          </button>
        )}
        {source && (
          <button disabled={forking} onClick={() => fork()} title="Fork: a new agent next to this one, with this whole conversation so far">
            {forking ? "forking…" : "⑂ Fork"}
          </button>
        )}
        {(!blocked || menu) && (
          <button className={showTerm ? "on" : ""} onClick={() => setShowTerm((v) => !v)} title="Show the agent's live terminal (menus, approvals, output in progress)">
            {showTerm ? "hide terminal" : "terminal"}
          </button>
        )}
      </div>
      <Composer paneId={paneId} agent={agent} focused={focused && !blocked} disabled={blocked} disabledHint={menu ? "Choose an option above" : undefined} onSlash={() => setShowTerm(true)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const ATTACH_HEAD = /^Read these attached files first:\n((?:- .+\n?)+)\n?/;

const Entry = memo(
  function Entry({ block, hl, onFork }: { block: ChatBlock; hl: number; onFork?: () => void }) {
    switch (block.kind) {
      case "user":
        return <UserMessage text={block.text} onFork={onFork} />;
      case "text":
        return <Prose text={block.text} hl={hl} />;
      case "notice":
        return <div className="c-notice">{block.text}</div>;
      case "tool":
        return <ToolCard t={block} />;
    }
  },
  (a, b) => a.block === b.block && a.hl === b.hl && !!a.onFork === !!b.onFork,
);

function UserMessage({ text, onFork }: { text: string; onFork?: () => void }) {
  const m = text.match(ATTACH_HEAD);
  const files = m ? m[1]!.trim().split("\n").map((l) => l.replace(/^- /, "")) : [];
  const body = m ? text.slice(m[0].length) : text;
  const long = body.split("\n").length > 5 || body.length > 420;
  const [open, setOpen] = useState(false);
  return (
    <div className="c-user">
      <span className="c-caret">›</span>
      {onFork && (
        <button className="c-fork" title="Fork from here: a new agent with the conversation before this message, and this message in its box to edit" onClick={onFork}>
          ⑂ fork from here
        </button>
      )}
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

function OutgoingMessage({ o, pane, working, stale, onTerminal }: { o: Outgoing; pane: string; working: boolean; stale: boolean; onTerminal: () => void }) {
  const label =
    o.state === "sending"
      ? "sending…"
      : o.state === "failed"
        ? `not sent: ${o.error}`
        : working
          ? "queued — the agent reads it after its current step"
          : stale
            ? "sent, but the agent has not picked it up yet"
            : "sent";
  return (
    <div className={`c-user pending ${o.state}`}>
      <span className="c-caret">›</span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {o.files.length > 0 && (
          <div className="c-files">
            {o.files.map((f) => (
              <AttachmentChip key={f} path={f} />
            ))}
          </div>
        )}
        {o.body && <div className="c-user-text">{o.body}</div>}
        <div className="c-pending">
          <span className={`live-dot ${o.state === "failed" ? "blocked" : "working"}`} />
          {label}
          {o.state === "failed" && (
            <>
              <button className="c-more" onClick={() => sendOutgoing(pane, o)}>
                retry
              </button>
              <button className="c-more" onClick={() => outbox.update(pane, (l) => l.filter((x) => x.id !== o.id))}>
                remove
              </button>
            </>
          )}
          {stale && (
            <>
              <button className="c-more" onClick={onTerminal}>
                show terminal
              </button>
              <button className="c-more" onClick={() => outbox.update(pane, (l) => l.filter((x) => x.id !== o.id))}>
                dismiss
              </button>
            </>
          )}
        </div>
      </div>
    </div>
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

let fileSeq = 0;

function Composer({
  paneId,
  agent,
  focused,
  disabled,
  disabledHint,
  onSlash,
}: {
  paneId: string;
  agent: string;
  focused: boolean;
  disabled: boolean;
  disabledHint?: string;
  onSlash: () => void;
}) {
  const draft = drafts.use(paneId);
  const { text, files } = draft;
  const setText = (t: string) => drafts.update(paneId, (d) => ({ ...d, text: t }));
  const setFiles = (fn: (fs: PendingFile[]) => PendingFile[]) => drafts.update(paneId, (d) => ({ ...d, files: fn(d.files) }));
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const cmd = useCommandMenu(paneId, text, (t) => {
    setText(t);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (el) (el.focus(), el.setSelectionRange(t.length, t.length));
    });
  });
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
  const canSend = !disabled && !uploading && (text.trim().length > 0 || ready.length > 0);

  const submit = () => {
    if (!canSend) return;
    const body = text.trim();
    const o: Outgoing = { id: ++outSeq, body, files: ready.map((f) => f.path!), prompt: body, at: Date.now(), state: "sending" };
    outbox.update(paneId, (l) => [...l, o]);
    drafts.update(paneId, () => ({ text: "", files: [] }));
    sendOutgoing(paneId, o);
    if (body.startsWith("/")) onSlash();
    ta.current?.focus();
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
      {cmd.open && <CommandMenu items={cmd.items} hi={cmd.hi} loading={cmd.loading} onHover={cmd.setHi} onPick={cmd.accept} />}
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
          placeholder={disabled ? (disabledHint ?? "Answer the question in the terminal above") : `Message ${agent} — Enter to send, Shift+Enter for a new line, paste or drop images and files`}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const fl = e.clipboardData.files;
            if (fl.length) {
              e.preventDefault();
              upload(fl);
            }
          }}
          onKeyDown={(e) => {
            if (cmd.open && cmd.items.length) {
              if (e.key === "ArrowDown") return (e.preventDefault(), cmd.move(1));
              if (e.key === "ArrowUp") return (e.preventDefault(), cmd.move(-1));
              if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                // Enter on an exact, complete command sends it; otherwise Tab/Enter complete the highlighted one
                const pick = cmd.items[cmd.hi]!;
                if (!(e.key === "Enter" && text.trim() === pick.insert)) return (e.preventDefault(), cmd.accept(pick));
              }
              if (e.key === "Escape") return (e.preventDefault(), cmd.dismiss());
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="composer-send" disabled={!canSend} onClick={submit} title="Send (Enter)">
          ↑
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// option menus (questions, approvals) drawn by the agent in its terminal, rendered as buttons

interface MenuOption {
  index: number;
  number?: number;
  label: string;
  description?: string;
  selected: boolean;
  freeText: boolean;
}
interface AgentMenu {
  question: string[];
  options: MenuOption[];
  hint?: string;
  multiSelect: boolean;
}

/** While the agent is blocked, read the menu on its screen once a second. */
function useMenu(pane: string, blocked: boolean) {
  const [menu, setMenu] = useState<AgentMenu | undefined>();
  useEffect(() => {
    if (!blocked) {
      setMenu(undefined);
      return;
    }
    let alive = true;
    let last = "";
    const poll = () =>
      api<{ menu: AgentMenu | null }>("GET", "/pane/menu", { pane })
        .then((r) => {
          if (!alive) return;
          const key = JSON.stringify(r.menu);
          if (key !== last) {
            last = key;
            setMenu(r.menu ?? undefined);
          }
        })
        .catch(() => {});
    void poll();
    const t = setInterval(poll, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pane, blocked]);
  return menu;
}

function MenuCard({ pane, menu, focused }: { pane: string; menu: AgentMenu; focused: boolean }) {
  const [hi, setHi] = useState(menu.options.find((o) => o.selected)?.index ?? 0);
  const [typing, setTyping] = useState<number>();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused && typing === undefined) box.current?.focus();
  }, [focused, typing]);

  const choose = (o: MenuOption, withText?: string) => {
    if (o.freeText && withText === undefined) {
      setTyping(o.index);
      return;
    }
    setBusy(true);
    setError(undefined);
    api("POST", "/pane/choose", { pane, index: o.index, label: o.label, text: withText })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const cancel = () => api("POST", "/keys", { pane, keys: ["esc"] }).catch((e) => setError(e.message));
  const [title, ...rest] = menu.question;
  const titleIsTab = !!title && /^[☐☑☒✔✓□■]/.test(title);
  const lines = titleIsTab ? rest : menu.question;

  return (
    <div
      ref={box}
      className={`menu-card ${busy ? "busy" : ""}`}
      tabIndex={0}
      onKeyDown={(e) => {
        if (typing !== undefined) return;
        const n = Number(e.key);
        if (n >= 1 && n <= 9) {
          const o = menu.options.find((x) => (x.number ?? x.index + 1) === n);
          if (o) (e.preventDefault(), choose(o));
        } else if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(menu.options.length - 1, h + 1)));
        else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
        else if (e.key === "Enter") (e.preventDefault(), choose(menu.options[hi]!));
        else if (e.key === "Escape") (e.preventDefault(), cancel());
      }}
    >
      {titleIsTab && <div className="menu-tab">{title!.replace(/^[☐☑☒✔✓□■]\s*/, "")}</div>}
      {lines.length > 0 && (
        <div className="menu-question">
          {lines.map((l, i) => (
            <div key={i} className={/^\$ |^[a-z0-9_./-]+ .*[|&;]|^(npm|git|rm|ls|cd|bun|node|python3?|make|cargo|go) /i.test(l) ? "cmd" : ""}>
              {l}
            </div>
          ))}
        </div>
      )}
      <div className="menu-options">
        {menu.options.map((o) =>
          typing === o.index ? (
            <form
              key={o.index}
              className="menu-option typing"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) choose(o, text);
              }}
            >
              <span className="menu-num">{o.number ?? o.index + 1}</span>
              <input className="text" autoFocus placeholder={o.label} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), setTyping(undefined))} />
              <button className="btn primary" disabled={!text.trim() || busy}>
                Send
              </button>
            </form>
          ) : (
            <button key={o.index} className={`menu-option ${o.index === hi ? "hi" : ""}`} disabled={busy} onClick={() => choose(o)} onMouseEnter={() => setHi(o.index)}>
              <span className="menu-num">{o.number ?? o.index + 1}</span>
              <span className="menu-label">
                {o.label}
                {o.description && <span className="menu-desc">{o.description}</span>}
              </span>
              {o.freeText && <span className="menu-type">type…</span>}
            </button>
          ),
        )}
      </div>
      <div className="menu-foot">
        <span>{menu.multiSelect ? "Toggle options, then choose the submit option" : "Click, or press 1–9 · ↑/↓ and Enter"}</span>
        <span className="spacer" />
        {error && <span className="menu-err">{error}</span>}
        <button className="c-more" onClick={cancel} title="Esc">
          Cancel (Esc)
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// the "/" menu: built-in commands and the skills this agent loaded ("$" for codex skills)

interface CommandItem {
  name: string;
  insert: string;
  description: string;
  kind: "command" | "skill";
}

const commandCache = new Map<string, { at: number; items: CommandItem[] }>();

function useCommandMenu(pane: string, text: string, setText: (t: string) => void) {
  const [all, setAll] = useState<CommandItem[]>();
  const [loading, setLoading] = useState(false);
  const [hi, setHi] = useState(0);
  const [dismissed, setDismissed] = useState<string>();
  // the menu is about the first word while it is being typed: "/", "/sk", "$img"
  const token = /^[/$][^\s]*$/.test(text) ? text : undefined;
  const wanted = !!token && dismissed !== token;
  useEffect(() => {
    if (!wanted || all) return;
    const hit = commandCache.get(pane);
    if (hit && Date.now() - hit.at < 60_000) return void setAll(hit.items);
    setLoading(true);
    api<{ items: CommandItem[] }>("GET", "/pane/commands", { pane })
      .then((r) => {
        commandCache.set(pane, { at: Date.now(), items: r.items });
        setAll(r.items);
      })
      .catch(failed("Could not load the agent's commands"))
      .finally(() => setLoading(false));
  }, [wanted, pane]);
  const items = useMemo(() => {
    if (!token || !all) return [];
    const q = token.toLowerCase();
    const pool = all.filter((c) => c.insert[0] === token[0] || (token[0] === "/" && c.insert.startsWith("/")));
    const starts = pool.filter((c) => c.insert.toLowerCase().startsWith(q));
    const word = q.slice(1);
    const inName = pool.filter((c) => !starts.includes(c) && word && c.name.toLowerCase().includes(word));
    const inDesc = pool.filter((c) => !starts.includes(c) && !inName.includes(c) && word.length > 1 && c.description.toLowerCase().includes(word));
    return [...starts, ...inName, ...inDesc].slice(0, 60);
  }, [token, all]);
  useEffect(() => setHi(0), [token]);
  return {
    open: wanted && (loading || items.length > 0),
    loading,
    items,
    hi: Math.min(hi, Math.max(0, items.length - 1)),
    setHi,
    move: (d: number) => setHi((h) => (items.length ? (h + d + items.length) % items.length : 0)),
    accept: (c: CommandItem) => {
      setDismissed(undefined);
      setText(`${c.insert} `);
    },
    dismiss: () => setDismissed(token),
  };
}

function CommandMenu({ items, hi, loading, onHover, onPick }: { items: CommandItem[]; hi: number; loading: boolean; onHover: (i: number) => void; onPick: (c: CommandItem) => void }) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);
  const cur = items[hi];
  return (
    <div className="cmd-menu" onMouseDown={(e) => e.preventDefault()}>
      <div className="cmd-list" ref={list}>
        {loading && !items.length && <div className="empty" style={{ padding: 10 }}>Loading the agent's commands…</div>}
        {items.map((c, i) => (
          <div key={c.insert} data-i={i} className={`cmd-row ${i === hi ? "hi" : ""}`} onMouseEnter={() => onHover(i)} onClick={() => onPick(c)}>
            <span className="cmd-name">{c.insert}</span>
            <span className={`cmd-kind ${c.kind}`}>{c.kind}</span>
            <span className="cmd-desc">{c.description}</span>
          </div>
        ))}
      </div>
      {cur && (
        <div className="cmd-preview">
          <div className="cmd-preview-head">
            <b>{cur.insert}</b> <span className={`cmd-kind ${cur.kind}`}>{cur.kind}</span>
          </div>
          <div className="cmd-preview-text">{cur.description || "No description."}</div>
          <div className="cmd-preview-keys">Tab or Enter to insert · ↑/↓ to choose · Esc to close</div>
        </div>
      )}
    </div>
  );
}
