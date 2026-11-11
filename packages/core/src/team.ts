// Teams, tickets and queues (docs/design.md section 4). A team is one manager (the session that called
// `af task`, or a router agent) and the tickets it hands out to members. Everything that happens is an event in
// the team's events.jsonl; this reducer turns events into state. Shared by the server (to rebuild state on
// restart) and the web UI (to follow a team live).

export const NAME = /^[a-z][a-z0-9_-]{0,31}$/;

export type AgentKind = "claude" | "codex" | "omp" | "gemini";
export const AGENT_KINDS: readonly AgentKind[] = ["claude", "codex", "omp", "gemini"];

export type AgentStatus = "starting" | "idle" | "working" | "blocked" | "done" | "unknown" | "exited";

/** direct: mode 1, the user's session hands out work itself. router: mode 2, a router agent runs the team. */
export type TeamMode = "direct" | "router";

export interface TeamMeta {
  id: string;
  /** Shown in the UI and used in branch names. */
  name: string;
  mode: TeamMode;
  createdAt: string;
  /** The team's own folder: ~/.agent-flow/teams/<id> (tickets/, out/, events.jsonl). */
  dir: string;
  cwd: string;
  /** Git top-level of cwd, when cwd is in a repository with commits (for --worktree). */
  repo?: string;
  /**
   * Who receives the queue. direct: the pane of the session that called af task. router: the router member (its
   * pane is that member's).
   */
  manager: { pane?: string; member?: string };
  /** Herdr workspace new members open in (as tabs). */
  workspace: string;
  /** The machine the manager is on (its Herdr ids carry its prefix); members go there unless told otherwise. */
  machine?: string;
  /** Workspaces for members on other machines than the manager's, by machine (one per team and machine). */
  workspaces?: Record<string, string>;
  /** The ticket on another team's timeline that stands for this team (a session that opened it, or a nested team). */
  parent?: { team: string; ticket: string };
  playbook?: string;
  playbookPath?: string;
  goal?: string;
  /**
   * The user lets the manager answer its members' prompts for them: folder trust, permission prompts, notices that
   * wait for Enter. Off: those are the user's (Needs you). Teams opened under a team that has it get it too.
   */
  delegate?: boolean;
}

export interface Member {
  name: string;
  kind: AgentKind;
  /** none: a plain session (mode 1); member / router: started with that protocol injected. */
  protocol: "none" | "member" | "router";
  role?: string;
  cwd: string;
  /** The machine it runs on ("local" when absent). */
  machine?: string;
  /** --worktree: its own git worktree and branch (never merged by agent-flow). */
  branch?: string;
  worktree?: string;
  paneId?: string;
  tabId?: string;
  /** Last status seen from Herdr. */
  status: AgentStatus;
  addedAt: string;
  /** claude: the session id it was started with, to find its transcript. */
  session?: string;
  /** This member stands for another team (its router): the ticket box opens that team. */
  team?: string;
}

export type TicketStatus = "open" | "working" | "submitted" | "closed";
export type ReportStatus = "ready" | "blocked" | "failed" | "dropped";
export type CloseOutcome = "done" | "failed" | "dropped" | "cancelled";

export interface TicketReport {
  status: ReportStatus;
  note?: string;
  /** The member it suggests for the next step (af submit --to): the router decides. */
  to?: string;
  /** Made by agent-flow from the end of a turn (mode 1), not by the member. */
  auto?: boolean;
  at: string;
}

export interface Ticket {
  id: string;
  title: string;
  assignee: string;
  /** The ticket this one follows up on (af ticket open --from). */
  from?: string;
  /** The first ticket of the chain this one is in (itself when it starts one). */
  thread: string;
  /** How many tickets of this thread, up to and including this one, the assignee has had. */
  round: number;
  /** On a thread's first ticket: the most rounds one member may have in the thread. */
  max?: number;
  status: TicketStatus;
  /** One line from the manager for routing (Super-Agent: at most ~30 words, never a rewritten plan). */
  note?: string;
  /** Files the member should read first (upstream result.md files). */
  inputs: string[];
  /** Worktree branch the work is on, when the member has one. */
  branch?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
  /** Delivering the task failed (and is retried); cleared by a delivery. */
  deliveryError?: string;
  /** Times the task or a follow-up reached the member. */
  turns: number;
  /** When a follow-up (af tell) last put it back to work. */
  reopenedAt?: string;
  /** Times the member went on working by itself after the ticket was closed (its result was taken): reopened. */
  resumed?: number;
  /** When the ticket had been closed, the last time it went on by itself (a message written before it is older). */
  resumedAfter?: string;
  progress?: string;
  report?: TicketReport;
  outcome?: CloseOutcome;
  closeNote?: string;
  closedAt?: string;
  /** A ticket another team works on: the member is that team's router. */
  team?: string;
}

export type QueueKind = "user" | "ask" | "asking" | "approval" | "stuck" | "exited" | "error" | "submit" | "turn" | "report";
export type QueueState = "queued" | "taken" | "handled";

export interface QueueItem {
  seq: number;
  kind: QueueKind;
  ticket?: string;
  /** Member it came from ("user" for the user, or the parent team's manager). */
  from?: string;
  /** Suggested next member (af submit --to). */
  to?: string;
  /** First lines: what the manager reads in its queue. */
  text: string;
  /** A file with the whole thing (result.md, a report). */
  path?: string;
  /** asking: the options on the member's screen, numbered from 1. */
  options?: string[];
  state: QueueState;
  /** The manager was told about it (a notice reached its terminal). */
  notified?: boolean;
  at: string;
}

/**
 * Text for a member's terminal that agent-flow types in when the member is free: a follow-up (af tell), an answer
 * to its question (af reply), the router's first message, "continue" after a passing API error. Stored before it is
 * sent, so a restart does not lose it.
 */
export interface Outgoing {
  id: string;
  member: string;
  /** context: the project context in the team's agent.md changed (see server context.ts). */
  kind: "tell" | "reply" | "brief" | "continue" | "context";
  text: string;
  ticket?: string;
  at: string;
  delivered?: string;
  /** Not delivered: a newer message replaced it (a later change of the project context). */
  dropped?: boolean;
}

export type AttentionKind = "approval" | "loop_limit" | "exited" | "startup" | "unhandled" | "notice_ignored" | "report" | "error";

export interface Attention {
  id: string;
  kind: AttentionKind;
  text: string;
  member?: string;
  ticket?: string;
  at: string;
}

type E<T extends string, P> = { type: T; at: string } & P;

export type TeamEvent = (
  | E<"team.created", { meta: TeamMeta }>
  | E<"team.stopped", {}>
  | E<"team.workspace", { machine: string; workspace: string }>
  | E<"team.delegate", { on: boolean }>
  | E<"member.added", { member: Member }>
  | E<"member.placed", { name: string; paneId: string; tabId: string }>
  | E<"member.status", { name: string; status: AgentStatus }>
  | E<"ticket.opened", { ticket: Ticket }>
  | E<"ticket.delivered", { id: string }>
  | E<"ticket.delivery_failed", { id: string; error: string }>
  | E<"ticket.progress", { id: string; text: string }>
  | E<"ticket.submitted", { id: string; report: TicketReport }>
  | E<"ticket.reopened", { id: string }>
  | E<"ticket.resumed", { id: string }>
  | E<"ticket.closed", { id: string; outcome: CloseOutcome; note?: string }>
  | E<"thread.max", { thread: string; max: number }>
  | E<"queue.added", { item: QueueItem }>
  | E<"queue.notified", { seqs: number[] }>
  | E<"queue.taken", { seqs: number[] }>
  | E<"queue.handled", { seqs: number[] }>
  | E<"message.queued", { message: Outgoing }>
  | E<"message.delivered", { id: string }>
  | E<"message.dropped", { ids: string[] }>
  | E<"attention.raised", { attention: Attention }>
  | E<"attention.resolved", { id: string }>
) & { seq?: number };

export interface TeamState {
  meta?: TeamMeta;
  stopped: boolean;
  members: Record<string, Member>;
  tickets: Record<string, Ticket>;
  /** Ticket ids in the order they were opened. */
  order: string[];
  queue: QueueItem[];
  outbox: Outgoing[];
  attention: Record<string, Attention>;
  seq: number;
}

export const emptyTeam = (): TeamState => ({ stopped: false, members: {}, tickets: {}, order: [], queue: [], outbox: [], attention: {}, seq: 0 });

export const DEFAULT_MAX_ROUNDS = 3;

export function applyTeam(s: TeamState, ev: TeamEvent): TeamState {
  if (ev.seq !== undefined) s.seq = ev.seq;
  const t = (id: string) => s.tickets[id];
  switch (ev.type) {
    case "team.created":
      s.meta = ev.meta;
      break;
    case "team.stopped":
      s.stopped = true;
      break;
    case "team.workspace":
      if (s.meta) s.meta.workspaces = { ...(s.meta.workspaces ?? {}), [ev.machine]: ev.workspace };
      break;
    case "team.delegate":
      if (s.meta) s.meta.delegate = ev.on;
      break;
    case "member.added":
      s.members[ev.member.name] = { ...ev.member };
      break;
    case "member.placed": {
      const m = s.members[ev.name];
      if (m) Object.assign(m, { paneId: ev.paneId, tabId: ev.tabId });
      break;
    }
    case "member.status": {
      const m = s.members[ev.name];
      if (m) m.status = ev.status;
      break;
    }
    case "ticket.opened":
      s.tickets[ev.ticket.id] = { ...ev.ticket, inputs: [...ev.ticket.inputs] };
      s.order.push(ev.ticket.id);
      break;
    case "ticket.delivered": {
      const k = t(ev.id);
      if (!k) break;
      if (k.status === "open") k.status = "working";
      k.deliveredAt ??= ev.at;
      k.deliveryError = undefined;
      k.turns++;
      k.updatedAt = ev.at;
      break;
    }
    case "ticket.delivery_failed": {
      const k = t(ev.id);
      if (k) Object.assign(k, { deliveryError: ev.error, updatedAt: ev.at });
      break;
    }
    case "ticket.progress": {
      const k = t(ev.id);
      if (k) Object.assign(k, { progress: ev.text, updatedAt: ev.at });
      break;
    }
    case "ticket.submitted": {
      const k = t(ev.id);
      if (k && k.status !== "closed") Object.assign(k, { status: "submitted", report: ev.report, updatedAt: ev.at });
      break;
    }
    case "ticket.reopened": {
      const k = t(ev.id);
      if (k && k.status !== "closed") {
        k.status = "working";
        k.turns++;
        k.reopenedAt = ev.at;
        k.updatedAt = ev.at;
      }
      break;
    }
    case "ticket.resumed": {
      // the member went on after its result was taken (a background task woke it, or someone typed to it): the
      // ticket is open again, so what it says next reaches the manager too
      const k = t(ev.id);
      if (k && k.status === "closed") {
        Object.assign(k, { status: "working", reopenedAt: ev.at, updatedAt: ev.at, resumed: (k.resumed ?? 0) + 1, resumedAfter: k.closedAt });
        k.turns++;
        delete k.outcome;
        delete k.closeNote;
        delete k.closedAt;
        delete k.report;
      }
      break;
    }
    case "ticket.closed": {
      const k = t(ev.id);
      if (k && k.status !== "closed") Object.assign(k, { status: "closed", outcome: ev.outcome, closeNote: ev.note, closedAt: ev.at, updatedAt: ev.at });
      break;
    }
    case "thread.max": {
      const k = t(ev.thread);
      if (k) k.max = ev.max;
      break;
    }
    case "queue.added":
      s.queue.push({ ...ev.item });
      break;
    case "queue.notified":
      for (const q of s.queue) if (ev.seqs.includes(q.seq)) q.notified = true;
      break;
    case "queue.taken":
      for (const q of s.queue) if (ev.seqs.includes(q.seq) && q.state === "queued") q.state = "taken";
      break;
    case "queue.handled":
      for (const q of s.queue) if (ev.seqs.includes(q.seq)) q.state = "handled";
      break;
    case "message.queued":
      s.outbox.push({ ...ev.message });
      break;
    case "message.delivered": {
      const m = s.outbox.find((x) => x.id === ev.id);
      if (m) m.delivered = ev.at;
      break;
    }
    case "message.dropped":
      for (const m of s.outbox) if (ev.ids.includes(m.id) && !m.delivered) Object.assign(m, { delivered: ev.at, dropped: true });
      break;
    case "attention.raised":
      s.attention[ev.attention.id] = ev.attention;
      break;
    case "attention.resolved":
      delete s.attention[ev.id];
      break;
    default: {
      const never: never = ev;
      throw new Error(`unknown team event ${JSON.stringify(never)}`);
    }
  }
  return s;
}

export const replayTeam = (events: Iterable<TeamEvent>) => {
  const s = emptyTeam();
  for (const ev of events) applyTeam(s, ev);
  return s;
};

// ---------------------------------------------------------------------------------------------
// queries

export const ticketList = (s: TeamState) => s.order.map((id) => s.tickets[id]!).filter(Boolean);

/** The ticket a member is on now: the oldest one delivered and not closed, else none. */
export const currentTicket = (s: TeamState, member: string) =>
  ticketList(s).find((k) => k.assignee === member && (k.status === "working" || k.status === "submitted"));

/** Tickets waiting to be delivered to a member, oldest first. */
export const waitingTickets = (s: TeamState, member: string) => ticketList(s).filter((k) => k.assignee === member && k.status === "open");

/** Rounds `member` has had in `thread` so far. */
export const roundsIn = (s: TeamState, thread: string, member: string) => ticketList(s).filter((k) => k.thread === thread && k.assignee === member).length;

/** The most rounds a member may have in `thread`. */
export const threadMax = (s: TeamState, thread: string) => s.tickets[thread]?.max ?? DEFAULT_MAX_ROUNDS;

/** Queue items in the order the manager should handle them: the user first, then problems, then results. */
const PRIORITY: Record<QueueKind, number> = { user: 0, ask: 1, asking: 1, approval: 1, stuck: 1, exited: 1, error: 1, submit: 2, turn: 2, report: 2 };
export const byPriority = (items: QueueItem[]) => [...items].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.seq - b.seq);

/** Messages for a member not typed in yet, oldest first. */
export const pendingMessages = (s: TeamState, member: string) => s.outbox.filter((m) => m.member === member && !m.delivered);

/**
 * When the ticket's latest turn of work began or was dealt with: its delivery, a follow-up, its report, or the
 * last queue item about the end of a turn. A turn that ended after this is new.
 */
export function lastTurnMark(s: TeamState, k: Ticket): number {
  const at = [k.deliveredAt, k.reopenedAt, k.report?.at, ...s.queue.filter((q) => q.ticket === k.id && (q.kind === "turn" || q.kind === "submit")).map((q) => q.at)];
  return Math.max(0, ...at.filter((x): x is string => !!x).map((x) => Date.parse(x)));
}

export const queued = (s: TeamState) => s.queue.filter((q) => q.state === "queued");
export const takenUnhandled = (s: TeamState) => s.queue.filter((q) => q.state === "taken");

/**
 * Is a question on an agent's screen a permission or trust prompt (for the user only), rather than a question about
 * the task (which the manager may answer)? Claude's "Do you want to proceed?", "Do you want to make this edit",
 * codex's "Would you like to run the following command?", gemini's "Allow execution", every agent's folder trust.
 */
export function isApproval(text: string | undefined) {
  if (!text) return false;
  return /\btrust\b|do you want to (proceed|make this edit|create|overwrite|allow)|would you like to (run|make|apply)|allow (execution|this|once|always)|always allow|don'?t ask again|permission|approve|apply (this|the) (change|patch)|sandbox|run the following command|enter (gemini )?api key|log ?in/i.test(text);
}

export type StageKey = "undelivered" | "asking" | "approval" | "review" | "blocked" | "failed" | "queued" | "working" | "idle" | "done" | "dropped" | "cancelled" | "exited";

/** What the member's pane shows, as far as the stage needs it. */
export interface PaneLook {
  /** Herdr's status, or "background": done/idle while background work it started still runs. */
  status?: string;
  /** The question on its screen, if any. */
  asking?: string;
}

/** A pane as the ticket stage sees it (from HPane: agentStatus, background, asking). */
export const paneLook = (p: { agentStatus: string; background?: number; asking?: string }): PaneLook => ({
  status: (p.agentStatus === "done" || p.agentStatus === "idle") && (p.background ?? 0) > 0 ? "background" : p.agentStatus,
  asking: p.asking,
});

/**
 * A ticket's stage: the one answer the timeline, the swim lanes and Needs you all use (docs/design.md 4.7). The
 * first matching rule wins.
 */
export function ticketStage(k: Ticket, member: Member | undefined, pane?: PaneLook): StageKey {
  if (k.status === "closed") return k.outcome === "failed" ? "failed" : k.outcome === "dropped" ? "dropped" : k.outcome === "cancelled" ? "cancelled" : "done";
  if (k.deliveryError) return "undelivered";
  // a ticket a whole team works on: working until its router reports it done
  if (k.team) return k.status === "submitted" ? "review" : k.status === "open" ? "queued" : "working";
  // a question on the member's screen: about this ticket when it is the one being worked on, or when the member is
  // stuck on a prompt while starting (folder trust, login) before it got any ticket
  const live = k.status === "working" || k.status === "submitted" || (k.status === "open" && member?.status === "blocked");
  if (live && (pane?.asking || pane?.status === "blocked")) return isApproval(pane?.asking) || k.status === "open" ? "approval" : "asking";
  if (k.status === "submitted") {
    const r = k.report?.status;
    return r === "blocked" ? "blocked" : r === "failed" ? "failed" : r === "dropped" ? "dropped" : "review";
  }
  if (k.status === "open") return "queued";
  if (member?.status === "exited") return "exited";
  return pane?.status === "working" || pane?.status === "background" ? "working" : "idle";
}

export const STAGE_LABEL: Record<StageKey, string> = {
  undelivered: "not delivered",
  asking: "asking",
  approval: "needs your approval",
  review: "finished",
  blocked: "blocked",
  failed: "failed",
  queued: "queued",
  working: "working",
  idle: "idle, not submitted",
  done: "done",
  dropped: "nothing to do",
  cancelled: "cancelled",
  exited: "exited",
};

/** Ticket ids: T1, T2, ... */
export const nextTicketId = (s: TeamState) => `T${s.order.length + 1}`;

/** Herdr agent names must match [a-z][a-z0-9_-]{0,31} and be unique server-wide, so they carry the team id. */
export const herdrMemberName = (team: string, member: string) => `${team}-${member}`.slice(0, 32);

export const memberBranch = (team: string, member: string) => `af/${team}/${member}`;
