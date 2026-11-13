import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrMemberName } from "@af/core";
import type { TranscriptAccess } from "../src/access.ts";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { makeHandler } from "../src/api.ts";
import { Handoffs, freshArgs, loadHandoffSettings } from "../src/handoff.ts";
import { PlaybookLibrary } from "../src/playbooks.ts";
import { Teams } from "../src/teams.ts";
import type { Peek } from "../src/transcripts/peek.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeBackend } from "./fake.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
const SKILL = join(import.meta.dir, "../../skill");
const OLD = "31ae5ea6-0c5f-429a-b14e-2be8f16545f0";
const BOX = (text = "") => `⏺ done\n${"─".repeat(40)}\n❯ ${text}\n${"─".repeat(40)}\n  ⏵⏵ auto mode on (shift+tab to cycle)`;

describe("the arguments of the new session", () => {
  test("its options kept; the ones for one conversation dropped; claude gets a new session id and agent-flow's hook", () => {
    expect(freshArgs("claude", ["--permission-mode", "auto", "--resume", OLD], { session: "new-id", claudeSettings: "/af/s.json" })).toEqual(["--permission-mode", "auto", "--session-id", "new-id", "--settings", "/af/s.json"]);
    expect(freshArgs("claude", ["--settings", "/mine.json", "--session-id", OLD], { session: "new-id", claudeSettings: "/af/s.json" })).toEqual(["--settings", "/mine.json", "--session-id", "new-id"]);
    expect(freshArgs("codex", ["resume", OLD, "-c", "x=1", "--dangerously-bypass-approvals-and-sandbox"])).toEqual(["-c", "x=1", "--dangerously-bypass-approvals-and-sandbox"]);
  });

  test("settings: 80% by default; a share, or false, in config.json", () => {
    const home = tmp("af-ho-cfg-");
    expect(loadHandoffSettings(home)).toEqual({ at: 0.8 });
    writeFileSync(join(home, "config.json"), JSON.stringify({ handoff: { at: 0.7 } }));
    expect(loadHandoffSettings(home)).toEqual({ at: 0.7 });
    writeFileSync(join(home, "config.json"), JSON.stringify({ handoff: false }));
    expect(loadHandoffSettings(home)).toEqual({ at: 0 });
  });
});

describe("a main session hands off when its context is nearly full", () => {
  test("asked at 80%; after af handoff ready and its turn: finished sessions closed, the rest kept, a fresh one started", async () => {
    const home = tmp("af-ho-home-");
    const cwd = tmp("af-ho-proj-");
    const backend = new FakeBackend();
    const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await w.start(60_000);
    const peeks = new Map<string, Peek>();
    const o = new Teams({ home, backend, w, sock: "/s", binDir: "/af/bin", protocolDir: SKILL, config: DEFAULT_CONFIG, playbooks: new PlaybookLibrary(join(SKILL, "playbooks"), join(home, "playbooks")), peek: async (p) => peeks.get(p), settleMs: 0, noSubmitMs: 0 });
    o.load();
    const ws = await backend.createWorkspace("smt-loop", cwd);
    const lead = ws.paneId;
    await backend.startAgent("lead", "claude", lead, []);
    backend.screens.set(lead, BOX());
    // the main session's process: two Ctrl+C end it and leave a shell; the new claude starts when typed in the shell
    const child = Bun.spawn(["sleep", "60"]);
    backend.procs.set(lead, [{ pid: child.pid, argv: ["claude", "--permission-mode", "auto", "--resume", OLD] }]);
    let ctrlC = 0;
    backend.onKeys = (t, keys) => {
      if (t === lead && keys.includes("ctrl+c") && ++ctrlC >= 2) {
        child.kill();
        backend.panes.get(lead)!.agent = undefined;
        backend.screens.set(lead, "zhengqiaoyi@Mac smt-loop % ");
      }
    };
    const run = backend.runInPane.bind(backend);
    backend.runInPane = async (id, cmd) => {
      await run(id, cmd);
      backend.panes.get(id)!.agent = { name: "", kind: "claude", args: [], status: "idle" };
      backend.screens.set(id, BOX());
    };
    await w.refresh();
    const h = makeHandler(o, w, backend);
    const notes: string[] = [];
    const access = { peek: async (p: string) => peeks.get(p), resolve: async () => ({ source: { agent: "claude", path: "/old/transcript.jsonl", how: "session" } }) } as unknown as TranscriptAccess;
    const handoffs = new Handoffs(w, o, access, { home, settings: { at: 0.8 }, claudeSettings: "/af/claude-settings.json", notify: (_l, _k, text, detail) => notes.push(`${text} | ${detail}`) });
    const api = makeHandler(o, w, backend, access, undefined, handoffs);
    const call = async (path: string, body: object, handler = h) => {
      const r = await handler(new Request(`http://af${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      return { status: r.status, body: (await r.json()) as any };
    };
    const step = async () => {
      for (let i = 0; i < 2; i++) {
        await w.refresh();
        await o.flush();
      }
    };
    const turn = async (name: string) => {
      backend.set(name, "working");
      await step();
      await Bun.sleep(5);
      backend.set(name, "idle");
      await step();
    };
    const typed = (pane: string) => backend.prompts.filter((p) => p.name === pane).map((p) => p.text);

    // three sessions it started: done (its result taken), still working, and one whose result waits in the queue
    const a = await call("/task", { callerPane: lead, kind: "claude", task: "read the review", name: "reader" });
    const team = a.body.team;
    await step();
    const m = (n: string) => o.get(team).members[n]!;
    peeks.set(m("reader").paneId!, { reply: "read it" });
    await turn(herdrMemberName(team, "reader"));
    await call("/team/take", { callerPane: lead });
    await call("/task", { callerPane: lead, kind: "claude", task: "run the long experiment", name: "runner" });
    await call("/task", { callerPane: lead, kind: "claude", task: "count the rounds", name: "counter" });
    await step();
    backend.set(herdrMemberName(team, "runner"), "working");
    peeks.set(m("counter").paneId!, { reply: "4,559 rounds" });
    await turn(herdrMemberName(team, "counter"));
    expect(o.get(team).tickets.T3!.status).toBe("submitted");

    // the main session ends a turn at 70%: nothing; at 85%: asked to hand off, once
    peeks.set(lead, { contextTokens: 700_000, contextWindow: 1_000_000 });
    await turn("lead");
    await handoffs.tick();
    expect(typed(lead).some((t) => t.includes("Your context is"))).toBe(false);
    peeks.set(lead, { contextTokens: 850_000, contextWindow: 1_000_000 });
    await turn("lead");
    await handoffs.tick();
    const ask = typed(lead).filter((t) => t.includes("Your context is"));
    expect(ask.length).toBe(1);
    expect(ask[0]).toStartWith("[agent-flow] Your context is 85% full (850k of 1M tokens).");
    const doc = ask[0]!.match(/handoff ready (\S+\.md)/)![1]!;
    expect(doc).toStartWith(join(home, "handoffs", ""));
    expect(doc).toEndWith("-smt-loop.md");
    expect(ask[0]).toContain(`/af/bin/af handoff ready ${doc}`);
    peeks.set(lead, { contextTokens: 870_000, contextWindow: 1_000_000 });
    await turn("lead");
    await handoffs.tick();
    expect(typed(lead).filter((t) => t.includes("Your context is")).length).toBe(1); // not again for 2 points more

    // af handoff ready: the document must be there
    expect((await call("/handoff/ready", { callerPane: lead, path: doc }, api)).status).toBe(404);
    writeFileSync(doc, "# Handoff\n\nGoal: the PLDI paper.\n");
    backend.set("lead", "working");
    await step();
    const ready = await call("/handoff/ready", { callerPane: lead, path: doc }, api);
    expect(ready.status).toBe(200);
    expect(w.isFree(lead)).toBe(false); // nothing typed into it meanwhile
    // a session working for it may not hand off itself
    expect((await call("/handoff/ready", { callerPane: m("runner").paneId, path: doc }, api)).status).toBe(403);

    // its turn ends: replaced
    await Bun.sleep(5);
    backend.set("lead", "idle");
    await step();
    await handoffs.tick();
    // the finished session is closed, not reported as exited; the working one and the one with a result stay
    expect(backend.panes.has(m("reader").paneId!)).toBe(false);
    expect(m("reader").status).toBe("exited");
    expect(o.get(team).queue.some((q) => q.kind === "exited")).toBe(false);
    expect(backend.panes.has(m("runner").paneId!)).toBe(true);
    expect(backend.panes.has(m("counter").paneId!)).toBe(true);
    // the old agent ended, a new conversation started in the same pane with the same flags
    await child.exited;
    const cmd = backend.panes.get(lead)!.typed.at(-1)!;
    expect(cmd).toStartWith(`cd '${cwd}' && 'claude' '--permission-mode' 'auto' '--session-id' '`);
    expect(cmd).toEndWith(`' '--settings' '/af/claude-settings.json'`);
    const session = cmd.match(/'--session-id' '([^']+)'/)![1]!;
    expect(session).not.toBe(OLD);
    expect(JSON.parse(readFileSync(join(home, "sessions.json"), "utf8"))[lead].id).toBe(session);
    // its first message: the document, the old conversation, who was closed and who goes on
    const first = typed(lead).at(-1)!;
    expect(first).toStartWith("[agent-flow] You take over from the previous claude session in this pane");
    expect(first).toContain(`Read its handoff document first: ${doc}`);
    expect(first).toContain("/old/transcript.jsonl");
    expect(first).toContain("closed the sessions it started that had finished: reader");
    expect(first).toContain("runner (T2: run the long experiment), working");
    expect(first).toContain("counter (T3: count the rounds), its result waits in your queue");
    // it is still the main session: its queue goes on, and it may be told about it again
    expect(o.directTeamOf(lead)?.id).toBe(team);
    backend.panes.get(lead)!.agent!.name = "lead2"; // the fake finds an agent by its name
    await turn("lead2");
    expect(w.isFree(lead)).toBe(true);
    // the result that waited still waits, for the new session (its first message named it)
    expect(o.get(team).queue.find((q) => q.ticket === "T3")?.state).toBe("queued");
    expect(notes.at(-1)).toContain("smt-loop: claude handed off to a new session (its context was 85% full)");
    expect(notes.at(-1)).toContain("Closed 1 finished session(s) (reader); 2 still running.");

    // close idle: once the counter's result is taken, it waits for nothing; the runner still works; a shell left
    // alone in a tab with nothing running goes too; the main session never
    const { idleSessions, closeIdle } = await import("../src/idle.ts");
    await call("/team/take", { callerPane: lead });
    const leftover = await backend.createTab(ws.workspaceId, cwd, "shell", {});
    backend.procs.set(leftover.paneId, [{ pid: 1, argv: ["-zsh"] }]);
    const busyShell = await backend.createTab(ws.workspaceId, cwd, "shell", {});
    backend.procs.set(busyShell.paneId, [{ pid: 2, argv: ["-zsh"] }, { pid: 3, argv: ["python", "train.py"] }]);
    await step();
    // its conversation holds only what agent-flow typed (the task, worded as an older version did): not talked with
    peeks.set(m("counter").paneId!, { reply: "4,559 rounds", userTexts: ["count the rounds\n\n(agent-flow ticket T3: when you finish, end with a summary. If the user then talks with you, just answer.)", "[agent-flow] The project context changed."] });
    const idle = await idleSessions(o, w);
    expect(idle.map((x) => [x.kind, x.label, !!x.talked])).toEqual([
      ["agent", "counter (claude)", false],
      ["shell", `shell in ${cwd.split("/").at(-1)}`, false],
    ]);
    // a message the user typed to it: listed, flagged (the button leaves it unticked)
    peeks.set(m("counter").paneId!, { reply: "4,559 rounds", userTexts: ["count the rounds", "第三节的数字是哪来的？"] });
    expect((await idleSessions(o, w)).find((x) => x.label === "counter (claude)")?.talked).toBe(true);
    const res = await closeIdle(o, w, idle.map((x) => x.pane));
    expect(res.closed.length).toBe(2);
    expect(backend.panes.has(m("counter").paneId!)).toBe(false);
    expect(m("counter").status).toBe("exited");
    expect(backend.panes.has(leftover.paneId)).toBe(false);
    expect(backend.panes.has(busyShell.paneId)).toBe(true);
    expect(backend.panes.has(m("runner").paneId!)).toBe(true);
    expect(backend.panes.has(lead)).toBe(true);
    expect(o.get(team).queue.some((q) => q.kind === "exited")).toBe(false);
    w.stop();
  });

  test("Refresh: the request goes now when it is free, and after its turn when it works", async () => {
    const home = tmp("af-ho-refresh-");
    const backend = new FakeBackend();
    const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await w.start(60_000);
    const o = new Teams({ home, backend, w, sock: "/s", binDir: "/af/bin", protocolDir: SKILL, config: DEFAULT_CONFIG });
    o.load();
    const ws = await backend.createWorkspace("paper", home);
    await backend.startAgent("me", "claude", ws.paneId, []);
    backend.screens.set(ws.paneId, BOX());
    await w.refresh();
    const access = { peek: async () => undefined, resolve: async () => ({ reason: "none" }) } as unknown as TranscriptAccess;
    const handoffs = new Handoffs(w, o, access, { home });
    const r = await handoffs.refresh(ws.paneId);
    expect(r.queued).toBe(false);
    const text = backend.prompts.at(-1)!.text;
    expect(text).toStartWith("[agent-flow] The user pressed Refresh for this session.");
    expect(text).toContain(`/af/bin/af handoff ready ${r.doc}`);
    // working: it waits for the end of the turn
    backend.set("me", "working");
    await w.refresh();
    expect((await handoffs.refresh(ws.paneId)).queued).toBe(true);
    w.stop();
  });
});
