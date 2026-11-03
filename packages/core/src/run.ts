// Run-level state: everything in a run's events.jsonl. Graph events are delegated to the graph engine;
// the rest (agents, mail, attention, git, opens) are recorded by the server as they happen.
// Shared by the server (to rebuild state on restart) and the web UI (to replay and follow live).

import { type AgentKind, type GraphEvent, type GraphState, apply as applyGraph, emptyGraph } from "./graph.ts";

export type AgentStatus = "starting" | "idle" | "working" | "blocked" | "done" | "unknown" | "exited";

export interface RunMeta {
  id: string;
  createdAt: string;
  /** Directory the run was started in. */
  cwd: string;
  /** Git top-level of cwd, when cwd is inside a git repo. */
  repo?: string;
  /** Commit the integration branch started from. */
  base?: string;
  /** Integration branch, e.g. af/r4k2/main. */
  branch?: string;
  /** Worktree that has the integration branch checked out. Shared nodes run here. */
  integration?: string;
  lead: string;
  team?: string;
  /** Workflow template the run was started from, and the goal it was given. */
  workflow?: string;
  goal?: string;
  /** The lead is a session the user already had (af here), not one agent-flow started. */
  attached?: boolean;
  herdrWorkspace?: string;
}

export interface AgentRec {
  name: string;
  kind: AgentKind;
  role?: string;
  /** Name registered in Herdr; unique across the whole Herdr server, so it carries the run id. */
  herdrName: string;
  paneId?: string;
  tabId?: string;
  cwd: string;
  /** For agents created for a node with --kind: the node that owns it. */
  node?: string;
  status: AgentStatus;
  spawnedAt: string;
  /** Session id agent-flow gave the agent at launch (claude --session-id), to find its transcript. */
  session?: string;
}

export type MailKind = "task" | "message" | "reply" | "system";

export interface Mail {
  id: string;
  from: string;
  to: string;
  kind: MailKind;
  body: string;
  /** Instance label this message is about, e.g. code#2. */
  node?: string;
  attachments?: string[];
  replyTo?: string;
  at: string;
}

export type AttentionKind = "blocked" | "startup_blocked" | "merge_conflict" | "loop_limit" | "agent_exited" | "no_submit" | "lead";

export interface Attention {
  id: string;
  kind: AttentionKind;
  text: string;
  agent?: string;
  node?: string;
  at: string;
}

export interface OpenRequest {
  id: string;
  by: string;
  target: string;
  /** Set when a worker opened it: the UI attaches it to that node instead of the main area. */
  node?: string;
  at: string;
}

type E<T extends string, P> = { type: T; at: string } & P;

export type ServerEvent =
  | E<"run.created", { meta: RunMeta }>
  | E<"run.stopped", {}>
  | E<"agent.spawned", { agent: AgentRec }>
  | E<"agent.placed", { name: string; paneId: string; tabId: string }>
  | E<"agent.status", { name: string; status: AgentStatus }>
  | E<"mail.sent", { mail: Mail }>
  | E<"mail.read", { agent: string; ids: string[] }>
  | E<"mail.delivered", { agent: string; ids: string[] }>
  | E<"attention.raised", { attention: Attention }>
  | E<"attention.resolved", { id: string }>
  | E<"open.requested", { open: OpenRequest }>
  | E<"git.committed", { node: string; n: number; commit: string }>
  | E<"git.merged", { node: string; n: number; commit: string }>
  | E<"git.merge_failed", { node: string; n: number; files: string[] }>;

export type RunEvent = (GraphEvent | ServerEvent) & { seq?: number };

export interface RunState {
  meta?: RunMeta;
  stopped: boolean;
  graph: GraphState;
  agents: Record<string, AgentRec>;
  mail: Mail[];
  /** Per agent: ids of messages it has read with `af inbox`. */
  read: Record<string, string[]>;
  /** Per agent: ids whose wake-up notice reached the agent's terminal. */
  delivered: Record<string, string[]>;
  attention: Record<string, Attention>;
  opens: OpenRequest[];
  commits: { node: string; n: number; commit: string; kind: "committed" | "merged"; at: string }[];
  seq: number;
}

export const emptyRun = (): RunState => ({
  stopped: false,
  graph: emptyGraph(),
  agents: {},
  mail: [],
  read: {},
  delivered: {},
  attention: {},
  opens: [],
  commits: [],
  seq: 0,
});

const GRAPH_PREFIXES = ["node.", "edge.", "instance."];
export const isGraphEvent = (ev: RunEvent): ev is GraphEvent & { seq?: number } =>
  ev.type === "run.quiescent" || GRAPH_PREFIXES.some((p) => ev.type.startsWith(p));

export function applyRun(s: RunState, ev: RunEvent): RunState {
  if (ev.seq !== undefined) s.seq = ev.seq;
  if (isGraphEvent(ev)) {
    applyGraph(s.graph, ev);
    return s;
  }
  const e = ev as ServerEvent;
  switch (e.type) {
    case "run.created":
      s.meta = e.meta;
      break;
    case "run.stopped":
      s.stopped = true;
      break;
    case "agent.spawned":
      s.agents[e.agent.name] = { ...e.agent };
      break;
    case "agent.placed": {
      const a = s.agents[e.name];
      if (a) Object.assign(a, { paneId: e.paneId, tabId: e.tabId });
      break;
    }
    case "agent.status": {
      const a = s.agents[e.name];
      if (a) a.status = e.status;
      break;
    }
    case "mail.sent":
      s.mail.push(e.mail);
      break;
    case "mail.read":
      (s.read[e.agent] ??= []).push(...e.ids);
      break;
    case "mail.delivered":
      (s.delivered[e.agent] ??= []).push(...e.ids);
      break;
    case "attention.raised":
      s.attention[e.attention.id] = e.attention;
      break;
    case "attention.resolved":
      delete s.attention[e.id];
      break;
    case "open.requested":
      s.opens.push(e.open);
      break;
    case "git.committed":
      s.commits.push({ node: e.node, n: e.n, commit: e.commit, kind: "committed", at: e.at });
      break;
    case "git.merged":
      s.commits.push({ node: e.node, n: e.n, commit: e.commit, kind: "merged", at: e.at });
      break;
    case "git.merge_failed":
      break;
    default: {
      const never: never = e;
      throw new Error(`unknown run event ${JSON.stringify(never)}`);
    }
  }
  return s;
}

export const replayRun = (events: Iterable<RunEvent>) => {
  const s = emptyRun();
  for (const ev of events) applyRun(s, ev);
  return s;
};

export const unreadMail = (s: RunState, agent: string) => {
  const read = new Set(s.read[agent] ?? []);
  return s.mail.filter((m) => m.to === agent && !read.has(m.id));
};

export const undeliveredMail = (s: RunState, agent: string) => {
  const done = new Set([...(s.delivered[agent] ?? []), ...(s.read[agent] ?? [])]);
  return s.mail.filter((m) => m.to === agent && !done.has(m.id));
};

/** Agent name -> Herdr agent name. Herdr names must match [a-z][a-z0-9_-]{0,31} and be unique server-wide. */
export const herdrAgentName = (run: string, agent: string) => `${run}-${agent}`.slice(0, 32);

export const integrationBranch = (run: string) => `af/${run}/main`;
export const nodeBranch = (run: string, node: string) => `af/${run}/node/${node}`;
