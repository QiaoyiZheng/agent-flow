// An agent pane, rendered: finished output from the agent's own transcript as markdown + LaTeX, with the
// live terminal kept as a strip at the bottom for typing, approvals and in-progress output.

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ChatBlock, ChatEntry, ChatOp, ChatSource } from "@af/core";
import { onChat, send } from "./store";
import { Terminal } from "./Terminal";
import { onHighlighterReady, renderMarkdown } from "./markdown";

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
        if (t) Object.assign(t, { output: o.output, error: o.error, done: true });
        else this.early.set(o.id, { output: o.output, error: o.error });
      }
    }
  }
}

export function AgentView({ paneId, status, focused }: { paneId: string; status?: string; focused: boolean }) {
  const [source, setSource] = useState<ChatSource | null | undefined>(undefined);
  const [reason, setReason] = useState<string>();
  const log = useRef(new Log());
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [height, setHeight] = useState(0);
  const [tall, setTall] = useState(false);
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
  }, [version, source]);

  const blocked = status === "blocked";
  const stripH = Math.round(Math.min(height * 0.85, Math.max(170, height * (blocked || tall ? 0.6 : 0.3))));
  const entries = log.current.entries;

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
        {source && !entries.length && <div className="chat-empty">Nothing yet. Type in the terminal below.</div>}
        {entries.map((e) => (
          <Entry key={e.key} block={e.block} version={e.block.kind === "tool" ? (e.block.done ? 1 : 0) : 0} hl={hl} />
        ))}
        {source?.how === "folder" && <div className="chat-note">Transcript matched by folder: {source.path}</div>}
      </div>
      {height > 0 && (
        <div className={`live ${blocked ? "blocked" : ""}`}>
          <div className="live-bar">
            <span className={`live-dot ${status ?? ""}`} />
            <span>{blocked ? "waiting for your answer below" : status === "working" ? "working…" : "live terminal"}</span>
            <span className="spacer" />
            <button onClick={() => setTall((t) => !t)}>{tall ? "smaller" : "taller"}</button>
          </div>
          <Terminal key="strip" paneId={paneId} autoFocus={focused} strip={{ fullHeight: height, viewHeight: stripH }} />
        </div>
      )}
    </div>
  );
}

const Entry = memo(
  function Entry({ block, hl }: { block: ChatBlock; version: number; hl: number }) {
    switch (block.kind) {
      case "user":
        return (
          <div className="c-user">
            <span className="c-caret">›</span>
            <div className="c-user-text">{block.text}</div>
          </div>
        );
      case "text":
        return <Prose text={block.text} hl={hl} />;
      case "notice":
        return <div className="c-notice">{block.text}</div>;
      case "tool":
        return <ToolCard t={block} />;
    }
  },
  (a, b) => a.block === b.block && a.version === b.version && a.hl === b.hl,
);

export function Prose({ text, hl }: { text: string; hl: number }) {
  const html = useMemo(() => renderMarkdown(text), [text, hl]);
  return <div className="c-text md" dangerouslySetInnerHTML={{ __html: html }} />;
}

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

