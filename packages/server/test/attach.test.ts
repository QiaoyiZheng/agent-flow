import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instanceLabel, latestInstance } from "@af/core";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { makeHandler } from "../src/api.ts";
import { commitAll, git } from "../src/git.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { installSkill, skillText } from "../src/skills.ts";
import { WorkflowLibrary } from "../src/workflows.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeBackend } from "./fake.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p = "af-at-") => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};

async function setup() {
  const home = tmp("af-at-home-");
  const repo = tmp("af-at-repo-");
  git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "a\n");
  commitAll(repo, "init");
  process.env.CODEX_HOME = tmp("af-codex-");
  const backend = new FakeBackend();
  const workflows = new WorkflowLibrary(join(import.meta.dir, "../../skill/workflows"), join(home, "workflows"));
  const o = new Orchestrator({ home, backend, sock: "/s", binDir: "/opt/af/bin", protocolDir: join(import.meta.dir, "../../skill"), config: DEFAULT_CONFIG, workflows });
  const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
  await w.start(60_000);
  // the user's own claude session, started outside agent-flow
  const ws = await backend.createWorkspace("my-project", repo);
  await backend.startAgent("", "claude", ws.paneId, []);
  backend.agentPane("")!.agent!.name = undefined as any; // Herdr knows it only by pane
  await w.refresh();
  const h = makeHandler(o, w, backend);
  const call = async (method: string, path: string, body: object = {}) => {
    const r = await h(
      method === "GET"
        ? new Request(`http://af${path}?${new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))}`)
        : new Request(`http://af${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
    return { status: r.status, body: (await r.json()) as any };
  };
  return { home, repo, backend, o, w, ws, call };
}

describe("af here: a session the user already has leads a run", () => {
  test("attach, then hand out parallel work from that pane; the graph lives in its workspace", async () => {
    const { repo, backend, o, ws, call } = await setup();
    const at = await call("POST", "/runs/attach", { pane: ws.paneId });
    expect(at.status).toBe(200);
    const run = at.body.id;
    expect(at.body).toMatchObject({ attached: true, herdrWorkspace: ws.workspaceId, branch: `af/${run}/main` });
    expect((await call("POST", "/runs/attach", { pane: ws.paneId })).body.id).toBe(run); // idempotent

    // CLI calls from that pane carry only callerPane: the server knows it is the lead
    expect((await call("GET", "/whoami", { callerPane: ws.paneId })).body).toEqual({ run, agent: "lead" });
    const add = (id: string, kind: string) =>
      call("POST", "/graph", { run, callerPane: ws.paneId, command: { type: "node.add", id, spec: { task: `do ${id}`, executor: { kind }, isolation: "shared" } } });
    expect((await add("a", "codex")).status).toBe(200);
    expect((await add("b", "omp")).status).toBe(200);
    // somebody else's pane cannot change the graph
    const other = await backend.splitPane(ws.paneId, "right", repo, {});
    await backend.startAgent("x", "claude", other.paneId, []);
    expect((await call("POST", "/graph", { run, agent: "x", command: { type: "node.remove", id: "a" } })).status).toBe(403);

    await o.flush();
    const g = o.getRun(run).graph;
    expect(["a", "b"].map((n) => `${instanceLabel(latestInstance(g.nodes[n]!)!)}:${latestInstance(g.nodes[n]!)!.state}`)).toEqual(["a#1:running", "b#1:running"]);
    // workers start as new tabs of the user's workspace
    expect(backend.agentPane(`${run}-a`)!.workspaceId).toBe(ws.workspaceId);

    // a submission is announced in the user's session, with the full af path (no AF_* env there)
    o.done({ run, agent: "a" }, { outcome: "pass", note: "did a" });
    await o.flush();
    const notice = backend.promptsTo(ws.paneId).at(-1)!;
    expect(notice).toContain("[agent-flow] New message");
    expect(notice).toContain("Run: /opt/af/bin/af inbox");
    const inbox = await call("POST", "/inbox", { run, callerPane: ws.paneId });
    expect(inbox.body.at(-1).body).toContain("a#1 submitted by a with outcome pass");
  });

  test("a notice is not typed while the session shows a question; the user is told instead", async () => {
    const { backend, o, ws, call } = await setup();
    const run = (await call("POST", "/runs/attach", { pane: ws.paneId })).body.id;
    o.send({ run, agent: undefined }, { to: "lead", body: "hello" });
    backend.screens.set(ws.paneId, ["Which format?", "", "❯ 1. Markdown", "  2. LaTeX", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n"));
    await o.flush();
    expect(backend.promptsTo(ws.paneId)).toEqual([]);
    expect(Object.keys(o.getRun(run).attention)).toContain("blocked:lead");
    backend.screens.set(ws.paneId, ["⏺ done", "─".repeat(30), "❯", "─".repeat(30), "  ⏵⏵ auto mode on"].join("\n"));
    await o.flush();
    expect(backend.promptsTo(ws.paneId).length).toBe(1);
    expect(Object.keys(o.getRun(run).attention)).not.toContain("blocked:lead");
    // and the composer is refused while a notice is open
    backend.screens.set(ws.paneId, ["─".repeat(30), " Auto mode changes …", "", " Enter to continue"].join("\n"));
    expect((await call("POST", "/prompt", { pane: ws.paneId, text: "hi" })).body.error.code).toBe("agent_asking");
  });

  test("a worker whose new tab is not ready yet is started once the shell is", async () => {
    const { backend, o, ws, call } = await setup();
    const run = (await call("POST", "/runs/attach", { pane: ws.paneId })).body.id;
    backend.busyStarts.set(`${run}-a`, 2);
    await call("POST", "/graph", { run, callerPane: ws.paneId, command: { type: "node.add", id: "a", spec: { task: "x", executor: { kind: "codex" } } } });
    await o.flush();
    expect(latestInstance(o.getRun(run).graph.nodes.a!)!.state).toBe("running");
    expect(o.getRun(run).agents.a!.status).toBe("idle");
  });

  test("graph apply adds a template to the running graph, checked as a whole first", async () => {
    const { o, ws, call } = await setup();
    const run = (await call("POST", "/runs/attach", { pane: ws.paneId })).body.id;
    const r = await call("POST", "/graph/apply", { run, callerPane: ws.paneId, workflow: "implement-review", goal: "加验证码" });
    expect(r.body).toEqual({ workflow: "implement-review", nodes: ["code", "review"] });
    expect(o.getRun(run).graph.nodes.code!.spec.task).toContain("加验证码");
    const again = await call("POST", "/graph/apply", { run, callerPane: ws.paneId, workflow: "implement-review", goal: "x" });
    expect(again.body.error.message).toMatch(/already exists/);
    expect(Object.keys(o.getRun(run).graph.nodes)).toEqual(["code", "review"]); // nothing half-added
  });

  test("one active run per workspace; another pane gets a clear answer", async () => {
    const { backend, w, ws, call } = await setup();
    await call("POST", "/runs/attach", { pane: ws.paneId });
    const second = await backend.splitPane(ws.paneId, "right", undefined, {});
    await backend.startAgent("y", "codex", second.paneId, []);
    await w.refresh();
    const r = await call("POST", "/runs/attach", { pane: second.paneId });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/already has run/);
  });

  test("the skill is written for claude and codex with this server's af path", () => {
    const home = tmp();
    for (const d of [".claude", ".codex"]) require("node:fs").mkdirSync(join(home, d));
    const files = installSkill("/srv/af/bin/af", home);
    expect(files).toEqual([join(home, ".claude/skills/agent-flow/SKILL.md"), join(home, ".codex/skills/agent-flow/SKILL.md")]);
    const text = readFileSync(files[0]!, "utf8");
    expect(text).toStartWith("---\nname: agent-flow\ndescription: ");
    expect(text).toContain("/srv/af/bin/af here");
    expect(skillText("X")).not.toContain("undefined");
  });
});
