import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentKind, type AgentStatus, latestInstance, instanceLabel } from "@af/core";
import { commitAll, git } from "../src/git.ts";
import { FakeBackend } from "./fake.ts";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { AfError, Orchestrator } from "../src/orchestrator.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};

const clock = { ms: 0 };

function setup(opts: { git?: boolean } = { git: true }) {
  const home = tmp("af-home-");
  process.env.CODEX_HOME = tmp("af-codex-"); // codex profiles must not land in the real ~/.codex
  const repo = tmp("af-repo-");
  if (opts.git) {
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "app.txt"), "line1\nline2\nline3\n");
    commitAll(repo, "init");
  }
  const backend = new FakeBackend();
  let t = 0;
  clock.ms = 0;
  const o = new Orchestrator({
    home,
    backend,
    sock: join(home, "server.sock"),
    binDir: "/opt/af/bin",
    protocolDir: join(import.meta.dir, "../../skill"),
    config: DEFAULT_CONFIG,
    now: () => `2026-11-02T00:00:${String(++t).padStart(4, "0")}Z`,
    clock: () => clock.ms,
    idleGraceMs: 20_000,
  });
  return { home, repo, backend, o };
}

const st = (o: Orchestrator, run: string, node: string) => {
  const i = latestInstance(o.getRun(run).graph.nodes[node]!);
  return i ? `${instanceLabel(i)}:${i.state}` : "none";
};

describe("orchestrator: a full review loop in a git repo", () => {
  test("lead builds a loop; workers run in worktrees; accept merges; fail loops back to the same agent", async () => {
    const { repo, backend, o, home } = setup();
    const meta = await o.createRun({ cwd: repo, prompt: "please build X" });
    const run = meta.id;
    const lead = { run, agent: "lead" };
    const hn = (a: string) => `${run}-${a}`;

    // lead started with the lead protocol injected, and gets the user's prompt once idle
    expect(backend.agentPane(hn("lead"))!.agent!.args).toContain("--append-system-prompt-file");
    expect(backend.envs.get("lead")).toMatchObject({ AF_RUN: run, AF_AGENT: "lead" });
    const tabsOfRun = [...backend.tabs.values()].filter((t) => t.workspaceId === meta.herdrWorkspace);
    expect(tabsOfRun.map((t) => t.label)).toEqual(["lead"]); // the lead uses the workspace's root pane: no empty shell tab
    await o.flush();
    expect(backend.promptsTo(hn("lead"))).toEqual(["please build X"]);
    expect(git(repo, ["status", "--porcelain"]).out).toBe(""); // worktrees hidden from the user's status

    o.graph(lead, { type: "node.add", id: "code", spec: { task: "implement X", executor: { kind: "codex" } } });
    o.graph(lead, { type: "node.add", id: "review", spec: { task: "review X", executor: { kind: "claude" }, isolation: "shared", autoAccept: true }, after: [{ from: "code" }] });
    o.graph(lead, { type: "edge.link", from: "review", to: "code", on: "fail", max: 2 });
    o.graph(lead, { type: "node.add", id: "docs", spec: { task: "document X", isolation: "shared" }, after: [{ from: "review", on: "pass" }] });

    // dispatch: a codex agent named "code" is spawned in its own worktree and gets a task + notice
    await o.flush();
    expect(st(o, run, "code")).toBe("code#1:running");
    const codeAgent = o.getRun(run).agents.code!;
    expect(codeAgent.cwd).toBe(join(repo, ".agent-flow/worktrees", run, "code"));
    expect(backend.agentPane(hn("code"))!.agent!.kind).toBe("codex");
    await o.flush();
    expect(backend.promptsTo(hn("code"))).toEqual([expect.stringContaining("[agent-flow] New message")]);
    const task = o.inbox({ run, agent: "code" });
    expect(task[0]!.body).toContain("You are assigned code#1.");
    expect(task[0]!.body).toContain("implement X");
    expect(o.inbox({ run, agent: "code" })).toEqual([]); // marked read

    // the worker writes and submits; agent-flow commits on the node branch and tells the lead
    writeFileSync(join(codeAgent.cwd, "x.ts"), "export const x = 1;\n");
    const r1 = o.done({ run, agent: "code" }, { outcome: "pass", note: "first try", result: "x.ts" });
    expect(r1.accepted).toBe(false);
    expect(o.getRun(run).graph.nodes.code!.instances[0]!.submissions[0]!.result).toBe(join(codeAgent.cwd, "x.ts"));
    expect(o.diff(lead, "code")).toContain("+export const x = 1;");
    const leadMail = o.inbox(lead);
    expect(leadMail.at(-1)!.body).toContain("code#1 submitted by code with outcome pass");

    // workers cannot change the graph
    expect(() => o.graph({ run, agent: "code" }, { type: "instance.accept", node: "code" })).toThrow(AfError);

    o.graph(lead, { type: "instance.accept", node: "code" });
    expect(readFileSync(join(meta.integration!, "x.ts"), "utf8")).toContain("x = 1");
    expect(git(repo, ["rev-parse", "main"]).out).toBe(meta.base!); // user's branch untouched

    // review runs in the integration worktree and fails → auto-accepted → loops back to code#2
    await o.flush();
    expect(st(o, run, "review")).toBe("review#1:running");
    expect(o.getRun(run).agents.review!.cwd).toBe(meta.integration!);
    const rv = o.done({ run, agent: "review" }, { outcome: "fail", note: "x should be 2" });
    expect(rv.accepted).toBe(true);
    expect(st(o, run, "code")).toBe("code#2:ready");

    await o.flush();
    expect(st(o, run, "code")).toBe("code#2:running");
    expect(latestInstance(o.getRun(run).graph.nodes.code!)!.agent).toBe("code"); // same agent session
    expect(Object.keys(o.getRun(run).agents).sort()).toEqual(["code", "lead", "review"]);
    const round2 = o.inbox({ run, agent: "code" });
    expect(round2[0]!.body).toContain('new round of code because review#1 returned "fail"');
    expect(round2[0]!.body).toContain("x should be 2");

    writeFileSync(join(codeAgent.cwd, "x.ts"), "export const x = 2;\n");
    o.done({ run, agent: "code" }, { outcome: "pass", note: "x is 2" });
    // lead rejects once, worker fixes on the same branch
    o.graph(lead, { type: "instance.reject", node: "code", reason: "add a comment" });
    expect(st(o, run, "code")).toBe("code#2:running");
    expect(o.inbox({ run, agent: "code" }).at(-1)!.body).toContain("add a comment");
    writeFileSync(join(codeAgent.cwd, "x.ts"), "// the answer\nexport const x = 2;\n");
    o.done({ run, agent: "code" }, { outcome: "pass", note: "commented" });
    o.graph(lead, { type: "instance.accept", node: "code" });
    await o.flush();
    o.done({ run, agent: "review" }, { outcome: "pass", note: "lgtm" });
    expect(st(o, run, "docs")).toBe("docs#1:ready");
    await o.flush();
    o.done({ run, agent: "docs" }, { note: "documented" });
    o.graph(lead, { type: "instance.accept", node: "docs" });
    expect(o.getRun(run).graph.quiescent).toBe(true);
    expect(o.inbox(lead).at(-1)!.body).toContain("The graph is quiescent");
    expect(readFileSync(join(meta.integration!, "x.ts"), "utf8")).toBe("// the answer\nexport const x = 2;\n");

    // restart: a fresh orchestrator rebuilds the same state from events.jsonl
    const o2 = new Orchestrator({ ...o.opts });
    expect(o2.load()).toBe(1);
    expect(o2.getRun(run)).toEqual(o.getRun(run));
    expect(existsSync(join(home, "runs", run, "graph.json"))).toBe(true);
  });
});

describe("orchestrator: conflicts, startup, reminders", () => {
  test("a conflicting parallel node is reported, rejected with merge instructions, then fixed", async () => {
    const { repo, o } = setup();
    const { id: run, integration } = await o.createRun({ cwd: repo });
    const lead = { run, agent: "lead" };
    o.graph(lead, { type: "node.add", id: "a", spec: { task: "A", executor: { kind: "codex" } } });
    o.graph(lead, { type: "node.add", id: "b", spec: { task: "B", executor: { kind: "omp" } } });
    await o.flush();
    const wa = o.getRun(run).agents.a!.cwd;
    const wb = o.getRun(run).agents.b!.cwd;
    writeFileSync(join(wa, "app.txt"), "line1\nA\nline3\n");
    writeFileSync(join(wb, "app.txt"), "line1\nB\nline3\n");
    o.done({ run, agent: "a" }, { note: "A" });
    o.done({ run, agent: "b" }, { note: "B" });
    o.graph(lead, { type: "instance.accept", node: "a" });
    expect(() => o.graph(lead, { type: "instance.accept", node: "b" })).toThrow(/conflicts in: app.txt/);
    expect(st(o, run, "b")).toBe("b#1:submitted");
    expect(Object.values(o.getRun(run).attention).map((a) => a.kind)).toContain("merge_conflict");

    o.graph(lead, { type: "instance.reject", node: "b", reason: "keep both A and B" });
    expect(o.inbox({ run, agent: "b" }).at(-1)!.body).toContain(`git merge af/${run}/main`);
    expect(Object.values(o.getRun(run).attention).map((a) => a.kind)).not.toContain("merge_conflict");
    // the worker does what the message says
    git(wb, ["merge", `af/${run}/main`], { allowFail: true });
    writeFileSync(join(wb, "app.txt"), "line1\nA\nB\nline3\n");
    o.done({ run, agent: "b" }, { note: "merged" });
    o.graph(lead, { type: "instance.accept", node: "b" });
    expect(readFileSync(join(integration!, "app.txt"), "utf8")).toBe("line1\nA\nB\nline3\n");
  });

  test("an agent stuck at startup raises attention until it becomes idle", async () => {
    const { repo, backend, o } = setup();
    const pre = await o.createRun({ cwd: repo });
    backend.blockOnStart.add(`${pre.id}-x`);
    await o.spawn({ run: pre.id }, { name: "x", kind: "claude" });
    const att = () => Object.values(o.getRun(pre.id).attention).map((a) => a.id);
    expect(att()).toContain("startup:x");
    await o.flush();
    expect(att()).toContain("startup:x");
    backend.set(`${pre.id}-x`, "idle");
    await o.flush();
    expect(att()).not.toContain("startup:x");
  });

  test("a worker idle for the grace period after reading its task is reminded once, then the human is asked", async () => {
    const { repo, backend, o } = setup();
    const { id: run } = await o.createRun({ cwd: repo });
    o.graph({ run }, { type: "node.add", id: "w", spec: { task: "work", executor: { kind: "claude" } } });
    await o.flush();
    await o.flush(); // task notice delivered
    const h = `${run}-w`;
    const reminders = () => o.getRun(run).mail.filter((m) => m.to === "w" && m.body.includes("has not been submitted")).length;

    // status flicker right after the notice, before the task is even read: no reminder
    backend.set(h, "working");
    await o.flush();
    backend.set(h, "done");
    clock.ms += 60_000;
    await o.flush();
    await o.flush();
    expect(reminders()).toBe(0);

    // reads the task, works, goes idle: nothing until the grace period has passed
    o.inbox({ run, agent: "w" });
    backend.set(h, "working");
    await o.flush();
    backend.set(h, "idle");
    await o.flush();
    clock.ms += 19_000;
    await o.flush();
    expect(reminders()).toBe(0);
    clock.ms += 2_000;
    await o.flush();
    expect(reminders()).toBe(1);
    await o.flush(); // reminder delivered
    expect(backend.promptsTo(h).at(-1)).toContain("New message");

    // still idle another full period: ask the human
    o.inbox({ run, agent: "w" });
    clock.ms += 21_000;
    await o.flush();
    expect(Object.values(o.getRun(run).attention).map((a) => a.kind)).toContain("no_submit");
    expect(reminders()).toBe(1);
    o.done({ run, agent: "w" }, { note: "finally" });
    expect(Object.values(o.getRun(run).attention).map((a) => a.kind)).not.toContain("no_submit");
  });

  test("notices wait while an agent is working or blocked, and go out once it is idle", async () => {
    const { repo, backend, o } = setup();
    const { id: run } = await o.createRun({ cwd: repo });
    await o.flush();
    const h = `${run}-lead`;
    const before = backend.promptsTo(h).length;
    backend.set(h, "working");
    await o.flush();
    o.send({ run, agent: "lead" }, { to: "lead", body: "note to self" });
    await o.flush();
    backend.set(h, "blocked");
    await o.flush();
    expect(backend.promptsTo(h).length).toBe(before);
    expect(Object.values(o.getRun(run).attention).map((a) => a.id)).toContain("blocked:lead");
    backend.set(h, "done");
    await o.flush();
    expect(backend.promptsTo(h).slice(before)).toEqual([expect.stringContaining("New message")]);
    expect(Object.values(o.getRun(run).attention).map((a) => a.id)).not.toContain("blocked:lead");
  });

  test("an agent that never starts: the instance is cancelled, the lead is told, retry gets a fresh agent", async () => {
    const { repo, backend, o } = setup();
    const { id: run } = await o.createRun({ cwd: repo });
    backend.failOnStart.add(`${run}-w`);
    o.graph({ run }, { type: "node.add", id: "w", spec: { task: "work", executor: { kind: "codex" } } });
    await o.flush();
    await o.flush(); // a second tick must not try again
    expect(st(o, run, "w")).toBe("w#1:cancelled");
    expect(o.getRun(run).agents.w!.status).toBe("exited");
    expect(backend.closed.length).toBe(1);
    expect(Object.keys(o.getRun(run).agents)).toEqual(["lead", "w"]);
    expect(o.inbox({ run, agent: "lead" }).at(-1)!.body).toContain("af graph retry w");
    expect(Object.values(o.getRun(run).attention).map((a) => a.id)).toContain("dispatch:w#1");

    o.graph({ run, agent: "lead" }, { type: "instance.retry", node: "w" });
    expect(Object.values(o.getRun(run).attention).map((a) => a.id)).not.toContain("dispatch:w#1");
    await o.flush();
    expect(st(o, run, "w")).toBe("w#2:running");
    expect(latestInstance(o.getRun(run).graph.nodes.w!)!.agent).toBe("w-2");
  });

  test("retry retires the node's old agent even if it still looks alive", async () => {
    const { repo, backend, o } = setup();
    const { id: run } = await o.createRun({ cwd: repo });
    o.graph({ run }, { type: "node.add", id: "w", spec: { task: "work", executor: { kind: "omp" } } });
    await o.flush();
    backend.set(`${run}-w`, "unknown"); // e.g. a confused agent
    o.graph({ run }, { type: "instance.cancel", node: "w" });
    o.graph({ run }, { type: "instance.retry", node: "w" });
    await o.flush();
    expect(o.getRun(run).agents.w!.status).toBe("exited");
    expect(backend.closed).toContain(o.getRun(run).agents.w!.tabId!);
    expect(latestInstance(o.getRun(run).graph.nodes.w!)!.agent).toBe("w-2");
  });

  test("an agent that disappears from Herdr while working raises attention", async () => {
    const { repo, backend, o } = setup();
    const { id: run } = await o.createRun({ cwd: repo });
    o.graph({ run }, { type: "node.add", id: "w", spec: { task: "work" } });
    await o.flush();
    backend.remove(`${run}-w`);
    await o.flush();
    expect(o.getRun(run).agents.w!.status).toBe("exited");
    expect(Object.values(o.getRun(run).attention).map((a) => a.kind)).toContain("agent_exited");
    expect(o.inbox({ run, agent: "lead" }).at(-1)!.body).toContain("af graph cancel w && af graph retry w");
    o.graph({ run }, { type: "instance.cancel", node: "w" });
    expect(Object.values(o.getRun(run).attention).map((a) => a.kind)).not.toContain("agent_exited");
  });
});

describe("orchestrator: messaging and other entry points", () => {
  test("send / reply / open, and errors that explain themselves", async () => {
    const { repo, o } = setup();
    const { id: run } = await o.createRun({ cwd: repo });
    await o.spawn({ run, agent: "lead" }, { name: "helper", kind: "omp", role: "answers questions" });
    expect(o.inbox({ run, agent: "helper" })[0]!.body).toBe("Your role in this run: answers questions");
    const q = o.send({ run, agent: "helper" }, { to: "lead", body: "which file?" });
    o.reply({ run, agent: "lead" }, q.id, "src/x.ts");
    expect(o.inbox({ run, agent: "helper" }).at(-1)).toMatchObject({ from: "lead", kind: "reply", replyTo: q.id, body: "src/x.ts" });
    o.send({ run, agent: "lead" }, { to: "user", body: "need a decision" });
    expect(Object.values(o.getRun(run).attention).map((a) => a.kind)).toContain("lead");

    const op = o.open({ run, agent: "lead" }, "app.txt");
    expect(op).toMatchObject({ by: "lead", target: join(repo, "app.txt"), node: undefined });
    expect(() => o.open({ run, agent: "lead" }, "nope.txt")).toThrow(/does not exist/);
    expect(o.open({ run }, "https://example.com").target).toBe("https://example.com");

    expect(() => o.done({ run, agent: "helper" }, {})).toThrow(/has no running node/);
    expect(() => o.send({ run, agent: "lead" }, { to: "ghost", body: "hi" })).toThrow(/no agent ghost/);
    expect(() => o.graph({ run, agent: "lead" }, { type: "instance.submit", node: "x" })).toThrow(/issued by agent-flow itself/);
    expect(() => o.spawn({ run, agent: "helper" }, { name: "y", kind: "claude" })).toThrow(/only the lead/);
  });

  test("a run outside git works with every node in the run directory", async () => {
    const { repo: plain, o } = setup({ git: false });
    const meta = await o.createRun({ cwd: plain, leadKind: "omp" });
    expect(meta.repo).toBeUndefined();
    o.graph({ run: meta.id }, { type: "node.add", id: "a", spec: { task: "x" } });
    await o.flush();
    expect(o.getRun(meta.id).agents.a!.cwd).toBe(plain);
    o.done({ run: meta.id, agent: "a" }, { outcome: "pass" });
    o.graph({ run: meta.id }, { type: "instance.accept", node: "a" });
    expect(st(o, meta.id, "a")).toBe("a#1:accepted");
    expect(() => o.diff({ run: meta.id }, "a")).toThrow(/not in a git repository/);
  });

  test("team files spawn every agent with its role", async () => {
    const { repo, backend, o } = setup();
    writeFileSync(
      join(repo, "team.yaml"),
      "name: review-loop\nentry: boss\nagents:\n  boss: { kind: claude, role: plan and check }\n  reviewer: { kind: codex, role: review diffs }\n",
    );
    const meta = await o.createRun({ cwd: repo, team: "team.yaml" });
    expect(meta.lead).toBe("boss");
    expect(backend.agentPane(`${meta.id}-reviewer`)!.agent!.kind).toBe("codex");
    const args = backend.agentPane(`${meta.id}-reviewer`)!.agent!.args;
    expect(args.slice(0, 2)).toEqual(["-p", "agent-flow-worker"]);
    expect(args.join(" ").length).toBeLessThan(200); // never the protocol itself: typed lines are capped at 1024 bytes
    expect(readFileSync(join(process.env.CODEX_HOME!, "agent-flow-worker.config.toml"), "utf8")).toContain("af done --outcome");
    expect(o.getRun(meta.id).agents.reviewer!.cwd).toBe(meta.integration!);
    expect(o.inbox({ run: meta.id, agent: "reviewer" })[0]!.body).toContain("review diffs");
    await expect(o.createRun({ cwd: repo, team: "missing" })).rejects.toThrow(/no team file/);
  });
});
