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
  paneLook,
  ticketStage,
  waitingTickets,
} from "@af/core";
import * as git from "./git.ts";
import { AfError } from "./errors.ts";
import type { TerminalBackend } from "./herdr.ts";
import type { Workspaces } from "./workspaces.ts";
import type { Menu, Overlay } from "./menu.ts";
import { type AgentConfig, type Role, launchArgs, plainArgs } from "./agents.ts";
import { sq } from "./remote.ts";
import type { PlaybookLibrary } from "./playbooks.ts";
import { type Host, addWorktree, gitTop, hostOf, hostPathOf } from "./hosts.ts";
import { codexProfileToml } from "./agents.ts";
import { type Peek, TRANSIENT } from "./transcripts/peek.ts";
import { agentMdText, contextChanges, contextFiles, sameContext } from "./context.ts";

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
  /** An edit of a team's project context (context.md) goes out once the file has not changed for this long. */
  contextSettleMs?: number;
}

/** Who is calling, once known: a member or router of a team, a session by its pane (mode 1), or the user. */
/** The keys a notice on screen takes, as options to answer it with (Enter goes on; Esc dismisses). */
export function noticeOptions(o: Overlay | undefined): { label: string; key: string }[] {
  if (!o) return [];
  return [...(o.enter ? [{ label: "Continue (Enter)", key: "enter" }] : []), ...(o.esc ? [{ label: "Dismiss (Esc)", key: "esc" }] : [])];
}

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
  /** When each member's pane was made (ms): a remote pane takes a few seconds to show up in Herdr's model. */
  placedAt: Map<string, number>;
}

const USER = "user";
const SNAPSHOT_EVERY = 500;

export class Teams {
  private teams = new Map<string, Team>();
  private listeners = new Set<(team: string, ev: TeamEvent) => void>();
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  /** team -> member -> when the user last talked with it (from the team's events: "the user talked with it"). */
  private talks = new Map<string, Map<string, string>>();
  /** team -> an edit of its project context not sent yet, and since when the file has had that text (ms). */
  private contextEdits = new Map<string, { text: string; since: number }>();
  private pending = new Set<Promise<unknown>>();
  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private now: () => string;
  private clock: () => number;

  constructor(readonly opts: TeamsOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.clock = opts.clock ?? (() => Date.now());
    mkdirSync(join(opts.home, "teams"), { recursive: true });
    opts.w.onRemap((from, to) => this.remapMachine(from, to));
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
    return { id, dir: join(this.opts.home, "teams", id), state, starting: new Set(), sizes: new Map(), asked: new Map(), reminded: new Set(), gone: new Map(), looked: new Map(), typing: new Map(), placedAt: new Map() };
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
          delegate: !!m.delegate,
          // members whose prompt the manager has in its queue (delegate): not the user's yet, for half an hour
          answering: m.delegate
            ? s.queue
                .filter((q) => q.kind === "approval" && q.state !== "handled" && q.options?.length && q.from && this.clock() - Date.parse(q.at) < 30 * 60_000)
                .map((q) => s.members[q.from!]?.paneId)
                .filter((x): x is string => !!x)
            : undefined,
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
    const repo = !meta.machine || meta.machine === "local" ? git.repoRoot(meta.cwd) : undefined;
    this.teams.set(id, t);
    this.emit(t, { type: "team.created", at: this.now(), meta: { ...meta, id, dir: t.dir, createdAt: this.now(), repo: repo && git.hasCommits(repo) ? repo : undefined } });
    const f = contextFiles(t.dir);
    if (!existsSync(f.dynamic)) writeFileSync(f.dynamic, "");
    this.writeAgentMd(t);
    return t;
  }

  // -------------------------------------------------------------------------------------------
  // the project context: the dynamic part of the team's agent.md (context.ts)

  /** The text agent.md has now (the last one sent out). */
  private publishedContext(t: Team) {
    const f = contextFiles(t.dir);
    return existsSync(f.published) ? readFileSync(f.published, "utf8") : "";
  }

  /** agent.md as a session on `machine` reads it (the af command there). */
  private agentMd(t: Team, machine?: string) {
    return agentMdText(t.state.meta?.mode === "router" ? "router" : "direct", this.publishedContext(t), this.afPathOn(machine));
  }

  private writeAgentMd(t: Team) {
    writeFileSync(contextFiles(t.dir).agentMd, this.agentMd(t));
  }

  /** agent.md where a session on `machine` reads it: here, or its copy in that machine's ~/.agent-flow. */
  private agentMdFor(t: Team, machine?: string) {
    const f = contextFiles(t.dir).agentMd;
    return machine && machine !== "local" ? hostPathOf(this.host(machine), this.opts.home, f) : f;
  }

  /** The team whose project context a caller keeps: the one it hands out work to (made on first use), or routes. */
  private contextTeam(who: Who): Team {
    if (who.kind === "router") return this.active(who.team);
    if (who.kind === "pane" || who.kind === "member") return this.directTeam(who.pane!);
    throw new AfError("no_team", "run this inside the session that hands out the work (it is known by its Herdr pane)");
  }

  /** af context: where the project context is, and its text. */
  context(who: Who) {
    const t = this.contextTeam(who);
    const f = contextFiles(t.dir);
    if (!existsSync(f.dynamic)) writeFileSync(f.dynamic, this.publishedContext(t));
    const sessions = Object.values(t.state.members).filter((m) => this.readAgentMd(t, m)).map((m) => m.name);
    return { team: t.id, path: f.dynamic, agentMd: f.agentMd, text: readFileSync(f.dynamic, "utf8"), sessions };
  }

  /** af context set: the project context is this text now; it goes out at once. */
  setContext(who: Who, text: string) {
    const t = this.contextTeam(who);
    writeFileSync(contextFiles(t.dir).dynamic, text.trim() ? `${text.trim()}\n` : "");
    this.contextEdits.delete(t.id);
    return { team: t.id, ...this.publishContext(t, readFileSync(contextFiles(t.dir).dynamic, "utf8")) };
  }

  /** A member that has read agent.md: one of its tickets was typed in, and it is still there. */
  private readAgentMd(t: Team, m: Member) {
    if (m.team || m.status === "exited" || m.name === t.state.meta?.manager.member) return false;
    return ticketList(t.state).some((k) => k.assignee === m.name && k.deliveredAt);
  }

  /** The manager edited context.md: once it has stayed the same for a moment, send it out. */
  private checkContext(t: Team) {
    let text: string;
    try {
      text = readFileSync(contextFiles(t.dir).dynamic, "utf8");
    } catch {
      return;
    }
    if (sameContext(text, this.publishedContext(t))) return void this.contextEdits.delete(t.id);
    const now = this.clock();
    const settle = this.opts.contextSettleMs ?? 3000;
    const seen = this.contextEdits.get(t.id);
    if (!seen || seen.text !== text) {
      this.contextEdits.set(t.id, { text, since: now });
      if (settle > 0) return;
    } else if (now - seen.since < settle) return;
    this.contextEdits.delete(t.id);
    this.publishContext(t, text);
  }

  /**
   * The project context is `text` now: agent.md gets it, and each session that has read agent.md is told (once it is
   * free, as af tell; one that was stopped for being idle when it wakes). A change it was not told yet is replaced.
   */
  private publishContext(t: Team, text: string) {
    const f = contextFiles(t.dir);
    const before = this.publishedContext(t);
    if (sameContext(text, before)) return { changed: false, told: [] as string[] };
    writeFileSync(f.published, text);
    this.writeAgentMd(t);
    const changes = contextChanges(before, text);
    const told: string[] = [];
    for (const m of Object.values(t.state.members)) {
      if (!this.readAgentMd(t, m)) continue;
      const old = pendingMessages(t.state, m.name).filter((o) => o.kind === "context").map((o) => o.id);
      if (old.length) this.emit(t, { type: "message.dropped", at: this.now(), ids: old });
      const msg = [
        `[agent-flow] The project context changed${old.length ? " (more than once since you were last told)" : ""}. Read the part "Project context" in ${this.agentMdFor(t, m.machine)} again, and follow it from now on.`,
        ...(changes ? [`Changed lines:\n${changes}`] : []),
        "Take it into account for the work from here on. Reply in one line that you have read it; if it changes work you already handed back, say what would change, and do not redo that work unless you are asked to.",
      ].join("\n");
      this.queueMessage(t, { member: m.name, kind: "context", text: msg });
      told.push(m.name);
    }
    return { changed: true, told };
  }

  /** The direct team led by `pane`, created on its first ticket. */
  private directTeam(pane: string): Team {
    const have = this.directTeamOf(pane);
    if (have) return have;
    const p = this.pane(pane);
    const ws = this.opts.w.model.workspaces.find((w) => w.id === p.workspaceId);
    const parent = this.parentOfPane(pane);
    // a session that works for a team whose manager answers prompts for the user does so for its own sessions too
    const delegate = parent ? !!this.teams.get(parent.team)?.state.meta?.delegate : undefined;
    return this.create({ name: ws?.label || p.agent || "session", mode: "direct", cwd: p.cwd, manager: { pane }, workspace: p.workspaceId, machine: p.machine, parent, ...(delegate ? { delegate } : {}) });
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

  /** The machine a member (or a team's manager) is on. Throws when a remote one is not connected. */
  host(machine: string | undefined): Host {
    return hostOf(this.opts.w, machine ?? "local", { backend: this.opts.backend, afHome: this.opts.home, binDir: this.opts.binDir });
  }

  private remotePath = new Map<string, string>();

  /** Env for an agent agent-flow starts: members with a protocol know who they are; plain ones are known by their pane. */
  private async env(t: Team, host: Host, member?: string): Promise<Record<string, string>> {
    const who: Record<string, string> = member ? { AF_TEAM: t.id, AF_AGENT: member } : {};
    if (host.local) return { ...who, AF_SOCK: this.opts.sock, AF_OUT: join(t.dir, "out"), PATH: `${this.opts.binDir}:${process.env.PATH ?? ""}` };
    // a remote machine: its af (a script that reaches this server through the SSH connection) goes first on its PATH
    let path = this.remotePath.get(host.machine);
    if (!path) {
      path = (await host.sh("echo $PATH")).out.trim() || "/usr/local/bin:/usr/bin:/bin";
      this.remotePath.set(host.machine, path);
    }
    return { ...who, AF_OUT: hostPathOf(host, this.opts.home, join(t.dir, "out")), PATH: `${host.afHome}/bin:${path}` };
  }

  /**
   * A new tab for a member on `host`: in the manager's workspace when it is on the same machine, else in the team's
   * workspace on that machine (made with the first member there, who then gets its first pane).
   */
  private async tabFor(t: Team, host: Host, name: string, cwd: string, env: Record<string, string>) {
    const meta = t.state.meta!;
    let ws = (meta.machine ?? "local") === host.machine ? meta.workspace : meta.workspaces?.[host.machine];
    if (ws && (meta.machine ?? "local") !== host.machine && !this.opts.w.model.workspaces.some((w) => w.id === ws)) ws = undefined; // closed since
    if (!ws) {
      const r = await host.backend.createWorkspace(meta.name, cwd, env);
      this.emit(t, { type: "team.workspace", at: this.now(), machine: host.machine, workspace: host.prefix(r.workspaceId) });
      await host.backend.renameTab(r.tabId, name).catch(() => {});
      return { paneId: host.prefix(r.paneId), tabId: host.prefix(r.tabId) };
    }
    const r = await host.backend.createTab(host.raw(ws), cwd, name, env);
    return { paneId: host.prefix(r.paneId), tabId: host.prefix(r.tabId) };
  }

  /**
   * Where a new member works: its machine (default the manager's), its folder there (default the manager's when on
   * the same machine, else the home folder), and whether it is in a git repository. In a repository the caller must
   * say whether the member gets its own worktree (`worktree`): agent-flow does not guess, since sessions that change
   * the same files at the same time need one and the others do not.
   */
  private async placeFor(t: Team, name: string, req: { machine?: string; cwd?: string; worktree?: boolean }) {
    const meta = t.state.meta!;
    const machine = this.opts.w.primaryOf(req.machine || meta.machine || "local"); // a route to a machine's Herdr: that machine
    const host = this.host(machine);
    const same = machine === (meta.machine ?? "local");
    const cwd = req.cwd ? host.expand(req.cwd) : same ? meta.cwd : host.home;
    const ok = await host.sh(`test -d ${sq(cwd)} && echo ok`);
    if (ok.out.trim() !== "ok") throw new AfError("bad_cwd", `${cwd} is not a folder${host.local ? "" : ` on ${host.label}`}`);
    const top = await gitTop(host, cwd);
    if (top && req.worktree === undefined)
      throw new AfError(
        "worktree_choice",
        `${cwd} is in a git repository: say whether ${name} gets its own worktree. --worktree if it changes files while other sessions change the same repository (its own branch af/${t.id}/${name}, never merged for you); --no-worktree if it works in the folder itself (read-only work, or nobody else edits it). If you cannot tell, ask the user.`,
      );
    if (!top && req.worktree) throw new AfError("no_repo", `${cwd} is not in a git repository with commits; --worktree needs one`);
    return { host, machine, cwd, worktree: !!req.worktree };
  }

  private uniqueName(t: Team, base: string) {
    const b = (base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "") || "member").slice(0, 28);
    if (!t.state.members[b]) return b;
    for (let i = 2; ; i++) if (!t.state.members[`${b}-${i}`]) return `${b}-${i}`;
  }

  /** Add a member and start its agent in a new tab of the team's workspace (or in a given pane). */
  private async spawn(
    t: Team,
    a: { name: string; kind: AgentKind; protocol: Member["protocol"]; role?: string; worktree?: boolean; machine?: string; cwd?: string; prepare?: string; ticket?: string; pane?: { paneId: string; tabId: string } },
  ) {
    if (!NAME.test(a.name)) throw new AfError("bad_name", `a member name must match ${NAME}`);
    if (a.name === USER) throw new AfError("bad_name", `${a.name} is reserved`);
    if (t.state.members[a.name]) throw new AfError("duplicate_member", `${a.name} is already a member of team ${t.id}`);
    if (!AGENT_KINDS.includes(a.kind)) throw new AfError("bad_kind", `kind must be one of ${AGENT_KINDS.join(", ")}`);
    const meta = t.state.meta!;
    const machine = a.machine ?? meta.machine ?? "local";
    let cwd = a.cwd ?? meta.cwd;
    const m: Member = {
      name: a.name,
      kind: a.kind,
      protocol: a.protocol,
      role: a.role,
      cwd,
      ...(machine !== "local" ? { machine } : {}),
      branch: a.worktree ? memberBranch(t.id, a.name) : undefined,
      status: "starting",
      addedAt: this.now(),
      session: a.kind === "claude" ? crypto.randomUUID() : undefined,
    };
    this.emit(t, { type: "member.added", at: this.now(), member: m });
    // gemini cannot add to its system prompt; a protocol file passed with "@file" needs its folder added to gemini's
    // workspace, which makes it ask whether to trust that folder. So the protocol is its first message instead.
    const typedProtocol = a.kind === "gemini" && a.protocol !== "none";
    if (typedProtocol)
      this.queueMessage(t, {
        member: a.name,
        kind: "brief",
        text: `${readFileSync(join(t.dir, "protocol", `${a.protocol}.md`), "utf8").trim()}\n\n[agent-flow] These are your agent-flow instructions for this whole session (your team is ${t.id}, your name ${a.name}). Reply only: ready`,
      });
    t.starting.add(a.name);
    try {
      const host = this.host(machine);
      // its own worktree, then the optional prepare command, both before the agent starts
      if (a.worktree) {
        cwd = await addWorktree(host, cwd, t.id, a.name, m.branch!);
        this.emit(t, { type: "member.added", at: this.now(), member: { ...t.state.members[a.name]!, cwd, worktree: cwd } });
      }
      if (a.prepare?.trim()) await this.prepare(t, host, a.name, cwd, a.prepare, a.ticket);
      const env = await this.env(t, host, a.protocol === "none" ? undefined : a.name);
      const tab = a.pane ?? (await this.tabFor(t, host, a.name, cwd, env));
      this.emit(t, { type: "member.placed", at: this.now(), name: a.name, paneId: tab.paneId, tabId: tab.tabId });
      t.placedAt.set(a.name, this.clock());
      if (m.session) this.opts.w.rememberSession(tab.paneId, m.session);
      // the protocol where the agent runs (a remote machine gets its own copy, and its codex its own profile)
      let protocolFile = join(t.dir, "protocol", `${a.protocol}.md`);
      let codexProfile: string | undefined;
      if (!host.local && a.protocol !== "none" && !typedProtocol) {
        const text = readFileSync(protocolFile, "utf8");
        protocolFile = hostPathOf(host, this.opts.home, protocolFile);
        await host.writeFile(protocolFile, text);
        if (a.kind === "codex") {
          const prof = codexProfileToml(a.protocol as Role, text);
          await host.writeFile(`${host.home}/.codex/${prof.file}`, prof.toml);
          codexProfile = prof.name;
        }
      }
      // claude's SessionStart hook (--settings) is a file on this Mac with this Mac's af: not for other machines
      const config = host.local ? this.opts.config : { ...this.opts.config, claudeSettings: undefined };
      const args = () =>
        a.protocol === "none" || typedProtocol ? plainArgs(a.kind, config, m.session) : launchArgs(a.kind, a.protocol as Role, protocolFile, config, m.session, codexProfile);
      const herdr = herdrMemberName(t.id, a.name);
      // a new tab's shell takes a moment to be ready; until then Herdr says the pane is busy
      let res = await host.backend.startAgent(herdr, a.kind, host.raw(tab.paneId), args());
      for (let i = 0; i < 12 && !res.ok && /busy/.test(res.code); i++) {
        await Bun.sleep(500);
        res = await host.backend.startAgent(herdr, a.kind, host.raw(tab.paneId), args());
      }
      if (res.ok) this.setStatus(t, a.name, "idle");
      else if (res.code === "agent_not_ready") {
        // a folder-trust or login prompt: the user answers it (Needs you shows the pane); delivery waits
        this.setStatus(t, a.name, "blocked");
      } else {
        if (!a.pane) await host.backend.closeTab(host.raw(tab.tabId)).catch(() => {});
        throw new AfError("agent_start_failed", `${a.kind} did not start${host.local ? "" : ` on ${host.label}`} (${res.code}: ${res.message})`);
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

  /** Run a member's prepare command once in its folder; its output goes to the ticket's prepare.log. */
  private async prepare(t: Team, host: Host, name: string, cwd: string, cmd: string, ticket?: string) {
    const r = await host.sh(`${cmd} 2>&1`, { cwd, timeoutMs: 10 * 60_000 });
    const log = `$ ${cmd}\n(in ${cwd}${host.local ? "" : ` on ${host.label}`}; exit ${r.code})\n\n${r.out}${r.err ? `\n${r.err}` : ""}`;
    if (ticket) writeFileSync(join(this.ticketDir(t, ticket), "prepare.log"), log);
    if (r.code !== 0) {
      const tail = `${r.out}${r.err}`.trim().split("\n").slice(-12).join("\n");
      throw new AfError("prepare_failed", `the prepare command for ${name} failed (exit ${r.code}${r.code === -1 || r.code === 143 ? ", stopped after 10 minutes" : ""}):\n${tail}`);
    }
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
    if (req.delegate !== undefined && req.delegate !== !!t.state.meta!.delegate) this.emit(t, { type: "team.delegate", at: this.now(), on: req.delegate });
    let member: Member;
    let spawn: Parameters<Teams["spawn"]>[1] | undefined;
    if (req.to) {
      member = t.state.members[req.to]!;
      if (!member || member.team) throw new AfError("unknown_member", `no member ${req.to} in this session's team (members: ${Object.keys(t.state.members).join(", ") || "none"})`, 404);
      if (member.status === "exited") throw new AfError("member_exited", `${req.to} has exited; give the work to a new member`);
      if (req.machine || req.cwd || req.prepare) throw new AfError("existing_member", `${req.to} already works in ${member.cwd}${member.machine ? ` on ${member.machine}` : ""}; --on, --cwd and --prepare are for a new member`);
    } else {
      const kind = (req.kind ?? "claude") as AgentKind;
      if (!AGENT_KINDS.includes(kind)) throw new AfError("bad_kind", `kind must be one of ${AGENT_KINDS.join(", ")}`);
      const name = req.name ? req.name : this.uniqueName(t, kind);
      if (req.name && t.state.members[req.name]) throw new AfError("duplicate_member", `${req.name} already exists; give it more work with --to ${req.name}`);
      if (!NAME.test(name) || name === USER) throw new AfError("bad_name", name === USER ? `"${USER}" is reserved; pick another name` : `a member name must match ${NAME}`);
      const place = await this.placeFor(t, name, req);
      spawn = { name, kind, protocol: "none", worktree: place.worktree, machine: place.machine, cwd: place.cwd, prepare: req.prepare };
      member = { name, kind, protocol: "none", cwd: place.cwd, status: "starting", addedAt: this.now(), ...(place.machine !== "local" ? { machine: place.machine } : {}) };
    }
    const k = this.openTicket(t, { title: req.title ?? firstLine(text), assignee: member.name, task: text, branch: member.branch ?? (spawn?.worktree ? memberBranch(t.id, member.name) : undefined) });
    if (spawn) this.spawnLater(t, { ...spawn, ticket: k.id }, k.id);
    return { team: t.id, ticket: k.id, member: member.name, dir: this.ticketDir(t, k.id), branch: k.branch, started: !!spawn, machine: member.machine ?? spawn?.machine, cwd: member.cwd };
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
    if (who.kind === "pane" || who.kind === "member") parent = this.directTeam(who.pane!);
    else if (who.kind === "router") parent = this.active(who.team);
    else if (!ui) throw new AfError("no_pane", "run af team new inside a session, or start a team from the agent-flow UI");
    // the router's machine: as asked, else the caller's; its folder: as asked, else the caller's (same machine) or home
    const pm = parent?.state.meta;
    const machine = this.opts.w.primaryOf(req.machine || pm?.machine || "local");
    const host = this.host(machine);
    const cwd = req.cwd ? host.expand(host.local ? resolve(req.cwd) : req.cwd) : pm && (pm.machine ?? "local") === machine ? pm.cwd : host.local ? undefined : host.home;
    if (!cwd || (await host.sh(`test -d ${sq(cwd)} && echo ok`)).out.trim() !== "ok") throw new AfError("bad_cwd", `${cwd ?? "(no folder)"} is not a folder${host.local ? "" : ` on ${host.label}`}`);
    const pb = req.playbook ? this.opts.playbooks?.find(req.playbook, host.local ? (git.repoRoot(cwd) ?? cwd) : undefined) : undefined;
    if (req.playbook && !pb) throw new AfError("no_playbooks", "playbooks are not available on this server");
    const name = (req.name || pb?.id || "team").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 24) || "team";

    const id = this.newId();
    const draft = this.blank(id, emptyTeam()); // for env(): only its id and folder are read
    const raw = await host.backend.createWorkspace(name, cwd, await this.env(draft, host, "router"));
    const ws = { workspaceId: host.prefix(raw.workspaceId), tabId: host.prefix(raw.tabId), paneId: host.prefix(raw.paneId) };
    // the team's ticket on the caller's timeline: its assignee stands for the whole team
    let parentRef: TeamMeta["parent"];
    if (parent) {
      const label = this.uniqueName(parent, name);
      this.emit(parent, { type: "member.added", at: this.now(), member: { name: label, kind: router, protocol: "router", cwd, status: "idle", addedAt: this.now(), team: id } });
      const k = this.openTicket(parent, { title: firstLine(goal), assignee: label, task: goal, team: id });
      this.emit(parent, { type: "ticket.delivered", at: this.now(), id: k.id });
      parentRef = { team: parent.id, ticket: k.id };
    }
    const delegate = req.delegate ?? !!parent?.state.meta?.delegate;
    const t = this.create({ name, mode: "router", cwd, manager: { member: "router" }, workspace: ws.workspaceId, machine, parent: parentRef, playbook: pb?.id, playbookPath: pb?.path, goal, ...(delegate ? { delegate } : {}) }, id);
    await host.backend.renameTab(raw.tabId, "router").catch(() => {});
    // a router on another machine reads its playbook there
    let playbookThere = pb?.path;
    if (pb && !host.local) {
      playbookThere = `${host.afHome}/teams/${id}/playbook.md`;
      await host.writeFile(playbookThere, readFileSync(pb.path, "utf8"));
    }
    // the router starts in the workspace's first pane; it gets the brief once it is free (a gemini router gets its
    // protocol first: spawn queues it before its first await)
    // the caller's ticket for the team opens the router's pane: it is known at once (the router starts in it)
    if (parent) {
      const m = Object.values(parent.state.members).find((x) => x.team === t.id);
      if (m) this.emit(parent, { type: "member.placed", at: this.now(), name: m.name, paneId: ws.paneId, tabId: ws.tabId });
    }
    const p = this.spawn(t, { name: "router", kind: router, protocol: "router", machine, cwd, pane: { paneId: ws.paneId, tabId: ws.tabId } })
      .catch((e) => this.raise(t, { id: "startup:router", kind: "startup", member: "router", text: `The router did not start: ${(e as Error).message}` }))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
    this.queueMessage(t, { member: "router", kind: "brief", text: this.brief(t, playbookThere) });
    return { team: t.id, name, workspace: ws.workspaceId, parent: t.state.meta!.parent, playbook: pb?.id, machine };
  }

  private brief(t: Team, playbook = t.state.meta!.playbookPath) {
    const m = t.state.meta!;
    return [
      `[agent-flow] You are the router of team ${t.id} ("${m.name}"). Folder: ${m.cwd}${m.machine && m.machine !== "local" ? ` on ${m.machine}` : ""}.`,
      `Goal: ${m.goal}`,
      ...(playbook ? [`Playbook: read ${playbook} and follow it.`] : ["No playbook: decide the members and the steps yourself, following your router instructions."]),
      `Start now: open the first tickets (af ticket open <member> --kind <kind> --title "..." --task-file <file>). Then end your turn; your queue wakes you.`,
    ].join(" ");
  }

  async openForRouter(who: Who, req: OpenTicketRequest) {
    if (who.kind !== "router") throw new AfError("forbidden", "only a router opens tickets this way; a session hands out work with af task", 403);
    const t = this.active(who.team);
    const name = (req.member ?? "").trim();
    if (!NAME.test(name)) throw new AfError("bad_name", `a member name must match ${NAME}`);
    if (name === "router") throw new AfError("bad_name", "the router does not take tickets");
    if (name === USER) throw new AfError("bad_name", `"${USER}" is reserved; pick another name`);
    if (!(req.task ?? "").trim()) throw new AfError("empty", "the task is empty (--task or --task-file)");
    const existing = t.state.members[name];
    if (existing?.status === "exited") throw new AfError("member_exited", `${name} has exited; open the ticket for a new member`);
    if (existing?.team) throw new AfError("is_team", `${name} is a team; use af tell ${name} "..."`);
    const kind = (req.kind ?? existing?.kind ?? "claude") as AgentKind;
    if (existing && (req.machine || req.cwd || req.prepare)) throw new AfError("existing_member", `${name} already works in ${existing.cwd}${existing.machine ? ` on ${existing.machine}` : ""}; --on, --cwd and --prepare are for a new member`);
    const place = existing ? undefined : await this.placeFor(t, name, req);
    const k = this.openTicket(t, {
      title: req.title || firstLine(req.task),
      assignee: name,
      task: req.task,
      from: req.from,
      max: req.max,
      note: req.note,
      inputs: req.inputs,
      branch: existing?.branch ?? (place?.worktree ? memberBranch(t.id, name) : undefined),
    });
    if (place) this.spawnLater(t, { name, kind, protocol: "member", role: req.role, worktree: place.worktree, machine: place.machine, cwd: place.cwd, prepare: req.prepare, ticket: k.id }, k.id);
    // a new ticket acts on the requests the router took (the user's, a report from a nested team)
    const asked = takenUnhandled(t.state).filter((q) => (q.kind === "user" || q.kind === "report") && !q.ticket).map((q) => q.seq);
    if (asked.length) this.emit(t, { type: "queue.handled", at: this.now(), seqs: asked });
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

  /**
   * Answer the question on a member's screen. A permission or trust prompt, or a notice, only when the user lets the
   * manager answer those (setDelegate); otherwise they are the user's.
   */
  async answer(who: Who, ref: string, option: number, text?: string) {
    const t = this.managed(who);
    const k = this.ticketFor(t, ref);
    const m = t.state.members[k.assignee]!;
    if (!m.paneId || m.team) throw new AfError("no_pane", `${m.name} has no pane to answer in`);
    const delegate = !!t.state.meta!.delegate;
    const st = await this.opts.w.screenState(m.paneId);
    const menu = st.menu;
    if (!menu && st.overlay && noticeOptions(st.overlay).length) {
      const head = firstLine(st.overlay.lines.filter((l) => l.trim()).join(" "));
      if (!delegate) throw new AfError("approval", `${m.name} shows a notice ("${head}"); that is the user's to answer`, 403);
      const opts = noticeOptions(st.overlay);
      const opt = opts[option - 1];
      if (!opt) throw new AfError("bad_option", `pick an option from 1 to ${opts.length}`);
      await this.opts.w.press(m.paneId, [opt.key]);
      t.asked.delete(m.name);
      this.handleFor(t, k.id);
      return { ticket: k.id, member: m.name, option: opt.label };
    }
    if (!menu) throw new AfError("no_menu", `${m.name} is not showing a question now`, 409);
    const question = [...menu.question, ...(menu.code ?? [])].join(" ");
    if (!delegate && (isApproval(question) || isApproval(menu.options.map((o) => o.label).join(" "))))
      throw new AfError("approval", `${m.name} is asking for permission ("${firstLine(question)}"); that is the user's to answer`, 403);
    const opt = menu.options[option - 1];
    if (!opt) throw new AfError("bad_option", `pick an option from 1 to ${menu.options.length}`);
    const r = await this.opts.w.choose(m.paneId, option - 1, opt.label, text);
    t.asked.delete(m.name);
    this.handleFor(t, k.id);
    return { ticket: k.id, member: m.name, option: r.option };
  }

  /** The plain session (af task) running in `pane`, and the direct team it works for. */
  private directChild(pane: string) {
    for (const t of this.teams.values()) {
      if (t.state.stopped || t.state.meta?.mode !== "direct") continue;
      const m = Object.values(t.state.members).find((x) => x.paneId === pane && x.protocol === "none" && x.status !== "exited" && !x.team);
      if (m) return { t, m };
    }
    return undefined;
  }

  private childReport(t: Team, m: Member, text: string) {
    if (!text.trim()) throw new AfError("empty", "the report is empty");
    const k = currentTicket(t.state, m.name) ?? ticketList(t.state).filter((x) => x.assignee === m.name).at(-1);
    mkdirSync(join(t.dir, "out"), { recursive: true });
    const file = join(t.dir, "out", `report-${m.name}-${Date.now()}.md`);
    writeFileSync(file, `${text.trim()}\n`);
    this.enqueue(t, { kind: "report", ticket: k?.id, from: m.name, text: text.trim(), path: file });
    return { to: "the session that gave you your task (it gets it in its queue)", file };
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

  /**
   * A router reports to whoever opened its team (its queue), or to the user (Needs you). --done finishes the team's
   * ticket. A session given a task with af task reports what its conversation with the user changed (to the queue of
   * the session that gave it the task).
   */
  report(who: Who, text: string, done = false) {
    const child = who.kind === "pane" ? this.directChild(who.pane) : undefined;
    if (child) return this.childReport(child.t, child.m, text);
    if (who.kind !== "router") throw new AfError("forbidden", "only a router, or a session given a task with af task, reports (members submit with af submit)", 403);
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
    // a report answers what the router took from above (the user's requests, a nested team's report), and problems
    // only the user can solve (a prompt that waits for them, a member that stopped); results still need routing
    const seqs = takenUnhandled(t.state)
      .filter((q) => !["submit", "turn", "ask", "asking"].includes(q.kind) || !q.ticket)
      .map((q) => q.seq);
    if (seqs.length) this.emit(t, { type: "queue.handled", at: this.now(), seqs });
    return { to: parent ? `the session that started this team (it gets it in its queue; its own team is ${parent.id})` : "the user (in Needs you)", file };
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

  async submit(who: Who, req: SubmitRequest) {
    const { t, k, member } = this.memberTicket(who, req.ticket);
    if (k.status === "closed") throw new AfError("closed", `${k.id} is closed (${k.outcome})`);
    if (k.status === "submitted") throw new AfError("submitted", `${k.id} is already submitted; wait for the router`);
    const status = req.status ?? "ready";
    if (!["ready", "blocked", "failed", "dropped"].includes(status)) throw new AfError("bad_status", "status must be ready, blocked, failed or dropped");
    const result = join(this.ticketDir(t, k.id), "result.md");
    // a member on another machine wrote result.md there: bring it here (the UI and the next members read this copy)
    const m = t.state.members[member]!;
    if (m.machine && m.machine !== "local") {
      const host = this.host(m.machine);
      const text = await host.readFile(hostPathOf(host, this.opts.home, result));
      if (text !== undefined) writeFileSync(result, text);
    }
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

  /**
   * Whether the agent in `pane` may be stopped for being idle (sleep.ts), as far as teams go; undefined when no
   * running team has it. A router or a member that stands for a team: never. A member while a ticket of its is open
   * or in progress, a message waits for it, or something it sent is not dealt with yet: not now. Otherwise it is a
   * worker with nothing to do (stopped sooner than other agents); a message to it starts it again.
   */
  sleepInfo(pane: string): { worker: boolean; ok: boolean; why?: string } | undefined {
    for (const t of this.teams.values()) {
      if (t.state.stopped) continue;
      for (const m of Object.values(t.state.members)) {
        if (m.paneId !== pane || m.status === "exited") continue;
        if (m.team) return { worker: false, ok: false, why: "stands for a team" };
        if (m.protocol === "router") return { worker: false, ok: false, why: "routes a team" };
        if (t.starting.has(m.name)) return { worker: true, ok: false, why: "starting" };
        const k = currentTicket(t.state, m.name);
        if (k) return { worker: true, ok: false, why: `${k.id} is ${k.status === "submitted" ? "waiting for its manager" : "in progress"}` };
        if (waitingTickets(t.state, m.name).length) return { worker: true, ok: false, why: "has a ticket waiting" };
        if (pendingMessages(t.state, m.name).length) return { worker: true, ok: false, why: "has a message waiting" };
        if (t.state.queue.some((q) => q.from === m.name && q.state !== "handled")) return { worker: true, ok: false, why: "its manager has not dealt with its last report" };
        return { worker: true, ok: true };
      }
    }
    return undefined;
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
      approval: "waits for the user",
      stuck: "may be stuck",
      exited: "exited",
      error: "error",
      submit: "submitted",
      turn: t.state.meta!.mode === "direct" ? "finished" : "finished a turn without af submit",
      report: "report",
    };
    const again = (q: QueueItem) => {
      const k = q.ticket ? t.state.tickets[q.ticket] : undefined;
      return k?.resumed && (q.kind === "turn" || q.kind === "submit") && Date.parse(q.at) >= Date.parse(k.reopenedAt ?? q.at) ? " again (it went on by itself after you took its result)" : "";
    };
    const out: string[] = [];
    for (const q of items) {
      const k = q.ticket ? t.state.tickets[q.ticket] : undefined;
      const v = q.kind === "approval" && q.options?.length ? "has a prompt for you to answer" : verb[q.kind];
      const head = [`#${q.seq}`, q.ticket, q.from ? `${q.from} ${v}${again(q)}` : v, k && k.round > 1 ? `(round ${k.round} of thread ${k.thread})` : "", q.to ? `→ suggests ${q.to}` : ""].filter(Boolean).join(" ");
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

  /**
   * Let a team's manager answer its members' prompts for the user (folder trust, permission prompts, notices), or
   * stop that: the user (the UI) for any team; a session or router for its own team (it does so when the user says it
   * may). Teams opened under it later get the same; those open already keep theirs.
   */
  setDelegate(who: Who, id: string | undefined, on: boolean) {
    let t: Team;
    if (who.kind === "user") {
      if (!id) throw new AfError("no_team", "which team?");
      t = this.require(id);
    } else if (who.kind === "router") t = this.active(who.team);
    else t = this.directTeam(who.pane!);
    if (who.kind !== "user" && id && id !== t.id) throw new AfError("forbidden", `team ${id} is not yours`, 403);
    if (!!t.state.meta!.delegate !== on) this.emit(t, { type: "team.delegate", at: this.now(), on });
    return { team: t.id, delegate: on };
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
        try {
          this.checkContext(t);
        } catch (e) {
          console.error(`team ${t.id} context:`, (e as Error).message);
        }
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
    // a member on a machine that is not connected right now: nothing can be known or done until it is back
    if (m.machine && m.machine !== "local" && w.model.machines.find((x) => x.id === w.primaryOf(m.machine!))?.state !== "online") return;
    const p = w.model.panes.find((x) => x.id === m.paneId);
    const now = this.clock();
    // a pane just made on another machine shows up in Herdr's model a few seconds later
    if (!p && now - (t.placedAt.get(m.name) ?? 0) < 20_000) return;
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
      const screen = await w.screenState(m.paneId!).catch(() => ({}) as { menu?: Menu; overlay?: Overlay });
      const menu = screen.menu;
      const notice = (screen.overlay?.lines ?? []).filter((l) => l.trim()).join(" ");
      const question = (menu ? [...menu.question, ...(menu.code ?? [])].join(" ") : (p.asking ?? notice)).replace(/\s+/g, " ").trim();
      const approval = !menu || isApproval(question) || isApproval(menu.options.map((o) => o.label).join(" "));
      const about = k ?? waitingTickets(t.state, m.name)[0];
      // once per question, also across restarts: an item about the same question since it appeared (the pane's status
      // changed when the dialog came up, and that time is kept across restarts)
      const since = p.statusAt ? Date.parse(p.statusAt) : 0;
      const known = t.state.queue.some((q) => q.from === m.name && (q.kind === "asking" || q.kind === "approval") && q.text.includes(firstLine(question, 200)) && (q.state !== "handled" || Date.parse(q.at) >= since));
      if (about && question && t.asked.get(m.name) !== question && !known) {
        t.asked.set(m.name, question);
        if (!approval && k) this.enqueue(t, { kind: "asking", ticket: k.id, from: m.name, text: question, options: menu!.options.map((o) => o.label) });
        // a permission or trust prompt, or a notice: the user's, unless they let the manager answer those
        else this.promptItem(t, m, about.id, question, screen);
      }
      return;
    }
    if (t.asked.has(m.name)) {
      // answered (by the manager, or the user on its card): an item nobody took is out of date
      t.asked.delete(m.name);
      const stale = t.state.queue.filter((q) => (q.kind === "asking" || q.kind === "approval") && q.from === m.name && q.state === "queued").map((q) => q.seq);
      if (stale.length) this.emit(t, { type: "queue.handled", at: this.now(), seqs: stale });
    }

    // working again after its ticket was closed, with nothing new for it: it went on by itself (a background task
    // woke it, or someone typed to it). Open the ticket again, so its next result reaches the manager.
    if (status === "working" && !k && !waitingTickets(t.state, m.name).length && !pendingMessages(t.state, m.name).length) {
      const last = ticketList(t.state).filter((x) => x.assignee === m.name).at(-1);
      const since = p.statusAt ? Date.parse(p.statusAt) : now;
      if (last && last.status === "closed" && last.outcome === "done" && !last.team && last.closedAt && since > Date.parse(last.closedAt))
        this.emit(t, { type: "ticket.resumed", at: this.now(), id: last.id });
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

    // a turn that ended since the ticket was last dealt with: done or idle and no longer waiting on background work
    // (a Monitor, a background command): Workspaces.settled. Waiting on background work is not the end of the job.
    if (k && k.status === "working" && changed > this.turnMark(t, k) && settled && w.settled(m.paneId!) && t.looked.get(m.name) !== changed) {
      // a notice or a question on its screen (Herdr can report "done" while one is up, and the question check runs
      // only every few seconds): it waits for an answer, it has not finished. Looked at once per status change.
      if (await this.waitsOnScreen(t, m, k)) {
        t.looked.set(m.name, changed);
        return;
      }
      if (await this.turnEnded(t, m, k, changed)) return;
    }
    if (!settled) return;

    // something to type in: a message first (a follow-up, an answer, the router's brief), else its next ticket. A
    // change of the project context does not wake a session stopped for being idle: it gets it when it is back.
    const msg = pendingMessages(t.state, m.name).find((x) => !(x.kind === "context" && p.asleep));
    if (msg) {
      if (msg.kind === "context" && m.machine && m.machine !== "local") {
        const host = this.host(m.machine);
        await host.writeFile(this.agentMdFor(t, m.machine), this.agentMd(t, m.machine));
      }
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
        try {
          this.writeAgentMd(t); // its first part is agent-flow's: as this version of agent-flow writes it
          await this.mirror(t, m, next);
          const text = this.taskMessage(t, m, next);
          if (await this.type(t, m, text, true)) this.emit(t, { type: "ticket.delivered", at: this.now(), id: next.id });
        } catch (e) {
          if (next.deliveryError !== (e as Error).message) this.emit(t, { type: "ticket.delivery_failed", at: this.now(), id: next.id, error: (e as Error).message });
        }
      }
    }
  }

  /**
   * Whether a member that looks finished shows a question or a notice instead (claude's notices, like the one about
   * auto mode billing, wait for Enter; Herdr may call that "done"). If so, its manager hears it once: a question
   * about the task it may answer (af answer); anything else is the user's, so it only hears that the member waits.
   */
  private async waitsOnScreen(t: Team, m: Member, k: Ticket): Promise<boolean> {
    const st = await this.opts.w.screenState(m.paneId!).catch(() => ({}) as { menu?: undefined; overlay?: undefined });
    if (!st.menu && !st.overlay) return false;
    const text = st.menu
      ? [...st.menu.question, ...(st.menu.code ?? [])].join(" ").replace(/\s+/g, " ").trim()
      : (st.overlay!.lines ?? []).filter((l) => l.trim()).join(" ").replace(/\s+/g, " ").trim();
    const head = firstLine(text, 200);
    const known = t.state.queue.some((q) => q.from === m.name && (q.kind === "asking" || q.kind === "approval") && q.text.includes(head) && q.state !== "handled");
    if (known || !head) return true;
    t.asked.set(m.name, text);
    const approval = !st.menu || isApproval(text) || isApproval(st.menu.options.map((o) => o.label).join(" "));
    if (!approval) this.enqueue(t, { kind: "asking", ticket: k.id, from: m.name, text, options: st.menu!.options.map((o) => o.label) });
    else this.promptItem(t, m, k.id, text, st, true);
    return true;
  }

  /**
   * The queue item for a permission or trust prompt, or a notice, on a member's screen. They are the user's (Needs
   * you shows them): the manager hears only that the member waits. When the user lets the manager answer them
   * (delegate), the item has the options and how to answer.
   */
  private promptItem(t: Team, m: Member, ticket: string, text: string, st: { menu?: Menu; overlay?: Overlay }, unfinished = false) {
    const head = firstLine(text, 200);
    const what = st.menu ? "prompt" : "notice";
    const options = st.menu ? st.menu.options.map((o) => o.label) : noticeOptions(st.overlay).map((o) => o.label);
    if (t.state.meta!.delegate && options.length)
      this.enqueue(t, {
        kind: "approval",
        ticket,
        from: m.name,
        text: `A ${what} on its screen: "${head}". The user lets you answer prompts like this for them (folder trust, permissions, notices): answer as they would. Allow what its task needs; anything destructive or outside the task, leave to them (af queue done <seq>: it stays in their Needs you).${unfinished ? " It has not finished its task." : ""}`,
        options,
      });
    else
      this.enqueue(t, {
        kind: "approval",
        ticket,
        from: m.name,
        text: `Waiting for the user to answer a ${what} on its screen: "${head}". Only the user can answer it (in agent-flow, on that session's pane, or in their Needs you); do not answer it yourself.${unfinished ? " It has not finished its task." : ""}`,
      });
  }

  /** When the ticket's current turn of work began: a turn that ended after it is new. */
  private turnMark(t: Team, k: Ticket) {
    const sent = t.state.outbox.filter((o) => o.ticket === k.id && o.delivered).map((o) => Date.parse(o.delivered!));
    return Math.max(lastTurnMark(t.state, k), ...sent);
  }

  /**
   * Whether the turn that just ended was the user's: its ticket opened again by itself after its result was taken
   * (ticket.resumed), and the last message in its conversation is one agent-flow did not type, written after that
   * result was taken. (A background task that wakes it adds no message: its last one is then agent-flow's, or older.)
   */
  private userTalked(t: Team, m: Member, k: Ticket, pk: Peek | undefined) {
    if (!k.resumed || pk?.lastUser === undefined || !pk.lastUser.trim()) return false;
    const at = pk.lastUserAt ? Date.parse(pk.lastUserAt) : NaN;
    if (k.resumedAfter && !Number.isNaN(at) && at < Date.parse(k.resumedAfter)) return false;
    return !this.typedByUs(t, m, pk.lastUser);
  }

  /** Whether this message is one of agent-flow's notes to the member that the project context changed. */
  private isContextMessage(t: Team, m: Member, text: string) {
    const n = (s: string) => s.replace(/\s+/g, " ").trim();
    const head = n(text).slice(0, 80);
    return t.state.outbox.some((o) => o.member === m.name && o.kind === "context" && o.delivered && !o.dropped && n(o.text).startsWith(head));
  }

  /** Whether agent-flow typed this message to the member (a task, af tell, an answer, "continue"), not the user. */
  private typedByUs(t: Team, m: Member, text: string) {
    const n = (s: string) => s.replace(/\s+/g, " ").trim();
    const got = n(text);
    const ours = [
      ...t.state.outbox.filter((o) => o.member === m.name).map((o) => o.text),
      // the task as written: the message around it was worded otherwise by earlier versions of agent-flow
      ...ticketList(t.state)
        .filter((x) => x.assignee === m.name)
        .map((x) => {
          try {
            return readFileSync(join(this.ticketDir(t, x.id), "task.md"), "utf8");
          } catch {
            return "";
          }
        }),
      ...ticketList(t.state)
        .filter((x) => x.assignee === m.name)
        .map((x) => {
          try {
            return this.taskMessage(t, m, x);
          } catch {
            return ""; // its task.md is gone
          }
        }),
    ];
    return ours.some((o) => {
      const head = n(o).slice(0, 80);
      return !!head && (got.includes(head) || (got.length >= 12 && n(o).includes(got.slice(0, 80))));
    });
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
    // no reply in its conversation (none found, or it stopped before writing one): the end of its screen instead
    const screen = pk?.reply ? "" : (await this.opts.w.read(m.paneId!, 25).catch(() => "")).trimEnd();
    const reply = pk?.reply ?? (screen ? `(no reply found in its conversation; its screen ends with:)\n${screen}` : "");
    // its reply to a change of the project context ("read it"): nothing for its manager
    if (k.resumed && pk?.lastUser && this.isContextMessage(t, m, pk.lastUser)) {
      this.emit(t, { type: "ticket.closed", at: this.now(), id: k.id, outcome: "done", note: "read the new project context" });
      return true;
    }
    if (m.protocol === "none" && this.userTalked(t, m, k, pk)) {
      // the user talked with it after its result was taken: that conversation is theirs, its manager does not hear
      // each reply. What it changes for the work, the session reports itself (af report, as its task says).
      this.emit(t, { type: "ticket.closed", at: this.now(), id: k.id, outcome: "done", note: "the user talked with it" });
      this.talkedAt(t, m.name);
      this.talks.get(t.id)?.set(m.name, this.now());
      return true;
    }
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
      // a question on its screen, or the user typing to it: typed later (the caller tries again)
      if (["agent_asking", "user_typing", "held"].includes((e as AfError).code)) return false;
      if (rethrow) throw e;
      console.error(`team ${t.id}: could not type into ${pane}:`, (e as Error).message);
      return false;
    }
  }

  /** What a member is sent for a ticket. */
  /**
   * A member on another machine reads its ticket there: task.md, and the inputs from the team's folder, are copied
   * to the same place under that machine's ~/.agent-flow before the ticket is typed in.
   */
  private async mirror(t: Team, m: Member, k: Ticket) {
    if (!m.machine || m.machine === "local") return;
    const host = this.host(m.machine);
    const dir = this.ticketDir(t, k.id);
    await host.writeFile(this.agentMdFor(t, m.machine), this.agentMd(t, m.machine));
    await host.writeFile(hostPathOf(host, this.opts.home, join(dir, "task.md")), readFileSync(join(dir, "task.md"), "utf8"));
    for (const f of k.inputs)
      if (f.startsWith(`${t.dir}/`) && existsSync(f)) await host.writeFile(hostPathOf(host, this.opts.home, f), readFileSync(f, "utf8"));
  }

  /** The ticket folder as the member sees it: on its machine. */
  private ticketDirFor(t: Team, m: Member, id: string) {
    const dir = this.ticketDir(t, id);
    return m.machine && m.machine !== "local" ? hostPathOf(this.host(m.machine), this.opts.home, dir) : dir;
  }

  private taskMessage(t: Team, m: Member, k: Ticket) {
    const local = this.ticketDir(t, k.id);
    const task = readFileSync(join(local, "task.md"), "utf8").trim();
    const dir = this.ticketDirFor(t, m, k.id);
    const there = (f: string) => (m.machine && m.machine !== "local" ? hostPathOf(this.host(m.machine), this.opts.home, f) : f);
    // its first ticket: agent.md first (agent-flow's rules for it, and the project context); later ones are told
    // when the context changes (publishContext)
    const first = ticketList(t.state).find((x) => x.assignee === m.name)?.id === k.id;
    const agentMd = this.agentMdFor(t, m.machine);
    if (m.protocol === "none") {
      const body = task.length > 1500 ? `Your task is in ${join(dir, "task.md")}. Read it and do it.` : task;
      const head = first ? `Before you start, read ${agentMd}: how you work with agent-flow, and the project context (you are told when it changes).\n\n` : "";
      return `${head}${body}\n\n(agent-flow ticket ${k.id}${k.branch ? `, on branch ${k.branch}` : ""}: when you finish, end your reply with a short summary of the result.${first ? "" : ` Your instructions: ${agentMd}.`})`;
    }
    const parts = [
      `[agent-flow] Ticket ${k.id} for you${k.round > 1 ? ` (thread ${k.thread}, round ${k.round})` : ""}: ${k.title}.`,
      ...(first ? [`Before you start, read ${agentMd} (the project context the router keeps; you are told when it changes).`] : []),
      `Read ${join(dir, "task.md")} and do it.`,
      ...(k.inputs.length ? [`Read first: ${k.inputs.map(there).join(", ")}.`] : []),
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
    // a session agent-flow did not start may not have af on its PATH: the full path, on the manager's machine
    const af = t.state.meta!.mode === "direct" ? this.afPathOn(t.state.meta!.machine) : "af";
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

  /**
   * Why a member's session stays (undefined: it has nothing left to do and may be closed). It stays when it stands
   * for a whole team, works, has a result not taken yet, has a ticket or a message waiting, or the user has been
   * talking with it. In a router's team that still runs, the router may give any member more work.
   */
  keepReason(t: Team, m: Member): string | undefined {
    const w = this.opts.w;
    if (m.team) return "a team";
    const p = w.model.panes.find((x) => x.id === m.paneId);
    const busy = !!p?.agent && (p.agentStatus === "working" || p.agentStatus === "blocked" || !!p.asking || !!p.background);
    const mine = ticketList(t.state).filter((k) => k.assignee === m.name);
    const open = mine.filter((k) => k.status !== "closed");
    const talking = (w.lastTyped(m.paneId!) ?? 0) > this.clock() - 10 * 60_000; // keys in its terminal just now
    if (busy) return "working";
    if (talking) return "the user talks with it";
    if (t.state.stopped) return undefined; // its team is over: nothing more will come
    if (t.state.meta?.mode === "router") return m.name === t.state.meta.manager.member ? "the router of a running team" : "its team's router may give it more work";
    if (open[0]?.status === "submitted") return "its result waits in your queue";
    if (open.length) return "working";
    if (pendingMessages(t.state, m.name).length) return "has a message waiting";
    return undefined;
  }

  /** Close a member's session: marked first (a member whose pane closes is otherwise reported as exited). */
  async closeMember(t: Team, m: Member) {
    this.setStatus(t, m.name, "exited");
    await this.opts.w.close(m.paneId!).catch(() => {});
  }

  /**
   * A main session hands off (handoff.ts): close the sessions it started that have nothing left to do (keepReason).
   * Returns who was closed, and who goes on (with their tickets).
   */
  async closeFinished(mainPane: string): Promise<{ closed: string[]; running: { name: string; ticket?: string; title?: string; stage: string }[] }> {
    const t = this.directTeamOf(mainPane);
    const out = { closed: [] as string[], running: [] as { name: string; ticket?: string; title?: string; stage: string }[] };
    if (!t) return out;
    for (const m of Object.values(t.state.members)) {
      if (m.status === "exited" || !m.paneId) continue;
      const why = this.keepReason(t, m) ?? ((await this.talkedWith(t, m)) ? "the user has talked with it" : undefined);
      if (why) {
        const mine = ticketList(t.state).filter((k) => k.assignee === m.name);
        const k = mine.find((x) => x.status !== "closed") ?? mine.at(-1);
        out.running.push({ name: m.name, ticket: k?.id, title: k?.title, stage: why });
        continue;
      }
      await this.closeMember(t, m);
      out.closed.push(m.name);
    }
    return out;
  }

  /** The sessions of all teams (running or over) that have nothing left to do: for the "close idle" button. */
  async idleMembers(): Promise<{ team: string; member: string; pane: string; agent: string; title?: string; talked: boolean }[]> {
    const found: { t: Team; m: Member }[] = [];
    for (const t of this.teams.values()) {
      if (!t.state.meta) continue;
      for (const m of Object.values(t.state.members)) {
        if (m.status === "exited" || !m.paneId || !this.opts.w.model.panes.some((p) => p.id === m.paneId && p.agent)) continue;
        if (!this.keepReason(t, m)) found.push({ t, m });
      }
    }
    const talked = new Map<Member, boolean>();
    for (let i = 0; i < found.length; i += 8) await Promise.all(found.slice(i, i + 8).map(async ({ t, m }) => talked.set(m, await this.talkedWith(t, m).catch(() => false))));
    return found.map(({ t, m }) => ({ team: t.id, member: m.name, pane: m.paneId!, agent: m.kind, title: ticketList(t.state).filter((k) => k.assignee === m.name).at(-1)?.title, talked: !!talked.get(m) }));
  }

  /** When the user last talked with a member directly (its turns agent-flow took for theirs: userTalked). */
  private talkedAt(t: Team, member: string): string | undefined {
    let map = this.talks.get(t.id);
    if (!map) {
      map = new Map();
      try {
        for (const line of readFileSync(join(t.dir, "events.jsonl"), "utf8").split("\n")) {
          if (!line.includes("the user talked with it")) continue;
          const e = JSON.parse(line);
          const who = e.type === "ticket.closed" && e.note === "the user talked with it" ? t.state.tickets[e.id]?.assignee : undefined;
          if (who) map.set(who, e.at);
        }
      } catch {}
      this.talks.set(t.id, map);
    }
    return map.get(member);
  }

  /**
   * Whether the user has talked with a member's session directly: agent-flow saw it (talkedAt), or its conversation
   * has a message that neither agent-flow nor its manager typed (before agent-flow told those turns apart).
   */
  async talkedWith(t: Team, m: Member): Promise<boolean> {
    if (this.talkedAt(t, m.name)) return true;
    if (!m.paneId || !this.opts.peek) return false;
    const pk = await this.opts.peek(m.paneId).catch(() => undefined);
    return (pk?.userTexts ?? []).some((u) => u.trim() && !u.startsWith("[agent-flow]") && !this.typedByUs(t, m, u));
  }

  /** Close the member in `pane` of team `team` (idle.ts checked it has nothing left to do). */
  async closeIdleMember(team: string, member: string) {
    const t = this.teams.get(team);
    const m = t?.state.members[member];
    if (t && m?.paneId) await this.closeMember(t, m);
  }

  /** Whether the agent in `pane` works for a team: a member (af task, a router's member) or a router. */
  isMemberPane(pane: string) {
    for (const t of this.teams.values()) if (!t.state.stopped && Object.values(t.state.members).some((m) => m.paneId === pane && m.status !== "exited" && !m.team)) return true;
    return false;
  }

  /** Machine `from` is another route to the Herdr of `to`: every team keeps its ids under `to`. */
  private remapMachine(from: string, to: string) {
    const pre = `${from}~`; // MACHINE_SEP
    for (const t of this.teams.values()) {
      const m = t.state.meta;
      const uses = m && (m.machine === from || m.manager.pane?.startsWith(pre) || m.workspace?.startsWith(pre) || m.workspaces?.[from] || Object.values(t.state.members).some((x) => x.machine === from || x.paneId?.startsWith(pre)));
      if (uses) this.emit(t, { type: "team.remapped", at: this.now(), from, to });
    }
  }

  /** The panes of the sessions that hand out work (mode 1), whose teams are active. */
  mainPanes(): string[] {
    return [...this.teams.values()].filter((t) => !t.state.stopped && t.state.meta?.mode === "direct").map((t) => t.state.meta!.manager.pane!).filter(Boolean);
  }

  /** The af command on a machine: this Mac's, or the one agent-flow puts in that machine's ~/.agent-flow/bin. */
  afPathOn(machine: string | undefined) {
    if (!machine || machine === "local") return join(this.opts.binDir, "af");
    const home = this.opts.w.remoteOf(`${machine}~x`)?.home;
    return home ? `${home}/.agent-flow/bin/af` : "af";
  }

  private shortItem(t: Team, q: QueueItem) {
    const who = q.from ?? "";
    const what: Record<QueueKind, string> = { user: "new request", ask: "asks a question", asking: "is asking", approval: "waits for the user's approval", stuck: "may be stuck", exited: "exited", error: "error", submit: "submitted", turn: t.state.meta!.mode === "direct" ? "finished" : "stopped without submitting", report: "reported" };
    // a prompt the manager may answer for the user (delegate): its item has the options
    const verb = q.kind === "approval" && q.options?.length ? "has a prompt for you to answer" : what[q.kind];
    return `${q.ticket ? `${q.ticket} ` : ""}${who} ${verb}`.replace(/\s+/g, " ").trim();
  }
}

const firstLine = (s: string, n = 100) => {
  const l = (s.split("\n").find((x) => x.trim()) ?? "").replace(/\s+/g, " ").trim();
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};

const toStatus = (s: string): AgentStatus => (s === "idle" || s === "working" || s === "blocked" || s === "done" ? s : "unknown");

const lookOf = (p: HPane | undefined) => (p ? paneLook(p) : undefined);
