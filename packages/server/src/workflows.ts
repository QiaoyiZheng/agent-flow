// Workflow templates: a graph written down once and reused. A run started from a template gets the graph at
// once (tasks filled in with the goal), and its lead supervises it: checks submissions, adapts the graph,
// reports. Templates come from three places, later ones overriding earlier ones with the same id:
//   built-in    packages/skill/workflows/*.yaml
//   yours       ~/.agent-flow/workflows/*.yaml   (also where "save as workflow" writes)
//   project     <repo>/.agent-flow/workflows/*.yaml
//
//   name: 实现 + 审查循环
//   description: ...
//   lead: claude                      # optional
//   nodes:
//     - id: code
//       kind: codex                   # claude | codex | omp (default claude)
//       task: |
//         目标：{{goal}} ...
//     - id: review
//       after: [code]                 # or [{ from: code, on: pass }]
//       shared: true                  # run in the integration worktree, read-only work
//       autoAccept: true              # its submission is accepted without the lead
//       task: ...
//   loops:
//     - { from: review, to: code, on: fail, max: 3 }

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENT_KINDS, type AgentKind, type Command, type GraphState, type RunState, GraphError, NODE_ID, emptyGraph, liveEdges, liveNodes, step } from "@af/core";
import { AfError } from "./orchestrator.ts";

export interface WorkflowNode {
  id: string;
  kind?: AgentKind;
  agent?: string;
  task: string;
  after?: (string | { from: string; on?: string })[];
  shared?: boolean;
  autoAccept?: boolean;
  hold?: boolean;
}

export interface WorkflowFile {
  name: string;
  description?: string;
  lead?: AgentKind;
  nodes: WorkflowNode[];
  loops?: { from: string; to: string; on: string; max?: number }[];
}

export interface WorkflowInfo {
  id: string;
  name: string;
  description: string;
  source: "built-in" | "yours" | "project";
  path: string;
  lead?: AgentKind;
  needsGoal: boolean;
  /** The graph it builds, without instances: for previews. */
  preview?: GraphState;
  error?: string;
}

const GOAL = /\{\{\s*goal\s*\}\}/g;
const usesGoal = (t: string) => /\{\{\s*goal\s*\}\}/.test(t);

export function parseWorkflow(text: string, where: string): WorkflowFile {
  let w: any;
  try {
    w = Bun.YAML.parse(text);
  } catch (e) {
    throw new AfError("bad_workflow", `${where}: not valid YAML (${(e as Error).message})`);
  }
  if (!w || typeof w !== "object") throw new AfError("bad_workflow", `${where}: empty`);
  if (!Array.isArray(w.nodes) || !w.nodes.length) throw new AfError("bad_workflow", `${where}: needs a list of nodes`);
  for (const n of w.nodes) {
    if (!n || typeof n.id !== "string" || !NODE_ID.test(n.id)) throw new AfError("bad_workflow", `${where}: every node needs an id matching ${NODE_ID}`);
    if (typeof n.task !== "string" || !n.task.trim()) throw new AfError("bad_workflow", `${where}: node ${n.id} needs a task`);
    if (n.kind !== undefined && !AGENT_KINDS.includes(n.kind)) throw new AfError("bad_workflow", `${where}: node ${n.id} has unknown kind ${n.kind}`);
  }
  if (w.lead !== undefined && !AGENT_KINDS.includes(w.lead)) throw new AfError("bad_workflow", `${where}: unknown lead kind ${w.lead}`);
  return { name: String(w.name ?? basename(where).replace(/\.ya?ml$/, "")), description: w.description ? String(w.description) : undefined, lead: w.lead, nodes: w.nodes, loops: Array.isArray(w.loops) ? w.loops : [] };
}

/** The graph commands a workflow stands for, with {{goal}} filled in. Nodes are added after their dependencies. */
export function workflowCommands(w: WorkflowFile, goal: string): Command[] {
  const fill = (t: string) => t.replace(GOAL, goal);
  const ids = new Set(w.nodes.map((n) => n.id));
  const deps = (n: WorkflowNode) => (n.after ?? []).map((a) => (typeof a === "string" ? { from: a } : { from: a.from, on: a.on }));
  for (const n of w.nodes) for (const d of deps(n)) if (!ids.has(d.from)) throw new AfError("bad_workflow", `node ${n.id} comes after ${d.from}, which is not a node`);
  const out: Command[] = [];
  const added = new Set<string>();
  const pending = [...w.nodes];
  while (pending.length) {
    const i = pending.findIndex((n) => deps(n).every((d) => added.has(d.from)));
    if (i < 0) throw new AfError("bad_workflow", `"after" makes a cycle among ${pending.map((n) => n.id).join(", ")}; use loops: for cycles`);
    const n = pending.splice(i, 1)[0]!;
    out.push({
      type: "node.add",
      id: n.id,
      spec: {
        task: fill(n.task),
        executor: n.agent ? { agent: n.agent } : { kind: n.kind ?? "claude" },
        isolation: n.shared ? "shared" : "isolated",
        hold: !!n.hold,
        autoAccept: !!n.autoAccept,
      },
      after: deps(n).length ? deps(n) : undefined,
    });
    added.add(n.id);
  }
  for (const l of w.loops ?? []) out.push({ type: "edge.link", from: l.from, to: l.to, on: l.on, max: l.max });
  return out;
}

/** Build the graph a workflow makes, to check it and to show it. Throws a readable error if the engine refuses it. */
export function previewGraph(w: WorkflowFile, goal = "…"): GraphState {
  let g = emptyGraph();
  for (const cmd of workflowCommands(w, goal)) {
    try {
      g = step(g, cmd, "preview").state;
    } catch (e) {
      if (e instanceof GraphError) throw new AfError("bad_workflow", `${cmd.type} ${"id" in cmd ? cmd.id : `${(cmd as any).from}->${(cmd as any).to}`}: ${e.message}`);
      throw e;
    }
  }
  for (const n of Object.values(g.nodes)) (n.instances = []), (n.backQueue = []);
  for (const e of Object.values(g.edges)) (e.queue = []), (e.fired = 0), (e.blocked = undefined);
  g.quiescent = false;
  return g;
}

export class WorkflowLibrary {
  constructor(
    readonly builtinDir: string,
    readonly userDir: string,
  ) {}

  private dirs(cwd?: string): { dir: string; source: WorkflowInfo["source"] }[] {
    return [
      { dir: this.builtinDir, source: "built-in" },
      { dir: this.userDir, source: "yours" },
      ...(cwd ? [{ dir: join(cwd, ".agent-flow", "workflows"), source: "project" as const }] : []),
    ];
  }

  list(cwd?: string): WorkflowInfo[] {
    const byId = new Map<string, WorkflowInfo>();
    for (const { dir, source } of this.dirs(cwd)) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
        const path = join(dir, f);
        const id = f.replace(/\.ya?ml$/, "");
        try {
          const w = parseWorkflow(readFileSync(path, "utf8"), path);
          byId.set(id, { id, name: w.name, description: w.description ?? "", source, path, lead: w.lead, needsGoal: w.nodes.some((n) => usesGoal(n.task)), preview: previewGraph(w) });
        } catch (e) {
          byId.set(id, { id, name: id, description: "", source, path, needsGoal: false, error: (e as Error).message });
        }
      }
    }
    return [...byId.values()];
  }

  load(id: string, cwd?: string): { info: WorkflowInfo; file: WorkflowFile } {
    const info = this.list(cwd).find((w) => w.id === id);
    if (!info) throw new AfError("unknown_workflow", `no workflow ${id}. Run af workflow list to see them.`, 404);
    if (info.error) throw new AfError("bad_workflow", info.error);
    return { info, file: parseWorkflow(readFileSync(info.path, "utf8"), info.path) };
  }

  /** Write a run's current graph as a template in the user's folder. The run's goal becomes {{goal}} again. */
  saveFromRun(run: RunState, name: string, description?: string): WorkflowInfo {
    const g = run.graph;
    const nodes = liveNodes(g);
    if (!nodes.length) throw new AfError("empty_graph", "this run has no graph to save yet");
    const goal = run.meta?.goal?.trim();
    const unfill = (t: string) => (goal ? t.split(goal).join("{{goal}}") : t);
    const edges = liveEdges(g);
    const file: WorkflowFile = {
      name,
      description: description || `Saved from run ${run.meta?.id}${run.meta?.workflow ? ` (started from ${run.meta.workflow})` : ""}.`,
      lead: run.meta ? (run.agents[run.meta.lead]?.kind ?? undefined) : undefined,
      nodes: nodes.map((n) => {
        const after = edges.filter((e) => !e.back && e.to === n.id).map((e) => (e.on ? { from: e.from, on: e.on } : e.from));
        const node: WorkflowNode = { id: n.id, task: unfill(n.spec.task) };
        if ("kind" in n.spec.executor) node.kind = n.spec.executor.kind;
        else node.agent = n.spec.executor.agent;
        if (after.length) node.after = after;
        if (n.spec.isolation === "shared") node.shared = true;
        if (n.spec.autoAccept) node.autoAccept = true;
        if (n.spec.hold) node.hold = true;
        return node;
      }),
      loops: edges.filter((e) => e.back).map((e) => ({ from: e.from, to: e.to, on: e.on!, max: e.max })),
    };
    if (!file.loops!.length) delete file.loops;
    const id = name.toLowerCase().replace(/[^a-z0-9一-鿿-]+/g, "-").replace(/^-+|-+$/g, "") || `run-${run.meta?.id}`;
    mkdirSync(this.userDir, { recursive: true });
    const path = join(this.userDir, `${id}.yaml`);
    writeFileSync(path, `# Saved by agent-flow from run ${run.meta?.id}. Edit freely; {{goal}} is replaced by the goal when a run starts.\n${Bun.YAML.stringify(file, null, 2)}`);
    return this.list().find((w) => w.path === path)!;
  }
}
