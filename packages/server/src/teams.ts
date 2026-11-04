// Teams (docs/design.md section 4): a manager hands out tickets to members, agent-flow watches the members and
// puts what the manager must know in its queue, and types a one-line notice into the manager when it is free.
//
//   mode 1 (direct)  the manager is a session the user talks to; it calls `af task`. Members are plain sessions:
//                    when one finishes a turn, its last reply becomes the ticket's result.md.
//   mode 2 (router)  the manager is a router agent in its own workspace; it calls `af ticket open`. Members are
//                    started with the member protocol and submit with `af submit`.
//
// Every change is an event in teams/<id>/events.jsonl (packages/core/src/team.ts replays them), written before the
// side effect it stands for is done, so a restart neither loses nor repeats work.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  type AgentKind,
  type AgentStatus,
  type Attention,
  type CloseOutcome,
  type HPane,
  type Member,
  type NewTeamRequest,
  type OpenTicketRequest,
  type Outgoing,
  type QueueItem,
  type QueueKind,
  type SubmitRequest,
  type TaskRequest,
  type TeamEvent,
  type TeamMeta,
  type TeamState,
  type TeamSummary,
  type Ticket,
  AGENT_KINDS,
  NAME,
  applyTeam,
  byPriority,
  currentTicket,
  emptyTeam,
  herdrMemberName,
  isApproval,
  lastTurnMark,
  memberBranch,
  nextTicketId,
  pendingMessages,
  queued,
  replayTeam,
  roundsIn,
  takenUnhandled,
  threadMax,
  ticketList,
  ticketStage,
  waitingTickets,
} from "@af/core";
import * as git from "./git.ts";
import { AfError } from "./errors.ts";
import type { TerminalBackend } from "./herdr.ts";
import type { Workspaces } from "./workspaces.ts";
import { type AgentConfig, type Role, launchArgs, plainArgs } from "./agents.ts";
import type { PlaybookLibrary } from "./playbooks.ts";
import { type Peek, TRANSIENT } from "./transcripts/peek.ts";

export interface TeamsOptions {
  /** Root for all state, normally ~/.agent-flow */
  home: string;
  /** The local Herdr (teams live on this machine). */
  backend: TerminalBackend;
  w: Workspaces;
  /** Unix socket the af CLI uses; passed to agents as AF_SOCK. */
  sock: string;
  /** Directory holding the `af` executable; prepended to agents' PATH. */
  binDir: string;
  /** Directory with router.md and member.md. */
  protocolDir: string;
  config: AgentConfig;
  playbooks?: PlaybookLibrary;
  /** The end of a pane's conversation (packages/server/src/transcripts/peek.ts). Tests replace it. */
  peek?: (pane: string) => Promise<Peek | undefined>;
  now?: () => string;
  clock?: () => number;
  /** A finished turn counts after the agent has stayed free this long (statuses flicker). */
  settleMs?: number;
  /** A mode-2 member that finished a turn without af submit: reported after this long. */
  noSubmitMs?: number;
  /** A member working this long without its conversation growing may be stuck. */
  stuckMs?: number;
  /** A notice the manager did not act on is typed again after this long. */
  renotifyMs?: number;
}

/** Who is calling, once known: a member or router of a team, a session by its pane (mode 1), or the user. */
export type Who = { kind: "member" | "router"; team: string; member: string; pane?: string } | { kind: "pane"; pane: string } | { kind: "user" };

interface Team {
  id: string;
  dir: string;
  state: TeamState;
  /** Members whose agent is being started. */
  starting: Set<string>;
  /** member -> conversation size and since when it has not changed (ms), while working. */
  sizes: Map<string, { size?: number; since: number; at: number; reported?: number }>;
  /** member -> the question on its screen that is already in the queue. */
  asked: Map<string, string>;
  /** The last notice typed into the manager. */
  notice?: { at: number; times: number; key: string };
  /** Taken queue items the router was reminded of. */
  reminded: Set<number>;
  /** member -> times in a row its pane showed no agent. */
  gone: Map<string, number>;
  /** member -> the turn (status change, ms) already looked at. */
  looked: Map<string, number>;
  /** Members a message was just typed into: no second one until it has started on it. */
  typing: Map<string, number>;
}

const USER = "user";
const SNAPSHOT_EVERY = 500;

export class Teams {
  private teams = new Map<string, Team>();
  private listeners = new Set<(team: string, ev: TeamEvent) => void>();
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private pending = new Set<Promise<unknown>>();
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private now: () => string;
  private clock: () => number;

  constructor(readonly opts: TeamsOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.clock = opts.clock ?? (() => Date.now());
    mkdirSync(join(opts.home, "teams"), { recursive: true });
  }

  // -------------------------------------------------------------------------------------------
  // lifecycle

  /** Rebuild every team from its events.jsonl. */
  load() {
    const root = join(this.opts.home, "teams");
    for (const id of readdirSync(root)) {
      const file = join(root, id, "events.jsonl");
      if (!existsSync(file)) continue;
      const events = readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as TeamEvent);
      this.teams.set(id, this.blank(id, replayTeam(events)));
    }
    return this.teams.size;
  }

  start(pollMs = 1000) {
    this.timer = setInterval(() => void this.tick(), pollMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  subscribe(fn: (team: string, ev: TeamEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private blank(id: string, state: TeamState): Team {
    return { id, dir: join(this.opts.home, "teams", id), state, starting: new Set(), sizes: new Map(), asked: new Map(), reminded: new Set(), gone: new Map(), looked: new Map(), typing: new Map() };
  }

  private emit(t: Team, ev: TeamEvent) {
    const full = { ...ev, seq: t.state.seq + 1 } as TeamEvent;
    appendFileSync(join(t.dir, "events.jsonl"), JSON.stringify(full) + "\n");
    applyTeam(t.state, full);
    for (const l of this.listeners) l(t.id, full);
    if (!this.snapshotTimers.has(t.id))
      this.snapshotTimers.set(
        t.id,
        setTimeout(() => {
          this.snapshotTimers.delete(t.id);
          try {
            writeFileSync(join(t.dir, "team.json"), JSON.stringify(t.state, null, 2));
          } catch {}
        }, SNAPSHOT_EVERY),
      );
  }

  // -------------------------------------------------------------------------------------------
  // queries

  list(): TeamSummary[] {
    const panes = new Map(this.opts.w.model.panes.map((p) => [p.id, p]));
    return [...this.teams.values()]
      .filter((t) => t.state.meta)
      .map((t) => {
        const s = t.state;
        const m = s.meta!;
        const stages: TeamSummary["stages"] = {};
        for (const k of ticketList(s)) {
          const mem = s.members[k.assignee];
          const st = ticketStage(k, mem, mem?.paneId ? lookOf(panes.get(mem.paneId)) : undefined);
          stages[st] = (stages[st] ?? 0) + 1;
        }
        return {
          id: t.id,
          name: m.name,
          mode: m.mode,
          cwd: m.cwd,
          createdAt: m.createdAt,
          stopped: s.stopped,
          workspace: m.workspace,
          managerPane: this.managerPane(t),
          parent: m.parent,
          goal: m.goal,
          playbook: m.playbook,
          needs: Object.values(s.attention).map((a) => ({ ...a, paneId: a.member ? s.members[a.member]?.paneId : undefined })),
          queued: queued(s).length,
          tickets: s.order.length,
          memberPanes: Object.values(s.members)
            .filter((x) => x.paneId && x.protocol !== "router" && !x.team)
            .map((x) => x.paneId!),
          stages,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string | undefined): TeamState {
    return this.require(id).state;
  }

  private require(id: string | undefined): Team {
    if (!id) throw new AfError("no_team", "no team given");
    const t = this.teams.get(id);
    if (!t) throw new AfError("unknown_team", `no team ${id}`, 404);
    return t;
  }

  private active(id: string | undefined) {
    const t = this.require(id);
    if (t.state.stopped) throw new AfError("team_stopped", `team ${t.id} is stopped`);
    return t;
  }

  private managerPane(t: Team) {
    const m = t.state.meta!;
    return m.manager.pane ?? (m.manager.member ? t.state.members[m.manager.member]?.paneId : undefined);
  }

  /** Who a CLI or UI call comes from. */
  who(c: { team?: string; agent?: string; pane?: string }): Who {
    if (c.team && c.agent) {
      const t = this.teams.get(c.team);
      const m = t?.state.members[c.agent];
      if (t && m) return { kind: m.protocol === "router" ? "router" : "member", team: t.id, member: m.name, pane: m.paneId };
    }
    if (c.pane) {
      // a router or protocol member is known by its pane too (a shell it opened has no AF_* env)
      for (const t of this.teams.values()) {
        if (t.state.stopped) continue;
        for (const m of Object.values(t.state.members))
          if (m.paneId === c.pane && m.status !== "exited" && (m.protocol === "router" || m.protocol === "member") && !m.team)
            return { kind: m.protocol === "router" ? "router" : "member", team: t.id, member: m.name, pane: c.pane };
      }
      return { kind: "pane", pane: c.pane };
    }
    return { kind: "user" };
  }

  /** The direct team a session leads (mode 1), if it has one. */
  directTeamOf(pane: string): Team | undefined {
    for (const t of this.teams.values()) if (!t.state.stopped && t.state.meta?.mode === "direct" && t.state.meta.manager.pane === pane) return t;
    return undefined;
  }

  /** The team whose queue a caller reads: its direct team, or the team it routes. */
  private managed(who: Who): Team {
    if (who.kind === "router") return this.active(who.team);
    if (who.kind === "pane") {
      const t = this.directTeamOf(who.pane);
      if (!t) throw new AfError("no_team", "this session has not handed out any work yet (af task <kind> \"<task>\")", 404);
      return t;
    }
    if (who.kind === "member") throw new AfError("forbidden", "members do not have a queue; submit with af submit, ask with af ask", 403);
    throw new AfError("no_team", "run this inside the session that hands out the work (it is known by its Herdr pane)");
  }

  /** Session id agent-flow started the agent in `pane` with, if any (claude --session-id). */
  sessionForPane(pane: string): string | undefined {
    for (const t of this.teams.values()) for (const m of Object.values(t.state.members)) if (m.paneId === pane && m.status !== "exited" && m.session && !m.team) return m.session;
    return undefined;
  }

  /** Workspace id -> team id (active first), for the sidebar's ◆ and the right panel. */
  workspaceTeams(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of [...this.teams.values()].sort((a, b) => (a.state.meta?.createdAt ?? "").localeCompare(b.state.meta?.createdAt ?? ""))) {
      const ws = t.state.meta?.workspace;
      if (ws && (!out[ws] || !t.state.stopped)) out[ws] = t.id;
    }
    return out;
  }

  /** Member name -> pane id in a team, for `af read <member>`. */
  memberPanes(team: string | undefined): Record<string, string | undefined> {
    const t = team ? this.teams.get(team) : undefined;
    return t ? Object.fromEntries(Object.values(t.state.members).filter((m) => m.status !== "exited" && !m.team).map((m) => [m.name, m.paneId])) : {};
  }

  /** Folders a team's members work in (the UI may preview files there). */
  folders(): string[] {
    return [...this.teams.values()].flatMap((t) => [t.state.meta?.cwd, t.state.meta?.repo, ...Object.values(t.state.members).map((m) => m.cwd)].filter((x): x is string => !!x));
  }

  // -------------------------------------------------------------------------------------------
  // creating teams and members

  private newId() {
    for (;;) {
      const id = "t" + Math.random().toString(36).slice(2, 6);
      if (!this.teams.has(id) && !existsSync(join(this.opts.home, "teams", id))) return id;
    }
  }

  private create(meta: Omit<TeamMeta, "id" | "createdAt" | "dir">, id = this.newId()): Team {
    const t = this.blank(id, emptyTeam());
    mkdirSync(join(t.dir, "tickets"), { recursive: true });
    mkdirSync(join(t.dir, "out"), { recursive: true });
    mkdirSync(join(t.dir, "protocol"), { recursive: true });
    for (const f of ["router.md", "member.md"]) {
      const src = join(this.opts.protocolDir, f);
      if (existsSync(src)) writeFileSync(join(t.dir, "protocol", f), readFileSync(src, "utf8"));
    }
    const repo = git.repoRoot(meta.cwd);
    this.teams.set(id, t);
    this.emit(t, { type: "team.created", at: this.now(), meta: { ...meta, id, dir: t.dir, createdAt: this.now(), repo: repo && git.hasCommits(repo) ? repo : undefined } });
    return t;
  }

  /** The direct team led by `pane`, created on its first ticket. */
  private directTeam(pane: string): Team {
    const have = this.directTeamOf(pane);
    if (have) return have;
    const p = this.pane(pane);
    if (p.machine !== "local") throw new AfError("remote_team", "handing out work from sessions on remote machines is not supported yet");
    const ws = this.opts.w.model.workspaces.find((w) => w.id === p.workspaceId);
    const parent = this.parentOfPane(pane);
    return this.create({ name: ws?.label || p.agent || "session", mode: "direct", cwd: p.cwd, manager: { pane }, workspace: p.workspaceId, parent });
  }

  /** A session that is itself a member of another team: its own team hangs under that member's ticket. */
  private parentOfPane(pane: string): TeamMeta["parent"] {
    for (const t of this.teams.values()) {
      if (t.state.stopped) continue;
      const m = Object.values(t.state.members).find((x) => x.paneId === pane && !x.team && x.status !== "exited");
      if (!m) continue;
      const k = currentTicket(t.state, m.name) ?? ticketList(t.state).filter((x) => x.assignee === m.name).at(-1);
      if (k) return { team: t.id, ticket: k.id };
    }
    return undefined;
  }

  private pane(id: string): HPane {
    const p = this.opts.w.model.panes.find((x) => x.id === id);
    if (!p) throw new AfError("unknown_pane", `no Herdr pane ${id}`, 404);
    return p;
  }

  private env(t: Team, member?: string) {
    // members with a protocol know who they are; plain sessions are known by their pane, like any session
    return {
      ...(member ? { AF_TEAM: t.id, AF_AGENT: member } : {}),
      AF_SOCK: this.opts.sock,
      AF_OUT: join(t.dir, "out"),
      PATH: `${this.opts.binDir}:${process.env.PATH ?? ""}`,
    };
  }

  private uniqueName(t: Team, base: string) {
    const b = (base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "") || "member").slice(0, 28);
    if (!t.state.members[b]) return b;
    for (let i = 2; ; i++) if (!t.state.members[`${b}-${i}`]) return `${b}-${i}`;
  }

  /** Add a member and start its agent in a new tab of the team's workspace (or in a given pane). */
  private async spawn(t: Team, a: { name: string; kind: AgentKind; protocol: Member["protocol"]; role?: string; worktree?: boolean; pane?: { paneId: string; tabId: string } }) {
    if (!NAME.test(a.name)) throw new AfError("bad_name", `a member name must match ${NAME}`);
    if (a.name === USER) throw new AfError("bad_name", `${a.name} is reserved`);
    if (t.state.members[a.name]) throw new AfError("duplicate_member", `${a.name} is already a member of team ${t.id}`);
    if (!AGENT_KINDS.includes(a.kind)) throw new AfError("bad_kind", `kind must be one of ${AGENT_KINDS.join(", ")}`);
    const meta = t.state.meta!;
    let cwd = meta.cwd;
    let branch: string | undefined;
    let worktree: string | undefined;
    if (a.worktree) {
      if (!meta.repo) throw new AfError("no_repo", `${meta.cwd} is not in a git repository with commits; --worktree needs one`);
      branch = memberBranch(t.id, a.name);
      worktree = join(meta.repo, ".agent-flow", "worktrees", t.id, a.name);
      git.ensureExcluded(meta.repo, ".agent-flow/");
      git.addWorktree(meta.repo, worktree, branch, git.headCommit(meta.cwd));
      cwd = worktree;
    }
    const m: Member = {
      name: a.name,
      kind: a.kind,
      protocol: a.protocol,
      role: a.role,
      cwd,
      branch,
      worktree,
      status: "starting",
      addedAt: this.now(),
      session: a.kind === "claude" ? crypto.randomUUID() : undefined,
    };
    this.emit(t, { type: "member.added", at: this.now(), member: m });
    t.starting.add(a.name);
    try {
      const env = this.env(t, a.protocol === "none" ? undefined : a.name);
      const tab = a.pane ?? (await this.opts.backend.createTab(meta.workspace, cwd, a.name, env));
      this.emit(t, { type: "member.placed", at: this.now(), name: a.name, paneId: tab.paneId, tabId: tab.tabId });
      if (m.session) this.opts.w.rememberSession(tab.paneId, m.session);
      const args = () =>
        a.protocol === "none" ? plainArgs(a.kind, this.opts.config, m.session) : launchArgs(a.kind, a.protocol as Role, join(t.dir, "protocol", `${a.protocol}.md`), this.opts.config, m.session);
      const herdr = herdrMemberName(t.id, a.name);
      // a new tab's shell takes a moment to be ready; until then Herdr says the pane is busy
      let res = await this.opts.backend.startAgent(herdr, a.kind, tab.paneId, args());
      for (let i = 0; i < 12 && !res.ok && /busy/.test(res.code); i++) {
        await Bun.sleep(500);
        res = await this.opts.backend.startAgent(herdr, a.kind, tab.paneId, args());
      }
      if (res.ok) this.setStatus(t, a.name, "idle");
      else if (res.code === "agent_not_ready") {
        // a folder-trust or login prompt: the user answers it (Needs you shows the pane); delivery waits
        this.setStatus(t, a.name, "blocked");
      } else {
        if (!a.pane) await this.opts.backend.closeTab(tab.tabId).catch(() => {});
        throw new AfError("agent_start_failed", `${a.kind} did not start (${res.code}: ${res.message})`);
      }
    } catch (e) {
      this.setStatus(t, a.name, "exited");
      throw e;
    } finally {
      t.starting.delete(a.name);
    }
    await this.opts.w.refresh().catch(() => {});
    return t.state.members[a.name]!;
  }

  private setStatus(t: Team, name: string, status: AgentStatus) {
    const m = t.state.members[name];
    if (m && m.status !== status) this.emit(t, { type: "member.status", at: this.now(), name, status });
  }

  /** Spawn without waiting (agents take seconds to start); failures close the ticket and tell the manager. */
  private spawnLater(t: Team, a: Parameters<Teams["spawn"]>[1], ticket: string) {
    const p = this.spawn(t, a)
      .catch((e) => {
        this.close(t, ticket, "failed", `could not start ${a.name}: ${(e as Error).message}`);
        this.enqueue(t, { kind: "error", ticket, from: a.name, text: `Could not start ${a.name} (${a.kind}) for ${ticket}: ${(e as Error).message}` });
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  // -------------------------------------------------------------------------------------------
  // tickets

  private ticketDir(t: Team, id: string) {
    return join(t.dir, "tickets", id);
  }

  private openTicket(t: Team, k: Omit<Ticket, "id" | "thread" | "round" | "status" | "createdAt" | "updatedAt" | "turns" | "inputs"> & { inputs?: string[]; task: string; max?: number }) {
    const s = t.state;
    const id = nextTicketId(s);
    const from = k.from ? s.tickets[k.from] : undefined;
    if (k.from && !from) throw new AfError("unknown_ticket", `no ticket ${k.from}`, 404);
    const thread = from ? from.thread : id;
    const round = roundsIn(s, thread, k.assignee) + 1;
    if (from && round > (k.max ?? threadMax(s, thread))) {
      const text = `Thread ${thread} reached its limit: ${k.assignee} has had ${round - 1} rounds (at most ${threadMax(s, thread)}).`;
      this.raise(t, { id: `limit:${thread}`, kind: "loop_limit", ticket: thread, member: k.assignee, text });
      throw new AfError("round_limit", `${text} Tell the user, or allow more rounds: af thread max ${thread} <N>`, 409);
    }
    if (from && k.max) this.emit(t, { type: "thread.max", at: this.now(), thread, max: k.max });
    const dir = this.ticketDir(t, id);
    mkdirSync(join(dir, "files"), { recursive: true });
    writeFileSync(join(dir, "task.md"), k.task.endsWith("\n") ? k.task : `${k.task}\n`);
    const inputs = [...(k.inputs ?? []), ...(from && existsSync(join(this.ticketDir(t, from.id), "result.md")) ? [join(this.ticketDir(t, from.id), "result.md")] : [])];
    const ticket: Ticket = {
      id,
      title: k.title.replace(/\s+/g, " ").trim().slice(0, 120) || id,
      assignee: k.assignee,
      from: k.from,
      thread,
      round,
      max: from ? undefined : k.max,
      status: "open",
      note: k.note?.trim() || undefined,
      inputs: [...new Set(inputs)],
      branch: k.branch,
      createdAt: this.now(),
      updatedAt: this.now(),
      turns: 0,
      team: k.team,
    };
    this.emit(t, { type: "ticket.opened", at: this.now(), ticket });
    // a follow-up settles the ticket it follows
    if (from && from.status === "submitted") this.close(t, from.id, "done");
    this.resolve(t, `limit:${thread}`);
    return s.tickets[id]!;
  }

  private close(t: Team, id: string, outcome: CloseOutcome, note?: string) {
    const k = t.state.tickets[id];
    if (!k || k.status === "closed") return;
    this.emit(t, { type: "ticket.closed", at: this.now(), id, outcome, note });
    this.handleFor(t, id);
  }

  private enqueue(t: Team, item: Omit<QueueItem, "seq" | "state" | "at">) {
    const q: QueueItem = { ...item, text: item.text.trim().slice(0, 4000), seq: (t.state.queue.at(-1)?.seq ?? 0) + 1, state: "queued", at: this.now() };
    this.emit(t, { type: "queue.added", at: q.at, item: q });
    return q;
  }

  /** Every queue item about ticket `id` is dealt with: the manager acted on the ticket. */
  private handleFor(t: Team, id: string) {
    const seqs = t.state.queue.filter((q) => q.ticket === id && q.state !== "handled").map((q) => q.seq);
    if (seqs.length) this.emit(t, { type: "queue.handled", at: this.now(), seqs });
  }

  private queueMessage(t: Team, m: Omit<Outgoing, "id" | "at">) {
    const msg: Outgoing = { ...m, id: `o${t.state.outbox.length + 1}`, at: this.now() };
    this.emit(t, { type: "message.queued", at: msg.at, message: msg });
    return msg;
  }

  private raise(t: Team, a: Omit<Attention, "at">) {
    if (t.state.attention[a.id]) return;
    this.emit(t, { type: "attention.raised", at: this.now(), attention: { ...a, at: this.now() } });
  }

  private resolve(t: Team, id: string) {
    if (t.state.attention[id]) this.emit(t, { type: "attention.resolved", at: this.now(), id });
  }

  // -------------------------------------------------------------------------------------------
  // mode 1: af task

  async task(who: Who, req: TaskRequest) {
    if (who.kind === "router") throw new AfError("use_ticket", "a router opens tickets with af ticket open");
    const pane = who.kind === "member" || who.kind === "pane" ? who.pane : undefined;
    if (!pane) throw new AfError("no_pane", "af task must run inside a Herdr pane (the session that hands out the work)");
    const text = (req.task ?? "").trim();
    if (!text) throw new AfError("empty", "the task is empty");
    const t = this.directTeam(pane);
    if (t.state.stopped) throw new AfError("team_stopped", `team ${t.id} is stopped`);
    let member: Member;
    let spawn: Parameters<Teams["spawn"]>[1] | undefined;
    if (req.to) {
      member = t.state.members[req.to]!;
      if (!member || member.team) throw new AfError("unknown_member", `no member ${req.to} in this session's team (members: ${Object.keys(t.state.members).join(", ") || "none"})`, 404);
      if (member.status === "exited") throw new AfError("member_exited", `${req.to} has exited; give the work to a new member`);
    } else {
      const kind = (req.kind ?? "claude") as AgentKind;
      if (!AGENT_KINDS.includes(kind)) throw new AfError("bad_kind", `kind must be one of ${AGENT_KINDS.join(", ")}`);
      const name = req.name ? req.name : this.uniqueName(t, kind);
      if (req.name && t.state.members[req.name]) throw new AfError("duplicate_member", `${req.name} already exists; give it more work with --to ${req.name}`);
      spawn = { name, kind, protocol: "none", worktree: !!req.worktree };
      member = { name, kind, protocol: "none", cwd: t.state.meta!.cwd, status: "starting", addedAt: this.now() };
    }
    const k = this.openTicket(t, { title: req.title ?? firstLine(text), assignee: member.name, task: text, branch: member.branch ?? (req.worktree ? memberBranch(t.id, member.name) : undefined) });
    if (spawn) this.spawnLater(t, spawn, k.id);
    return { team: t.id, ticket: k.id, member: member.name, dir: this.ticketDir(t, k.id), branch: k.branch, started: !!spawn };
  }

  // -------------------------------------------------------------------------------------------
  // mode 2: af team new, and the router's commands

  async newTeam(who: Who, req: NewTeamRequest, ui = false) {
    const goal = (req.goal ?? "").trim();
    if (!goal) throw new AfError("no_goal", "a team needs a goal (--goal \"...\")");
    const router = (req.router ?? "claude") as AgentKind;
    if (!AGENT_KINDS.includes(router)) throw new AfError("bad_kind", `the router kind must be one of ${AGENT_KINDS.join(", ")}`);
    // the caller: a session (its direct team gets a ticket for the whole team), a router (nested), or the UI
    let parent: Team | undefined;
    let cwd = req.cwd ? resolve(req.cwd) : undefined;
    if (who.kind === "pane" || who.kind === "member") {
      parent = this.directTeam(who.pane!);
      cwd ??= parent.state.meta!.cwd;
    } else if (who.kind === "router") {
      parent = this.active(who.team);
      cwd ??= parent.state.meta!.cwd;
    } else if (!ui) throw new AfError("no_pane", "run af team new inside a session, or start a team from the agent-flow UI");
    if (!cwd || !existsSync(cwd)) throw new AfError("bad_cwd", `${cwd ?? "(no folder)"} does not exist`);
    const pb = req.playbook ? this.opts.playbooks?.find(req.playbook, git.repoRoot(cwd) ?? cwd) : undefined;
    if (req.playbook && !pb) throw new AfError("no_playbooks", "playbooks are not available on this server");
    const name = (req.name || pb?.id || "team").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 24) || "team";

    const id = this.newId();
    const dir = join(this.opts.home, "teams", id);
    const ws = await this.opts.backend.createWorkspace(`◆ ${name}`, cwd, {
      AF_TEAM: id,
      AF_AGENT: "router",
      AF_SOCK: this.opts.sock,
      AF_OUT: join(dir, "out"),
      PATH: `${this.opts.binDir}:${process.env.PATH ?? ""}`,
    });
    // the team's ticket on the caller's timeline: its assignee stands for the whole team
    let parentRef: TeamMeta["parent"];
    if (parent) {
      const label = this.uniqueName(parent, name);
      this.emit(parent, { type: "member.added", at: this.now(), member: { name: label, kind: router, protocol: "router", cwd, status: "idle", addedAt: this.now(), team: id } });
      const k = this.openTicket(parent, { title: firstLine(goal), assignee: label, task: goal, team: id });
      this.emit(parent, { type: "ticket.delivered", at: this.now(), id: k.id });
      parentRef = { team: parent.id, ticket: k.id };
    }
    const t = this.create({ name, mode: "router", cwd, manager: { member: "router" }, workspace: ws.workspaceId, parent: parentRef, playbook: pb?.id, playbookPath: pb?.path, goal }, id);
    await this.opts.backend.renameTab(ws.tabId, "router").catch(() => {});
    this.queueMessage(t, { member: "router", kind: "brief", text: this.brief(t) });
    // the router starts in the workspace's first pane; it gets the brief once it is free
    const p = this.spawn(t, { name: "router", kind: router, protocol: "router", pane: { paneId: ws.paneId, tabId: ws.tabId } })
      .catch((e) => this.raise(t, { id: "startup:router", kind: "startup", member: "router", text: `The router did not start: ${(e as Error).message}` }))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    if (parent) this.emitParentPane(parent, t);
    return { team: t.id, name, workspace: ws.workspaceId, parent: t.state.meta!.parent, playbook: pb?.id };
  }

  /** Point the parent's team member at the router's pane once it has one (its box then opens the team). */
  private emitParentPane(parent: Team, child: Team) {
    const wait = async () => {
      for (let i = 0; i < 60 && !child.state.members.router?.paneId; i++) await Bun.sleep(100);
      const pane = child.state.members.router?.paneId;
      const tab = child.state.members.router?.tabId;
      const m = Object.values(parent.state.members).find((x) => x.team === child.id);
      if (pane && tab && m) this.emit(parent, { type: "member.placed", at: this.now(), name: m.name, paneId: pane, tabId: tab });
    };
    void wait();
  }

  private brief(t: Team) {
    const m = t.state.meta!;
    return [
      `[agent-flow] You are the router of team ${t.id} ("${m.name}"). Folder: ${m.cwd}.`,
      `Goal: ${m.goal}`,
      ...(m.playbookPath ? [`Playbook: read ${m.playbookPath} and follow it.`] : ["No playbook: decide the members and the steps yourself, following your router instructions."]),
      `Start now: open the first tickets (af ticket open <member> --kind <kind> --title "..." --task-file <file>). Then end your turn; your queue wakes you.`,
    ].join(" ");
  }

  async openForRouter(who: Who, req: OpenTicketRequest) {
    if (who.kind !== "router") throw new AfError("forbidden", "only a router opens tickets this way; a session hands out work with af task", 403);
    const t = this.active(who.team);
    const name = (req.member ?? "").trim();
    if (!NAME.test(name)) throw new AfError("bad_name", `a member name must match ${NAME}`);
    if (name === "router") throw new AfError("bad_name", "the router does not take tickets");
    if (!(req.task ?? "").trim()) throw new AfError("empty", "the task is empty (--task or --task-file)");
    const existing = t.state.members[name];
    if (existing?.status === "exited") throw new AfError("member_exited", `${name} has exited; open the ticket for a new member`);
    if (existing?.team) throw new AfError("is_team", `${name} is a team; use af tell ${name} "..."`);
    const kind = (req.kind ?? existing?.kind ?? "claude") as AgentKind;
    const k = this.openTicket(t, {
      title: req.title || firstLine(req.task),
      assignee: name,
      task: req.task,
      from: req.from,
      max: req.max,
      note: req.note,
      inputs: req.inputs,
      branch: existing?.branch ?? (req.worktree ? memberBranch(t.id, name) : undefined),
    });
    if (!existing) this.spawnLater(t, { name, kind, protocol: "member", role: req.role, worktree: !!req.worktree }, k.id);
    return { ticket: k.id, member: name, thread: k.thread, round: k.round, dir: this.ticketDir(t, k.id), started: !existing };
  }

  closeTicket(who: Who, id: string, outcome: CloseOutcome, note?: string) {
    const t = this.managed(who);
    const k = t.state.tickets[id];
    if (!k) throw new AfError("unknown_ticket", `no ticket ${id}`, 404);
    if (k.status === "closed") throw new AfError("closed", `${id} is already closed (${k.outcome})`);
    this.close(t, id, outcome, note);
    if (outcome === "cancelled" && k.status !== "open") {
      const m = t.state.members[k.assignee];
      if (m && !m.team && m.status !== "exited")
        this.queueMessage(t, { member: m.name, kind: "tell", ticket: id, text: `[agent-flow] ${id} was cancelled${note ? `: ${note}` : ""}. Stop working on it and wait.` });
    }
    return t.state.tickets[id];
  }

  setMax(who: Who, thread: string, max: number) {
    const t = this.managed(who);
    if (!t.state.tickets[thread]) throw new AfError("unknown_ticket", `no ticket ${thread}`, 404);
    if (!Number.isInteger(max) || max < 1) throw new AfError("bad_max", "the limit must be a whole number of rounds, 1 or more");
    const root = t.state.tickets[thread]!.thread;
    this.emit(t, { type: "thread.max", at: this.now(), thread: root, max });
    this.resolve(t, `limit:${root}`);
    return { thread: root, max };
  }

  /** A follow-up for a ticket or member: typed in when the member is free (a team member: its router's queue). */
  tell(who: Who, ref: string, text: string) {
    const t = this.managed(who);
    if (!text.trim()) throw new AfError("empty", "nothing to tell");
    const k = this.ticketFor(t, ref);
    const m = t.state.members[k.assignee]!;
    if (m.team) {
      // a team: its router hears it first thing
      const child = this.active(m.team);
      let ticket = k;
      if (k.status === "closed") {
        ticket = this.openTicket(t, { title: firstLine(text), assignee: m.name, task: text, from: k.id, team: m.team });
        this.emit(t, { type: "ticket.delivered", at: this.now(), id: ticket.id });
      } else if (k.status === "submitted") this.emit(t, { type: "ticket.reopened", at: this.now(), id: k.id });
      this.enqueue(child, { kind: "user", from: who.kind === "router" ? `router of ${t.id}` : USER, text });
      return { ticket: ticket.id, to: `team ${child.id}` };
    }
    if (m.status === "exited") throw new AfError("member_exited", `${m.name} has exited`);
    if (k.status === "closed") {
      const next = this.openTicket(t, { title: firstLine(text), assignee: m.name, task: text, from: k.id, branch: k.branch });
      return { ticket: next.id, to: m.name, opened: true };
    }
    this.queueMessage(t, { member: m.name, kind: "tell", ticket: k.id, text: m.protocol === "none" ? text : `[agent-flow] More for ${k.id} from the router: ${text}` });
    this.handleFor(t, k.id);
    return { ticket: k.id, to: m.name };
  }

  /** A ticket by id, or a member's current (else latest) ticket. */
  private ticketFor(t: Team, ref: string): Ticket {
    const byId = t.state.tickets[ref];
    if (byId) return byId;
    const m = t.state.members[ref];
    if (!m) throw new AfError("unknown_ticket", `no ticket or member ${ref}`, 404);
    const k = currentTicket(t.state, m.name) ?? ticketList(t.state).filter((x) => x.assignee === m.name).at(-1);
    if (!k) throw new AfError("no_ticket", `${ref} has no ticket`, 404);
    return k;
  }

  /** Answer the question on a member's screen (not a permission prompt: those are the user's). */
  async answer(who: Who, ref: string, option: number, text?: string) {
    const t = this.managed(who);
    const k = this.ticketFor(t, ref);
    const m = t.state.members[k.assignee]!;
    if (!m.paneId || m.team) throw new AfError("no_pane", `${m.name} has no pane to answer in`);
    const menu = await this.opts.w.menu(m.paneId);
    if (!menu) throw new AfError("no_menu", `${m.name} is not showing a question now`, 409);
    const question = [...menu.question, ...(menu.code ?? [])].join(" ");
    if (isApproval(question) || isApproval(menu.options.map((o) => o.label).join(" "))) throw new AfError("approval", `${m.name} is asking for permission ("${firstLine(question)}"); that is the user's to answer`, 403);
    const opt = menu.options[option - 1];
    if (!opt) throw new AfError("bad_option", `pick an option from 1 to ${menu.options.length}`);
    const r = await this.opts.w.choose(m.paneId, option - 1, opt.label, text);
    t.asked.delete(m.name);
    this.handleFor(t, k.id);
    return { ticket: k.id, member: m.name, option: r.option };
  }

  /** Answer a member's `af ask`. */
  reply(who: Who, seq: number, text: string) {
    const t = this.managed(who);
    const q = t.state.queue.find((x) => x.seq === seq);
    if (!q) throw new AfError("unknown_item", `no queue item #${seq}`, 404);
    if (q.kind !== "ask" || !q.from) throw new AfError("not_a_question", `#${seq} is not a member's question; act on its ticket instead`);
    if (!text.trim()) throw new AfError("empty", "the answer is empty");
    this.queueMessage(t, { member: q.from, kind: "reply", ticket: q.ticket, text: `[agent-flow] Answer to your question #${seq}: ${text.trim()}` });
    this.emit(t, { type: "queue.handled", at: this.now(), seqs: [seq] });
    return { to: q.from };
  }

  /** A router reports to whoever opened its team (its queue), or to the user (Needs you). --done finishes the team's ticket. */
  report(who: Who, text: string, done = false) {
    if (who.kind !== "router") throw new AfError("forbidden", "only a router reports (members submit with af submit)", 403);
    const t = this.active(who.team);
    if (!text.trim()) throw new AfError("empty", "the report is empty");
    const file = join(t.dir, "out", `report-${Date.now()}.md`);
    writeFileSync(file, `${text.trim()}\n`);
    const p = t.state.meta!.parent;
    const parent = p ? this.teams.get(p.team) : undefined;
    if (parent && !parent.state.stopped) {
      const member = Object.values(parent.state.members).find((m) => m.team === t.id);
      const k = (member && currentTicket(parent.state, member.name)) ?? parent.state.tickets[p!.ticket];
      if (k && done && k.status !== "closed") {
        writeFileSync(join(this.ticketDir(parent, k.id), "result.md"), `${text.trim()}\n`);
        this.emit(parent, { type: "ticket.submitted", at: this.now(), id: k.id, report: { status: "ready", note: firstLine(text), at: this.now() } });
      }
      this.enqueue(parent, { kind: "report", ticket: k?.id, from: member?.name ?? t.id, text: `${done ? "Team finished" : "Team update"} (${t.state.meta!.name}): ${text}`, path: done && k ? join(this.ticketDir(parent, k.id), "result.md") : file });
    } else this.raise(t, { id: `report:${t.state.queue.length}:${Date.now()}`, kind: "report", text: `${done ? "Finished" : "Update"}: ${firstLine(text, 300)}` });
    // a report answers what the router took from above (the user's requests, a nested team's report)
    const seqs = takenUnhandled(t.state)
      .filter((q) => q.kind === "user" || q.kind === "report" || !q.ticket)
      .map((q) => q.seq);
    if (seqs.length) this.emit(t, { type: "queue.handled", at: this.now(), seqs });
    return { to: parent ? `team ${parent.id}` : "the user", file };
  }

  // -------------------------------------------------------------------------------------------
  // members: af submit / progress / ask

  private memberTicket(who: Who, id?: string): { t: Team; k: Ticket; member: string } {
    if (who.kind !== "member") throw new AfError("forbidden", "only a team member submits (a session gets its members' results by itself)", 403);
    const t = this.active(who.team);
    const k = id ? t.state.tickets[id] : currentTicket(t.state, who.member);
    if (!k || k.assignee !== who.member) throw new AfError("no_ticket", id ? `${id} is not your ticket` : "you have no ticket to work on", 404);
    return { t, k, member: who.member };
  }

  submit(who: Who, req: SubmitRequest) {
    const { t, k, member } = this.memberTicket(who, req.ticket);
    if (k.status === "closed") throw new AfError("closed", `${k.id} is closed (${k.outcome})`);
    if (k.status === "submitted") throw new AfError("submitted", `${k.id} is already submitted; wait for the router`);
    const status = req.status ?? "ready";
    if (!["ready", "blocked", "failed", "dropped"].includes(status)) throw new AfError("bad_status", "status must be ready, blocked, failed or dropped");
    const result = join(this.ticketDir(t, k.id), "result.md");
    const body = existsSync(result) ? readFileSync(result, "utf8") : "";
    this.emit(t, { type: "ticket.submitted", at: this.now(), id: k.id, report: { status, note: req.note?.trim() || undefined, to: req.to, at: this.now() } });
    this.enqueue(t, {
      kind: "submit",
      ticket: k.id,
      from: member,
      to: req.to,
      text: [`${status}${req.note ? `: ${req.note.trim()}` : ""}`, body ? body.slice(0, 400) : "(no result.md written)"].join("\n"),
      path: body ? result : undefined,
    });
    return { ticket: k.id, status, result: body ? result : undefined };
  }

  progress(who: Who, text: string) {
    const { t, k } = this.memberTicket(who);
    this.emit(t, { type: "ticket.progress", at: this.now(), id: k.id, text: text.trim().slice(0, 500) });
    return { ticket: k.id };
  }

  ask(who: Who, text: string) {
    const { t, k, member } = this.memberTicket(who);
    if (!text.trim()) throw new AfError("empty", "the question is empty");
    const q = this.enqueue(t, { kind: "ask", ticket: k.id, from: member, text });
    return { ticket: k.id, seq: q.seq };
  }

  // -------------------------------------------------------------------------------------------
  // the manager's queue

  queue(who: Who, all = false) {
    const t = this.managed(who);
    return { team: t.id, items: byPriority(t.state.queue.filter((q) => (all ? true : q.state !== "handled"))) };
  }

  /** Take every queued item (oldest problems first after the user's). Mode 1: taking it deals with it. */
  take(who: Who) {
    const t = this.managed(who);
    const items = byPriority(queued(t.state));
    if (!items.length) return { team: t.id, items: [], text: "(your queue is empty)" };
    const seqs = items.map((q) => q.seq);
    this.emit(t, { type: "queue.taken", at: this.now(), seqs });
    t.notice = undefined;
    this.resolve(t, "notice");
    if (t.state.meta!.mode === "direct") {
      this.emit(t, { type: "queue.handled", at: this.now(), seqs });
      // a finished turn is the result: the ticket is done unless the session sends more (af tell)
      for (const q of items) if ((q.kind === "turn" || q.kind === "report") && q.ticket && t.state.tickets[q.ticket]?.status === "submitted") this.close(t, q.ticket, "done");
    }
    return { team: t.id, items, text: this.formatItems(t, items) };
  }

  handled(who: Who, seqs: number[] | "all") {
    const t = this.managed(who);
    const list = seqs === "all" ? t.state.queue.filter((q) => q.state !== "handled").map((q) => q.seq) : seqs;
    if (list.length) this.emit(t, { type: "queue.handled", at: this.now(), seqs: list });
    return { handled: list };
  }

  formatItems(t: Team, items: QueueItem[]) {
    const verb: Record<QueueKind, string> = {
      user: "new request",
      ask: "asks",
      asking: "is asking on screen",
      stuck: "may be stuck",
      exited: "exited",
      error: "error",
      submit: "submitted",
      turn: t.state.meta!.mode === "direct" ? "finished" : "finished a turn without af submit",
      report: "report",
    };
    const out: string[] = [];
    for (const q of items) {
      const k = q.ticket ? t.state.tickets[q.ticket] : undefined;
      const head = [`#${q.seq}`, q.ticket, q.from ? `${q.from} ${verb[q.kind]}` : verb[q.kind], k && k.round > 1 ? `(round ${k.round} of thread ${k.thread})` : "", q.to ? `→ suggests ${q.to}` : ""].filter(Boolean).join(" ");
      out.push(head);
      out.push(...q.text.split("\n").map((l) => `  ${l}`));
      if (q.options?.length) out.push(...q.options.map((o, i) => `  ${i + 1}. ${o}`), `  answer: af answer ${q.ticket ?? q.from} <number>`);
      if (q.path) out.push(`  full text: ${q.path}`);
      if (q.kind === "ask") out.push(`  answer: af reply ${q.seq} "<answer>"`);
    }
    return out.join("\n");
  }

  ticketShow(who: Who, ref: string) {
    const t = who.kind === "user" ? undefined : this.managed(who);
    if (!t) throw new AfError("no_team", "no team");
    const k = this.ticketFor(t, ref);
    const dir = this.ticketDir(t, k.id);
    const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : undefined);
    const related = ticketList(t.state)
      .filter((x) => x.id !== k.id && (x.thread === k.thread || x.from === k.id || k.from === x.id))
      .map((x) => `${x.id} ${x.assignee} ${x.status}${x.outcome ? ` ${x.outcome}` : ""}`);
    return { ticket: k, dir, task: read("task.md"), result: read("result.md"), related };
  }

  tickets(who: Who) {
    const t = this.managed(who);
    const panes = new Map(this.opts.w.model.panes.map((p) => [p.id, p]));
    return ticketList(t.state).map((k) => {
      const m = t.state.members[k.assignee];
      return { ...k, stage: ticketStage(k, m, m?.paneId ? lookOf(panes.get(m.paneId)) : undefined) };
    });
  }

  async status(who: Who, ref: string) {
    const t = this.managed(who);
    const m = t.state.members[ref] ?? t.state.members[this.ticketFor(t, ref).assignee];
    if (!m) throw new AfError("unknown_member", `no member ${ref}`, 404);
    const p = m.paneId ? this.opts.w.model.panes.find((x) => x.id === m.paneId) : undefined;
    const k = currentTicket(t.state, m.name) ?? ticketList(t.state).filter((x) => x.assignee === m.name).at(-1);
    const peek = m.paneId && !m.team ? await this.opts.peek?.(m.paneId).catch(() => undefined) : undefined;
    const screen = m.paneId && !m.team ? await this.opts.w.read(m.paneId, 15).catch(() => "") : "";
    return { member: m.name, kind: m.kind, status: p?.agentStatus ?? m.status, asking: p?.asking, ticket: k ? { id: k.id, status: k.status, stage: ticketStage(k, m, lookOf(p)) } : undefined, lastReply: peek?.reply?.slice(-1500), screen: screen.trimEnd() };
  }

  stopTeam(who: Who, id?: string) {
    const t = id ? this.require(id) : this.managed(who);
    if (!t.state.stopped) this.emit(t, { type: "team.stopped", at: this.now() });
    return { team: t.id };
  }

  /** The UI stops a team (closing its workspace, or the ⋯ menu). */
  stopById(id: string) {
    const t = this.require(id);
    if (!t.state.stopped) this.emit(t, { type: "team.stopped", at: this.now() });
  }

  /** Teams that live in a workspace (its router team, and direct teams of sessions in it). */
  teamsInWorkspace(workspace: string) {
    return [...this.teams.values()].filter((t) => t.state.meta?.workspace === workspace && !t.state.stopped).map((t) => t.id);
  }

  dismiss(team: string, id: string) {
    const t = this.require(team);
    if (!t.state.attention[id]) throw new AfError("unknown_attention", `no attention item ${id}`);
    this.resolve(t, id);
  }

  // -------------------------------------------------------------------------------------------
  // the loop: watch members, deliver tickets and messages, tell managers

  async flush() {
    await this.tick();
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const t of this.teams.values()) {
        if (!t.state.meta || t.state.stopped) continue;
        for (const m of Object.values(t.state.members)) {
          if (m.team || t.starting.has(m.name) || !m.paneId) continue;
          try {
            await this.watchMember(t, m);
          } catch (e) {
            console.error(`team ${t.id} ${m.name}:`, (e as Error).message);
          }
        }
        try {
          await this.tellManager(t);
        } catch (e) {
          console.error(`team ${t.id} manager:`, (e as Error).message);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async watchMember(t: Team, m: Member) {
    const w = this.opts.w;
    const p = w.model.panes.find((x) => x.id === m.paneId);
    const now = this.clock();
    // gone: no pane, or a pane whose agent has exited (twice in a row: Herdr's detection can blink)
    if (!p || !p.agent) {
      if (m.status === "exited") return;
      const n = (t.gone.get(m.name) ?? 0) + 1;
      t.gone.set(m.name, n);
      if (n < 2) return;
      this.setStatus(t, m.name, "exited");
      const k = currentTicket(t.state, m.name) ?? waitingTickets(t.state, m.name)[0];
      if (k) this.enqueue(t, { kind: "exited", ticket: k.id, from: m.name, text: `${m.name} (${m.kind}) exited${p ? " (its terminal is a shell now)" : " (its pane was closed)"} while on ${k.id}. Give the work to a new member if it should go on.` });
      return;
    }
    t.gone.delete(m.name);
    const status = toStatus(p.agentStatus);
    if (m.status !== status && !(m.status === "blocked" && status === "unknown")) this.setStatus(t, m.name, status);
    const k = currentTicket(t.state, m.name);

    // a question on screen: a task question goes to the manager; a permission prompt is the user's (Needs you)
    if (p.asking || p.agentStatus === "blocked") {
      const menu = await w.menu(m.paneId!).catch(() => undefined);
      const question = menu ? [...menu.question, ...(menu.code ?? [])].join(" ").replace(/\s+/g, " ").trim() : (p.asking ?? "");
      if (k && menu && question && !isApproval(question) && !isApproval(menu.options.map((o) => o.label).join(" ")) && t.asked.get(m.name) !== question) {
        t.asked.set(m.name, question);
        this.enqueue(t, { kind: "asking", ticket: k.id, from: m.name, text: question, options: menu.options.map((o) => o.label) });
      }
      return;
    }
    if (t.asked.has(m.name)) {
      // answered (by the manager, or the user on its card): an item nobody took is out of date
      t.asked.delete(m.name);
      const stale = t.state.queue.filter((q) => q.kind === "asking" && q.from === m.name && q.state === "queued").map((q) => q.seq);
      if (stale.length) this.emit(t, { type: "queue.handled", at: this.now(), seqs: stale });
    }

    // working: is the conversation still growing?
    if (status === "working") {
      if (k && k.status === "working" && this.opts.peek) {
        const seen = t.sizes.get(m.name);
        if (!seen || now - seen.at >= 30_000) {
          const pk = await this.opts.peek(m.paneId!).catch(() => undefined);
          const size = pk?.size;
          if (!seen || seen.size !== size) t.sizes.set(m.name, { size, since: now, at: now });
          else {
            seen.at = now;
            if (now - seen.since >= (this.opts.stuckMs ?? 600_000) && seen.reported !== seen.since) {
              seen.reported = seen.since;
              const screen = await w.read(m.paneId!, 12).catch(() => "");
              this.enqueue(t, { kind: "stuck", ticket: k.id, from: m.name, text: `${m.name} has been working for ${Math.round((now - seen.since) / 60_000)} min without writing to its conversation. Its screen ends with:\n${screen.trimEnd()}` });
            }
          }
        }
      }
      t.typing.delete(m.name);
      return;
    }
    t.sizes.delete(m.name);
    if (!w.isFree(m.paneId!)) return;
    const typed = t.typing.get(m.name);
    if (typed && now - typed < 15_000) return;
    t.typing.delete(m.name);
    const changed = p.statusAt ? Date.parse(p.statusAt) : 0;
    const settled = !changed || now - changed >= (this.opts.settleMs ?? 6000);

    // a turn that ended since the ticket was last dealt with
    if (k && k.status === "working" && changed > this.turnMark(t, k) && settled && t.looked.get(m.name) !== changed) {
      if (await this.turnEnded(t, m, k, changed)) return;
    }
    if (!settled) return;

    // something to type in: a message first (a follow-up, an answer, the router's brief), else its next ticket
    const msg = pendingMessages(t.state, m.name)[0];
    if (msg) {
      if (await this.type(t, m, msg.text)) {
        this.emit(t, { type: "message.delivered", at: this.now(), id: msg.id });
        if (msg.ticket && (msg.kind === "tell" || msg.kind === "reply" || msg.kind === "continue")) {
          const tk = t.state.tickets[msg.ticket];
          if (tk && tk.status === "submitted" && msg.kind === "tell") this.emit(t, { type: "ticket.reopened", at: this.now(), id: tk.id });
        }
      }
      return;
    }
    if (!k) {
      const next = waitingTickets(t.state, m.name)[0];
      if (next) {
        const text = this.taskMessage(t, m, next);
        try {
          if (await this.type(t, m, text, true)) this.emit(t, { type: "ticket.delivered", at: this.now(), id: next.id });
        } catch (e) {
          if (next.deliveryError !== (e as Error).message) this.emit(t, { type: "ticket.delivery_failed", at: this.now(), id: next.id, error: (e as Error).message });
        }
      }
    }
  }

  /** When the ticket's current turn of work began: a turn that ended after it is new. */
  private turnMark(t: Team, k: Ticket) {
    const sent = t.state.outbox.filter((o) => o.ticket === k.id && o.delivered).map((o) => Date.parse(o.delivered!));
    return Math.max(lastTurnMark(t.state, k), ...sent);
  }

  /** A member finished a turn on its ticket. Returns true when something was typed (or the turn was dealt with). */
  private async turnEnded(t: Team, m: Member, k: Ticket, changed: number): Promise<boolean> {
    const now = this.clock();
    if (m.protocol === "member" && now - changed < (this.opts.noSubmitMs ?? 20_000)) return false; // it may still submit
    // waiting for an answer to its question, or about to get a message: not a turn that ended without a result
    const waiting = t.state.queue.some((q) => q.kind === "ask" && q.from === m.name && q.state !== "handled") || pendingMessages(t.state, m.name).length > 0;
    if (m.protocol === "member" && waiting) {
      t.looked.set(m.name, changed);
      return false;
    }
    t.looked.set(m.name, changed);
    const pk = await this.opts.peek?.(m.paneId!).catch(() => undefined);
    // a passing API error: tell it to go on, three times at most
    if (pk?.error && TRANSIENT.test(pk.error)) {
      const tries = t.state.outbox.filter((o) => o.ticket === k.id && o.kind === "continue").length;
      if (tries < 3) {
        this.queueMessage(t, { member: m.name, kind: "continue", ticket: k.id, text: "continue" });
        return false;
      }
      this.enqueue(t, { kind: "error", ticket: k.id, from: m.name, text: `${m.name} keeps failing with: ${firstLine(pk.error, 300)} (told to continue 3 times)` });
      return true;
    }
    const reply = pk?.reply ?? (await this.opts.w.read(m.paneId!, 60).catch(() => "")).trimEnd();
    if (m.protocol === "none") {
      const file = join(this.ticketDir(t, k.id), "result.md");
      writeFileSync(file, `${reply || "(no reply found)"}\n`);
      this.emit(t, { type: "ticket.submitted", at: this.now(), id: k.id, report: { status: pk?.error ? "failed" : "ready", note: firstLine(reply), auto: true, at: this.now() } });
      this.enqueue(t, { kind: "turn", ticket: k.id, from: m.name, text: [pk?.error ? `ended with an error: ${firstLine(pk.error, 300)}` : "", reply.slice(0, 400)].filter(Boolean).join("\n"), path: file });
    } else {
      this.enqueue(t, { kind: "turn", ticket: k.id, from: m.name, text: `Its last reply:\n${(reply || "(none)").slice(-400)}${pk?.error ? `\nIt ended with an error: ${firstLine(pk.error, 300)}` : ""}\nTell it what to do (af tell ${k.id} "..."), or close the ticket.` });
    }
    return true;
  }

  /** Type into a member or manager pane, unless a question or notice is on its screen. */
  private async type(t: Team, m: Member | undefined, text: string, rethrow = false): Promise<boolean> {
    const pane = m?.paneId ?? this.managerPane(t);
    if (!pane) return false;
    try {
      await this.opts.w.prompt(pane, text);
      if (m) t.typing.set(m.name, this.clock());
      return true;
    } catch (e) {
      if ((e as AfError).code === "agent_asking") return false;
      if (rethrow) throw e;
      console.error(`team ${t.id}: could not type into ${pane}:`, (e as Error).message);
      return false;
    }
  }

  /** What a member is sent for a ticket. */
  private taskMessage(t: Team, m: Member, k: Ticket) {
    const dir = this.ticketDir(t, k.id);
    const task = readFileSync(join(dir, "task.md"), "utf8").trim();
    if (m.protocol === "none") {
      const body = task.length > 1500 ? `Your task is in ${join(dir, "task.md")}. Read it and do it.` : task;
      return `${body}\n\n(agent-flow ticket ${k.id}${k.branch ? `, on branch ${k.branch}` : ""}: when you finish, end your reply with a short summary of the result.)`;
    }
    const parts = [
      `[agent-flow] Ticket ${k.id} for you${k.round > 1 ? ` (thread ${k.thread}, round ${k.round})` : ""}: ${k.title}.`,
      `Read ${join(dir, "task.md")} and do it.`,
      ...(k.inputs.length ? [`Read first: ${k.inputs.join(", ")}.`] : []),
      ...(k.note ? [`Router's note: ${k.note}`] : []),
      `Work in ${m.cwd}.`,
      `When finished, write ${join(dir, "result.md")}, then run: af submit --status ready --note "<one line>" (or blocked / failed / dropped).`,
    ];
    return parts.join(" ");
  }

  /** Tell the manager about new queue items, and remind a router of items it took and left. */
  private async tellManager(t: Team) {
    const pane = this.managerPane(t);
    if (!pane) return;
    const mgr = t.state.meta!.manager.member ? t.state.members[t.state.meta!.manager.member] : undefined;
    if (mgr && (t.starting.has(mgr.name) || pendingMessages(t.state, mgr.name).length)) return; // the brief goes first
    const w = this.opts.w;
    if (!w.isFree(pane)) return;
    const p = w.model.panes.find((x) => x.id === pane);
    const now = this.clock();
    const changed = p?.statusAt ? Date.parse(p.statusAt) : 0;
    if (changed && now - changed < Math.min(this.opts.settleMs ?? 6000, 3000)) return; // statuses flicker
    if (mgr) {
      const typed = t.typing.get(mgr.name);
      if (typed && now - typed < 15_000) return;
    }
    const af = t.state.meta!.mode === "direct" ? join(this.opts.binDir, "af") : "af";
    const waiting = byPriority(queued(t.state));
    const fresh = waiting.filter((q) => !q.notified);
    if (waiting.length) {
      const key = waiting.map((q) => q.seq).join(",");
      const again = !fresh.length && t.notice && now - t.notice.at >= (this.opts.renotifyMs ?? 30_000) && (!changed || changed <= t.notice.at || now - changed >= (this.opts.renotifyMs ?? 30_000));
      if (fresh.length || again || (!t.notice && waiting.length)) {
        if (again && t.notice!.times >= 2) {
          this.raise(t, { id: "notice", kind: "notice_ignored", text: `${waiting.length} item(s) wait in the queue of ${t.state.meta!.mode === "router" ? "the router" : "this session"}, which has not taken them.` });
          return;
        }
        const text = `[agent-flow] ${waiting.length} new in your queue: ${waiting
          .slice(0, 4)
          .map((q) => this.shortItem(t, q))
          .join("; ")}${waiting.length > 4 ? "; …" : ""}. Run: ${af} queue take`;
        if (await this.type(t, mgr, text)) {
          if (fresh.length) this.emit(t, { type: "queue.notified", at: this.now(), seqs: fresh.map((q) => q.seq) });
          t.notice = { at: now, times: (t.notice?.key === key ? t.notice.times : 0) + 1, key };
        }
      }
      return;
    }
    // a router that took items and left some without an action
    if (t.state.meta!.mode === "router" && (!changed || now - changed >= (this.opts.settleMs ?? 6000))) {
      const left = takenUnhandled(t.state);
      const fresh2 = left.filter((q) => !t.reminded.has(q.seq));
      if (fresh2.length) {
        for (const q of fresh2) t.reminded.add(q.seq);
        await this.type(t, mgr, `[agent-flow] You took ${left.length} queue item(s) and did not act on: ${left.map((q) => `#${q.seq}${q.ticket ? ` ${q.ticket}` : ""}`).join(", ")}. Act on each (af ticket open --from / af ticket close / af reply / af answer / af tell / af report), or: af queue done <seq>.`);
      } else if (left.length && left.every((q) => t.reminded.has(q.seq)))
        this.raise(t, { id: "unhandled", kind: "unhandled", text: `The router left ${left.length} queue item(s) without acting on them.` });
    }
  }

  private shortItem(t: Team, q: QueueItem) {
    const who = q.from ?? "";
    const what: Record<QueueKind, string> = { user: "new request", ask: "asks a question", asking: "is asking", stuck: "may be stuck", exited: "exited", error: "error", submit: "submitted", turn: t.state.meta!.mode === "direct" ? "finished" : "stopped without submitting", report: "reported" };
    return `${q.ticket ? `${q.ticket} ` : ""}${who} ${what[q.kind]}`.replace(/\s+/g, " ").trim();
  }
}

const firstLine = (s: string, n = 100) => {
  const l = (s.split("\n").find((x) => x.trim()) ?? "").replace(/\s+/g, " ").trim();
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};

const toStatus = (s: string): AgentStatus => (s === "idle" || s === "working" || s === "blocked" || s === "done" ? s : "unknown");

const lookOf = (p: HPane | undefined) => (p ? { status: p.agentStatus, asking: p.asking } : undefined);
