import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, launchArgs, plainArgs } from "../src/agents.ts";
import { Sleeper, agentArgs, dropMissingFiles, parseTopMem, agentProcess, childWork, etimeSeconds, keptOptions, memoryMb, parsePs, resumeArgs, scheduledWork, sessionOf } from "../src/sleep.ts";
import { LocalFS } from "../src/transcripts/index.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeBackend } from "./fake.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "af-sleep-")));
  dirs.push(d);
  return d;
};
const ID = "31ae5ea6-0c5f-429a-b14e-2be8f16545f0";
const config = { ...DEFAULT_CONFIG, claudeSettings: "/af/claude-settings.json" };

describe("resuming an agent with the flags it was started with", () => {
  test("claude: its settings and protocol kept; a new session id, a first message, --continue dropped", () => {
    expect(resumeArgs("claude", plainArgs("claude", config, "s-1"), { id: ID })).toEqual(["--settings", "/af/claude-settings.json", "--permission-mode", "auto", "--resume", ID]);
    expect(resumeArgs("claude", launchArgs("claude", "member", "/t/member.md", config, "s-1"), { id: ID })).toEqual([
      "--append-system-prompt-file",
      "/t/member.md",
      "--settings",
      "/af/claude-settings.json",
      "--permission-mode",
      "auto",
      "--resume",
      ID,
    ]);
    expect(resumeArgs("claude", ["fix the tests", "--resume", "old", "-c", "--add-dir", "/a", "/b"], { id: ID })).toEqual(["--add-dir", "/a", "/b", "--resume", ID]);
    expect(resumeArgs("claude", ["--model=opus", "--", "a message"], { id: ID })).toEqual(["--model=opus", "--resume", ID]);
    expect(resumeArgs("claude", [], {})).toBeUndefined();
  });

  test("codex: its resume subcommand with its options; omp: its file; gemini: no first message", () => {
    expect(resumeArgs("codex", plainArgs("codex", config), { id: ID })).toEqual(["resume", "-c", "check_for_update_on_startup=false", "--no-alt-screen", "-c", "sandbox_workspace_write.network_access=true", ID]);
    expect(resumeArgs("codex", ["resume", "old-id", "-p", "agent-flow-member", "-i", "a.png", "b.png", "do it"], { id: ID })).toEqual(["resume", "-p", "agent-flow-member", ID]);
    expect(resumeArgs("omp", ["--append-system-prompt=/t/member.md", "--continue"], { path: "/s/x.jsonl" })).toEqual(["--append-system-prompt=/t/member.md", "--resume=/s/x.jsonl"]);
    expect(resumeArgs("gemini", launchArgs("gemini", "member", "/t/p/member.md", config), { id: ID })).toEqual(["--include-directories", "/t/p", "--approval-mode=yolo", "--resume", ID]);
    expect(keptOptions("nope", ["--x"])).toEqual([]);
  });

  test("the agent's own arguments, also when it runs through an interpreter; files that are gone left out", () => {
    expect(agentArgs("omp", ["bun", "/Users/u/.bun/bin/omp", "--append-system-prompt=/tmp/p.md"])).toEqual(["--append-system-prompt=/tmp/p.md"]);
    expect(agentArgs("gemini", ["node", "--import=/u/.gemini/agent-flow/gateway-fix.mjs", "/opt/lib/gemini-cli/bundle/gemini.js", "--approval-mode=yolo"])).toEqual(["--approval-mode=yolo"]);
    expect(agentArgs("claude", ["claude", "--resume"])).toEqual(["--resume"]);
    // "--resume" without a value (claude's list): the next option is not taken for its value
    expect(resumeArgs("claude", ["--resume", "--settings", "/af/s.json"], { id: ID })).toEqual(["--settings", "/af/s.json", "--resume", ID]);
    const gone = (f: string) => !f.startsWith("/tmp/");
    expect(dropMissingFiles("claude", ["--settings", "/tmp/af-e2e/claude-settings.json", "--permission-mode", "auto", "--resume", ID], gone)).toEqual({ args: ["--permission-mode", "auto", "--resume", ID], dropped: ["/tmp/af-e2e/claude-settings.json"] });
    expect(dropMissingFiles("omp", ["--append-system-prompt=/tmp/t/member.md", "--resume=/s/x.jsonl"], gone)).toEqual({ args: ["--resume=/s/x.jsonl"], dropped: ["/tmp/t/member.md"] });
    expect(dropMissingFiles("claude", ["--settings", "/home/u/s.json"], gone).args).toEqual(["--settings", "/home/u/s.json"]);
  });

  test("the conversation: from the transcript's name, what Herdr reports, or gemini's first line", () => {
    const src = (agent: string, path: string) => ({ agent, path, how: "session" }) as any;
    expect(sessionOf("claude", src("claude", `/p/${ID}.jsonl`), undefined)).toEqual({ id: ID, path: `/p/${ID}.jsonl` });
    expect(sessionOf("codex", src("codex", `/r/rollout-2026-11-05T10-00-00-${ID}.jsonl`), undefined)?.id).toBe(ID);
    expect(sessionOf("codex", undefined, { kind: "id", value: ID })?.id).toBe(ID);
    expect(sessionOf("omp", src("omp", "/o/2026_abc.jsonl"), undefined)).toEqual({ path: "/o/2026_abc.jsonl" });
    expect(sessionOf("gemini", src("gemini", "/g/session-x.jsonl"), undefined, JSON.stringify({ sessionId: ID }) + "\n{}")?.id).toBe(ID);
    expect(sessionOf("claude", src("claude", "/p/not-a-session.jsonl"), undefined)).toBeUndefined();
    expect(agentProcess("claude", [{ pid: 1, argv: ["caffeinate", "-i"] }, { pid: 2, argv: ["claude", "--resume", ID] }])?.pid).toBe(2);
    expect(agentProcess("gemini", [{ pid: 3, argv: ["node", "/opt/bin/gemini", "-m", "x"] }])?.pid).toBe(3);
  });
});

describe("work an idle agent still has running", () => {
  test("processes it started during its turns count; what started with it (MCP servers, helpers) does not", () => {
    expect([etimeSeconds("05:07"), etimeSeconds("1:02:03"), etimeSeconds("2-00:00:10")]).toEqual([307, 3723, 172810]);
    const ps = parsePs(
      [
        "  100     1 2-00:00:00  20480 claude",
        "  101   100 1-23:59:58   4096 node", // an MCP server, started with it
        "  102   100 1-23:59:59   1024 caffeinate",
        "  103   100    3:00:00   8192 /bin/zsh", // the shell of a command it started later
        "  104   103    2:59:59  65536 python3", // the experiment
        "  200     1      10:00   1000 other",
      ].join("\n"),
    );
    expect(childWork(ps, 100)).toEqual(["zsh", "python3"]);
    // a plugin or MCP server it started again later, and what that runs: helpers, not work
    const withPlugin = parsePs(
      [
        "  100     1 2-00:00:00  20480 codex -c x",
        "  110   100    1:00:00   1000 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node --import file:///u/.codex/plugins/cache/openai-bundled/unified-computer-use/x.js",
        "  111   110    1:00:00   1000 /Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl",
        "  112   100    1:00:00   1000 npx -y @modelcontextprotocol/server-filesystem /tmp",
      ].join("\n"),
    );
    expect(childWork(withPlugin, 100)).toEqual([]);
    // a language server claude started when it read a Python file (seen on joy: pyright, hours after claude)
    const withLsp = parsePs(["  100     1 2-00:00:00  20480 claude", "  120   100    4:00:00   9000 node /home/joy/.local/bin/pyright-langserver --stdio"].join("\n"));
    expect(childWork(withLsp, 100)).toEqual([]);
    // omp's own worker broker, started again hours in (seen on joy)
    const withBroker = parsePs(["  100     1 11-00:00:00  20480 bun /home/u/.local/bin/omp", "  130   100 10-22:00:00   9000 /home/u/.local/bin/bun /home/u/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js __omp_worker_daemon_broker"].join("\n"));
    expect(childWork(withBroker, 100)).toEqual([]);
    expect(withPlugin.get(110)?.comm).toBe("/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node");
    expect(memoryMb(ps, 100)).toBe(Math.round((20480 + 4096 + 1024 + 8192 + 65536) / 1024));
    // with top's figures (compressed and swapped memory counted): those where known, ps's for the rest
    const top = parseTopMem("Processes: 700 total\nPID    MEM\n100    929M\n101    12K\n104    1.5G+\n999    3M-\n");
    expect([top.get(100), top.get(101), top.get(104), top.get(999)]).toEqual([929, 12 / 1024, 1536, 3]);
    expect(memoryMb(ps, 100, top)).toBe(Math.round(929 + 12 / 1024 + 1 + 8 + 1536));
    ps.delete(104);
    ps.delete(103);
    expect(childWork(ps, 100)).toEqual([]);
    expect(childWork(ps, 999)).toEqual([]);
  });

  test("claude's schedules: a cron not removed, a wake-up still to come", () => {
    const line = (at: number, name: string, input: object = {}) => JSON.stringify({ timestamp: new Date(at).toISOString(), message: { content: [{ type: "tool_use", name, input }] } });
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(scheduledWork([line(now - 3600_000, "CronCreate", { cron: "0 9 * * *" })], now)).toBe("1 scheduled task (cron)");
    expect(scheduledWork([line(now - 3600_000, "CronCreate"), line(now - 60_000, "CronDelete", { id: "a" })], now)).toBeUndefined();
    expect(scheduledWork([line(now - 8 * 86400_000, "CronCreate")], now)).toBeUndefined(); // session crons end after 7 days
    expect(scheduledWork([line(now - 600_000, "ScheduleWakeup", { delaySeconds: 1200 })], now)).toBe("a scheduled wake-up");
    expect(scheduledWork([line(now - 600_000, "ScheduleWakeup", { stop: true })], now)).toBeUndefined();
    expect(scheduledWork([line(now - 3 * 3600_000, "ScheduleWakeup", { delaySeconds: 1200 })], now)).toBeUndefined(); // it fired long ago
    expect(scheduledWork(["not json"], now)).toBeUndefined();
  });
});

const BOX = (text = "") => `⏺ done\n${"─".repeat(40)}\n❯ ${text}\n${"─".repeat(40)}\n  ⏵⏵ auto mode on (shift+tab to cycle)`;

async function setup() {
  const home = tmp();
  const backend = new FakeBackend();
  const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
  await w.start(60_000);
  const ws = await backend.createWorkspace("proj", home);
  // an agent process the test can end: exiting claude (two Ctrl+C) ends it and leaves a shell in the pane
  const child = Bun.spawn(["sleep", "60"]);
  let ctrlC = 0;
  backend.onKeys = (_t, keys) => {
    if (keys.includes("ctrl+c") && ++ctrlC >= 2) {
      child.kill();
      backend.panes.get(ws.paneId)!.agent = undefined;
      backend.screens.set(ws.paneId, "zhengqiaoyi@Mac proj % ");
    }
  };
  backend.screens.set(ws.paneId, BOX());
  await w.refresh();
  return { home, backend, w, ws, child };
}

describe("an idle agent stopped and started again in its pane", () => {
  test("stopped: its pane shows it as it was; a message queues, starts it on its conversation, then goes out", async () => {
    const { home, backend, w, ws, child } = await setup();
    backend.panes.get(ws.paneId)!.agent = { name: "", kind: "claude", args: [], status: "done" };
    await w.refresh();
    const settings = join(home, "s.json");
    writeFileSync(settings, "{}");
    const args = ["--settings", settings, "--session-id", ID];
    await w.putToSleep({ pane: ws.paneId, agent: "claude", bin: "claude", args, cwd: home, status: "done", session: { id: ID }, since: new Date().toISOString(), reason: "idle 8 h" }, child.pid);
    await child.exited;
    // only Ctrl+C: a Ctrl+D that reached the shell after the agent quit would end the shell and close the pane
    expect(backend.keys.flatMap((k) => k.keys)).toEqual(["ctrl+c", "ctrl+c"]);
    // Herdr still reports claude for a few seconds after it exits: not taken for a new start
    backend.panes.get(ws.paneId)!.agent = { name: "", kind: "claude", args: [], status: "idle" };
    await w.refresh();
    expect(w.asleepRecord(ws.paneId)).toBeDefined();
    backend.panes.get(ws.paneId)!.agent = undefined;
    await w.refresh();
    let p = w.model.panes.find((x) => x.id === ws.paneId)!;
    expect([p.agent, p.agentStatus, !!p.asleep]).toEqual(["claude", "done", true]);
    expect(JSON.parse(readFileSync(join(home, "asleep.json"), "utf8"))[ws.paneId].session.id).toBe(ID);
    expect(await w.screenState(ws.paneId)).toEqual({}); // its shell is not read as a dialog
    // a restart keeps it
    const again = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await again.start(60_000);
    expect(again.model.panes.find((x) => x.id === ws.paneId)?.asleep).toBeDefined();
    again.stop();

    // the user's message: queued at once (the request does not wait for claude to start), then sent
    const run = backend.runInPane.bind(backend);
    backend.runInPane = async (id, cmd) => {
      await run(id, cmd);
      backend.panes.get(id)!.agent = { name: "", kind: "claude", args: [], status: "idle" };
      backend.screens.set(id, BOX());
    };
    const r = await w.send(ws.paneId, "hello again", []);
    expect(r).toMatchObject({ waking: true });
    for (let i = 0; i < 60 && !backend.prompts.some((x) => x.text === "hello again"); i++) await Bun.sleep(100);
    expect(backend.panes.get(ws.paneId)!.typed).toEqual([`cd '${home}' && 'claude' '--settings' '${settings}' '--resume' '${ID}'`]);
    expect(backend.prompts.map((x) => x.text)).toEqual(["hello again"]);
    p = w.model.panes.find((x) => x.id === ws.paneId)!;
    expect([p.agent, p.asleep]).toEqual(["claude", undefined]);
    expect(JSON.parse(readFileSync(join(home, "asleep.json"), "utf8"))).toEqual({});
    w.stop();
  });

  test("a team member comes back under its Herdr name; exit forgets a stopped agent; a closed pane too", async () => {
    const { home, backend, w, ws, child } = await setup();
    await backend.startAgent("t1abc-writer", "claude", ws.paneId, []);
    const proto = join(home, "m.md");
    writeFileSync(proto, "protocol");
    backend.panes.get(ws.paneId)!.agent!.status = "done";
    await w.refresh();
    await w.putToSleep({ pane: ws.paneId, agent: "claude", name: "t1abc-writer", bin: "claude", args: ["--append-system-prompt-file", proto, "--session-id", ID], cwd: home, status: "done", session: { id: ID }, since: new Date().toISOString(), reason: "finished worker" }, child.pid);
    expect(w.model.panes.find((x) => x.id === ws.paneId)?.agentName).toBe("t1abc-writer");
    expect(await w.wake(ws.paneId)).toBe(true);
    expect(backend.panes.get(ws.paneId)!.agent).toMatchObject({ name: "t1abc-writer", args: ["--append-system-prompt-file", proto, "--resume", ID] });
    expect(await w.wake(ws.paneId)).toBe(false); // running already

    // stopped again, then the user exits it: the pane is a shell
    const child2 = Bun.spawn(["sleep", "60"]);
    backend.onKeys = (_t, keys) => {
      if (keys.includes("ctrl+c")) {
        child2.kill();
        backend.panes.get(ws.paneId)!.agent = undefined;
      }
    };
    await w.putToSleep({ pane: ws.paneId, agent: "claude", bin: "claude", args: [], cwd: home, status: "idle", session: { id: ID }, since: new Date().toISOString(), reason: "idle" }, child2.pid);
    await w.control(ws.paneId, "exit");
    expect(w.model.panes.find((x) => x.id === ws.paneId)?.agent).toBeUndefined();

    // stopped, and its pane closed: forgotten
    const child3 = Bun.spawn(["sleep", "60"]);
    backend.panes.get(ws.paneId)!.agent = { name: "", kind: "claude", args: [], status: "idle" };
    backend.onKeys = () => {
      child3.kill();
      backend.panes.get(ws.paneId)!.agent = undefined;
    };
    await w.refresh();
    await w.putToSleep({ pane: ws.paneId, agent: "claude", bin: "claude", args: [], cwd: home, status: "idle", session: { id: ID }, since: new Date().toISOString(), reason: "idle" }, child3.pid);
    await backend.closePane(ws.paneId);
    await w.refresh();
    expect(w.asleepRecord(ws.paneId)).toBeUndefined();
    w.stop();
  });

  test("the policy: idle long enough, its box empty, no schedule left; then stopped by the check", async () => {
    const { home, backend, w, ws, child } = await setup();
    backend.panes.get(ws.paneId)!.agent = { name: "", kind: "claude", args: [], status: "done" };
    backend.procs.set(ws.paneId, [{ pid: child.pid, argv: ["claude", "--session-id", ID] }]);
    await w.refresh();
    const file = join(home, `${ID}.jsonl`);
    writeFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", name: "CronCreate", input: { cron: "0 9 * * *" } }] } }) + "\n");
    const access = { resolve: async () => ({ source: { agent: "claude", path: file, how: "session" } }), fsFor: () => ({ fs: new LocalFS() }) } as any;
    let team: { worker: boolean; ok: boolean; why?: string } | undefined = { worker: true, ok: false, why: "T1 is in progress" };
    const s = new Sleeper(w, access, { sleepInfo: () => team }, home);
    s.setSettings({ idleHours: 0.00001, workerMinutes: 0.0001 });
    const row = async () => (await s.list(true)).find((r) => r.pane === ws.paneId)!;
    expect((await row()).keep).toBe("T1 is in progress");
    team = undefined;
    await Bun.sleep(80);
    expect((await row()).keep).toBe("1 scheduled task (cron)");
    backend.screens.set(ws.paneId, BOX("half a thought"));
    expect((await row()).keep).toBe("has text typed in its box");
    backend.screens.set(ws.paneId, BOX());
    appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), message: { content: [{ type: "tool_use", name: "CronDelete", input: { id: "x" } }] } }) + "\n");
    expect((await row()).keep).toBeUndefined();
    expect(await s.tick()).toEqual([ws.paneId]);
    await child.exited;
    expect((await row()).asleep?.reason).toStartWith("idle ");
    expect(w.asleepRecord(ws.paneId)?.args).toEqual(["--session-id", ID]);
    expect(existsSync(join(home, "settings.json"))).toBe(true);
    w.stop();
  });
});

describe("after a Herdr restart (a reboot): pages stay, agents resume on a message", () => {
  test("a remembered agent whose pane has a new shell and no agent is shown stopped; the same shell: exited, forgotten", async () => {
    const home = tmp();
    const backend = new FakeBackend();
    const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await w.start(60_000);
    const ws = await backend.createWorkspace("proj", home);
    const other = await backend.splitPane(ws.paneId, "right", home, {});
    for (const id of [ws.paneId, other.paneId]) backend.panes.get(id)!.agent = { name: "", kind: "claude", args: [], status: "done" };
    backend.procs.set(ws.paneId, [{ pid: 4242, argv: ["claude", "--permission-mode", "auto", "--session-id", ID] }]);
    backend.procs.set(other.paneId, [{ pid: 4243, argv: ["claude"] }]);
    backend.shellPids.set(ws.paneId, 500);
    backend.shellPids.set(other.paneId, 501);
    await w.refresh();
    const file = join(home, `${ID}.jsonl`);
    writeFileSync(file, "{}\n");
    const OTHER = "11111111-2222-4333-8444-555555555555";
    const access = { resolve: async (pane: string) => ({ source: { agent: "claude", path: pane === ws.paneId ? file : join(home, `${OTHER}.jsonl`), how: "session" } }), fsFor: () => ({ fs: new LocalFS() }) } as any;
    const s = new Sleeper(w, access, { sleepInfo: () => undefined }, home);
    await s.rememberAll();
    expect(w.knownAgent(ws.paneId)).toMatchObject({ shellPid: 500, agentPid: 4242, session: { id: ID }, args: ["--permission-mode", "auto", "--session-id", ID] });
    expect(JSON.parse(readFileSync(join(home, "known-agents.json"), "utf8"))[other.paneId].session.id).toBe(OTHER);
    w.stop();

    // the machine restarts: Herdr makes the panes again with new shells and no agents; agent-flow starts again
    for (const id of [ws.paneId, other.paneId]) backend.panes.get(id)!.agent = undefined;
    backend.shellPids.set(ws.paneId, 900);
    const w2 = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await w2.start(60_000);
    await w2.refresh();
    for (let i = 0; i < 50 && !w2.model.panes.find((x) => x.id === ws.paneId)?.asleep; i++) await Bun.sleep(20);
    const p = w2.model.panes.find((x) => x.id === ws.paneId)!;
    expect([p.agent, p.agentStatus, !!p.asleep]).toEqual(["claude", "done", true]);
    expect(w2.asleepRecord(ws.paneId)?.reason).toBe("Herdr restarted");
    // the other pane kept its shell (its claude was exited by hand): a shell, and forgotten
    expect(w2.model.panes.find((x) => x.id === other.paneId)?.agent).toBeUndefined();
    expect(w2.knownAgent(other.paneId)).toBeUndefined();
    // a message resumes it on its conversation, with its flags
    const run = backend.runInPane.bind(backend);
    backend.runInPane = async (id, cmd) => {
      await run(id, cmd);
      backend.panes.get(id)!.agent = { name: "", kind: "claude", args: [], status: "idle" };
      backend.screens.set(id, BOX());
    };
    await w2.send(ws.paneId, "go on", []);
    for (let i = 0; i < 60 && !backend.prompts.some((x) => x.text === "go on"); i++) await Bun.sleep(100);
    expect(backend.panes.get(ws.paneId)!.typed.at(-1)).toBe(`cd '${home}' && 'claude' '--permission-mode' 'auto' '--resume' '${ID}'`);
    expect(backend.prompts.map((x) => x.text)).toEqual(["go on"]);
    w2.stop();
  });
});

describe("which machines", () => {
  test("agents on SSH machines are stopped too, unless the user turns that off", async () => {
    const pane = { id: "gpu~w1:p1", machine: "gpu", workspaceId: "gpu~w1", tabId: "gpu~w1:t1", agent: "claude", agentStatus: "done", cwd: "/h", statusAt: "2026-01-01T00:00:00Z" };
    const w = { model: { panes: [pane], machines: [{ id: "gpu", state: "online" }], workspaces: [] }, asleepRecord: () => undefined, machineExec: async () => "", processes: async () => [] } as any;
    const home = tmp();
    const s = new Sleeper(w, {} as any, { sleepInfo: () => undefined }, home);
    expect((await s.list())[0]!.keep).toBe("no agent process found"); // looked at like this Mac's
    s.setSettings({ remote: false });
    expect((await s.list())[0]!.keep).toBe("on an SSH machine (stopping there is off)");
    expect(new Sleeper(w, {} as any, { sleepInfo: () => undefined }, home).settings.remote).toBe(false); // saved
  });
});
