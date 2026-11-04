// Graph engine for agent-flow: a cyclic graph of nodes whose executions are unrolled into immutable instances.
//
// Event-sourced:
//   decide(state, command, now) -> events   validates a command and returns every resulting event,
//                                           including derived ones (edge firing, new instances, loop limits).
//   apply(state, event)         -> state    applies one event mechanically. No scheduling decisions here,
//                                           so replaying events.jsonl through apply() rebuilds the exact state.
//
// Side effects (spawning agents, git merges, messages) are not this module's job. The server reads the
// state and the emitted events and acts on them.

export const NODE_ID = /^[a-z][a-z0-9_-]{0,31}$/;
export const DEFAULT_LOOP_MAX = 3;

export type AgentKind = "claude" | "codex" | "omp" | "gemini";
export const AGENT_KINDS: readonly AgentKind[] = ["claude", "codex", "omp", "gemini"];

export type Executor = { kind: AgentKind } | { agent: string };
export type Isolation = "isolated" | "shared";

export interface NodeSpec {
  task: string;
  executor: Executor;
  isolation: Isolation;
  /** When true, a ready instance waits for an explicit `instance.start` before the server dispatches it. */
  hold: boolean;
  /** When true, the server accepts a submission without asking the lead. */
  autoAccept: boolean;
}

export interface InstanceRef {
  node: string;
  n: number;
}

export type InstanceState = "ready" | "running" | "submitted" | "accepted" | "cancelled";
export const ACTIVE_STATES: readonly InstanceState[] = ["ready", "running", "submitted"];

export type Trigger = { type: "root" } | { type: "forward" } | { type: "back"; edge: string } | { type: "manual" };

export interface Submission {
  outcome?: string;
  result?: string;
  note?: string;
  at: string;
}

export interface Instance {
  node: string;
  n: number;
  state: InstanceState;
  held: boolean;
  trigger: Trigger;
  /** Upstream instances whose results this instance consumes. */
  inputs: InstanceRef[];
  agent?: string;
  submissions: Submission[];
  rejections: { reason: string; at: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface GraphNode {
  id: string;
  spec: NodeSpec;
  removed: boolean;
  instances: Instance[];
  /** Back-edge triggers waiting for this node to become free. */
  backQueue: { edge: string; from: InstanceRef }[];
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  /** Fires only when the source instance's outcome equals this. Undefined matches any outcome. */
  on?: string;
  /** True when the edge closes a cycle. Back edges must be conditional and are capped by `max`. */
  back: boolean;
  max: number;
  fired: number;
  /** Forward edges only: accepted source instances not yet consumed by the target. */
  queue: InstanceRef[];
  /** Back edges only: a matching source instance that arrived after `fired` reached `max`. */
  blocked?: InstanceRef;
  removed: boolean;
}

export interface GraphState {
  nodes: Record<string, GraphNode>;
  edges: Record<string, Edge>;
  /** Node ids in insertion order, so scheduling is deterministic. */
  order: string[];
  quiescent: boolean;
}

export type NodeSpecInput = { task: string } & Partial<Omit<NodeSpec, "task">>;

export type Command =
  | { type: "node.add"; id: string; spec: NodeSpecInput; after?: { from: string; on?: string }[] }
  | { type: "node.edit"; id: string; patch: Partial<NodeSpec> }
  | { type: "node.remove"; id: string }
  | { type: "edge.link"; from: string; to: string; on?: string; max?: number }
  | { type: "edge.unlink"; from: string; to: string }
  | { type: "edge.set_max"; from: string; to: string; max: number }
  | { type: "instance.start"; node: string }
  | { type: "instance.dispatch"; node: string; agent: string }
  | { type: "instance.submit"; node: string; agent?: string; outcome?: string; result?: string; note?: string }
  | { type: "instance.accept"; node: string }
  | { type: "instance.reject"; node: string; reason: string }
  | { type: "instance.cancel"; node: string }
  /** Start a new instance of an idle node by hand, e.g. after its agent died and the instance was cancelled. */
  | { type: "instance.retry"; node: string };

type E<T extends string, P> = { type: T; at: string } & P;

export type GraphEvent =
  | E<"node.added", { id: string; spec: NodeSpec }>
  | E<"node.edited", { id: string; patch: Partial<NodeSpec> }>
  | E<"node.removed", { id: string }>
  | E<"edge.added", { id: string; from: string; to: string; on?: string; back: boolean; max: number }>
  | E<"edge.removed", { id: string }>
  | E<"edge.max_set", { id: string; max: number }>
  | E<"edge.queued", { id: string; from: InstanceRef }>
  | E<"edge.fired_back", { id: string; from: InstanceRef }>
  | E<"edge.limited", { id: string; from: InstanceRef }>
  | E<"instance.created", { node: string; n: number; trigger: Trigger; inputs: InstanceRef[]; held: boolean }>
  | E<"instance.released", { node: string; n: number }>
  | E<"instance.dispatched", { node: string; n: number; agent: string }>
  | E<"instance.submitted", { node: string; n: number; outcome?: string; result?: string; note?: string }>
  | E<"instance.accepted", { node: string; n: number }>
  | E<"instance.rejected", { node: string; n: number; reason: string }>
  | E<"instance.cancelled", { node: string; n: number }>
  | E<"run.quiescent", {}>;

export class GraphError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

// ---------------------------------------------------------------------------------------------
// Queries

export const emptyGraph = (): GraphState => ({ nodes: {}, edges: {}, order: [], quiescent: false });

export const edgeId = (from: string, to: string) => `${from}->${to}`;

export const liveNodes = (s: GraphState) => s.order.map((id) => s.nodes[id]!).filter((n) => !n.removed);

export const liveEdges = (s: GraphState) => Object.values(s.edges).filter((e) => !e.removed);

export const latestInstance = (n: GraphNode): Instance | undefined => n.instances[n.instances.length - 1];

export const activeInstance = (n: GraphNode): Instance | undefined => {
  const i = latestInstance(n);
  return i && ACTIVE_STATES.includes(i.state) ? i : undefined;
};

export const forwardInEdges = (s: GraphState, node: string) => liveEdges(s).filter((e) => e.to === node && !e.back);

export const outEdges = (s: GraphState, node: string) => liveEdges(s).filter((e) => e.from === node);

export const instanceLabel = (r: InstanceRef) => `${r.node}#${r.n}`;

export const getInstance = (s: GraphState, r: InstanceRef): Instance | undefined => s.nodes[r.node]?.instances[r.n - 1];

/** True when `to` can reach `from` through live forward edges, i.e. adding from->to would close a cycle. */
export function wouldCloseCycle(s: GraphState, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [to];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === from) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const e of liveEdges(s)) if (e.from === cur && !e.back) stack.push(e.to);
  }
  return false;
}

const outcomeMatches = (on: string | undefined, outcome: string | undefined) => on === undefined || on === outcome;

// ---------------------------------------------------------------------------------------------
// apply: mechanical, no decisions

export function apply(s: GraphState, ev: GraphEvent): GraphState {
  const node = (id: string) => {
    const n = s.nodes[id];
    if (!n) throw new GraphError("corrupt_log", `event ${ev.type} references unknown node ${id}`);
    return n;
  };
  const edge = (id: string) => {
    const e = s.edges[id];
    if (!e) throw new GraphError("corrupt_log", `event ${ev.type} references unknown edge ${id}`);
    return e;
  };
  const inst = (id: string, n: number) => {
    const i = node(id).instances[n - 1];
    if (!i) throw new GraphError("corrupt_log", `event ${ev.type} references unknown instance ${id}#${n}`);
    i.updatedAt = ev.at;
    return i;
  };

  switch (ev.type) {
    case "node.added":
      s.nodes[ev.id] = { id: ev.id, spec: { ...ev.spec }, removed: false, instances: [], backQueue: [] };
      s.order.push(ev.id);
      break;
    case "node.edited":
      Object.assign(node(ev.id).spec, ev.patch);
      break;
    case "node.removed":
      node(ev.id).removed = true;
      node(ev.id).backQueue = [];
      break;
    case "edge.added":
      s.edges[ev.id] = { id: ev.id, from: ev.from, to: ev.to, on: ev.on, back: ev.back, max: ev.max, fired: 0, queue: [], removed: false };
      break;
    case "edge.removed": {
      const e = edge(ev.id);
      e.removed = true;
      e.queue = [];
      e.blocked = undefined;
      break;
    }
    case "edge.max_set":
      edge(ev.id).max = ev.max;
      break;
    case "edge.queued":
      edge(ev.id).queue.push(ev.from);
      break;
    case "edge.fired_back": {
      const e = edge(ev.id);
      e.fired += 1;
      e.blocked = undefined;
      node(e.to).backQueue.push({ edge: e.id, from: ev.from });
      break;
    }
    case "edge.limited":
      edge(ev.id).blocked = ev.from;
      break;
    case "instance.created": {
      const n = node(ev.node);
      if (ev.trigger.type === "back") n.backQueue.shift();
      if (ev.trigger.type === "forward") for (const e of forwardInEdges(s, ev.node)) e.queue.shift();
      n.instances.push({
        node: ev.node,
        n: ev.n,
        state: "ready",
        held: ev.held,
        trigger: ev.trigger,
        inputs: ev.inputs,
        submissions: [],
        rejections: [],
        createdAt: ev.at,
        updatedAt: ev.at,
      });
      s.quiescent = false;
      break;
    }
    case "instance.released":
      inst(ev.node, ev.n).held = false;
      break;
    case "instance.dispatched": {
      const i = inst(ev.node, ev.n);
      i.state = "running";
      i.agent = ev.agent;
      break;
    }
    case "instance.submitted": {
      const i = inst(ev.node, ev.n);
      i.state = "submitted";
      i.submissions.push({ outcome: ev.outcome, result: ev.result, note: ev.note, at: ev.at });
      break;
    }
    case "instance.accepted":
      inst(ev.node, ev.n).state = "accepted";
      break;
    case "instance.rejected": {
      const i = inst(ev.node, ev.n);
      i.state = "running";
      i.rejections.push({ reason: ev.reason, at: ev.at });
      break;
    }
    case "instance.cancelled":
      inst(ev.node, ev.n).state = "cancelled";
      break;
    case "run.quiescent":
      s.quiescent = true;
      break;
    default: {
      const never: never = ev;
      throw new GraphError("corrupt_log", `unknown event ${JSON.stringify(never)}`);
    }
  }
  return s;
}

export const replay = (events: Iterable<GraphEvent>, from: GraphState = emptyGraph()) => {
  let s = from;
  for (const ev of events) s = apply(s, ev);
  return s;
};

// ---------------------------------------------------------------------------------------------
// decide: validation + every derived event

const clone = (s: GraphState): GraphState => structuredClone(s);

function normalizeSpec(input: NodeSpecInput): NodeSpec {
  return {
    task: input.task,
    executor: input.executor ?? { kind: "claude" },
    isolation: input.isolation ?? "isolated",
    hold: input.hold ?? false,
    autoAccept: input.autoAccept ?? false,
  };
}

function validateSpec(spec: Partial<NodeSpec>) {
  if (spec.task !== undefined && !spec.task.trim()) throw new GraphError("invalid_task", "task must not be empty");
  if (spec.executor) {
    if ("kind" in spec.executor && !AGENT_KINDS.includes(spec.executor.kind))
      throw new GraphError("invalid_executor", `unknown agent kind ${spec.executor.kind}; expected one of ${AGENT_KINDS.join(", ")}`);
    if ("agent" in spec.executor && !NODE_ID.test(spec.executor.agent))
      throw new GraphError("invalid_executor", `invalid agent name ${spec.executor.agent}`);
  }
  if (spec.isolation && spec.isolation !== "isolated" && spec.isolation !== "shared")
    throw new GraphError("invalid_isolation", `isolation must be isolated or shared`);
}

/**
 * Validate `cmd` against `state` and return every event it causes, in order.
 * Throws GraphError when the command is invalid. Never mutates `state`.
 */
export function decide(state: GraphState, cmd: Command, now: string): GraphEvent[] {
  const s = clone(state);
  const out: GraphEvent[] = [];
  const emit = (ev: GraphEvent) => {
    out.push(ev);
    apply(s, ev);
  };
  const at = now;

  const requireNode = (id: string) => {
    const n = s.nodes[id];
    if (!n || n.removed) throw new GraphError("unknown_node", `no node named ${id}`);
    return n;
  };
  const requireActive = (id: string, states: InstanceState[], verb: string) => {
    const n = requireNode(id);
    const i = activeInstance(n);
    if (!i || !states.includes(i.state)) {
      const cur = latestInstance(n);
      const where = cur ? `${instanceLabel(cur)} is ${cur.state}` : "it has no instance yet";
      throw new GraphError("invalid_state", `cannot ${verb} ${id}: ${where}`);
    }
    return i;
  };
  const linkEvents = (from: string, to: string, on: string | undefined, max: number | undefined) => {
    requireNode(from);
    requireNode(to);
    const id = edgeId(from, to);
    if (s.edges[id] && !s.edges[id]!.removed) throw new GraphError("duplicate_edge", `edge ${id} already exists`);
    const back = wouldCloseCycle(s, from, to);
    if (back && on === undefined)
      throw new GraphError("back_edge_requires_condition", `${id} closes a cycle, so it needs --on <outcome> to avoid an endless loop`);
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) throw new GraphError("invalid_max", "--max must be a positive integer");
    if (!back && max !== undefined) throw new GraphError("invalid_max", `--max only applies to edges that close a cycle; ${id} does not`);
    emit({ type: "edge.added", at, id, from, to, on, back, max: back ? (max ?? DEFAULT_LOOP_MAX) : 0 });
    // Late binding: a forward edge from a node that already finished fires for its latest accepted instance.
    if (!back) {
      const last = latestInstance(s.nodes[from]!);
      if (last?.state === "accepted" && outcomeMatches(on, last.submissions.at(-1)?.outcome))
        emit({ type: "edge.queued", at, id, from: { node: from, n: last.n } });
    }
  };

  switch (cmd.type) {
    case "node.add": {
      if (!NODE_ID.test(cmd.id)) throw new GraphError("invalid_node_id", `node id must match ${NODE_ID}`);
      if (s.nodes[cmd.id]) throw new GraphError("duplicate_node", `node ${cmd.id} already exists (ids are never reused)`);
      const spec = normalizeSpec(cmd.spec);
      validateSpec(spec);
      for (const a of cmd.after ?? []) requireNode(a.from);
      emit({ type: "node.added", at, id: cmd.id, spec });
      for (const a of cmd.after ?? []) linkEvents(a.from, cmd.id, a.on, undefined);
      break;
    }
    case "node.edit": {
      const n = requireNode(cmd.id);
      validateSpec(cmd.patch);
      const busy = activeInstance(n);
      if (busy && busy.state !== "ready")
        throw new GraphError("node_busy", `${instanceLabel(busy)} is ${busy.state}; cancel it before editing ${cmd.id}`);
      emit({ type: "node.edited", at, id: cmd.id, patch: cmd.patch });
      break;
    }
    case "node.remove": {
      const n = requireNode(cmd.id);
      const busy = activeInstance(n);
      if (busy && busy.state !== "ready")
        throw new GraphError("node_busy", `${instanceLabel(busy)} is ${busy.state}; cancel it before removing ${cmd.id}`);
      if (busy) emit({ type: "instance.cancelled", at, node: busy.node, n: busy.n });
      for (const e of liveEdges(s)) if (e.from === cmd.id || e.to === cmd.id) emit({ type: "edge.removed", at, id: e.id });
      emit({ type: "node.removed", at, id: cmd.id });
      break;
    }
    case "edge.link":
      linkEvents(cmd.from, cmd.to, cmd.on, cmd.max);
      break;
    case "edge.unlink": {
      const e = s.edges[edgeId(cmd.from, cmd.to)];
      if (!e || e.removed) throw new GraphError("unknown_edge", `no edge ${edgeId(cmd.from, cmd.to)}`);
      emit({ type: "edge.removed", at, id: e.id });
      break;
    }
    case "edge.set_max": {
      const e = s.edges[edgeId(cmd.from, cmd.to)];
      if (!e || e.removed) throw new GraphError("unknown_edge", `no edge ${edgeId(cmd.from, cmd.to)}`);
      if (!e.back) throw new GraphError("invalid_max", `${e.id} does not close a cycle, so it has no loop limit`);
      if (!Number.isInteger(cmd.max) || cmd.max < 1) throw new GraphError("invalid_max", "--max must be a positive integer");
      emit({ type: "edge.max_set", at, id: e.id, max: cmd.max });
      break;
    }
    case "instance.start": {
      const i = requireActive(cmd.node, ["ready"], "start");
      if (!i.held) throw new GraphError("invalid_state", `${instanceLabel(i)} is not on hold`);
      emit({ type: "instance.released", at, node: i.node, n: i.n });
      break;
    }
    case "instance.dispatch": {
      const i = requireActive(cmd.node, ["ready"], "dispatch");
      if (i.held) throw new GraphError("held", `${instanceLabel(i)} is on hold; start it first`);
      emit({ type: "instance.dispatched", at, node: i.node, n: i.n, agent: cmd.agent });
      break;
    }
    case "instance.submit": {
      const i = requireActive(cmd.node, ["running"], "submit");
      if (cmd.agent !== undefined && i.agent !== cmd.agent)
        throw new GraphError("wrong_agent", `${instanceLabel(i)} is assigned to ${i.agent}, not ${cmd.agent}`);
      emit({ type: "instance.submitted", at, node: i.node, n: i.n, outcome: cmd.outcome, result: cmd.result, note: cmd.note });
      break;
    }
    case "instance.accept": {
      const i = requireActive(cmd.node, ["submitted"], "accept");
      emit({ type: "instance.accepted", at, node: i.node, n: i.n });
      const outcome = i.submissions.at(-1)?.outcome;
      const ref = { node: i.node, n: i.n };
      for (const e of outEdges(s, i.node)) {
        if (!outcomeMatches(e.on, outcome)) continue;
        if (!e.back) emit({ type: "edge.queued", at, id: e.id, from: ref });
        else if (e.fired < e.max) emit({ type: "edge.fired_back", at, id: e.id, from: ref });
        else emit({ type: "edge.limited", at, id: e.id, from: ref });
      }
      break;
    }
    case "instance.reject": {
      if (!cmd.reason.trim()) throw new GraphError("invalid_reason", "a rejection needs a reason the worker can act on");
      const i = requireActive(cmd.node, ["submitted"], "reject");
      emit({ type: "instance.rejected", at, node: i.node, n: i.n, reason: cmd.reason });
      break;
    }
    case "instance.cancel": {
      const i = requireActive(cmd.node, ["ready", "running", "submitted"], "cancel");
      emit({ type: "instance.cancelled", at, node: i.node, n: i.n });
      break;
    }
    case "instance.retry": {
      const n = requireNode(cmd.node);
      const busy = activeInstance(n);
      if (busy) throw new GraphError("node_busy", `${instanceLabel(busy)} is ${busy.state}; cancel it first`);
      const last = latestInstance(n);
      emit({ type: "instance.created", at, node: n.id, n: n.instances.length + 1, trigger: { type: "manual" }, inputs: last?.inputs ?? [], held: n.spec.hold });
      break;
    }
    default: {
      const never: never = cmd;
      throw new GraphError("unknown_command", `unknown command ${JSON.stringify(never)}`);
    }
  }

  settle(s, emit, at);
  return out;
}

/** Emit derived events until nothing more can happen: unblock raised loops, create instances, detect quiescence. */
function settle(s: GraphState, emit: (ev: GraphEvent) => void, at: string) {
  for (let progressed = true; progressed; ) {
    progressed = false;
    for (const e of liveEdges(s)) {
      if (e.back && e.blocked && e.fired < e.max && !s.nodes[e.to]!.removed) {
        emit({ type: "edge.fired_back", at, id: e.id, from: e.blocked });
        progressed = true;
      }
    }
    for (const n of liveNodes(s)) {
      if (activeInstance(n)) continue;
      const next = n.instances.length + 1;
      const held = n.spec.hold;
      const back = n.backQueue[0];
      if (back) {
        emit({ type: "instance.created", at, node: n.id, n: next, trigger: { type: "back", edge: back.edge }, inputs: [back.from], held });
        progressed = true;
        continue;
      }
      const fin = forwardInEdges(s, n.id);
      if (fin.length === 0) {
        if (n.instances.length === 0) {
          emit({ type: "instance.created", at, node: n.id, n: next, trigger: { type: "root" }, inputs: [], held });
          progressed = true;
        }
        continue;
      }
      if (fin.every((e) => e.queue.length > 0)) {
        emit({ type: "instance.created", at, node: n.id, n: next, trigger: { type: "forward" }, inputs: fin.map((e) => e.queue[0]!), held });
        progressed = true;
      }
    }
  }
  const anyActive = liveNodes(s).some((n) => activeInstance(n));
  const anyInstance = liveNodes(s).some((n) => n.instances.length > 0);
  if (!anyActive && anyInstance && !s.quiescent) emit({ type: "run.quiescent", at });
}

/** Convenience: decide + apply on a copy. Returns the new state and the events to persist. */
export function step(state: GraphState, cmd: Command, now: string) {
  const events = decide(state, cmd, now);
  return { events, state: replay(events, clone(state)) };
}
