// Per-WebSocket chat sessions: the UI asks to render a pane; this finds its transcript, sends everything
// parsed so far, then polls the file and sends what gets appended. If no transcript can be found yet (a
// fresh agent writes its file only after the first turn), it keeps retrying.

import type { ClientPush, HPane, ServerPush } from "@af/core";
import { TranscriptFinder, TranscriptTail } from "./index.ts";

interface Opts {
  finder: TranscriptFinder;
  send: (m: ServerPush) => void;
  panes: () => HPane[];
  knownSession: (paneId: string) => string | undefined;
  argv: (paneId: string) => Promise<string[][]>;
  pollMs?: number;
  retryMs?: number;
}

interface Open {
  paneId: string;
  tail?: TranscriptTail;
  timer: ReturnType<typeof setInterval>;
  lastResolve: number;
  closed: boolean;
}

export class ChatBridge {
  private open = new Map<string, Open>();

  constructor(private opts: Opts) {}

  handle(msg: Extract<ClientPush, { type: "chat.open" | "chat.close" }>) {
    if (msg.type === "chat.close") return this.close(msg.id);
    this.close(msg.id);
    const o: Open = { paneId: msg.paneId, lastResolve: 0, closed: false, timer: setInterval(() => void this.tick(msg.id), this.opts.pollMs ?? 500) };
    this.open.set(msg.id, o);
    void this.tick(msg.id);
  }

  private async resolve(id: string, o: Open) {
    o.lastResolve = Date.now();
    const panes = this.opts.panes();
    const pane = panes.find((p) => p.id === o.paneId);
    if (!pane) return this.opts.send({ type: "chat.reset", id, source: null, reason: "pane is gone", ops: [] });
    const r = await this.opts.finder.resolve({ pane, panes, knownSession: this.opts.knownSession(o.paneId), argv: () => this.opts.argv(o.paneId) });
    if (o.closed) return;
    if ("reason" in r) {
      if (!o.tail) this.opts.send({ type: "chat.reset", id, source: null, reason: r.reason, ops: [] });
      return;
    }
    if (o.tail && o.tail.source.path === r.source.path) return;
    o.tail = new TranscriptTail(r.source);
    const { ops } = o.tail.read();
    this.opts.send({ type: "chat.reset", id, source: r.source, ops });
  }

  private async tick(id: string) {
    const o = this.open.get(id);
    if (!o || o.closed) return;
    try {
      // re-resolve now and then: the agent may start a new session (/clear, /new) or write its first file
      if (!o.tail || Date.now() - o.lastResolve > (this.opts.retryMs ?? 3000)) await this.resolve(id, o);
      if (!o.tail || o.closed) return;
      const { ops, reset } = o.tail.read();
      if (reset) this.opts.send({ type: "chat.reset", id, source: o.tail.source, ops });
      else if (ops.length) this.opts.send({ type: "chat.ops", id, ops });
    } catch (e) {
      console.error("chat:", (e as Error).message);
    }
  }

  close(id: string) {
    const o = this.open.get(id);
    if (!o) return;
    o.closed = true;
    clearInterval(o.timer);
    this.open.delete(id);
  }

  closeAll() {
    for (const id of [...this.open.keys()]) this.close(id);
  }
}
