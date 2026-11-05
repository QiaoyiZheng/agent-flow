// An agent pane, rendered: finished output from the agent's own transcript as markdown + LaTeX, tool calls
// folded into step groups, and our own composer (paste or drop images and files). The live terminal
// appears only when it is needed: the agent waits for an answer, a slash command opened a menu, or the
// user asks for it.

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ChatBlock, ChatEntry, ChatMeta, ChatOp, ChatSource, Delivery, QueuedMessage } from "@af/core";
import { TOKEN, api, failed, fileUrl, notify, onChat, onReconnect, openIn, send, useStore } from "./store";
import { Terminal } from "./Terminal";
import { onHighlighterReady, renderMarkdown } from "./markdown";
import { basename } from "./view";
import { OpenButtons } from "./Viewers";

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
  /** Sent into the agent's running turn instead of waiting for it to end. */
  steer?: boolean;
}
const outbox = paneStore<Outgoing[]>(() => []);
let outSeq = 0;

/** auto: now if the agent is free, else into agent-flow's queue for the end of its turn. steer: now, into the turn. */
function sendOutgoing(pane: string, o: Outgoing, mode: "auto" | "steer" = o.steer ? "steer" : "auto") {
  outbox.update(pane, (list) => list.map((x) => (x.id === o.id ? { ...x, state: "sending", error: undefined } : x)));
  api<{ sent?: string; queued?: unknown }>("POST", "/prompt", { pane, text: o.body, attachments: o.files, mode })
    .then((r) =>
      r.queued || o.body.startsWith("/")
        ? outbox.update(pane, (list) => list.filter((x) => x.id !== o.id)) // the queue panel shows it; a command shows its own result
        : outbox.update(pane, (list) => list.map((x) => (x.id === o.id ? { ...x, state: "sent", prompt: r.sent ?? o.body, at: Date.now() } : x))),
    )
    .catch((e) => outbox.update(pane, (list) => list.map((x) => (x.id === o.id ? { ...x, state: "failed", error: e.message } : x))));
}

const entryTime = (at: unknown) => (typeof at === "number" ? at : typeof at === "string" ? Date.parse(at) : NaN);

/** Entries plus an index so tool results can find their call. */
class Log {
  entries: ChatEntry[] = [];
  private tools = new Map<string, Tool>();
  private early = new Map<string, Partial<Tool>>();
  meta: ChatMeta = {};
  /** Earlier conversation in front of what is here (results of its calls that arrived already apply to them). */
  prepend(ops: ChatOp[]) {
    const later = this.entries;
    this.entries = [];
    this.apply(ops.filter((o) => o.op !== "meta")); // the footer keeps the latest settings
    this.entries = [...this.entries, ...later];
  }
  apply(ops: ChatOp[]) {
    for (const o of ops) {
      if (o.op === "add") {
        const b = { ...o.entry.block } as ChatBlock;
        if (b.kind === "tool") {
          const r = this.early.get(b.id);
          if (r) Object.assign(b, r);
          this.tools.set(b.id, b);
        }
        this.entries.push({ ...o.entry, block: b });
      } else if (o.op === "result" || o.op === "update") {
        const set: Partial<Tool> = o.op === "result" ? { output: o.output, error: o.error, ...(o.images?.length ? { images: o.images } : {}), ...(o.background ? { background: true } : { done: true }) } : o.set;
        const t = this.tools.get(o.id);
        if (t) {
          // replace the object so memoized rows notice the change
          const next = { ...t, ...set };
          this.tools.set(o.id, next);
          const i = this.entries.findIndex((e) => e.block === t);
          if (i >= 0) this.entries[i] = { ...this.entries[i]!, block: next };
        } else this.early.set(o.id, { ...this.early.get(o.id), ...set });
      } else if (o.op === "meta") this.meta = { ...this.meta, ...o.meta };
      else if (o.op === "remove") {
        const gone = new Set(o.keys);
        this.entries = this.entries.filter((e) => !gone.has(e.key));
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

export function AgentView({ paneId, agent, status, background, focused, onForked }: { paneId: string; agent: string; status?: string; background?: number; focused: boolean; onForked?: (paneId: string) => void }) {
  const [source, setSource] = useState<ChatSource | null | undefined>(undefined);
  const [reason, setReason] = useState<string>();
  const log = useRef(new Log());
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // earlier conversation: asked for when the user scrolls near the top
  const [more, setMore] = useState(false);
  const loadingEarlier = useRef(false);
  const anchor = useRef<{ height: number; top: number } | undefined>(undefined);
  const chatId = useRef("");
  const loadEarlier = () => {
    if (!more || loadingEarlier.current || !chatId.current) return;
    loadingEarlier.current = true;
    send({ type: "chat.more", id: chatId.current });
  };
  useLayoutEffect(() => {
    const el = list.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = undefined;
    el.scrollTop = a.top + (el.scrollHeight - a.height);
  }, [version]);
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
      if (m.type === "chat.prepend") {
        // keep what is on screen where it is: the earlier part grows the list above it
        const el = list.current;
        anchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : undefined;
        log.current.prepend(m.ops);
        setMore(m.more);
        loadingEarlier.current = false;
        return bump();
      }
      if (m.type === "chat.reset") {
        log.current = new Log();
        setSource(m.source);
        setReason(m.reason);
        setMore(!!m.more);
        loadingEarlier.current = false;
      }
      log.current.apply(m.ops);
      bump();
    });
    chatId.current = id;
    send({ type: "chat.open", id, paneId });
    // the server restarted (or the connection dropped): open it again; the server answers with the whole log
    const offR = onReconnect(() => send({ type: "chat.open", id, paneId }));
    return () => {
      off();
      offR();
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

  const { menu, overlay } = useMenu(paneId, status === "blocked");
  // a dialog or notice on screen means the agent waits for the user, whatever Herdr's status says
  const blocked = status === "blocked" || !!menu || !!overlay;
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

  // rewind to before one of your messages: agent-flow drives the agent's own picker to it (see server rewind.ts)
  const rewindable = !!source && !source.pending && (source.agent === "claude" || source.agent === "codex" || source.agent === "omp");
  const [picking, setPicking] = useState(false);
  const [rewinding, setRewinding] = useState(false);
  const firstLineOf = (t: string) => (t.split("\n").find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  const rewindInfo = useMemo(() => {
    const users = log.current.entries.filter((e) => e.block.kind === "user") as (ChatEntry & { block: { kind: "user"; text: string } })[];
    const info = new Map<string, { back: number; occurrence: number }>();
    users.forEach((e, i) => {
      const fl = firstLineOf(e.block.text);
      const occurrence = users.slice(i).filter((x) => firstLineOf(x.block.text) === fl).length;
      info.set(e.key, { back: users.length - 1 - i, occurrence });
    });
    return info;
  }, [version]);
  const rewindTo = (e: ChatEntry & { block: { kind: "user"; text: string } }, code: boolean) => {
    const at = rewindInfo.get(e.key);
    if (!at) return;
    setRewinding(true);
    setPicking(false);
    api("POST", "/pane/rewind", { pane: paneId, text: e.block.text, back: at.back, occurrence: at.occurrence, ref: e.ref, code })
      .then(() => {
        // the message comes back into the box, as in the agent's own terminal
        const m = e.block.text.match(ATTACH_HEAD);
        const files = m ? m[1]!.trim().split("\n").map((l) => l.replace(/^- /, "")) : [];
        const body = m ? e.block.text.slice(m[0].length) : e.block.text;
        drafts.update(paneId, () => ({ text: body, files: files.map((f) => ({ id: ++fileSeq, name: basename(f), path: f })) }));
      })
      .catch(failed("Could not rewind"))
      .finally(() => setRewinding(false));
  };
  useEffect(() => {
    if (!picking) return;
    const k = (ev: KeyboardEvent) => ev.key === "Escape" && (ev.preventDefault(), setPicking(false));
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [picking]);
  const [controls, setControls] = useState(false);
  const control = (action: "interrupt" | "rewind" | "clear" | "exit") =>
    api<{ hint?: string }>("POST", "/pane/control", { pane: paneId, action })
      .then((r) => {
        // a rewind picker is the agent's own screen: show it, with what to do there
        if (action === "rewind") {
          setShowTerm(true);
          if (r.hint) notify("info", `Rewind: ${r.hint}`);
        }
      })
      .catch(failed("That did not work"));
  // Esc in this view stops the agent's turn, as in its own terminal (not while typing in a field, or in a menu)
  useEffect(() => {
    if (!focused || status !== "working") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement;
      if (t.closest(".xterm") || t.closest(".menu-card") || document.querySelector(".modal-back, .lightbox")) return;
      const typing = t.tagName === "TEXTAREA" || t.tagName === "INPUT";
      if (typing && (t as HTMLTextAreaElement).value) return; // Esc while typing keeps its meaning (close the / menu, …)
      e.preventDefault();
      control("interrupt");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, status, paneId]);

  // links to local files in agent output (codex writes [x.ts](/Users/…/x.ts:12)) open next to this pane
  const openLink = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a[data-path]") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    // a remote agent's file: VS Code over Remote-SSH (preview panes are local only)
    if (paneId.includes("~")) return void openIn("vscode", a.dataset.path!, { pane: paneId });
    api("POST", "/show", { target: a.dataset.path, of: paneId }).catch(failed("Could not open the file"));
  };

  // keep the newest output in view unless the user scrolled up
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [version, source, showTerm, out.length, !!menu]);
  // ... also when the view or its content changes size without a new entry: the queue panel or terminal strip
  // opening, the message box growing, an image or the code highlighter arriving
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const pin = () => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    };
    const ro = new ResizeObserver(pin);
    ro.observe(el);
    const mo = new MutationObserver(() => {
      for (const c of Array.from(el.children)) if (!observed.has(c)) (observed.add(c), ro.observe(c));
    });
    const observed = new WeakSet<Element>();
    mo.observe(el, { childList: true });
    for (const c of Array.from(el.children)) (observed.add(c), ro.observe(c));
    el.addEventListener("load", pin, true);
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("load", pin, true);
    };
  }, [source === null]);
  // the live terminal is only needed for prompts we cannot draw ourselves
  const termVisible = (blocked && !menu && !overlay) || showTerm;
  const stripH = Math.round(Math.min(height * 0.7, Math.max(180, height * (blocked ? 0.55 : 0.4))));
  const segs = useMemo(() => segments(log.current.entries), [version]);
  // documents this agent handed over (af deliver, or found at the end of its turn): a row of open buttons at the end
  // of the turn they came in, i.e. under the agent's reply, before the next user message. Ones from turns not loaded
  // yet (earlier pages) wait until those are.
  const { deliveries } = useStore();
  const docsAt = useMemo(() => {
    const mine = deliveries.filter((d) => d.pane === paneId);
    const at = new Map<number, Delivery[]>();
    if (!mine.length || !segs.length) return at;
    const times = segs.map((g) => (g.kind === "entry" && g.entry.block.kind === "user" ? entryTime(g.entry.at) : NaN));
    const first = segs.map((g) => (g.kind === "entry" ? entryTime(g.entry.at) : NaN)).find((t) => !Number.isNaN(t));
    for (const d of mine) {
      const t = Date.parse(d.at);
      if (first !== undefined && t < first - 60_000) continue; // its turn is in an earlier page
      let i = times.findIndex((u) => !Number.isNaN(u) && u > t);
      if (i < 0) i = segs.length;
      const list = at.get(i) ?? [];
      // one row per file per turn: the latest hand-over of it
      at.set(i, [...list.filter((x) => x.path !== d.path), d]);
    }
    return at;
  }, [deliveries, segs, paneId]);

  if (source === null)
    return (
      <div ref={box} className="agent-view">
        <div className="agent-banner">Showing the plain terminal: {reason ?? "no transcript found"}.</div>
        {/* a startup prompt (folder trust, update, login) before there is any transcript: answer it here too */}
        {!menu && overlay && (
          <div style={{ padding: "0 16px", flex: "none" }}>
            <OverlayCard pane={paneId} overlay={overlay} onTerminal={() => {}} />
          </div>
        )}
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
        onClick={openLink}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          if (el.scrollTop < 400) loadEarlier();
        }}
      >
        {(picking || rewinding) && (
          <div className="rewind-banner">
            {rewinding ? `Rewinding ${agent}…` : "Pick the message to go back to: ↶ rewind to here on it. Esc to cancel."}
            {picking && (
              <button className="c-more" onClick={() => setPicking(false)}>
                cancel
              </button>
            )}
          </div>
        )}
        {source === undefined && <div className="chat-empty">Loading transcript…</div>}
        {more && (
          <button className="chat-earlier" onClick={loadEarlier}>
            {loadingEarlier.current ? "Loading earlier messages…" : "Show earlier messages"}
          </button>
        )}
        {source && !segs.length && !out.length && (
          <div className="chat-empty">{source.pending ? `New conversation. Send ${agent} a message below; it shows up here as you go.` : "Nothing yet. Send a message below."}</div>
        )}
        {segs.map((s, i) => [
          docsAt.get(i) && <DeliveredFiles key={`docs-${i}`} docs={docsAt.get(i)!} paneId={paneId} />,
          s.kind === "steps" ? (
            <Steps key={s.key} tools={s.tools} />
          ) : (
            <Entry
              key={s.entry.key}
              block={s.entry.block}
              hl={hl}
              onFork={forkable && s.entry.block.kind === "user" && s.entry.ref !== undefined ? forkAt(s.entry.ref, s.entry.block.text) : undefined}
              rewind={
                rewindable && s.entry.block.kind === "user" && !rewinding
                  ? { agent, picking, run: (code: boolean) => rewindTo(s.entry as ChatEntry & { block: { kind: "user"; text: string } }, code) }
                  : undefined
              }
            />
          ),
        ])}
        {docsAt.get(segs.length) && <DeliveredFiles docs={docsAt.get(segs.length)!} paneId={paneId} />}
        {out.map((o) => (
          <OutgoingMessage key={o.id} o={o} pane={paneId} working={status === "working"} stale={o.state === "sent" && now - o.at > 30_000 && status !== "working"} onTerminal={() => setShowTerm(true)} />
        ))}
        {menu && blocked && <MenuCard key={menu.options.map((o) => o.label).join("|")} pane={paneId} menu={menu} focused={focused} />}
        {!menu && overlay && <OverlayCard pane={paneId} overlay={overlay} onTerminal={() => setShowTerm(true)} />}
        {source?.how === "folder" && <div className="chat-note">Transcript matched by folder: {source.path}</div>}
        {source?.how === "screen" && <div className="chat-note">Transcript matched by screen content: {source.path}</div>}
        {source?.how === "title" && <div className="chat-note">Transcript matched by conversation title: {source.path}</div>}
      </div>
      {termVisible && height > 0 && (
        <div className={`live ${blocked ? "blocked" : ""}`}>
          <Terminal key="strip" paneId={paneId} autoFocus={focused && blocked} strip={{ fullHeight: height, viewHeight: stripH }} />
        </div>
      )}
      <div className={`agent-status ${status ?? ""} ${background && status !== "working" ? "background" : ""}`}>
        <span className={`live-dot ${background && status !== "working" ? "working" : (status ?? "")}`} />
        <span>
          {blocked
            ? menu
              ? "waiting for your choice"
              : overlay
                ? "the agent shows a notice above"
                : "waiting for your answer in the terminal"
            : status === "working"
              ? "working…"
              : background
                ? `waiting on ${background} background task${background === 1 ? "" : "s"} · you can still send it messages`
                : status === "done"
                  ? "done"
                  : "idle"}
        </span>
        <MetaChips meta={log.current.meta} />
        <span className="spacer" />
        {status === "working" && (
          <button className="stop" title={`Stop ${agent}'s turn (Esc). What you queued stays queued.`} onClick={() => control("interrupt")}>
            ■ Stop
          </button>
        )}
        {rewindable && (
          <button className={picking ? "on" : ""} disabled={rewinding} title="Rewind: pick one of your messages to go back to; the conversation continues from before it" onClick={() => setPicking((v) => !v)}>
            {rewinding ? "rewinding…" : "↶ Rewind"}
          </button>
        )}
        <span className="menu-wrap">
          <button title="More controls" onClick={() => setControls((c) => !c)}>
            ⋯
          </button>
          {controls && (
            <div className="menu up" onMouseLeave={() => setControls(false)} onClick={() => setControls(false)}>
              <div className="item" onClick={() => control("interrupt")}>
                ■ Stop the turn <span className="kbd">Esc</span>
              </div>
              {rewindable && (
                <div className="item" onClick={() => setPicking(true)}>
                  ↶ Rewind to one of your messages…
                </div>
              )}
              <div className="item" onClick={() => control("rewind")}>
                ↶ Open {agent}'s own rewind list <span className="kbd">{agent === "omp" ? "/rewind" : "Esc Esc"}</span>
              </div>
              <div className="item" onClick={() => control("clear")}>
                ⌫ Clear what is typed in {agent}'s own box <span className="kbd">Ctrl+C</span>
              </div>
              <div
                className="item danger"
                onClick={() => {
                  if (confirm(`Exit ${agent}?\n\nIts conversation is saved; you can resume it later. The pane stays open with a shell.`)) control("exit");
                }}
              >
                ⏻ Exit {agent} <span className="kbd">{agent === "claude" ? "Ctrl+C Ctrl+C" : "Ctrl+D"}</span>
              </div>
            </div>
          )}
        </span>
        {source && !source.pending && (
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
      <Composer paneId={paneId} agent={agent} working={status === "working"} focused={focused && !blocked} disabled={blocked} disabledHint={menu ? "Choose an option above" : overlay ? "Answer the notice above first" : undefined} onSlash={() => setShowTerm(true)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const ATTACH_HEAD = /^Read these attached files first:\n((?:- .+\n?)+)\n?/;

const Entry = memo(
  function Entry({ block, hl, onFork, rewind }: { block: ChatBlock; hl: number; onFork?: () => void; rewind?: RewindProp }) {
    switch (block.kind) {
      case "user":
        return <UserMessage text={block.text} images={block.images} command={block.command} onFork={onFork} rewind={rewind} />;
      case "text":
        return <Prose text={block.text} hl={hl} />;
      case "thinking":
        return <Thinking text={block.text} hl={hl} />;
      case "notice":
        return <NoticeLine n={block} hl={hl} />;
      case "tool":
        return <ToolCard t={block} />;
    }
  },
  (a, b) => a.block === b.block && a.hl === b.hl && !!a.onFork === !!b.onFork && !!a.rewind === !!b.rewind && a.rewind?.picking === b.rewind?.picking,
);

interface RewindProp {
  agent: string;
  /** The footer's Rewind was pressed: every message offers itself. */
  picking: boolean;
  run: (code: boolean) => void;
}

function UserMessage({ text, images, command, onFork, rewind }: { text: string; images?: string[]; command?: string; onFork?: () => void; rewind?: RewindProp }) {
  const m = text.match(ATTACH_HEAD);
  const files = m ? m[1]!.trim().split("\n").map((l) => l.replace(/^- /, "")) : [];
  const body = m ? text.slice(m[0].length) : text;
  const long = body.split("\n").length > 5 || body.length > 420;
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  return (
    <div className={`c-user ${rewind?.picking ? "pickable" : ""} ${asking ? "asking" : ""}`}>
      <span className="c-caret">›</span>
      {(onFork || rewind) && !asking && (
        <span className="c-user-actions">
          {rewind && (
            <button className={`c-rewind ${rewind.picking ? "on" : ""}`} title={`Rewind ${rewind.agent} to before this message: it and everything after it leave the conversation, and it comes back into the box below`} onClick={() => setAsking(true)}>
              ↶ rewind to here
            </button>
          )}
          {onFork && (
            <button className="c-fork" title="Fork from here: a new agent with the conversation before this message, and this message in its box to edit" onClick={onFork}>
              ⑂ fork from here
            </button>
          )}
        </span>
      )}
      {asking && rewind && (
        <div className="c-rewind-ask">
          <span>
            Rewind {rewind.agent} to before this message? It and what came after leave the conversation; the message comes back into the box below.
            {rewind.agent !== "claude" && " Files are not changed."}
          </span>
          <span className="c-rewind-btns">
            <button className="btn primary" onClick={() => (setAsking(false), rewind.run(false))}>
              Rewind{rewind.agent === "claude" ? " conversation" : ""}
            </button>
            {rewind.agent === "claude" && (
              <button className="btn" title="claude also puts back the files it edited since this message (its checkpoints)" onClick={() => (setAsking(false), rewind.run(true))}>
                Rewind conversation and code
              </button>
            )}
            <button className="btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {files.length > 0 && (
          <div className="c-files">
            {files.map((f) => (
              <AttachmentChip key={f} path={f} />
            ))}
          </div>
        )}
        {images && images.length > 0 && <Thumbs images={images} />}
        <div className={`c-user-text ${long && !open ? "clamp" : ""}`}>
          {command && <span className="c-cmd-badge">{command}</span>}
          {body}
        </div>
        {long && (
          <button className="c-more" onClick={() => setOpen((o) => !o)}>
            {open ? "show less" : "show more"}
          </button>
        )}
      </div>
    </div>
  );
}

const short = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Model, effort, mode and context use, as the agent's own status line shows them. */
function MetaChips({ meta }: { meta: ChatMeta }) {
  const used = meta.contextTokens && meta.contextWindow ? meta.contextTokens / meta.contextWindow : undefined;
  const parts = [meta.model, meta.effort, meta.mode].filter(Boolean) as string[];
  if (!parts.length && used === undefined && meta.cost === undefined) return null;
  return (
    <span className="meta-chips">
      {parts.map((p, i) => (
        <span key={i} className="meta-chip">
          {p}
        </span>
      ))}
      {used !== undefined && (
        <span className={`meta-chip ctx ${used > 0.85 ? "hot" : used > 0.6 ? "warm" : ""}`} title={`${meta.contextTokens!.toLocaleString()} of ${meta.contextWindow!.toLocaleString()} tokens in context`}>
          <span className="ctx-bar">
            <span style={{ width: `${Math.min(100, Math.round(used * 100))}%` }} />
          </span>
          {short(meta.contextTokens!)} / {short(meta.contextWindow!)}
        </span>
      )}
      {meta.cost !== undefined && <span className="meta-chip">${meta.cost.toFixed(2)}</span>}
    </span>
  );
}

/** The model's reasoning: one dim line, opened on click. */
function Thinking({ text, hl }: { text: string; hl: number }) {
  const [open, setOpen] = useState(false);
  const first = text.replace(/[*_#`>]/g, "").trim().split("\n")[0] ?? "";
  return (
    <div className={`c-think ${open ? "open" : ""}`}>
      <div className="c-think-head" onClick={() => setOpen((o) => !o)}>
        <span className="c-tool-caret">{open ? "▾" : "▸"}</span>
        <span className="c-think-label">Thinking</span>
        {!open && <span className="c-think-first">{first}</span>}
      </div>
      {open && (
        <div className="c-think-body">
          <Prose text={text} hl={hl} />
        </div>
      )}
    </div>
  );
}

/** A compact line (command output, wake-up, error, compaction). Its detail opens on click. */
function NoticeLine({ n, hl }: { n: Extract<ChatBlock, { kind: "notice" }>; hl: number }) {
  const [open, setOpen] = useState(false);
  const tone = n.tone ?? "info";
  const head = (
    <>
      {n.detail && <span className="c-tool-caret">{open ? "▾" : "▸"}</span>}
      <span className="c-notice-text">{n.text}</span>
    </>
  );
  return (
    <div className={`c-notice ${tone} ${n.divider ? "divider" : ""} ${n.detail ? "has-detail" : ""}`}>
      <div className="c-notice-head" onClick={() => n.detail && setOpen((o) => !o)}>
        {head}
      </div>
      {open && n.detail && (n.divider ? <div className="c-notice-detail md-wrap"><Prose text={n.detail} hl={hl} /></div> : <pre className="c-pre c-notice-detail">{n.detail}</pre>)}
    </div>
  );
}

/** Image thumbnails; a click shows the image full size. */
function Thumbs({ images }: { images: string[] }) {
  const [big, setBig] = useState<string>();
  const src = (i: string) => (i.startsWith("afimg:") ? `/api/chat-image?id=${encodeURIComponent(i.slice(6))}&token=${encodeURIComponent(TOKEN)}` : /^(data:|https?:|blob:)/.test(i) ? i : fileUrl(i));
  return (
    <>
      <div className="c-thumbs">
        {images.map((i, k) => (
          <img key={k} src={src(i)} alt="" loading="lazy" decoding="async" onClick={() => setBig(src(i))} />
        ))}
      </div>
      {big && (
        <div className="lightbox" onClick={() => setBig(undefined)}>
          <img src={big} alt="" />
        </div>
      )}
    </>
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
          ? "sent now, into the current turn"
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

/** Documents the agent handed over in this turn: one line each, with buttons to open it (nothing opens by itself). */
function DeliveredFiles({ docs, paneId }: { docs: Delivery[]; paneId: string }) {
  const remote = paneId.includes("~");
  return (
    <div className="c-docs">
      {docs.map((d) => (
        <div key={d.id} className="c-doc" title={d.path}>
          <span className="c-doc-ic">≡</span>
          <span className="c-doc-name">{basename(d.path)}</span>
          {(d.title || d.note) && <span className="c-doc-note">{[d.found ? "" : d.title, d.note].filter(Boolean).join(" — ")}</span>}
          <span className="c-doc-btns">
            <OpenButtons path={d.path} remote={remote} pane={paneId} delivery={d.id} />
            {!remote && (
              <button
                className="btn subtle"
                title="Preview it in a pane next to this one"
                onClick={() => api("POST", "/show", { target: d.path, of: paneId, run: undefined }).catch(failed("Could not show it"))}
              >
                Preview
              </button>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A folded group of tool calls: "4 steps · Bash ×3 · Edit calc.js". */
const Steps = memo(
  function Steps({ tools }: { tools: Tool[] }) {
    const [open, setOpen] = useState(false);
    const running = tools.some((t) => !t.done && !t.aborted && !t.background);
    const bg = tools.some((t) => !t.done && !t.aborted && t.background);
    const aborted = tools.some((t) => t.aborted);
    const failed = tools.filter((t) => t.error).length;
    const counts = new Map<string, number>();
    for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    const edits = tools.flatMap((t) => (t.files?.length ? t.files : t.edit || t.patch ? [t.edit?.path ?? t.summary.split(" — ")[0] ?? ""] : [])).map((f) => basename(f));
    const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
    const label = tools.length === 1 ? `${tools[0]!.name} ${tools[0]!.summary}` : `${tools.length} steps · ${parts.join(" · ")}`;
    return (
      <div className={`c-steps ${open ? "open" : ""}`}>
        <div className="c-steps-head" onClick={() => setOpen((o) => !o)}>
          <span className="c-tool-caret">{open ? "▾" : "▸"}</span>
          <span className={`c-tool-icon ${running ? "run" : failed ? "err" : aborted ? "abort" : bg ? "bg" : "ok"}`}>{running ? "◌" : failed ? "✗" : aborted ? "⊘" : bg ? "◔" : "✓"}</span>
          <span className="c-steps-label">{label}</span>
          {edits.length > 0 && (tools.length > 1 || tools[0]!.files?.length) && (
            <span className="c-steps-edits">
              edited {[...new Set(edits)].slice(0, 3).join(", ")}
              {new Set(edits).size > 3 ? ` +${new Set(edits).size - 3}` : ""}
            </span>
          )}
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
  // the log replaces a tool's object whenever it changes
  (a, b) => a.tools.length === b.tools.length && a.tools.every((t, i) => t === b.tools[i]),
);

const toolState = (t: Tool) => (t.aborted ? "abort" : !t.done ? (t.background ? "bg" : "run") : t.error ? "err" : "ok");
const TOOL_ICON = { abort: "⊘", bg: "◔", run: "◌", err: "✗", ok: "✓" } as const;

function ToolCard({ t }: { t: Tool }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(t.input || t.patch || t.edit || t.output || t.report || t.images?.length);
  const st = toolState(t);
  return (
    <div className={`c-tool ${open ? "open" : ""} ${t.error ? "err" : ""}`}>
      <div className="c-tool-head" onClick={() => hasDetail && setOpen((o) => !o)}>
        <span className={`c-tool-icon ${st}`} title={st === "abort" ? "interrupted" : st === "bg" ? "running in the background" : undefined}>
          {TOOL_ICON[st]}
        </span>
        <span className="c-tool-name">{t.name}</span>
        <span className="c-tool-sum">{t.summary}</span>
        {st === "bg" && <span className="c-tool-tag">background</span>}
        {st === "abort" && <span className="c-tool-tag">interrupted</span>}
        {hasDetail && <span className="c-tool-caret">{open ? "▾" : "▸"}</span>}
      </div>
      {open && (
        <div className="c-tool-body">
          {t.input && <pre className="c-pre">{t.input}</pre>}
          {t.patch ? <Patch text={t.patch} /> : t.edit && <EditDiff before={t.edit.before} after={t.edit.after} />}
          {t.report && (
            <div className="c-report">
              <Prose text={t.report} hl={0} />
            </div>
          )}
          {t.images && t.images.length > 0 && <Thumbs images={t.images} />}
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

/** A unified diff: file headers, hunks, and old/new line numbers when the hunk headers give them. */
function Patch({ text }: { text: string }) {
  type Row = { kind: "file" | "hunk" | "add" | "del" | "ctx" | "meta"; text: string; a?: number; b?: number };
  const rows = useMemo(() => {
    const out: Row[] = [];
    let a = 0;
    let b = 0;
    let numbered = false;
    for (const l of text.split("\n")) {
      const file = l.match(/^\+\+\+ (?:b\/)?(.+)$/) ?? l.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
      if (file && !(l.startsWith("+++") && out.at(-1)?.kind === "add")) {
        out.push({ kind: "file", text: file[1]!.trim() });
        continue;
      }
      if (/^--- (a\/|\/dev\/null)/.test(l) || /^(diff --git|index [0-9a-f]+\.\.|\*\*\* (Begin|End) Patch)/.test(l)) continue;
      const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      if (h) {
        a = Number(h[1]);
        b = Number(h[2]);
        numbered = true;
        out.push({ kind: "hunk", text: h[3]?.trim() || "" });
        continue;
      }
      if (l.startsWith("@@")) {
        numbered = false;
        out.push({ kind: "hunk", text: l.slice(2).trim() });
        continue;
      }
      if (l.startsWith("+")) out.push({ kind: "add", text: l.slice(1), b: numbered ? b++ : undefined });
      else if (l.startsWith("-")) out.push({ kind: "del", text: l.slice(1), a: numbered ? a++ : undefined });
      else if (l.startsWith("\\")) out.push({ kind: "meta", text: l });
      else out.push({ kind: "ctx", text: l.startsWith(" ") ? l.slice(1) : l, a: numbered ? a++ : undefined, b: numbered ? b++ : undefined });
    }
    return out;
  }, [text]);
  const nums = rows.some((r) => r.a !== undefined || r.b !== undefined);
  return (
    <div className={`diff c-diff ${nums ? "nums" : ""}`}>
      {rows.map((r, i) =>
        r.kind === "file" ? (
          <div key={i} className="file">
            {r.text}
          </div>
        ) : r.kind === "hunk" ? (
          <div key={i} className="hunk">
            {nums ? "⋯ " : "@@ "}
            {r.text}
          </div>
        ) : (
          <div key={i} className={r.kind}>
            {nums && <span className="ln">{r.a ?? ""}</span>}
            {nums && <span className="ln">{r.b ?? ""}</span>}
            <span className="sign">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}</span>
            {r.text || " "}
          </div>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

let fileSeq = 0;

/** What each agent's own "send now" is (agent-flow presses it for Steer). */
const STEER_KEY: Record<string, string> = { claude: "claude's Ctrl+Enter", codex: "codex's Esc on a held message", omp: "omp's Enter while it works" };

function Composer({
  paneId,
  agent,
  focused,
  disabled,
  disabledHint,
  onSlash,
  working,
}: {
  paneId: string;
  agent: string;
  focused: boolean;
  disabled: boolean;
  disabledHint?: string;
  onSlash: () => void;
  working: boolean;
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

  const submit = (steer = false) => {
    if (!canSend) return;
    const body = text.trim();
    const o: Outgoing = { id: ++outSeq, body, files: ready.map((f) => f.path!), prompt: body, at: Date.now(), state: "sending", steer: steer && working };
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
      <QueuePanel paneId={paneId} agent={agent} working={working} onEdit={(q) => drafts.update(paneId, (d) => ({ text: d.text ? `${d.text}\n${q.body}` : q.body, files: [...d.files, ...q.files.map((p) => ({ id: ++fileSeq, name: basename(p), path: p }))] }))} />
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
          placeholder={
            disabled
              ? (disabledHint ?? "Answer the question in the terminal above")
              : working
                ? `${agent} is working — Enter queues for after this turn, ⌘/Ctrl+Enter steers it now`
                : `Message ${agent} — Enter to send, Shift+Enter for a new line, paste or drop images and files`
          }
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
              submit(e.metaKey || e.ctrlKey);
            }
          }}
        />
        {working && (
          <button className="composer-steer" disabled={!canSend} onClick={() => submit(true)} title={`Steer: send it to ${agent} now, into its current turn, as ${STEER_KEY[agent] ?? "its send now"} does (⌘/Ctrl+Enter)`}>
            Steer
          </button>
        )}
        <button className="composer-send" disabled={!canSend} onClick={() => submit()} title={working ? `Queue: send when ${agent} finishes this turn (Enter)` : "Send (Enter)"}>
          ↑
        </button>
      </div>
    </div>
  );
}

/** Messages agent-flow holds until the agent's turn ends. Each can be steered into the running turn instead. */
function QueuePanel({ paneId, agent, working, onEdit }: { paneId: string; agent: string; working: boolean; onEdit: (q: QueuedMessage) => void }) {
  const { queue } = useStore();
  const list = queue[paneId] ?? [];
  const [busy, setBusy] = useState<string>();
  if (!list.length) return null;
  const act = (q: QueuedMessage, path: string, then?: (r: any) => void) => {
    setBusy(q.id);
    api("POST", path, { pane: paneId, id: q.id })
      .then((r) => then?.(r))
      .catch(failed(path.endsWith("steer") ? "Could not steer" : "That did not work"))
      .finally(() => setBusy(undefined));
  };
  return (
    <div className="queue">
      <div className="queue-head">
        <span>
          Queued · {list.length} · {working ? `sent when ${agent} finishes this turn` : `sending to ${agent}…`}
        </span>
      </div>
      {list.map((q, i) => (
        <div key={q.id} className={`queue-item ${busy === q.id ? "busy" : ""}`}>
          <span className="queue-n">{i + 1}</span>
          <div className="queue-body">
            {q.files.length > 0 && (
              <div className="c-files">
                {q.files.map((f) => (
                  <AttachmentChip key={f} path={f} />
                ))}
              </div>
            )}
            {q.body && <div className="queue-text">{q.body}</div>}
          </div>
          <div className="queue-actions">
            <button className="queue-steer" disabled={!!busy} onClick={() => act(q, "/queue/steer", (r) => r.sent && outbox.update(paneId, (l) => [...l, { id: ++outSeq, body: q.body, files: q.files, prompt: r.sent, at: Date.now(), state: "sent", steer: true }]))} title={`Send it to ${agent} now, into its current turn (${STEER_KEY[agent] ?? "its send now"})`}>
              Steer
            </button>
            <button disabled={!!busy} onClick={() => act(q, "/queue/remove", () => onEdit(q))} title="Take it out of the queue and back into the message box">
              Edit
            </button>
            <button disabled={!!busy} onClick={() => act(q, "/queue/remove")} title="Delete it">
              ✕
            </button>
          </div>
        </div>
      ))}
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
  preview?: string;
  selected: boolean;
  freeText: boolean;
  checked?: boolean;
  action?: "primary" | "secondary";
  current?: boolean;
}
interface AgentMenu {
  question: string[];
  code?: string[];
  options: MenuOption[];
  tabs?: { label: string; done: boolean; submit?: boolean; current?: boolean }[];
  review?: boolean;
  setting?: { label: string; value: string; levels?: string[]; note?: string };
  extraKeys?: { key: string; label: string }[];
  hint?: string;
  multiSelect: boolean;
}

/**
 * Read the menu on the agent's screen: every second while Herdr says it is blocked, and every 4 seconds
 * otherwise, because some dialogs are not recognized as blocked (a menu on screen means the agent waits).
 */
interface AgentOverlay {
  lines: string[];
  hint?: string;
  enter: boolean;
  esc: boolean;
}

function useMenu(pane: string, blocked: boolean) {
  const [menu, setMenu] = useState<AgentMenu | undefined>();
  const [overlay, setOverlay] = useState<AgentOverlay | undefined>();
  useEffect(() => {
    let alive = true;
    let last = "";
    const poll = () =>
      api<{ menu: AgentMenu | null; overlay: AgentOverlay | null }>("GET", "/pane/menu", { pane })
        .then((r) => {
          if (!alive) return;
          const key = JSON.stringify([r.menu, r.overlay]);
          if (key !== last) {
            last = key;
            setMenu(r.menu ?? undefined);
            setOverlay(r.overlay ?? undefined);
          }
        })
        .catch(() => {});
    void poll();
    const t = setInterval(poll, blocked ? 1000 : 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [pane, blocked]);
  return { menu, overlay };
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

  // a ←/→ setting (claude's effort), and a second way to confirm ("s to use this session only")
  const [setting, setSetting] = useState(menu.setting?.value);
  const [via, setVia] = useState<string | undefined>(undefined);
  const choose = (o: MenuOption, withText?: string) => {
    if (o.freeText && withText === undefined) {
      setTyping(o.index);
      return;
    }
    setBusy(true);
    setError(undefined);
    api("POST", "/pane/choose", { pane, index: o.index, label: o.label, text: withText, key: via, setting: setting !== menu.setting?.value ? setting : undefined })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const cancel = () => api("POST", "/keys", { pane, keys: ["esc"] }).catch((e) => setError(e.message));
  const lines = menu.question;
  // claude's multi-select "Next"/"Submit" and its review page's "Submit answers"/"Cancel" are buttons under the list
  const answers = menu.options.filter((o) => !o.action);
  const actions = menu.options.filter((o) => o.action);
  const steps = menu.tabs && (menu.tabs.length > 2 || !menu.tabs.some((t) => t.submit)) ? menu.tabs : undefined;

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
      {steps ? (
        steps.length === 1 ? (
          <div className="menu-tab">{steps[0]!.label}</div>
        ) : (
          <div className="menu-steps">
            {steps.map((t, i) => (
              <span key={i} className={`menu-step ${t.done ? "done" : ""} ${t.current ? "cur" : ""}`}>
                {!t.submit && <span className="mark">{t.done ? "✓" : ""}</span>}
                {t.label}
              </span>
            ))}
          </div>
        )
      ) : (
        (menu.review || (menu.tabs?.[0] && !menu.tabs[0].submit)) && <div className="menu-tab">{menu.review ? "Review your answers" : menu.tabs![0]!.label}</div>
      )}
      {lines.length > 0 && (
        <div className="menu-question">
          {(menu.review ? lines.filter((l) => !/^Review your answers$/i.test(l)) : lines).map((l, i) => (
            <div key={i} className={menu.review && /^●/.test(l) ? "review-q" : menu.review && /^→/.test(l) ? "review-a" : menu.code?.includes(l) || /^\$ |^[a-z0-9_./-]+ .*[|&;]|^(npm|git|rm|ls|cd|bun|node|python3?|make|cargo|go) /i.test(l) ? "cmd" : ""}>
              {l}
            </div>
          ))}
        </div>
      )}
      <div className={`menu-body ${menu.options.some((o) => o.preview) ? "with-preview" : ""}`}>
      <div className="menu-options">
        {answers.map((o) =>
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
              {o.checked !== undefined && <span className={`menu-check ${o.checked ? "on" : ""}`}>{o.checked ? "✓" : ""}</span>}
              <span className="menu-label">
                <span>
                  {o.label}
                  {o.current && <span className="menu-current">current</span>}
                </span>
                {o.description && <span className="menu-desc">{o.description}</span>}
              </span>
              {o.freeText && <span className="menu-type">type…</span>}
            </button>
          ),
        )}
      </div>
      {menu.options.some((o) => o.preview) && (
        <pre className="menu-preview">{menu.options[hi]?.preview ?? "(no preview for this option)"}</pre>
      )}
      </div>
      {(menu.setting || menu.extraKeys?.length) && (
        <div className="menu-extras">
          {menu.setting && (
            <div className="menu-setting">
              <span className="ms-label">{menu.setting.label[0]!.toUpperCase() + menu.setting.label.slice(1)}</span>
              {menu.setting.levels ? (
                <span className="seg">
                  {menu.setting.levels.map((l) => (
                    <button key={l} className={l.toLowerCase() === setting?.toLowerCase() ? "on" : ""} onClick={() => setSetting(l)} disabled={busy}>
                      {l}
                    </button>
                  ))}
                </span>
              ) : (
                <span className="ms-value">{menu.setting.value}</span>
              )}
            </div>
          )}
          {menu.setting?.note && setting === menu.setting.value && <div className="menu-desc">{menu.setting.note}</div>}
          {menu.extraKeys?.length ? (
            <div className="menu-setting">
              <span className="ms-label">Apply</span>
              <span className="seg">
                <button className={!via ? "on" : ""} onClick={() => setVia(undefined)} disabled={busy} title="Enter">
                  {(menu.hint?.match(/Enter to ([^·]+)/i)?.[1] ?? "as chosen").trim()}
                </button>
                {menu.extraKeys.map((k) => (
                  <button key={k.key} className={via === k.key ? "on" : ""} onClick={() => setVia(k.key)} disabled={busy} title={`the "${k.key}" key`}>
                    {k.label}
                  </button>
                ))}
              </span>
            </div>
          ) : null}
        </div>
      )}
      {actions.length > 0 && (
        <div className="menu-actions">
          {actions.map((o) => (
            <button key={o.index} className={`btn ${o.action === "primary" ? "primary" : ""} ${o.index === hi ? "hi" : ""}`} disabled={busy} onClick={() => choose(o)} onMouseEnter={() => setHi(o.index)}>
              {o.label === "Next" ? "Next →" : o.label}
            </button>
          ))}
        </div>
      )}
      <div className="menu-foot">
        <span>
          {menu.review
            ? "Check your answers, then submit"
            : menu.multiSelect
              ? `Click options to tick them, then ${actions[0]?.label === "Next" ? "Next" : "Submit"}`
              : "Click, or press 1–9 · ↑/↓ and Enter"}
        </span>
        <span className="spacer" />
        {error && <span className="menu-err">{error}</span>}
        {!actions.some((o) => /^cancel$/i.test(o.label)) && (
          <button className="c-more" onClick={cancel} title="Esc">
            Cancel (Esc)
          </button>
        )}
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

const URL_RE = /(https?:\/\/[^\s)>\]]+)/g;

/** A notice or panel the agent shows instead of its input box, with the keys it asks for. */
function OverlayCard({ pane, overlay, onTerminal }: { pane: string; overlay: AgentOverlay; onTerminal: () => void }) {
  const [busy, setBusy] = useState(false);
  const press = (key: string) => {
    setBusy(true);
    api("POST", "/keys", { pane, keys: [key] })
      .catch(failed("Could not send the key"))
      .finally(() => setBusy(false));
  };
  // gemini asking for an API key: it was started in a terminal opened before the gateway settings existed
  if (overlay.lines.some((l) => /Enter Gemini API Key/i.test(l)))
    return (
      <div className="menu-card overlay-card">
        <div className="menu-tab">Gemini started without its gateway settings</div>
        <div className="overlay-text">
          <div>This Gemini is asking for an API key because the terminal it runs in was opened before the gateway was set up, so ~/.gemini/gateway.env (the key and the gateway address) was never loaded there.</div>
          <div>&nbsp;</div>
          <div>Restart it here with the settings loaded (same arguments), or start Gemini in a new tab.</div>
        </div>
        <div className="menu-foot">
          <button
            className="btn primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              api("POST", "/pane/gemini-relaunch", { pane })
                .catch(failed("Could not restart Gemini"))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Restarting…" : "Restart Gemini with the gateway"}
          </button>
          <button className="c-more" onClick={onTerminal}>
            show terminal
          </button>
        </div>
      </div>
    );
  return (
    <div className="menu-card overlay-card">
      <div className="menu-tab">The agent is showing this in its terminal</div>
      <div className="overlay-text">
        {overlay.lines.map((l, i) => (
          <div key={i}>
            {l
              ? l.split(URL_RE).map((part, k) =>
                  URL_RE.test(part) ? (
                    <a key={k} href={part} target="_blank" rel="noopener noreferrer">
                      {part}
                    </a>
                  ) : (
                    <span key={k}>{part}</span>
                  ),
                )
              : "\u00a0"}
          </div>
        ))}
      </div>
      <div className="menu-foot">
        {overlay.enter && (
          <button className="btn primary" disabled={busy} onClick={() => press("enter")}>
            Continue (Enter)
          </button>
        )}
        {overlay.esc && (
          <button className="btn" disabled={busy} onClick={() => press("esc")}>
            Esc
          </button>
        )}
        <button className="c-more" onClick={onTerminal}>
          show terminal
        </button>
        <span className="spacer" />
        {overlay.hint && <span>{overlay.hint}</span>}
      </div>
    </div>
  );
}
