// Channels: the ways two agents send each other messages, shown in the right panel's Channels tab.
//   parent  a session and one it handed work to (af task, a team's tickets): results and questions go up into its
//           queue, more work (af tell) goes down. Disconnecting makes the child an independent session (Teams.detach).
//   peer    two agents the user connected. Each is told once that the other is there and by which name; either
//           sends with `af send <name> "<text>"`. A message waits in agent-flow's queue for the end of the receiver's
//           turn (Workspaces.send, mode queue), so nothing is typed into a busy agent. Deleting the channel drops what
//           waits on it.
// The user can send a single message on any channel, and delete one that waits.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Channel, ChannelEnd, HPane } from "@af/core";
import { currentTicket, pendingMessages, ticketStage, ticketList } from "@af/core";
import { AfError } from "./errors.ts";
import type { Teams } from "./teams.ts";
import type { Workspaces } from "./workspaces.ts";

interface Peer {
  id: string;
  a: string;
  b: string;
  /** The name each end sends to the other by (af send <name>). */
  aName: string;
  bName: string;
  createdAt: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9一-鿿_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "agent";

export class Channels {
  private peers: Peer[] = [];
  private file: string;

  constructor(
    private w: Workspaces,
    private teams: Teams,
    home: string,
  ) {
    this.file = join(home, "channels.json");
    try {
      if (existsSync(this.file)) this.peers = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {}
  }

  private save() {
    writeFileSync(this.file, JSON.stringify(this.peers, null, 2));
  }

  private paneOf(id: string) {
    return this.w.model.panes.find((p) => p.id === this.w.canonId(id));
  }

  private end(pane: string, name: string): ChannelEnd {
    const p = this.paneOf(pane);
    const ws = p && this.w.model.workspaces.find((x) => x.id === p.workspaceId);
    return { pane, name, agent: p?.agent, workspace: ws?.label, ...(!p?.agent ? { gone: true } : {}) };
  }

  /** A name for the agent in a pane: its team member name, Herdr's name, or its kind and workspace. */
  private nameOf(p: HPane | undefined, pane: string) {
    for (const t of this.teams.allTeams()) {
      const m = Object.values(t.state.members).find((x) => x.paneId === pane && !x.detached && x.status !== "exited");
      if (m) return m.name;
    }
    if (p?.agentName) return slug(p.agentName);
    const ws = p && this.w.model.workspaces.find((x) => x.id === p.workspaceId);
    return slug(`${p?.agent ?? "agent"}-${ws?.label ?? pane}`);
  }

  /** Every channel with what waits on it: the parent channels of all teams, and the peer channels. */
  list(workspace?: string): Channel[] {
    const out: Channel[] = [];
    const queue = this.w.queue;
    for (const { id, state: s, manager } of this.teams.allTeams()) {
      if (!manager || s.stopped) continue;
      const managerName = s.meta!.mode === "router" ? "router" : this.nameOf(this.paneOf(manager), manager);
      for (const m of Object.values(s.members)) {
        if (m.detached || m.team || !m.paneId || m.name === s.meta!.manager.member) continue;
        if (m.status === "exited" && !pendingMessages(s, m.name).length) continue;
        const k = currentTicket(s, m.name) ?? ticketList(s).filter((x) => x.assignee === m.name).at(-1);
        out.push({
          id: `parent:${id}:${m.name}`,
          kind: "parent",
          a: this.end(manager, managerName),
          b: this.end(m.paneId, m.name),
          toA: s.queue.filter((q) => q.from === m.name && q.state !== "handled").map((q) => ({ ref: `q${q.seq}`, text: q.text, at: q.at, from: m.name })),
          toB: pendingMessages(s, m.name).map((o) => ({ ref: o.id, text: o.text, at: o.at, from: managerName })),
          ...(k ? { ticket: { id: k.id, title: k.title, stage: ticketStage(k, m, this.paneOf(m.paneId) ? { status: this.paneOf(m.paneId)!.agentStatus, asking: this.paneOf(m.paneId)!.asking } : undefined) } } : {}),
        });
      }
    }
    for (const c of this.peers) {
      const waiting = (pane: string) => (queue[this.w.canonId(pane)] ?? []).filter((q) => q.channel === c.id).map((q) => ({ ref: q.id, text: q.body, at: q.at, from: q.from }));
      out.push({ id: c.id, kind: "peer", a: this.end(c.a, c.aName), b: this.end(c.b, c.bName), toA: waiting(c.a), toB: waiting(c.b), createdAt: c.createdAt });
    }
    if (!workspace) return out;
    const wsOf = (pane: string) => this.paneOf(pane)?.workspaceId;
    return out.filter((c) => wsOf(c.a.pane) === workspace || wsOf(c.b.pane) === workspace);
  }

  /** Connect two agents. Each is told the other is there, by which name, and how to send to it. */
  async connect(a: string, b: string) {
    a = this.w.canonId(a);
    b = this.w.canonId(b);
    if (a === b) throw new AfError("same", "an agent cannot be connected to itself");
    const pa = this.paneOf(a);
    const pb = this.paneOf(b);
    if (!pa?.agent || !pb?.agent) throw new AfError("no_agent", "both ends must be panes with an agent in them", 404);
    if (this.peers.some((c) => (c.a === a && c.b === b) || (c.a === b && c.b === a))) throw new AfError("exists", "these two are connected already", 409);
    let aName = this.nameOf(pa, a);
    let bName = this.nameOf(pb, b);
    if (aName === bName) (aName = `${aName}-1`), (bName = `${bName}-2`);
    const c: Peer = { id: `peer:${crypto.randomUUID().slice(0, 8)}`, a, b, aName, bName, createdAt: new Date().toISOString() };
    this.peers.push(c);
    this.save();
    const af = (pane: string) => this.teams.afPathOn(this.paneOf(pane)?.machine);
    const intro = (other: string, otherPane: string, me: string) =>
      `[agent-flow] The user connected you with another agent: ${other} (${this.paneOf(otherPane)?.agent} in ${this.end(otherPane, other).workspace ?? otherPane}). To send it a message: ${af(me)} send ${other} "<text>" (one shell command; it gets it when its turn ends). Its messages come to you the same way, marked with its name. Send only what it needs from you; you do not have to answer this.`;
    await this.w.send(a, intro(bName, b, a), [], "queue").catch(() => {});
    await this.w.send(b, intro(aName, a, b), [], "queue").catch(() => {});
    return c;
  }

  /** Delete a peer channel: what waits on it is dropped; both ends are told it is gone. */
  async disconnect(id: string) {
    const c = this.peers.find((x) => x.id === id);
    if (!c) throw new AfError("unknown_channel", `no channel ${id}`, 404);
    this.peers = this.peers.filter((x) => x !== c);
    this.save();
    let dropped = 0;
    for (const pane of [c.a, c.b])
      for (const q of (this.w.queue[pane] ?? []).filter((x) => x.channel === id)) {
        this.w.unqueue(pane, q.id);
        dropped++;
      }
    const bye = (other: string) => `[agent-flow] The user disconnected you from ${other}: af send ${other} does not work any more.`;
    await this.w.send(c.a, bye(c.bName), [], "queue").catch(() => {});
    await this.w.send(c.b, bye(c.aName), [], "queue").catch(() => {});
    return { dropped };
  }

  /** A message along a channel. from: a pane (af send) or the user; to: the end that is not `from`, or `to`. */
  async send(id: string, text: string, opts: { from?: string; to?: string }) {
    if (!text.trim()) throw new AfError("empty", "nothing to send");
    const c = this.peers.find((x) => x.id === id);
    if (!c) throw new AfError("unknown_channel", `no channel ${id}`, 404);
    const from = opts.from ? this.w.canonId(opts.from) : undefined;
    const to = opts.to ? this.w.canonId(opts.to) : from === c.a ? c.b : from === c.b ? c.a : undefined;
    if (!to || (to !== c.a && to !== c.b)) throw new AfError("bad_end", "say which end it goes to", 400);
    const sender = from === c.a ? c.aName : from === c.b ? c.bName : "the user";
    const body = `[agent-flow] Message from ${sender}${from ? ` (reply: af send ${sender} "<text>")` : ""}:\n${text.trim()}`;
    const r = await this.w.send(to, body, [], "queue");
    const item = "queued" in r ? r.queued : undefined;
    if (item) this.w.tagQueued(to, item.id, { channel: id, from: sender });
    return { to: to === c.a ? c.aName : c.bName, queued: !!item };
  }

  /** af send <name> "<text>" from the agent in `pane`: along the peer channel where the other end is called <name>. */
  async sendByName(pane: string, name: string, text: string) {
    pane = this.w.canonId(pane);
    const c = this.peers.find((x) => (x.a === pane && x.bName === name) || (x.b === pane && x.aName === name));
    if (!c) {
      const mine = this.peers.filter((x) => x.a === pane || x.b === pane).map((x) => (x.a === pane ? x.bName : x.aName));
      throw new AfError("no_channel", mine.length ? `you are not connected with ${name}; you are with: ${mine.join(", ")}` : `you are not connected with ${name} (the user connects agents in agent-flow's Channels tab)`, 404);
    }
    return this.send(c.id, text, { from: pane });
  }

  /** Delete a message waiting on a peer channel (a queued message of the receiver). */
  drop(id: string, ref: string) {
    const c = this.peers.find((x) => x.id === id);
    if (!c) throw new AfError("unknown_channel", `no channel ${id}`, 404);
    for (const pane of [c.a, c.b])
      if ((this.w.queue[pane] ?? []).some((q) => q.id === ref && q.channel === id)) {
        this.w.unqueue(pane, ref);
        return { ok: true };
      }
    throw new AfError("gone", "that message is not waiting any more", 404);
  }

  /** Machine `from` turned out to be another route to machine `to`: the channels keep their panes under `to`. */
  remap(from: string, to: string) {
    const pre = `${from}~`;
    const move = (id: string) => (id.startsWith(pre) ? `${to}~${id.slice(pre.length)}` : id);
    let n = 0;
    for (const c of this.peers)
      if (c.a.startsWith(pre) || c.b.startsWith(pre)) {
        c.a = move(c.a);
        c.b = move(c.b);
        n++;
      }
    if (n) this.save();
  }
}
