// Per-WebSocket chat sessions: the UI asks to render a pane; this finds its transcript (on this machine or
// over SSH), sends everything parsed so far, then polls the file and sends what gets appended. If no
// transcript can be found yet (a fresh agent writes its file only after the first turn), it keeps retrying.

import type { ClientPush, HPane, ServerPush } from "@af/core";
import { type TranscriptFS, TranscriptTail, WINDOW_RAW, WINDOW_RAW_REMOTE, resolveTranscript } from "./index.ts";

interface Opts {
  /** File access for the machine a pane is on. */
  fsFor: (paneId: string) => { fs: TranscriptFS; remote: boolean };
  send: (m: ServerPush) => void;
  panes: () => HPane[];
  knownSession: (paneId: string) => { id?: string; path?: string } | undefined;
  argv: (paneId: string) => Promise<string[][]>;
  pids?: (paneId: string) => Promise<number[]>;
  screen: (paneId: string) => Promise<string>;
}

interface Open {
  paneId: string;
  tail?: TranscriptTail;
  timer?: ReturnType<typeof setTimeout>;
  lastResolve: number;
  closed: boolean;
  /** Locked to a conversation not written yet (agent:path): checked often until it is. */
  pending?: string;
  loadingEarlier?: boolean;
}

export class ChatBridge {
  private open = new Map<string, Open>();

  constructor(private opts: Opts) {}

  handle(msg: Extract<ClientPush, { type: "chat.open" | "chat.close" | "chat.more" }>) {
    if (msg.type === "chat.close") return this.close(msg.id);
    if (msg.type === "chat.more") return void this.more(msg.id);
    this.close(msg.id);
    const o: Open = { paneId: msg.paneId, lastResolve: 0, closed: false };
    this.open.set(msg.id, o);
    void this.loop(msg.id, o);
  }

  private async resolve(id: string, o: Open, fs: TranscriptFS) {
    o.lastResolve = Date.now();
    const panes = this.opts.panes();
    const pane = panes.find((p) => p.id === o.paneId);
    if (!pane) return this.opts.send({ type: "chat.reset", id, source: null, reason: "pane is gone", ops: [] });
    const known = this.opts.knownSession(o.paneId);
    const r = await resolveTranscript(fs, {
      pane,
      panes,
      knownSession: known?.id,
      knownPath: known?.path,
      argv: () => this.opts.argv(o.paneId).catch(() => []),
      pids: this.opts.pids ? () => this.opts.pids!(o.paneId).catch(() => []) : undefined,
      screen: () => this.opts.screen(o.paneId),
    });
    if (o.closed) return;
    if ("reason" in r) {
      if (!o.tail) this.opts.send({ type: "chat.reset", id, source: null, reason: r.reason, ops: [] });
      return;
    }
    if (r.source.pending) {
      // locked, nothing written yet: an empty conversation now; re-resolving soon swaps the real one in
      const key = `${r.source.agent}:${r.source.path}`;
      if (o.pending === key && !o.tail) return;
      o.pending = key;
      o.tail = undefined;
      return this.opts.send({ type: "chat.reset", id, source: r.source, ops: [] });
    }
    o.pending = undefined;
    if (o.tail && o.tail.source.path === r.source.path) return;
    o.tail = new TranscriptTail(r.source, fs, undefined, this.opts.fsFor(o.paneId).remote ? WINDOW_RAW_REMOTE : WINDOW_RAW);
    const { ops } = await o.tail.read();
    if (!o.closed) this.opts.send({ type: "chat.reset", id, source: r.source, ops, more: o.tail.more });
  }

  /** Earlier conversation, one window at a time. Serialized with the loop's reads through `busy`. */
  private async more(id: string) {
    const o = this.open.get(id);
    if (!o?.tail || o.loadingEarlier) return;
    o.loadingEarlier = true;
    const tail = o.tail;
    try {
      const { ops, more } = await tail.readEarlier();
      if (!o.closed && o.tail === tail) this.opts.send({ type: "chat.prepend", id, ops, more });
    } catch {
      if (!o.closed) this.opts.send({ type: "chat.prepend", id, ops: [], more: tail.more });
    } finally {
      o.loadingEarlier = false;
    }
  }

  /** Poll sequentially (never two reads of one file at once): 0.5s locally, 1.5s over SSH. */
  private async loop(id: string, o: Open) {
    while (!o.closed) {
      let remote = false;
      try {
        const where = this.opts.fsFor(o.paneId);
        remote = where.remote;
        // re-resolve now and then: the agent may start a new session (/clear, /new) or write its first file
        // (cheap when the session is known; screen matching reads candidate files, so it runs less often)
        // codex is asked with lsof (a process, ~50 ms): less often than claude's registry file or omp's path
        const codex = (o.tail?.source.agent ?? o.pending?.split(":")[0]) === "codex";
        const every = o.pending ? (remote ? 2000 : codex ? 1500 : 700) : o.tail && o.tail.source.how !== "session" ? 20_000 : remote ? 10_000 : codex ? 10_000 : 3_000;
        if (Date.now() - o.lastResolve > every) await this.resolve(id, o, where.fs);
        if (o.tail && !o.closed) {
          const { ops, reset } = await o.tail.read();
          if (o.closed) break;
          if (reset) this.opts.send({ type: "chat.reset", id, source: o.tail.source, ops, more: o.tail.more });
          else if (ops.length) this.opts.send({ type: "chat.ops", id, ops });
        }
      } catch (e) {
        if (!o.tail && !o.closed) this.opts.send({ type: "chat.reset", id, source: null, reason: (e as Error).message, ops: [] });
      }
      await new Promise((r) => (o.timer = setTimeout(r, remote ? 1500 : 500)));
    }
  }

  close(id: string) {
    const o = this.open.get(id);
    if (!o) return;
    o.closed = true;
    clearTimeout(o.timer);
    this.open.delete(id);
  }

  closeAll() {
    for (const id of [...this.open.keys()]) this.close(id);
  }
}
