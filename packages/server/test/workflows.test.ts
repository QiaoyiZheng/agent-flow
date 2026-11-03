import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceLabel, latestInstance, liveEdges } from "@af/core";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { commitAll, git } from "../src/git.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { WorkflowLibrary, parseWorkflow, previewGraph, workflowCommands } from "../src/workflows.ts";
import { FakeBackend } from "./fake.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p = "af-wf-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
const BUILTIN = join(import.meta.dir, "../../skill/workflows");

describe("workflow templates", () => {
  test("every built-in template is valid and builds its graph", () => {
    const lib = new WorkflowLibrary(BUILTIN, tmp());
    const list = lib.list();
    expect(list.map((w) => w.id).sort()).toEqual(["bugfix", "compare-plans", "implement-review", "research-write-review"]);
    for (const w of list) {
      expect(w.error).toBeUndefined();
      expect(w.needsGoal).toBe(true);
      expect(Object.keys(w.preview!.nodes).length).toBeGreaterThan(1);
      expect(Object.values(w.preview!.edges).some((e) => e.back)).toBe(true); // each has a rework loop
    }
  });

  test("goal is filled in; nodes are ordered after their dependencies; bad templates are explained", () => {
    const w = parseWorkflow("name: t\nnodes:\n  - id: b\n    after: [a]\n    task: 'B for {{goal}}'\n  - id: a\n    kind: codex\n    task: 'A for {{ goal }}'\nloops:\n  - { from: b, to: a, on: fail }\n", "t.yaml");
    const cmds = workflowCommands(w, "加验证码");
    expect(cmds.map((c) => c.type + ":" + ("id" in c ? c.id : `${(c as any).from}->${(c as any).to}`))).toEqual(["node.add:a", "node.add:b", "edge.link:b->a"]);
    expect((cmds[0] as any).spec).toMatchObject({ task: "A for 加验证码", executor: { kind: "codex" }, isolation: "isolated" });
    expect(() => parseWorkflow("nodes: []", "x.yaml")).toThrow(/needs a list of nodes/);
    expect(() => parseWorkflow("nodes:\n  - id: Bad Id\n    task: x", "x.yaml")).toThrow(/needs an id/);
    expect(() => parseWorkflow("nodes:\n  - id: a\n    kind: gpt\n    task: x", "x.yaml")).toThrow(/unknown kind/);
    expect(() => workflowCommands(parseWorkflow("nodes:\n  - id: a\n    after: [z]\n    task: x", "x.yaml"), "")).toThrow(/z, which is not a node/);
    expect(() => workflowCommands(parseWorkflow("nodes:\n  - { id: a, after: [b], task: x }\n  - { id: b, after: [a], task: y }", "x.yaml"), "")).toThrow(/use loops: for cycles/);
    // the engine's own rules apply: a loop must be conditional
    expect(() => previewGraph(parseWorkflow("nodes:\n  - { id: a, task: x }\n  - { id: b, after: [a], task: y }\nloops:\n  - { from: b, to: a }", "x.yaml"))).toThrow(/needs --on/);
  });

  test("your templates and the project's override built-ins with the same id", () => {
    const user = tmp();
    const proj = tmp();
    writeFileSync(join(user, "implement-review.yaml"), "name: my version\nnodes:\n  - { id: x, task: 'do {{goal}}' }\n");
    mkdirSync(join(proj, ".agent-flow/workflows"), { recursive: true });
    writeFileSync(join(proj, ".agent-flow/workflows/release.yaml"), "name: release\nnodes:\n  - { id: tag, task: tag it }\n");
    writeFileSync(join(proj, ".agent-flow/workflows/broken.yaml"), "nodes: [");
    const list = new WorkflowLibrary(BUILTIN, user).list(proj);
    expect(list.find((w) => w.id === "implement-review")).toMatchObject({ name: "my version", source: "yours" });
    expect(list.find((w) => w.id === "release")).toMatchObject({ source: "project", needsGoal: false });
    expect(list.find((w) => w.id === "broken")!.error).toMatch(/not valid YAML/);
  });
});

describe("runs from workflows", () => {
  async function setup() {
    const home = tmp("af-wf-home-");
    const repo = tmp("af-wf-repo-");
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    commitAll(repo, "init");
    process.env.CODEX_HOME = tmp("af-codex-");
    const backend = new FakeBackend();
    const workflows = new WorkflowLibrary(BUILTIN, join(home, "workflows"));
    const o = new Orchestrator({ home, backend, sock: "/s", binDir: "/b", protocolDir: join(import.meta.dir, "../../skill"), config: DEFAULT_CONFIG, workflows });
    return { home, repo, backend, o, workflows };
  }

  test("the graph is built at once, the goal is in the tasks, the lead is briefed, workers are dispatched", async () => {
    const { repo, backend, o } = await setup();
    const meta = await o.createRun({ cwd: repo, workflow: "implement-review", goal: "给登录页加验证码" });
    expect(meta).toMatchObject({ workflow: "implement-review", goal: "给登录页加验证码" });
    const g = o.getRun(meta.id).graph;
    expect(Object.keys(g.nodes)).toEqual(["code", "review"]);
    expect(g.nodes.code!.spec.task).toContain("目标：给登录页加验证码");
    expect(liveEdges(g).find((e) => e.back)).toMatchObject({ from: "review", to: "code", on: "fail", max: 3 });
    const brief = o.inbox({ run: meta.id, agent: "lead" }).find((m) => m.body.includes("follows the workflow"))!;
    expect(brief.body).toContain('"实现 + 审查循环"');
    expect(brief.body).toContain("review -> code on fail, at most 3 times");
    await o.flush();
    const code = latestInstance(o.getRun(meta.id).graph.nodes.code!)!;
    expect(`${instanceLabel(code)}:${code.state}`).toBe("code#1:running");
    expect(backend.agentPane(`${meta.id}-code`)!.agent!.kind).toBe("codex");
    expect(backend.envs.get("code")?.AF_OUT ?? backend.agentPane(`${meta.id}-code`)!.env.AF_OUT).toBe(join(o.opts.home, "runs", meta.id, "out"));
  });

  test("a workflow that needs a goal refuses to start without one, and nothing is created", async () => {
    const { repo, o, home } = await setup();
    await expect(o.createRun({ cwd: repo, workflow: "bugfix" })).rejects.toThrow(/needs a goal/);
    await expect(o.createRun({ cwd: repo, workflow: "nope", goal: "x" })).rejects.toThrow(/no workflow nope/);
    expect(o.listRuns()).toEqual([]);
    expect(git(repo, ["branch", "--list", "af/*"]).out).toBe("");
    void home;
  });

  test("save as workflow: the run's graph becomes a template with {{goal}} back in place, and starts again", async () => {
    const { repo, o, workflows } = await setup();
    const meta = await o.createRun({ cwd: repo, workflow: "bugfix", goal: "登录后白屏" });
    o.graph({ run: meta.id, agent: "lead" }, { type: "node.add", id: "docs", spec: { task: "把 登录后白屏 的修复写进 CHANGELOG", executor: { kind: "omp" }, isolation: "shared" }, after: [{ from: "verify", on: "pass" }] });
    const saved = workflows.saveFromRun(o.getRun(meta.id), "白屏修复流程");
    expect(saved).toMatchObject({ source: "yours", needsGoal: true });
    const text = readFileSync(saved.path, "utf8");
    expect(text).toContain("{{goal}}");
    expect(text).not.toContain("登录后白屏");
    const again = await o.createRun({ cwd: repo, workflow: saved.id, goal: "支付页卡死" });
    const g = o.getRun(again.id).graph;
    expect(Object.keys(g.nodes)).toEqual(["reproduce", "fix", "verify", "docs"]);
    expect(g.nodes.docs!.spec.task).toBe("把 支付页卡死 的修复写进 CHANGELOG");
    expect(liveEdges(g).find((e) => e.to === "docs")).toMatchObject({ from: "verify", on: "pass" });
  });
});
