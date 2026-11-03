// The agent-flow orchestrator: owns every run's event log and state, turns CLI/API calls into graph
// commands, and performs the side effects the graph engine leaves to the server: spawning agents,
// dispatching instances, delivering wake-up notices, committing and merging git work.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  type AgentKind,
  type AgentRec,
  type AgentStatus,
  type Attention,
  type Caller,
  type Command,
  type CreateRunRequest,
  type DoneRequest,
  type GraphNode,
  type Instance,
  type Mail,
  type MailKind,
  type RunEvent,
  type RunMeta,
  type RunState,
  type RunSummary,
  type SendRequest,
  type SpawnRequest,
  AGENT_KINDS,
  GraphError,
  NODE_ID,
  activeInstance,
  applyRun,
  decide,
  emptyRun,
  getInstance,
  herdrAgentName,
  instanceLabel,
  integrationBranch,
  latestInstance,
  liveEdges,
  liveNodes,
  nodeBranch,
  replayRun,
  step,
  undeliveredMail,
  unreadMail,
} from "@af/core";
import * as git from "./git.ts";
import { parseMenu, screenOverlay } from "./menu.ts";
import { workflowCommands } from "./workflows.ts";
import type { TerminalBackend } from "./herdr.ts";
import { type AgentConfig, type Role, launchArgs, noticeText } from "./agents.ts";

export class AfError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AfError";
  }
}

export interface OrchestratorOptions {
  /** Root for all state, normally ~/.agent-flow */
  home: string;
  backend: TerminalBackend;
  /** Unix socket the af CLI uses; passed to agents as AF_SOCK. */
  sock: string;
  /** Directory holding the `af` executable; prepended to agents' PATH. */
  binDir: string;
  /** Directory with lead.md and worker.md. */
  protocolDir: string;
  config: AgentConfig;
  /** Workflow templates (runs can start from one). */
  workflows?: import("./workflows.ts").WorkflowLibrary;
  now?: () => string;
  /** Wall clock in ms, for idle timing. Tests replace it. */
  clock?: () => number;
  /** How long a worker must sit idle, after reading its task, before it is reminded to submit. */
  idleGraceMs?: number;
}

interface Run {
  id: string;
  dir: string;
  state: RunState;
  /** Instance labels currently being dispatched (agent spawning can take seconds). */
  dispatching: Set<string>;
  /** Agents whose `herdr agent start` call is still in flight. */
  starting: Set<string>;
  /** Text to type straight into an agent's terminal once it is idle, e.g. the user's first prompt to the lead. */
  direct: Map<string, string[]>;
  /** Reminders sent per instance label for "went idle without af done". */
  reminded: Map<string, number>;
  /** Agent name -> ms since it has been continuously idle or done. */
  idleSince: Map<string, number>;
}

interface TeamFile {
  name: string;
  entry: string;
  agents: Record<string, { kind: AgentKind; role?: string }>;
}

const USER = "user";
const SYSTEM = "agent-flow";

export class Orchestrator {
  private runs = new Map<string, Run>();
  private listeners = new Set<(run: string, ev: RunEvent) => void>();
  private ticking = false;
  private pending = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private now: () => string;

  constructor(readonly opts: OrchestratorOptions) {
    this.now = opts.now ?? (() => new Date().toISOString());
    mkdirSync(join(opts.home, "runs"), { recursive: true });
  }

  // -------------------------------------------------------------------------------------------
  // lifecycle

  /** Rebuild every run from its events.jsonl. */
  load() {
    const root = join(this.opts.home, "runs");
    for (const id of readdirSync(root)) {
      const file = join(root, id, "events.jsonl");
      if (!existsSync(file)) continue;
      const events = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunEvent);
      this.runs.set(id, this.newRun(id, replayRun(events)));
    }
    return this.runs.size;
  }

  start(pollMs = 1000) {
    this.timer = setInterval(() => void this.tick(), pollMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  subscribe(fn: (run: string, ev: RunEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private newRun(id: string, state: RunState): Run {
    return { id, dir: join(this.opts.home, "runs", id), state, dispatching: new Set(), starting: new Set(), direct: new Map(), reminded: new Map(), idleSince: new Map() };
  }

  // -------------------------------------------------------------------------------------------
  // queries

  listRuns(): RunSummary[] {
    return [...this.runs.values()]
      .filter((r) => r.state.meta)
      .map((r) => ({
        id: r.id,
        cwd: r.state.meta!.cwd,
        createdAt: r.state.meta!.createdAt,
        stopped: r.state.stopped,
        lead: r.state.meta!.lead,
        leadPane: r.state.agents[r.state.meta!.lead]?.paneId,
        attention: Object.keys(r.state.attention).length,
        needs: Object.values(r.state.attention).map((a) => ({ ...a, paneId: a.agent ? r.state.agents[a.agent]?.paneId : undefined })),
        quiescent: r.state.graph.quiescent,
        workspace: r.state.meta!.herdrWorkspace,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getRun(id: string | undefined): RunState {
    return this.requireRun(id).state;
  }

  private requireRun(id: string | undefined): Run {
    if (!id) throw new AfError("no_run", "no run given (set AF_RUN or pass --run)");
    const r = this.runs.get(id);
    if (!r) throw new AfError("unknown_run", `no run ${id}`, 404);
    return r;
  }

  // -------------------------------------------------------------------------------------------
  // events

  private emit(run: Run, ev: RunEvent) {
    const full = { ...ev, seq: run.state.seq + 1 } as RunEvent;
    appendFileSync(join(run.dir, "events.jsonl"), JSON.stringify(full) + "\n");
    applyRun(run.state, full);
    for (const l of this.listeners) l(run.id, full);
  }

  /** Run a graph command: validate, persist every resulting event, then react to them. */
  private exec(run: Run, cmd: Command) {
    let events;
    try {
      events = decide(run.state.graph, cmd, this.now());
    } catch (e) {
      if (e instanceof GraphError) throw new AfError(e.code, e.message);
      throw e;
    }
    for (const ev of events) this.emit(run, ev);
    writeFileSync(join(run.dir, "graph.json"), JSON.stringify(run.state.graph, null, 2));
    for (const ev of events) this.react(run, ev);
    return events;
  }

  private react(run: Run, ev: RunEvent) {
    const meta = run.state.meta!;
    switch (ev.type) {
      case "edge.limited": {
        const e = run.state.graph.edges[ev.id]!;
        const text = `Loop limit reached on ${e.from} -> ${e.to} (${e.fired}/${e.max}): ${instanceLabel(ev.from)} returned "${this.outcomeOf(run, ev.from)}" again.`;
        this.raise(run, { id: `loop:${e.id}`, kind: "loop_limit", text, node: e.to });
        this.mail(run, {
          from: SYSTEM,
          to: meta.lead,
          kind: "system",
          node: instanceLabel(ev.from),
          body: `${text}\nThe loop is paused. To allow more rounds: af graph max ${e.from} ${e.to} <N>. Or change the graph, or tell the user.`,
        });
        break;
      }
      case "edge.max_set":
        this.resolve(run, `loop:${ev.id}`);
        break;
      case "run.quiescent":
        this.mail(run, { from: SYSTEM, to: meta.lead, kind: "system", body: this.quiescentSummary(run) });
        break;
      case "instance.created":
        if (ev.trigger.type === "manual") {
          this.clearAttentionFor(run, ev.node);
          const spec = run.state.graph.nodes[ev.node]!.spec;
          if ("kind" in spec.executor)
            for (const a of Object.values(run.state.agents)) if (a.node === ev.node) void this.retire(run, a.name);
        }
        break;
      case "node.removed":
        this.clearAttentionFor(run, ev.id);
        break;
      case "instance.cancelled": {
        this.clearAttentionFor(run, ev.node);
        const i = getInstance(run.state.graph, ev)!;
        if (i.agent && run.state.agents[i.agent]?.status !== "exited")
          this.mail(run, { from: meta.lead, to: i.agent, kind: "message", node: instanceLabel(ev), body: `${instanceLabel(ev)} was cancelled. Stop working on it and wait for new messages.` });
        break;
      }
    }
  }

  private clearAttentionFor(run: Run, nodeId: string) {
    for (const a of Object.values(run.state.attention))
      if (a.node && (a.node === nodeId || a.node.startsWith(`${nodeId}#`)) && a.kind !== "merge_conflict") this.resolve(run, a.id);
  }

  private raise(run: Run, a: Omit<Attention, "at">) {
    if (run.state.attention[a.id]) return;
    this.emit(run, { type: "attention.raised", at: this.now(), attention: { ...a, at: this.now() } });
  }

  private resolve(run: Run, id: string) {
    if (run.state.attention[id]) this.emit(run, { type: "attention.resolved", at: this.now(), id });
  }

  private mail(run: Run, m: { from: string; to: string; kind: MailKind; body: string; node?: string; attachments?: string[]; replyTo?: string }): Mail {
    const mail: Mail = { id: `m${run.state.mail.length + 1}`, at: this.now(), ...m };
    this.emit(run, { type: "mail.sent", at: mail.at, mail });
    const dir = join(run.dir, "mail", m.to);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${mail.id}.json`), JSON.stringify(mail, null, 2));
    if (m.to === USER) this.raise(run, { id: `msg:${mail.id}`, kind: "lead", text: `${m.from}: ${m.body}`, agent: m.from });
    return mail;
  }

  // -------------------------------------------------------------------------------------------
  // runs and agents

  async createRun(req: CreateRunRequest): Promise<RunMeta> {
    const cwd = resolve(req.cwd);
    if (!existsSync(cwd)) throw new AfError("bad_cwd", `${cwd} does not exist`);
    const team = req.team ? this.loadTeam(req.team, cwd) : undefined;
    // a workflow is checked completely before anything is created
    let workflow: { info: import("./workflows.ts").WorkflowInfo; commands: Command[] } | undefined;
    if (req.workflow) {
      if (!this.opts.workflows) throw new AfError("no_workflows", "workflows are not available on this server");
      const { info, file } = this.opts.workflows.load(req.workflow, git.repoRoot(cwd) ?? cwd);
      const goal = (req.goal ?? "").trim();
      if (info.needsGoal && !goal) throw new AfError("no_goal", `the workflow "${info.name}" needs a goal`);
      const { workflowCommands, previewGraph } = await import("./workflows.ts");
      previewGraph(file, goal || "…");
      workflow = { info, commands: workflowCommands(file, goal) };
      req = { ...req, leadKind: req.leadKind ?? file.lead };
    }
    const id = this.newRunId();
    const run = this.newRun(id, emptyRun());
    mkdirSync(join(run.dir, "protocol"), { recursive: true });
    for (const f of ["lead.md", "worker.md"]) copyFileSync(join(this.opts.protocolDir, f), join(run.dir, "protocol", f));

    const lead = team?.entry ?? "lead";
    const meta: RunMeta = { id, createdAt: this.now(), cwd, lead, team: team?.name, workflow: workflow?.info.id, goal: req.goal?.trim() || undefined };
    mkdirSync(join(run.dir, "out"), { recursive: true });
    const repo = git.repoRoot(cwd);
    if (repo && git.hasCommits(repo)) {
      git.ensureExcluded(repo, ".agent-flow/");
      meta.repo = repo;
      meta.base = git.headCommit(repo);
      meta.branch = integrationBranch(id);
      meta.integration = join(repo, ".agent-flow", "worktrees", id, "_main");
      git.addWorktree(repo, meta.integration, meta.branch, meta.base);
    }
    const ws = await this.opts.backend.createWorkspace(`af ${id}`, cwd, this.agentEnv(id, lead));
    meta.herdrWorkspace = ws.workspaceId;

    this.runs.set(id, run);
    this.emit(run, { type: "run.created", at: this.now(), meta });
    if (req.prompt) run.direct.set(lead, [req.prompt]);
    if (workflow) {
      for (const cmd of workflow.commands) this.exec(run, cmd);
      this.mail(run, { from: SYSTEM, to: lead, kind: "system", body: this.workflowBrief(run, workflow.info.name, meta.goal) });
    }

    const leadKind = team?.agents[lead]?.kind ?? req.leadKind ?? "claude";
    await this.opts.backend.renameTab(ws.tabId, lead);
    const spawns = [this.spawnAgent(run, { name: lead, kind: leadKind, role: team?.agents[lead]?.role, cwd, protocol: "lead", pane: { paneId: ws.paneId, tabId: ws.tabId } })];
    for (const [name, a] of Object.entries(team?.agents ?? {}))
      if (name !== lead) spawns.push(this.spawnAgent(run, { name, kind: a.kind, role: a.role, cwd: meta.integration ?? cwd, protocol: "worker" }));
    await Promise.all(spawns);
    return meta;
  }

  /**
   * Make a session the user already has (any claude, codex or omp pane) the lead of a new run in its own
   * workspace: `af here`. Workers then start as new tabs of that workspace, and the UI shows the run's graph
   * next to it. Calling it again from the same pane returns the same run.
   */
  async attachRun(a: { paneId: string; tabId: string; workspaceId: string; cwd: string; kind: AgentKind }): Promise<RunMeta> {
    if (!AGENT_KINDS.includes(a.kind)) throw new AfError("bad_kind", `the pane runs ${a.kind}; af here works for ${AGENT_KINDS.join(", ")}`);
    for (const r of this.runs.values()) {
      if (r.state.stopped || r.state.meta?.herdrWorkspace !== a.workspaceId) continue;
      const lead = r.state.agents[r.state.meta.lead];
      if (lead?.paneId === a.paneId) return r.state.meta;
      throw new AfError("workspace_has_run", `this workspace already has run ${r.id} (led by ${lead?.name} in pane ${lead?.paneId}). Stop it first (af run stop --run ${r.id}) or use it from that pane.`, 409);
    }
    const cwd = resolve(a.cwd);
    const id = this.newRunId();
    const run = this.newRun(id, emptyRun());
    mkdirSync(join(run.dir, "protocol"), { recursive: true });
    mkdirSync(join(run.dir, "out"), { recursive: true });
    for (const f of ["lead.md", "worker.md"]) copyFileSync(join(this.opts.protocolDir, f), join(run.dir, "protocol", f));
    const meta: RunMeta = { id, createdAt: this.now(), cwd, lead: "lead", attached: true, herdrWorkspace: a.workspaceId };
    const repo = git.repoRoot(cwd);
    if (repo && git.hasCommits(repo)) {
      git.ensureExcluded(repo, ".agent-flow/");
      meta.repo = repo;
      meta.base = git.headCommit(repo);
      meta.branch = integrationBranch(id);
      meta.integration = join(repo, ".agent-flow", "worktrees", id, "_main");
      git.addWorktree(repo, meta.integration, meta.branch, meta.base);
    }
    this.runs.set(id, run);
    this.emit(run, { type: "run.created", at: this.now(), meta });
    const rec: AgentRec = { name: "lead", kind: a.kind, herdrName: a.paneId, paneId: a.paneId, tabId: a.tabId, cwd, status: "idle", spawnedAt: this.now() };
    this.emit(run, { type: "agent.spawned", at: this.now(), agent: rec });
    return meta;
  }

  /** The run agent living in a pane (for CLI calls from sessions that were attached, which have no AF_* env). */
  agentByPane(paneId: string): { run: string; agent: string } | undefined {
    for (const r of this.runs.values()) {
      if (r.state.stopped) continue;
      for (const a of Object.values(r.state.agents)) if (a.paneId === paneId && a.status !== "exited") return { run: r.id, agent: a.name };
    }
    return undefined;
  }

  /** Add a workflow template's nodes to a running graph (af graph apply). Checked as a whole before anything changes. */
  applyWorkflow(caller: Caller, workflowId: string, goal: string | undefined) {
    const run = this.requireRun(caller.run);
    this.requireLeadOrUser(run, caller, "change the graph");
    if (!this.opts.workflows) throw new AfError("no_workflows", "workflows are not available on this server");
    const meta = run.state.meta!;
    const { info, file } = this.opts.workflows.load(workflowId, meta.repo ?? meta.cwd);
    if (info.needsGoal && !goal?.trim()) throw new AfError("no_goal", `the workflow "${info.name}" needs a goal (--goal "...")`);
    const cmds = workflowCommands(file, (goal ?? "").trim());
    let g = structuredClone(run.state.graph);
    for (const cmd of cmds) {
      try {
        g = step(g, cmd, this.now()).state;
      } catch (e) {
        if (e instanceof GraphError) throw new AfError(e.code, `${info.name}: ${e.message}`);
        throw e;
      }
    }
    for (const cmd of cmds) this.exec(run, cmd);
    return { workflow: info.id, nodes: cmds.flatMap((c) => (c.type === "node.add" ? [c.id] : [])) };
  }

  stopRun(caller: Caller) {
    const run = this.requireRun(caller.run);
    this.requireLeadOrUser(run, caller);
    if (!run.state.stopped) this.emit(run, { type: "run.stopped", at: this.now() });
  }

  private loadTeam(nameOrPath: string, cwd: string): TeamFile {
    const candidates = nameOrPath.endsWith(".yaml") || nameOrPath.endsWith(".yml")
      ? [resolve(cwd, nameOrPath)]
      : [join(cwd, ".agent-flow", "teams", `${nameOrPath}.yaml`), join(this.opts.home, "teams", `${nameOrPath}.yaml`)];
    const file = candidates.find(existsSync);
    if (!file) throw new AfError("unknown_team", `no team file; looked in ${candidates.join(", ")}`);
    const t = Bun.YAML.parse(readFileSync(file, "utf8")) as TeamFile;
    if (!t?.agents || !t.entry || !t.agents[t.entry]) throw new AfError("bad_team", `${file}: needs agents: and an entry: that names one of them`);
    for (const [n, a] of Object.entries(t.agents)) {
      if (!NODE_ID.test(n)) throw new AfError("bad_team", `${file}: agent name ${n} must match ${NODE_ID}`);
      if (!AGENT_KINDS.includes(a.kind)) throw new AfError("bad_team", `${file}: agent ${n} has unknown kind ${a.kind}`);
    }
    return { ...t, name: t.name ?? nameOrPath };
  }

  private newRunId() {
    for (;;) {
      const id = "r" + Math.random().toString(36).slice(2, 6);
      if (!this.runs.has(id) && !existsSync(join(this.opts.home, "runs", id))) return id;
    }
  }

  async spawn(caller: Caller, req: SpawnRequest & { place?: { split: string; direction: "right" | "down" } }) {
    const run = this.requireRun(caller.run);
    this.requireLeadOrUser(run, caller);
    if (!AGENT_KINDS.includes(req.kind)) throw new AfError("bad_kind", `kind must be one of ${AGENT_KINDS.join(", ")}`);
    const meta = run.state.meta!;
    const name = req.name || this.uniqueAgentName(run, req.kind);
    await this.spawnAgent(run, { name, kind: req.kind, role: req.role, cwd: meta.integration ?? meta.cwd, protocol: "worker", place: req.place });
    return run.state.agents[name]!;
  }

  /** Herdr workspace id -> run id, for runs that are not stopped first. */
  runByWorkspace(workspaceId: string): string | undefined {
    const runs = [...this.runs.values()].filter((r) => r.state.meta?.herdrWorkspace === workspaceId);
    return (runs.find((r) => !r.state.stopped) ?? runs[0])?.id;
  }

  workspaceRuns(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.runs.values()) {
      const ws = r.state.meta?.herdrWorkspace;
      if (ws && (!out[ws] || !r.state.stopped)) out[ws] = r.id;
    }
    return out;
  }

  /** Session id agent-flow launched the agent in `paneId` with, if any. */
  sessionForPane(paneId: string): string | undefined {
    for (const r of this.runs.values()) for (const a of Object.values(r.state.agents)) if (a.paneId === paneId && a.status !== "exited") return a.session;
    return undefined;
  }

  /** Run agent name -> pane id, for resolving `af read <agent>`. */
  agentPanes(runId: string | undefined): Record<string, string | undefined> {
    const run = runId ? this.runs.get(runId) : undefined;
    return run ? Object.fromEntries(Object.values(run.state.agents).filter((a) => a.status !== "exited").map((a) => [a.name, a.paneId])) : {};
  }

  /** Record that someone showed a file in a run, so the node detail can list it. */
  recordOpen(caller: Caller, target: string) {
    const run = caller.run ? this.runs.get(caller.run) : undefined;
    if (!run) return;
    const by = caller.agent ?? USER;
    const node = caller.agent && caller.agent !== run.state.meta!.lead ? this.currentLabel(run, caller.agent) : undefined;
    const open = { id: `o${run.state.opens.length + 1}`, by, target, node, at: this.now() };
    this.emit(run, { type: "open.requested", at: open.at, open });
  }

  private agentEnv(runId: string, agent: string) {
    // AF_OUT: where agents put reports and other results they hand on (outside the repo)
    return { AF_RUN: runId, AF_AGENT: agent, AF_SOCK: this.opts.sock, AF_OUT: join(this.opts.home, "runs", runId, "out"), PATH: `${this.opts.binDir}:${process.env.PATH ?? ""}` };
  }

  /** What the lead of a workflow run is told when it starts. */
  private workflowBrief(run: Run, name: string, goal?: string) {
    const g = run.state.graph;
    const nodes = liveNodes(g).map((n) => {
      const after = liveEdges(g).filter((e) => !e.back && e.to === n.id).map((e) => `${e.from}${e.on ? ` on ${e.on}` : ""}`);
      const ex = "kind" in n.spec.executor ? n.spec.executor.kind : `@${n.spec.executor.agent}`;
      return `- ${n.id} (${ex}${n.spec.isolation === "shared" ? ", shared" : ""}${n.spec.autoAccept ? ", auto-accept" : ""})${after.length ? ` after ${after.join(", ")}` : ""}`;
    });
    const loops = liveEdges(g).filter((e) => e.back).map((e) => `- ${e.from} -> ${e.to} on ${e.on}, at most ${e.max} times`);
    return [
      `This run follows the workflow "${name}".${goal ? ` Goal: ${goal}` : ""}`,
      "The graph is already built, and its first nodes are being dispatched now:",
      ...nodes,
      ...(loops.length ? ["Loops:", ...loops] : []),
      "",
      "Your job: check each submission you are told about (af inbox, af diff <node>) and accept or reject it with concrete reasons;",
      "change the graph if the plan needs to change (af graph add / edit / link / rm); keep the user informed here.",
      "When the graph is quiescent, report the result. Run af graph show at any time.",
    ].join("\n");
  }

  private async spawnAgent(
    run: Run,
    a: { name: string; kind: AgentKind; role?: string; cwd: string; node?: string; protocol: Role; place?: { split: string; direction: "right" | "down" }; pane?: { paneId: string; tabId: string } },
  ) {
    if (!NODE_ID.test(a.name)) throw new AfError("bad_name", `agent name must match ${NODE_ID}`);
    if (a.name === USER || a.name === SYSTEM) throw new AfError("bad_name", `${a.name} is reserved`);
    if (run.state.agents[a.name]) throw new AfError("duplicate_agent", `agent ${a.name} already exists in run ${run.id}`);
    const meta = run.state.meta!;
    const rec: AgentRec = {
      name: a.name,
      kind: a.kind,
      role: a.role,
      herdrName: herdrAgentName(run.id, a.name),
      cwd: a.cwd,
      node: a.node,
      status: "starting",
      spawnedAt: this.now(),
      session: a.kind === "claude" ? crypto.randomUUID() : undefined,
    };
    this.emit(run, { type: "agent.spawned", at: this.now(), agent: rec });
    run.starting.add(a.name);
    try {
      const env = this.agentEnv(run.id, a.name);
      const tab = a.pane
        ? a.pane
        : a.place
        ? await this.opts.backend.splitPane(a.place.split, a.place.direction, a.cwd, env)
        : await this.opts.backend.createTab(meta.herdrWorkspace!, a.cwd, a.name, env);
      this.emit(run, { type: "agent.placed", at: this.now(), name: a.name, paneId: tab.paneId, tabId: tab.tabId });
      const proto = join(run.dir, "protocol", `${a.protocol}.md`);
      // a new tab's shell takes a moment to be ready; until then Herdr says the pane is busy
      let res = await this.opts.backend.startAgent(rec.herdrName, a.kind, tab.paneId, launchArgs(a.kind, a.protocol, proto, this.opts.config, rec.session));
      for (let i = 0; i < 12 && !res.ok && /busy/.test(res.code); i++) {
        await Bun.sleep(500);
        res = await this.opts.backend.startAgent(rec.herdrName, a.kind, tab.paneId, launchArgs(a.kind, a.protocol, proto, this.opts.config, rec.session));
      }
      if (res.ok) this.setStatus(run, a.name, "idle");
      else if (res.code !== "agent_not_ready") {
        // the agent never came up (e.g. timeout); do not leave a half-started process behind
        await this.opts.backend.closeTab(tab.tabId);
        throw new AfError("agent_start_failed", `${a.kind} did not start (${res.code}: ${res.message})`);
      } else {
        this.setStatus(run, a.name, "blocked");
        const hint = res.code === "agent_not_ready" ? "Open its terminal and answer the prompt (folder trust, login, update)." : `Open its terminal to see what went wrong (${res.message}).`;
        this.raise(run, { id: `startup:${a.name}`, kind: "startup_blocked", agent: a.name, text: `${a.name} (${a.kind}) is stuck while starting (${res.code}). ${hint}` });
      }
    } catch (e) {
      this.setStatus(run, a.name, "exited");
      throw e;
    } finally {
      run.starting.delete(a.name);
    }
    if (a.role) this.mail(run, { from: meta.lead === a.name ? SYSTEM : meta.lead, to: a.name, kind: "message", body: `Your role in this run: ${a.role}` });
  }

  private setStatus(run: Run, name: string, status: AgentStatus) {
    const a = run.state.agents[name];
    if (a && a.status !== status) this.emit(run, { type: "agent.status", at: this.now(), name, status });
  }

  // -------------------------------------------------------------------------------------------
  // graph API

  graph(caller: Caller, cmd: Command) {
    const run = this.requireRun(caller.run);
    this.requireLeadOrUser(run, caller, "change the graph");
    if (run.state.stopped) throw new AfError("run_stopped", `run ${run.id} is stopped`);
    switch (cmd.type) {
      case "instance.dispatch":
      case "instance.submit":
        throw new AfError("internal_command", `${cmd.type} is issued by agent-flow itself`);
      case "instance.accept":
        return this.accept(run, cmd.node, true);
      case "instance.reject":
        return this.reject(run, cmd.node, cmd.reason);
      default:
        return this.exec(run, cmd);
    }
  }

  private requireLeadOrUser(run: Run, caller: Caller, what = "do that") {
    const lead = run.state.meta!.lead;
    if (caller.agent && caller.agent !== lead) throw new AfError("forbidden", `only the lead (${lead}) or the user can ${what}`, 403);
  }

  private accept(run: Run, nodeId: string, throwOnConflict: boolean) {
    const g = run.state.graph;
    const node = g.nodes[nodeId];
    const inst = node && activeInstance(node);
    if (!node || node.removed || !inst || inst.state !== "submitted") return this.exec(run, { type: "instance.accept", node: nodeId }); // engine reports the precise error
    const meta = run.state.meta!;
    const label = instanceLabel(inst);
    if (meta.repo && node.spec.isolation === "isolated") {
      const m = git.mergeInto(meta.integration!, nodeBranch(run.id, nodeId), `merge ${label} into ${meta.branch}`);
      if (!m.ok) {
        this.emit(run, { type: "git.merge_failed", at: this.now(), node: nodeId, n: inst.n, files: m.files });
        const text = `Merging ${label} into ${meta.branch} conflicts in: ${m.files.join(", ")}.`;
        this.raise(run, { id: `merge:${nodeId}`, kind: "merge_conflict", node: nodeId, text });
        this.mail(run, {
          from: SYSTEM,
          to: meta.lead,
          kind: "system",
          node: label,
          body: `${text}\n${label} stays submitted. Either reject it so ${inst.agent} merges ${meta.branch} into its branch and resolves the conflict (af graph reject ${nodeId} --reason "..."), or add a node that fixes it.`,
        });
        if (throwOnConflict) throw new AfError("merge_conflict", text, 409);
        return [];
      }
      if (m.changed) this.emit(run, { type: "git.merged", at: this.now(), node: nodeId, n: inst.n, commit: m.commit });
    }
    this.resolve(run, `merge:${nodeId}`);
    return this.exec(run, { type: "instance.accept", node: nodeId });
  }

  private reject(run: Run, nodeId: string, reason: string) {
    const events = this.exec(run, { type: "instance.reject", node: nodeId, reason });
    const inst = latestInstance(run.state.graph.nodes[nodeId]!)!;
    const meta = run.state.meta!;
    const conflicted = !!run.state.attention[`merge:${nodeId}`];
    this.resolve(run, `merge:${nodeId}`);
    const cwd = this.cwdFor(run, run.state.graph.nodes[nodeId]!);
    const lines = [
      `${instanceLabel(inst)} was rejected by ${meta.lead}:`,
      reason,
      "",
      ...(conflicted ? [`Your branch conflicts with ${meta.branch}. First run \`git merge ${meta.branch}\` in ${cwd}, resolve the conflicts, and commit the merge.`] : []),
      `Fix it in ${cwd} and submit again with af done.`,
    ];
    this.mail(run, { from: meta.lead, to: inst.agent!, kind: "message", node: instanceLabel(inst), body: lines.join("\n") });
    return events;
  }

  diff(caller: Caller, nodeId: string, stat = false) {
    const run = this.requireRun(caller.run);
    const meta = run.state.meta!;
    const node = run.state.graph.nodes[nodeId];
    if (!node) throw new AfError("unknown_node", `no node named ${nodeId}`);
    if (!meta.repo) throw new AfError("no_repo", "this run is not in a git repository");
    if (node.spec.isolation !== "isolated") throw new AfError("shared_node", `${nodeId} is shared; its changes go straight to ${meta.branch}`);
    const branch = nodeBranch(run.id, nodeId);
    if (!git.branchExists(meta.repo, branch)) throw new AfError("not_started", `${nodeId} has not started yet`);
    return git.diffSince(meta.repo, meta.branch!, branch, stat);
  }

  // -------------------------------------------------------------------------------------------
  // worker API

  done(caller: Caller, req: DoneRequest) {
    const run = this.requireRun(caller.run);
    if (!caller.agent) throw new AfError("no_agent", "af done is for agents (AF_AGENT is not set)");
    const g = run.state.graph;
    const inst = liveNodes(g)
      .map((n) => activeInstance(n))
      .find((i) => i?.state === "running" && i.agent === caller.agent);
    if (!inst) {
      const sub = liveNodes(g).map(activeInstance).find((i) => i?.state === "submitted" && i.agent === caller.agent);
      throw new AfError("nothing_running", sub ? `${instanceLabel(sub)} is already submitted and waiting for the lead` : `${caller.agent} has no running node`);
    }
    const node = g.nodes[inst.node]!;
    const meta = run.state.meta!;
    const agent = run.state.agents[caller.agent]!;
    const result = req.result && !isAbsolute(req.result) && !/^[a-z]+:\/\//.test(req.result) ? resolve(agent.cwd, req.result) : req.result;
    if (meta.repo) {
      const commit = git.commitAll(this.cwdFor(run, node), `${instanceLabel(inst)}: ${req.note ?? "submit"}`.slice(0, 200));
      if (commit) this.emit(run, { type: "git.committed", at: this.now(), node: node.id, n: inst.n, commit });
    }
    this.exec(run, { type: "instance.submit", node: node.id, agent: caller.agent, outcome: req.outcome, result, note: req.note });
    this.resolve(run, `nosubmit:${caller.agent}`);
    run.reminded.delete(instanceLabel(inst));
    const label = instanceLabel(inst);
    if (node.spec.autoAccept) {
      this.accept(run, node.id, false);
      const accepted = latestInstance(g.nodes[node.id]!)!.state === "accepted";
      return { instance: label, accepted, message: accepted ? `${label} submitted and auto-accepted` : `${label} submitted; auto-accept hit a merge conflict, the lead was told` };
    }
    const lines = [
      `${label} submitted by ${caller.agent}${req.outcome ? ` with outcome ${req.outcome}` : ""}.`,
      ...(req.note ? [`Note: ${req.note}`] : []),
      ...(result ? [`Result: ${result}`] : []),
      `Check it${meta.repo && node.spec.isolation === "isolated" ? ` (af diff ${node.id})` : ""}, then: af graph accept ${node.id}  or  af graph reject ${node.id} --reason "..."`,
    ];
    this.mail(run, { from: SYSTEM, to: meta.lead, kind: "system", node: label, body: lines.join("\n") });
    return { instance: label, accepted: false, message: `${label} submitted; waiting for ${meta.lead} to check it` };
  }

  send(caller: Caller, req: SendRequest) {
    const run = this.requireRun(caller.run);
    const from = caller.agent ?? USER;
    if (req.to !== USER && !run.state.agents[req.to]) throw new AfError("unknown_agent", `no agent ${req.to} in run ${run.id}`);
    if (!req.body.trim()) throw new AfError("empty", "message is empty");
    const node = caller.agent ? this.currentLabel(run, caller.agent) : undefined;
    return this.mail(run, { from, to: req.to, kind: req.replyTo ? "reply" : "message", body: req.body, attachments: req.attachments, replyTo: req.replyTo, node });
  }

  reply(caller: Caller, msgId: string, body: string, attachments?: string[]) {
    const run = this.requireRun(caller.run);
    const m = run.state.mail.find((x) => x.id === msgId);
    if (!m) throw new AfError("unknown_message", `no message ${msgId}`);
    if (m.from === SYSTEM) throw new AfError("system_message", `${msgId} is from agent-flow itself; use af graph or af send instead`);
    return this.send(caller, { to: m.from, body, attachments, replyTo: msgId });
  }

  inbox(caller: Caller, all = false): Mail[] {
    const run = this.requireRun(caller.run);
    const who = caller.agent ?? USER;
    const unread = unreadMail(run.state, who);
    if (unread.length) this.emit(run, { type: "mail.read", at: this.now(), agent: who, ids: unread.map((m) => m.id) });
    return all ? run.state.mail.filter((m) => m.to === who) : unread;
  }

  open(caller: Caller, target: string) {
    const run = this.requireRun(caller.run);
    const by = caller.agent ?? USER;
    const isUrl = /^[a-z]+:\/\//i.test(target);
    const agent = caller.agent ? run.state.agents[caller.agent] : undefined;
    const resolved = isUrl ? target : resolve(agent?.cwd ?? run.state.meta!.cwd, target);
    if (!isUrl && !existsSync(resolved)) throw new AfError("not_found", `${resolved} does not exist`);
    const node = caller.agent && caller.agent !== run.state.meta!.lead ? this.currentLabel(run, caller.agent) : undefined;
    const open = { id: `o${run.state.opens.length + 1}`, by, target: resolved, node, at: this.now() };
    this.emit(run, { type: "open.requested", at: open.at, open });
    return open;
  }

  /** The instance an agent is working on (running or submitted), if any. */
  private currentLabel(run: Run, agent: string) {
    const i = liveNodes(run.state.graph)
      .map(activeInstance)
      .find((x) => x && x.agent === agent && (x.state === "running" || x.state === "submitted"));
    return i ? instanceLabel(i) : undefined;
  }

  // -------------------------------------------------------------------------------------------
  // UI helpers

  shellWorkspace(): string | undefined {
    const file = join(this.opts.home, "shell.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).workspaceId as string | undefined) : undefined;
  }

  dismiss(caller: Caller, id: string) {
    const run = this.requireRun(caller.run);
    this.requireLeadOrUser(run, caller);
    if (!run.state.attention[id]) throw new AfError("unknown_attention", `no attention item ${id}`);
    this.resolve(run, id);
  }

  /** The persistent shell shown in the UI's bottom drawer: one Herdr workspace that outlives runs. */
  async shell(): Promise<{ paneId: string; workspaceId?: string }> {
    const file = join(this.opts.home, "shell.json");
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { paneId: string; workspaceId?: string };
      if (await this.opts.backend.paneExists(saved.paneId)) return saved;
    }
    const ws = await this.opts.backend.createWorkspace("af shell", process.env.HOME ?? "/");
    const saved = { paneId: ws.paneId, workspaceId: ws.workspaceId };
    writeFileSync(file, JSON.stringify(saved));
    return saved;
  }

  // -------------------------------------------------------------------------------------------
  // the loop: track agent status, dispatch ready instances, deliver notices

  /** One tick, then wait for the dispatches it started. Used by tests and by `af` calls that want a settled view. */
  async flush() {
    await this.tick();
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const active = [...this.runs.values()].filter((r) => r.state.meta && !r.state.stopped);
      if (!active.length) return;
      // by Herdr name (agents agent-flow started) and by pane id (sessions attached with af here)
      const seen = new Map((await this.opts.backend.listAgents()).flatMap((a) => [...(a.name ? [[a.name, a] as const] : []), [a.paneId, a] as const]));
      for (const run of active) {
        await this.trackAgents(run, seen);
        this.dispatchReady(run);
      }
    } catch (e) {
      console.error("tick:", (e as Error).message);
    } finally {
      this.ticking = false;
    }
  }

  private async trackAgents(run: Run, seen: Map<string, { status: AgentStatus }>) {
    for (const a of Object.values(run.state.agents)) {
      if (a.status === "exited" || run.starting.has(a.name) || !a.paneId) continue;
      const prev = a.status;
      const now: AgentStatus = seen.get(a.herdrName)?.status ?? "exited";
      this.setStatus(run, a.name, now);

      if (now === "blocked" && prev !== "blocked")
        this.raise(run, { id: `blocked:${a.name}`, kind: "blocked", agent: a.name, text: `${a.name} is waiting for an answer in its terminal (approval or question).` });
      if (now !== "blocked") {
        this.resolve(run, `blocked:${a.name}`);
        this.resolve(run, `startup:${a.name}`);
      }
      if (now === "exited") {
        const label = this.currentLabel(run, a.name);
        if (label) {
          const nodeId = label.split("#")[0]!;
          const text = `${a.name} exited while working on ${label}.`;
          this.raise(run, { id: `exited:${a.name}`, kind: "agent_exited", agent: a.name, node: label, text });
          if (a.name !== run.state.meta!.lead)
            this.mail(run, { from: SYSTEM, to: run.state.meta!.lead, kind: "system", node: label, body: `${text} To run it again with a fresh agent: af graph cancel ${nodeId} && af graph retry ${nodeId}` });
        }
        continue;
      }
      if (now !== "idle" && now !== "done") {
        run.idleSince.delete(a.name);
        continue;
      }
      const clock = this.opts.clock?.() ?? Date.now();
      if (!run.idleSince.has(a.name)) run.idleSince.set(a.name, clock);

      // Sat idle, after reading its task, while holding a running instance: remind once, then ask the human.
      // Agents' status flickers (working -> done -> working within a second), hence the grace period.
      const running = liveNodes(run.state.graph).map(activeInstance).find((i) => i?.state === "running" && i.agent === a.name);
      if (running && !unreadMail(run.state, a.name).length && clock - run.idleSince.get(a.name)! >= (this.opts.idleGraceMs ?? 20_000)) {
        const label = instanceLabel(running);
        const n = run.reminded.get(label) ?? 0;
        run.reminded.set(label, n + 1);
        run.idleSince.set(a.name, clock); // the next step needs another full idle period
        if (n === 0)
          this.mail(run, { from: SYSTEM, to: a.name, kind: "system", node: label, body: `${label} has not been submitted. If it is finished or cannot be finished, run af done now. If you are waiting for an answer, ignore this.` });
        else this.raise(run, { id: `nosubmit:${a.name}`, kind: "no_submit", agent: a.name, node: label, text: `${a.name} has been idle without submitting ${label}.` });
      }

      // a question or approval on screen: typing a notice would answer it. Wait, and tell the user.
      const screen = a.paneId ? await this.opts.backend.readScreen(a.paneId).catch(() => "") : "";
      if (a.paneId && (parseMenu(screen, a.kind) || screenOverlay(screen, a.kind))) {
        this.raise(run, { id: `blocked:${a.name}`, kind: "blocked", agent: a.name, text: `${a.name} is waiting for an answer in its terminal (approval or question).` });
        continue;
      }
      this.resolve(run, `blocked:${a.name}`);
      const direct = run.direct.get(a.name);
      if (direct?.length) {
        await this.opts.backend.prompt(a.herdrName, direct.shift()!);
        continue;
      }
      const pending = undeliveredMail(run.state, a.name);
      if (pending.length) {
        const af = run.state.meta!.attached && a.name === run.state.meta!.lead ? join(this.opts.binDir, "af") : "af";
        await this.opts.backend.prompt(a.herdrName, noticeText(pending.length, pending.at(-1)!, af));
        this.emit(run, { type: "mail.delivered", at: this.now(), agent: a.name, ids: pending.map((m) => m.id) });
      }
    }
  }

  private dispatchReady(run: Run) {
    for (const node of liveNodes(run.state.graph)) {
      const inst = activeInstance(node);
      if (!inst || inst.state !== "ready" || inst.held) continue;
      const label = instanceLabel(inst);
      if (run.dispatching.has(label)) continue;
      run.dispatching.add(label);
      const p = this.dispatchOne(run, node, inst)
        .catch((e) => this.dispatchFailed(run, node.id, label, (e as Error).message))
        .finally(() => {
          run.dispatching.delete(label);
          this.pending.delete(p);
        });
      this.pending.add(p);
    }
  }

  private async dispatchOne(run: Run, node: GraphNode, inst: Instance) {
    const spec = node.spec;
    const cwd = this.prepareCwd(run, node);
    let agentName: string;
    if ("agent" in spec.executor) {
      const a = run.state.agents[spec.executor.agent];
      if (!a || a.status === "exited") {
        this.raise(run, { id: `noagent:${node.id}`, kind: "agent_exited", node: node.id, text: `${node.id} is assigned to agent ${spec.executor.agent}, which does not exist or has exited.` });
        return;
      }
      if (this.currentLabel(run, a.name)) return; // busy with another node; try again next tick
      agentName = a.name;
    } else {
      const own = Object.values(run.state.agents).filter((a) => a.node === node.id && a.status !== "exited").at(-1);
      if (own) agentName = own.name;
      else {
        agentName = this.uniqueAgentName(run, node.id);
        await this.spawnAgent(run, { name: agentName, kind: spec.executor.kind, cwd, node: node.id, protocol: "worker" });
      }
    }
    // the graph may have changed while the agent was starting
    const cur = activeInstance(run.state.graph.nodes[node.id]!);
    if (!cur || cur.n !== inst.n || cur.state !== "ready" || cur.held) return;
    this.resolve(run, `noagent:${node.id}`);
    this.exec(run, { type: "instance.dispatch", node: node.id, agent: agentName });
    this.mail(run, { from: run.state.meta!.lead, to: agentName, kind: "task", node: instanceLabel(cur), body: this.taskBody(run, node, cur, cwd) });
  }

  private dispatchFailed(run: Run, nodeId: string, label: string, why: string) {
    const text = `Could not start an agent for ${label}: ${why}`;
    const cur = activeInstance(run.state.graph.nodes[nodeId]!);
    if (cur && instanceLabel(cur) === label && cur.state !== "submitted") this.exec(run, { type: "instance.cancel", node: nodeId });
    this.raise(run, { id: `dispatch:${label}`, kind: "agent_exited", node: label, text });
    this.mail(run, { from: SYSTEM, to: run.state.meta!.lead, kind: "system", node: label, body: `${text}\n${label} was cancelled. Fix the cause (see the agent's terminal or the server log), then: af graph retry ${nodeId}` });
  }

  /** Stop an agent for good: close its terminal and mark it exited, so the next instance gets a fresh agent. */
  private async retire(run: Run, name: string) {
    const a = run.state.agents[name];
    if (!a || a.status === "exited") return;
    this.setStatus(run, name, "exited");
    if (a.tabId) await this.opts.backend.closeTab(a.tabId);
  }

  private uniqueAgentName(run: Run, base: string) {
    if (!run.state.agents[base]) return base;
    for (let i = 2; ; i++) {
      const name = `${base.slice(0, 28)}-${i}`;
      if (!run.state.agents[name]) return name;
    }
  }

  /** Directory a node works in. */
  private cwdFor(run: Run, node: GraphNode) {
    const meta = run.state.meta!;
    if (!meta.repo) return meta.cwd;
    if (node.spec.isolation === "shared") return meta.integration!;
    return join(meta.repo, ".agent-flow", "worktrees", run.id, node.id);
  }

  private prepareCwd(run: Run, node: GraphNode) {
    const meta = run.state.meta!;
    const cwd = this.cwdFor(run, node);
    if (!meta.repo || node.spec.isolation === "shared") return cwd;
    const existed = existsSync(join(cwd, ".git"));
    git.addWorktree(meta.repo, cwd, nodeBranch(run.id, node.id), meta.branch!);
    if (existed && !git.isDirty(cwd)) git.refreshFrom(cwd, meta.branch!);
    return cwd;
  }

  private taskBody(run: Run, node: GraphNode, inst: Instance, cwd: string) {
    const meta = run.state.meta!;
    const label = instanceLabel(inst);
    const where = !meta.repo
      ? ""
      : node.spec.isolation === "isolated"
        ? ` (git branch ${nodeBranch(run.id, node.id)}; agent-flow commits your changes when you submit)`
        : ` (integration worktree on ${meta.branch}; treat it as read-only unless the task says otherwise)`;
    const lines = [`You are assigned ${label}.`, `Working directory: ${cwd}${where}`];
    if (inst.trigger.type === "back") {
      const from = inst.inputs[0]!;
      lines.push(`This is a new round of ${node.id} because ${instanceLabel(from)} returned "${this.outcomeOf(run, from)}". Its note is below.`);
    }
    lines.push("", "Task:", node.spec.task);
    if (inst.inputs.length) {
      lines.push("", "Inputs:");
      for (const ref of inst.inputs) {
        const sub = getInstance(run.state.graph, ref)?.submissions.at(-1);
        lines.push(`- ${instanceLabel(ref)} outcome=${sub?.outcome ?? "-"}${sub?.note ? ` note: ${sub.note}` : ""}${sub?.result ? ` result: ${sub.result}` : ""}`);
      }
    }
    lines.push("", `When done: af done --outcome <outcome> --note "<one line>" [--result <path>]`);
    return lines.join("\n");
  }

  private outcomeOf(run: Run, ref: { node: string; n: number }) {
    return getInstance(run.state.graph, ref)?.submissions.at(-1)?.outcome ?? "-";
  }

  private quiescentSummary(run: Run) {
    const g = run.state.graph;
    const fmt = (i: Instance) => `${instanceLabel(i)}${i.submissions.at(-1)?.outcome ? ` (${i.submissions.at(-1)!.outcome})` : ""}`;
    const nodes = liveNodes(g);
    const accepted = nodes.map(latestInstance).filter((i): i is Instance => i?.state === "accepted").map(fmt);
    const waiting = nodes.filter((n) => !n.instances.length).map((n) => n.id);
    const limited = liveEdges(g).filter((e) => e.blocked).map((e) => `${e.from} -> ${e.to} (${e.fired}/${e.max})`);
    return [
      "The graph is quiescent: nothing is ready or running.",
      `Latest accepted: ${accepted.join(", ") || "none"}`,
      ...(waiting.length ? [`Never started (dependencies not met): ${waiting.join(", ")}`] : []),
      ...(limited.length ? [`Loop limits reached: ${limited.join(", ")}`] : []),
      `Report the results to the user, or add nodes to continue.${run.state.meta!.branch ? ` The run's work is on branch ${run.state.meta!.branch}.` : ""}`,
    ].join("\n");
  }
}
