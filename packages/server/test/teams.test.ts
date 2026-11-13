import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrMemberName, ticketStage } from "@af/core";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { makeHandler } from "../src/api.ts";
import { commitAll, git } from "../src/git.ts";
import { PlaybookLibrary } from "../src/playbooks.ts";
import { Teams, type TeamsOptions } from "../src/teams.ts";
import { type Peek, lastReply } from "../src/transcripts/peek.ts";
import { Workspaces } from "../src/workspaces.ts";
import { REMOTE_AF, RemoteAf, parseCliBody } from "../src/remote-af.ts";
import { FakeBackend } from "./fake.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};

const SKILL = join(import.meta.dir, "../../skill");

// a claude question about the task (AskUserQuestion), and a permission prompt
const ASK = [
  "─".repeat(80),
  " ☐ Format",
  "",
  "Which output format do you prefer for the report?",
  "",
  "❯ 1. Markdown",
  "     Plain text with headings",
  "  2. LaTeX",
  "     For the paper",
  "  3. Type something.",
  "─".repeat(80),
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");
const PERMISSION = ["─".repeat(80), " Bash command", " rm -rf build", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"].join("\n");

async function setup(over: Partial<TeamsOptions> = {}, home = tmp("af-teams-home-"), backend = new FakeBackend()) {
  const cwd = tmp("af-teams-proj-");
  const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
  await w.start(60_000);
  const replies = new Map<string, Peek>();
  const o = new Teams({
    home,
    backend,
    w,
    sock: "/s",
    binDir: "/af/bin",
    protocolDir: SKILL,
    config: DEFAULT_CONFIG,
    playbooks: new PlaybookLibrary(join(SKILL, "playbooks"), join(home, "playbooks")),
    peek: async (pane) => replies.get(pane),
    settleMs: 0,
    noSubmitMs: 0,
    ...over,
  });
  o.load();
  // the user's own session, the one that hands out work
  const ws = await backend.createWorkspace("proj", cwd);
  await backend.startAgent("lead", "claude", ws.paneId, []);
  await w.refresh();
  const h = makeHandler(o, w, backend);
  const call = async (path: string, body: object, method: "POST" | "GET" = "POST") => {
    const url = method === "GET" ? `http://af${path}?${new URLSearchParams(body as Record<string, string>)}` : `http://af${path}`;
    const r = await h(new Request(url, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined }));
    return { status: r.status, body: (await r.json()) as any };
  };
  /** Let Herdr's model and the team loop catch up (twice: some steps need a status seen first). */
  const step = async () => {
    for (let i = 0; i < 2; i++) {
      await w.refresh();
      await o.flush();
    }
  };
  /** A member's turn: it starts working on what was typed, then finishes. */
  const turn = async (herdr: string) => {
    backend.set(herdr, "working");
    await step();
    await Bun.sleep(5);
    backend.set(herdr, "idle");
    await step();
  };
  const typed = (pane: string) => backend.prompts.filter((p) => p.name === pane).map((p) => p.text);
  return { home, backend, w, o, ws, cwd, call, step, turn, typed, replies, lead: ws.paneId };
}

describe("mode 1: a session hands out tasks", () => {
  test("the notice waits while the user types to the session (text in its box, or keys in its web terminal)", async () => {
    const { o, w, backend, call, step, turn, typed, replies, lead } = await setup();
    const r = await call("/task", { callerPane: lead, kind: "claude", task: "count them", name: "counter" });
    await step();
    const m = o.get(r.body.team).members.counter!;
    // the user has half a message in the session's box (claude's prompt line)
    backend.screens.set(lead, "─".repeat(40) + "\n❯\u00a0我想问一下第三节的\n" + "─".repeat(40) + "\n");
    replies.set(m.paneId!, { reply: "There are 4." });
    await turn(herdrMemberName(r.body.team, "counter"));
    await step();
    expect(typed(lead)).toEqual([]); // nothing joined their text
    expect(o.get(r.body.team).queue[0]).toMatchObject({ kind: "turn", state: "queued" });
    // they sent it or cleared it: the box is empty, and the notice goes in
    backend.screens.set(lead, "─".repeat(40) + "\n❯\u00a0\n" + "─".repeat(40) + "\n");
    // but a key pressed in the web terminal just now (an input method's text is not in the box yet): still waits
    w.noteTyped(lead);
    await step();
    expect(typed(lead)).toEqual([]);
    (w as any).typedAt.set(lead, Date.now() - 10_000); // four seconds and more since
    await step();
    expect(typed(lead).at(-1)).toStartWith("[agent-flow] 1 new in your queue: T1 counter finished.");
    // what the user sends themselves goes at once, whatever is in the box
    backend.screens.set(lead, "─".repeat(40) + "\n❯\u00a0draft\n" + "─".repeat(40) + "\n");
    expect((await call("/prompt", { pane: lead, text: "hello", mode: "auto" })).status).toBe(200);
  });

  test("the project context: the main session edits it, its sessions read it first and are told when it changes", async () => {
    const { o, backend, call, step, turn, typed, replies, lead } = await setup({ contextSettleMs: 0 });
    // before any task: the file to edit (its team is made for it)
    const c = await call("/team/context", { callerPane: lead }, "GET");
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ text: "", sessions: [] });
    expect(c.body.path).toEndWith(`/teams/${c.body.team}/context.md`);
    writeFileSync(c.body.path, "口径：只报最终结论。\n");
    await step();
    const agentMd = readFileSync(c.body.agentMd, "utf8");
    expect(agentMd).toContain("## How you work with agent-flow");
    expect(agentMd).toContain("## Project context\n\n口径：只报最终结论。");

    const r = await call("/task", { callerPane: lead, kind: "claude", task: "write section 3", name: "writer" });
    expect(r.body.team).toBe(c.body.team);
    await step();
    const m = o.get(r.body.team).members.writer!;
    const herdr = herdrMemberName(r.body.team, "writer");
    expect(typed(m.paneId!)[0]).toStartWith(`Before you start, read ${c.body.agentMd}`);
    replies.set(m.paneId!, { reply: "Section 3 written.", lastUser: typed(m.paneId!)[0] });
    await turn(herdr);
    await call("/team/take", { callerPane: lead });
    await turn("lead");
    const toLead = typed(lead).length;

    // the main session edits the context: the writer is told, with what changed
    writeFileSync(c.body.path, "口径：只报最终结论。\n主结果用两年全量。\n");
    await step();
    const note = typed(m.paneId!).at(-1)!;
    expect(note).toStartWith(`[agent-flow] The project context changed. Read the part "Project context" in ${c.body.agentMd} again`);
    expect(note).toContain("Changed lines:\n+ 主结果用两年全量。");
    expect(readFileSync(c.body.agentMd, "utf8")).toContain("主结果用两年全量。");
    expect((await call("/team/context", { callerPane: lead }, "GET")).body.sessions).toEqual(["writer"]);
    // its "read it" reply is not news for the main session
    await Bun.sleep(5);
    replies.set(m.paneId!, { reply: "Read it.", lastUser: note });
    await turn(herdr);
    expect(o.get(r.body.team).tickets.T1).toMatchObject({ status: "closed", closeNote: "read the new project context" });
    expect(o.get(r.body.team).queue.filter((q) => q.state !== "handled")).toEqual([]);
    expect(typed(lead).length).toBe(toLead);

    // two edits while it is busy: one message once it is free
    const before = typed(m.paneId!).length;
    backend.set(herdr, "working");
    await step();
    writeFileSync(c.body.path, "口径：只报最终结论。\n主结果用两年全量。\n不写 11 月 5 日的测试。\n");
    await step();
    const set = await call("/team/context", { callerPane: lead, text: "口径：只报最终结论。\n主结果用两年全量和测试集。" });
    expect(set.body).toMatchObject({ changed: true, told: ["writer"] });
    await step();
    expect(typed(m.paneId!).length).toBe(before);
    replies.set(m.paneId!, { reply: "ok", lastUser: note });
    await Bun.sleep(5);
    backend.set(herdr, "idle");
    await step();
    await step();
    const sent = typed(m.paneId!).slice(before);
    expect(sent.length).toBe(1);
    expect(sent[0]).toContain("(more than once since you were last told)");
    expect(sent[0]).toContain("+ 主结果用两年全量和测试集。");
    // a later task for it does not ask it to read agent.md first
    await call("/team/tell", { callerPane: lead, ref: "writer", text: "now section 4" });
    replies.set(m.paneId!, { reply: "ok", lastUser: sent[0] });
    await turn(herdr);
    await step();
    expect(typed(m.paneId!).at(-1)).toStartWith("now section 4");
  });

  test("af task starts a plain session, types the task, and puts its final reply in the session's queue", async () => {
    const { o, backend, call, step, turn, typed, replies, lead } = await setup();
    const r = await call("/task", { callerPane: lead, kind: "codex", task: "Count the exported functions in calc.js", name: "counter" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ticket: "T1", member: "counter", started: true });
    await step();
    const team = r.body.team;
    const s = o.get(team);
    expect(s.meta).toMatchObject({ mode: "direct", manager: { pane: lead } });
    const m = s.members.counter!;
    // a plain session: no protocol injected, no AF_TEAM (it is known by its pane, like any session)
    const pane = backend.panes.get(m.paneId!)!;
    expect(pane.agent!.args.join(" ")).not.toContain("agent-flow-member");
    expect(pane.env.AF_TEAM).toBeUndefined();
    expect(pane.env.AF_OUT).toContain(join("teams", team, "out"));
    // the task is its first message
    // agent.md first (agent-flow's rules, the project context), then the task
    expect(typed(m.paneId!)[0]).toStartWith(`Before you start, read ${join(o.opts.home, "teams", r.body.team, "agent.md")}`);
    expect(typed(m.paneId!)[0]).toContain("\n\nCount the exported functions in calc.js\n\n(agent-flow ticket T1:");
    expect(s.tickets.T1!.status).toBe("working");

    replies.set(m.paneId!, { reply: "There are 4 exported functions: add, sub, mul, div." });
    await turn(herdrMemberName(team, "counter"));
    expect(o.get(team).tickets.T1).toMatchObject({ status: "submitted", report: { status: "ready", auto: true } });
    expect(readFileSync(join(o.opts.home, "teams", team, "tickets", "T1", "result.md"), "utf8")).toContain("4 exported functions");
    // the session that handed it out is told in one line
    const notice = typed(lead).at(-1)!;
    expect(notice).toStartWith("[agent-flow] 1 new in your queue: T1 counter finished.");
    expect(notice).toContain("/af/bin/af queue take");
    expect(o.get(team).queue[0]).toMatchObject({ kind: "turn", ticket: "T1", notified: true });

    const take = await call("/team/take", { callerPane: lead });
    expect(take.body.text).toContain("T1 counter finished");
    expect(take.body.text).toContain("4 exported functions");
    expect(o.get(team).tickets.T1).toMatchObject({ status: "closed", outcome: "done" });
    expect((await call("/team/take", { callerPane: lead })).body.text).toBe("(your queue is empty)");

    // more for the same session: a new ticket that follows T1, same member
    const more = await call("/team/tell", { callerPane: lead, ref: "counter", text: "Now list them with their line numbers" });
    expect(more.body).toMatchObject({ ticket: "T2", to: "counter", opened: true });
    await step();
    expect(typed(m.paneId!).at(-1)).toStartWith("Now list them with their line numbers");
    expect(o.get(team).tickets.T2).toMatchObject({ from: "T1", thread: "T1", round: 2, status: "working" });
  });

  test("a member that goes on by itself after its result was taken: the ticket opens again and the new result comes too", async () => {
    const { o, backend, call, step, turn, typed, replies, lead } = await setup();
    const r = await call("/task", { callerPane: lead, kind: "claude", task: "run the profile", name: "profile" });
    await step();
    const team = r.body.team;
    const m = o.get(team).members.profile!;
    const herdr = herdrMemberName(team, "profile");
    replies.set(m.paneId!, { reply: "Started the experiment; waiting for it." });
    await turn(herdr);
    await call("/team/take", { callerPane: lead });
    expect(o.get(team).tickets.T1!.status).toBe("closed");
    // its background experiment ends and wakes it
    replies.set(m.paneId!, { reply: "The experiment finished: 42 tokens/s." });
    await Bun.sleep(5);
    await turn(herdr);
    expect(o.get(team).tickets.T1).toMatchObject({ status: "submitted", resumed: 1 });
    expect(typed(lead).at(-1)).toContain("T1 profile finished");
    const take = await call("/team/take", { callerPane: lead });
    expect(take.body.text).toContain("T1 profile finished again (it went on by itself after you took its result)");
    expect(take.body.text).toContain("42 tokens/s");
    expect(readFileSync(join(o.opts.home, "teams", team, "tickets", "T1", "result.md"), "utf8")).toContain("42 tokens/s");
    expect(o.get(team).tickets.T1!.status).toBe("closed");
    expect(backend.prompts.filter((x) => x.name === m.paneId).length).toBe(1); // nothing was typed to it
  });

  test("the user talks with a session after its result was taken: its answers stay there; what changed comes by af report", async () => {
    const { o, backend, call, step, turn, typed, replies, lead } = await setup();
    const r = await call("/task", { callerPane: lead, kind: "omp", task: "Read the review of paper.tex, then wait for the user", name: "chat" });
    await step();
    const team = r.body.team;
    const m = o.get(team).members.chat!;
    const herdr = herdrMemberName(team, "chat");
    // its agent.md says how to report
    expect(readFileSync(join(o.opts.home, "teams", team, "agent.md"), "utf8")).toContain('/af/bin/af report "<what changed>"');
    replies.set(m.paneId!, { reply: "Read it; ready.", lastUser: typed(m.paneId!)[0] });
    await turn(herdr);
    await call("/team/take", { callerPane: lead });
    await turn("lead"); // the session takes its queue in a turn of its own
    const toLead = typed(lead).length;

    // the user asks it something in its own pane: the answer is not passed on
    await Bun.sleep(5);
    const asked = new Date().toISOString();
    replies.set(m.paneId!, { reply: "Section 3 says 4,559 rounds.", lastUser: "How many rounds does section 3 give?", lastUserAt: asked });
    await turn(herdr);
    expect(o.get(team).tickets.T1).toMatchObject({ status: "closed", closeNote: "the user talked with it", resumed: 1 });
    expect(o.get(team).queue.filter((q) => q.state !== "handled")).toEqual([]);
    expect(typed(lead).length).toBe(toLead);

    // a background task wakes it later: no new message from the user, so its result does come
    await Bun.sleep(5);
    replies.set(m.paneId!, { reply: "The recount finished: 4,489 rounds have agent text.", lastUser: "How many rounds does section 3 give?", lastUserAt: asked });
    await turn(herdr);
    expect(o.get(team).tickets.T1).toMatchObject({ status: "submitted", resumed: 2 });
    expect(typed(lead).at(-1)).toContain("1 new in your queue: T1 chat finished");
    expect((await call("/team/take", { callerPane: lead })).body.text).toContain("4,489 rounds");
    await turn("lead");

    // the conversation changed what was agreed: the session says so itself
    const rep = await call("/team/report", { callerPane: m.paneId, text: "The user decided: the headline is the two-year totals, not stage III." });
    expect(rep.status).toBe(200);
    expect(rep.body.to).toContain("the session that gave you your task");
    await step();
    expect(typed(lead).at(-1)).toContain("1 new in your queue: T1 chat reported");
    const take = await call("/team/take", { callerPane: lead });
    expect(take.body.text).toContain("the headline is the two-year totals");
    // the session that hands out work cannot report as if it were one of its sessions
    expect((await call("/team/report", { callerPane: lead, text: "x" })).status).toBe(403);
  });

  test("tasks wait for a busy member; --to gives a member more work; a member's session can lead its own team", async () => {
    const { o, call, step, turn, typed, replies, lead } = await setup();
    const a = await call("/task", { callerPane: lead, kind: "claude", task: "plan it", name: "plan" });
    await step();
    const team = a.body.team;
    const plan = o.get(team).members.plan!;
    const b = await call("/task", { callerPane: lead, to: "plan", task: "and estimate it" });
    expect(b.body).toMatchObject({ ticket: "T2", member: "plan", started: false });
    await step();
    expect(typed(plan.paneId!).length).toBe(1); // T2 waits until T1 is done
    replies.set(plan.paneId!, { reply: "plan written" });
    await turn(herdrMemberName(team, "plan"));
    await call("/team/take", { callerPane: lead });
    await step();
    expect(typed(plan.paneId!).at(-1)).toStartWith("and estimate it");
    expect(o.get(team).tickets.T2!.status).toBe("working");

    // the member hands out work itself: its own team, under its ticket
    const nested = await call("/task", { callerPane: plan.paneId, kind: "gemini", task: "draft the notes" });
    expect(nested.status).toBe(200);
    expect(nested.body.team).not.toBe(team);
    expect(o.get(nested.body.team).meta!.parent).toEqual({ team, ticket: "T2" });
    expect((await call("/task", { callerPane: lead, kind: "claude", task: "x", name: "plan" })).body.error.code).toBe("duplicate_member");
  });

  test("when the user lets the session answer them, permission prompts and notices reach it with options, and af answer answers", async () => {
    const { o, backend, call, step, lead } = await setup();
    const r = await call("/task", { callerPane: lead, kind: "claude", task: "write the report", name: "writer", delegate: true });
    await step();
    const team = r.body.team;
    expect(o.get(team).meta!.delegate).toBe(true);
    const m = o.get(team).members.writer!;
    const herdr = herdrMemberName(team, "writer");
    backend.screens.set(m.paneId!, PERMISSION);
    backend.set(herdr, "blocked");
    await step();
    const q = o.get(team).queue.find((x) => x.kind === "approval")!;
    expect(q).toMatchObject({ ticket: "T1", from: "writer", options: ["Yes", "No"] });
    expect(q.text).toContain("The user lets you answer prompts like this");
    // Needs you leaves it to the session meanwhile
    expect(o.list().find((x) => x.id === team)).toMatchObject({ delegate: true, answering: [m.paneId] });
    const take = await call("/team/take", { callerPane: lead });
    expect(take.body.text).toContain("writer has a prompt for you to answer");
    expect(take.body.text).toContain("af answer T1 <number>");
    expect((await call("/team/answer", { callerPane: lead, ref: "T1", option: 1 })).body).toMatchObject({ member: "writer", option: "Yes" });
    expect(backend.keys.at(-1)).toEqual({ target: m.paneId!, keys: ["enter"] });

    // a notice that waits for Enter: answered with Enter
    const rule = "─".repeat(40);
    backend.screens.set(m.paneId!, ["⏺ Running the first command", "", rule, " Auto mode now uses your extra usage when your plan's limit is reached.", " You can change this in /config.", "", " Enter to continue"].join("\n"));
    await step();
    const n = o.get(team).queue.filter((x) => x.kind === "approval").at(-1)!;
    expect(n.options).toEqual(["Continue (Enter)"]);
    expect(n.text).toContain("Auto mode now uses your extra usage");
    expect((await call("/team/answer", { callerPane: lead, ref: "writer", option: 1 })).body.option).toBe("Continue (Enter)");
    expect(backend.keys.at(-1)).toEqual({ target: m.paneId!, keys: ["enter"] });

    // the sessions it hands work to get the same: a member that hands out work itself
    const nested = await call("/task", { callerPane: m.paneId, kind: "gemini", task: "check the numbers" });
    expect(o.get(nested.body.team).meta!.delegate).toBe(true);

    // turned off: the user's again
    expect((await call("/team/delegate", { callerPane: lead, on: false })).body).toMatchObject({ team, delegate: false });
    expect((await call("/team/answer", { callerPane: lead, ref: "writer", option: 1 })).body.error.code).toBe("approval");
    // the user turns it on from the UI, for any team; a session only for its own
    expect((await call("/team/delegate", { id: team, on: true })).body.delegate).toBe(true);
    expect((await call("/team/delegate", { callerPane: lead, id: nested.body.team, on: true })).status).toBe(403);
  });

  test("a question about the task goes to the queue and is answered with af answer; a permission prompt is the user's", async () => {
    const { o, backend, w, call, step, typed, lead } = await setup();
    const r = await call("/task", { callerPane: lead, kind: "claude", task: "write the report", name: "writer" });
    await step();
    const team = r.body.team;
    const m = o.get(team).members.writer!;
    const herdr = herdrMemberName(team, "writer");
    backend.screens.set(m.paneId!, ASK);
    backend.set(herdr, "blocked");
    await step();
    const q = o.get(team).queue.find((x) => x.kind === "asking")!;
    expect(q).toMatchObject({ ticket: "T1", from: "writer", text: "Which output format do you prefer for the report?", options: ["Markdown", "LaTeX", "Type something."] });
    expect(typed(lead).at(-1)).toContain("T1 writer is asking");
    const take = await call("/team/take", { callerPane: lead });
    expect(take.body.text).toContain("2. LaTeX");
    expect(take.body.text).toContain("af answer T1 <number>");
    const ans = await call("/team/answer", { callerPane: lead, ref: "T1", option: 2 });
    expect(ans.body).toMatchObject({ member: "writer", option: "LaTeX" });
    expect(backend.keys.at(-1)).toEqual({ target: m.paneId!, keys: ["down", "enter"] });

    // a permission prompt: not queued, and af answer refuses it
    backend.screens.set(m.paneId!, PERMISSION);
    await w.refresh();
    await o.flush();
    expect(o.get(team).queue.filter((x) => x.kind === "asking").length).toBe(1);
    // the session only hears that it waits for the user, once
    expect(o.get(team).queue.at(-1)).toMatchObject({ kind: "approval", ticket: "T1", from: "writer" });
    await step();
    expect(o.get(team).queue.filter((x) => x.kind === "approval").length).toBe(1);
    // the session dealt with it; a new server (no memory of what it saw) does not report the same dialog again
    await call("/team/take", { callerPane: lead });
    const o2 = new Teams({ ...o.opts });
    o2.load();
    await o2.flush();
    expect(o2.get(team).queue.filter((x) => x.kind === "approval").length).toBe(1);
    expect(ticketStage(o.get(team).tickets.T1!, o.get(team).members.writer, { status: "blocked", asking: "Bash command rm -rf build Do you want to proceed?" })).toBe("approval");
    const refused = await call("/team/answer", { callerPane: lead, ref: "writer", option: 1 });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("approval");
  });

  test("a member that looks done but shows a notice waits for the user: no result, its manager told once", async () => {
    const { o, backend, call, step, turn, typed, replies, lead } = await setup();
    const r = await call("/task", { callerPane: lead, kind: "claude", task: "survey the folder", name: "survey" });
    await step();
    const team = r.body.team;
    const m = o.get(team).members.survey!;
    const herdr = herdrMemberName(team, "survey");
    // claude's billing notice (it waits for Enter), with Herdr calling the pane done
    const NOTICE = ["⏺ Bash(ls)", "  ⎿  Waiting…", "─".repeat(60), "  We're changing auto mode to no longer charge for", "  classifier requests in Claude Code.", "", "  Nothing breaks: auto mode keeps working.", "", "  Enter to continue · Esc to cancel"].join("\n");
    backend.screens.set(m.paneId!, NOTICE);
    await turn(herdr);
    expect(o.get(team).tickets.T1!.status).toBe("working");
    const q = o.get(team).queue.at(-1)!;
    expect(q).toMatchObject({ kind: "approval", ticket: "T1", from: "survey" });
    expect(q.text).toContain("We're changing auto mode");
    expect(typed(lead).at(-1)).toContain("T1 survey waits for the user's approval");
    await step();
    expect(o.get(team).queue.filter((x) => x.kind === "approval").length).toBe(1);
    // the user dismissed it; the member goes on and finishes: that is its result
    backend.screens.delete(m.paneId!);
    replies.set(m.paneId!, { reply: "3 folders: code, data, docs." });
    await Bun.sleep(5);
    await turn(herdr);
    expect(o.get(team).tickets.T1).toMatchObject({ status: "submitted" });
    expect(o.get(team).queue.at(-1)).toMatchObject({ kind: "turn", ticket: "T1" });
    expect(o.get(team).queue.at(-1)!.text).toContain("3 folders");
  });

  test("a turn that ends in a passing API error gets 'continue' three times, then the error is reported", async () => {
    const { o, call, step, turn, typed, replies, lead } = await setup();
    const r = await call("/task", { callerPane: lead, kind: "codex", task: "fix the build", name: "fixer" });
    await step();
    const team = r.body.team;
    const m = o.get(team).members.fixer!;
    const herdr = herdrMemberName(team, "fixer");
    replies.set(m.paneId!, { error: "API Error: 529 overloaded" });
    for (let i = 0; i < 3; i++) {
      await turn(herdr);
      expect(typed(m.paneId!).at(-1)).toBe("continue");
    }
    await turn(herdr);
    expect(o.get(team).queue.at(-1)).toMatchObject({ kind: "error", ticket: "T1" });
    expect(typed(lead).at(-1)).toContain("T1 fixer error");
  });

  test("a member that exits, or works without writing to its conversation, is reported", async () => {
    let now = Date.now();
    const { o, backend, call, step, replies, lead } = await setup({ clock: () => now, stuckMs: 60_000 });
    const r = await call("/task", { callerPane: lead, kind: "claude", task: "long job", name: "slow" });
    await step();
    const team = r.body.team;
    const m = o.get(team).members.slow!;
    replies.set(m.paneId!, { size: 100 });
    backend.set(herdrMemberName(team, "slow"), "working");
    await step();
    now += 61_000;
    await step();
    now += 31_000;
    await step();
    expect(o.get(team).queue.at(-1)).toMatchObject({ kind: "stuck", ticket: "T1", from: "slow" });

    backend.remove(herdrMemberName(team, "slow"));
    await step();
    await step();
    expect(o.get(team).members.slow!.status).toBe("exited");
    expect(o.get(team).queue.at(-1)).toMatchObject({ kind: "exited", ticket: "T1" });
  });

  test("--worktree: the member works on its own branch, cut from the session's HEAD, never merged", async () => {
    const { o, backend, w, call, step, lead, cwd } = await setup();
    git(cwd, ["init", "-q", "-b", "main"]);
    writeFileSync(join(cwd, "a.txt"), "a\n");
    commitAll(cwd, "init");
    backend.panes.get(lead)!.cwd = cwd;
    await w.refresh();
    const r = await call("/task", { callerPane: lead, kind: "codex", task: "change a.txt", name: "coder", worktree: true });
    expect(r.status).toBe(200);
    await step();
    const m = o.get(r.body.team).members.coder!;
    expect(m.branch).toBe(`af/${r.body.team}/coder`);
    expect(m.cwd).toBe(join(cwd, ".agent-flow", "worktrees", r.body.team, "coder"));
    expect(existsSync(join(m.cwd, "a.txt"))).toBe(true);
    expect(git(cwd, ["branch", "--show-current"]).out).toBe("main");
  });
});

describe("mode 2: an agent team with a router", () => {
  test("af team new: a router in its own workspace, briefed; a ticket on the caller's timeline stands for the team", async () => {
    const { o, backend, call, step, typed, lead } = await setup();
    const r = await call("/team/new", { callerPane: lead, goal: "Add a captcha to the login page", playbook: "humanize-loop" });
    expect(r.status).toBe(200);
    await step();
    const team = o.get(r.body.team);
    expect(team.meta).toMatchObject({ mode: "router", manager: { member: "router" }, playbook: "humanize-loop", parent: { ticket: "T1" } });
    const router = team.members.router!;
    const pane = backend.panes.get(router.paneId!)!;
    expect(pane.workspaceId).toBe(team.meta!.workspace);
    expect(pane.agent!.args.join(" ")).toContain(join("teams", r.body.team, "protocol", "router.md"));
    expect(pane.env).toMatchObject({ AF_TEAM: r.body.team, AF_AGENT: "router" });
    expect(typed(router.paneId!)[0]).toContain("You are the router of team");
    expect(typed(router.paneId!)[0]).toContain("humanize-loop.md");
    // the caller's own team has a ticket for the whole team
    const parent = o.get(team.meta!.parent!.team);
    expect(parent.meta!.manager.pane).toBe(lead);
    expect(Object.values(parent.members)[0]).toMatchObject({ team: r.body.team, paneId: router.paneId });
    expect(parent.tickets.T1).toMatchObject({ status: "working", team: r.body.team });
    expect((await call("/team/new", { goal: "x" })).status).toBe(400); // not from a session, not from the UI
  });

  test("a whole loop: tickets, submit, queue, rounds, the round limit, and the final report to the caller", async () => {
    const { o, backend, call, step, turn, typed, lead } = await setup();
    const made = await call("/team/new", { callerPane: lead, goal: "Write a haiku about rain" });
    await step();
    const id = made.body.team;
    const router = o.get(id).members.router!;
    const R = { team: id, agent: "router" };
    const routerHerdr = herdrMemberName(id, "router");
    await turn(routerHerdr); // it read the brief

    const t1 = await call("/team/ticket", { ...R, member: "writer", kind: "codex", title: "first version", task: "Write a haiku about rain.", max: 2 });
    expect(t1.body).toMatchObject({ ticket: "T1", member: "writer", started: true, thread: "T1", round: 1 });
    await step();
    const writer = o.get(id).members.writer!;
    expect(backend.panes.get(writer.paneId!)!.agent!.args).toContain("agent-flow-member");
    expect(backend.panes.get(writer.paneId!)!.env).toMatchObject({ AF_TEAM: id, AF_AGENT: "writer" });
    const msg = typed(writer.paneId!)[0]!;
    expect(msg).toStartWith("[agent-flow] Ticket T1 for you: first version.");
    expect(msg).toContain(join(o.opts.home, "teams", id, "tickets", "T1", "task.md"));
    expect(readFileSync(join(o.opts.home, "teams", id, "tickets", "T1", "task.md"), "utf8")).toBe("Write a haiku about rain.\n");

    // only members submit, and only their own ticket
    expect((await call("/team/submit", { ...R, status: "ready" })).status).toBe(403);
    writeFileSync(join(o.opts.home, "teams", id, "tickets", "T1", "result.md"), "rain on the tin roof\n");
    const sub = await call("/team/submit", { team: id, agent: "writer", status: "ready", note: "first draft", to: "reviewer" });
    expect(sub.body).toMatchObject({ ticket: "T1", status: "ready" });
    expect((await call("/team/submit", { team: id, agent: "writer", status: "ready" })).body.error.code).toBe("submitted");
    await step();
    expect(typed(router.paneId!).at(-1)).toBe("[agent-flow] 1 new in your queue: T1 writer submitted. Run: af queue take");
    const take = await call("/team/take", R);
    expect(take.body.text).toContain("#1 T1 writer submitted → suggests reviewer");
    expect(take.body.text).toContain("rain on the tin roof");
    expect(o.get(id).queue[0]!.state).toBe("taken"); // a router must act on it

    // review: --from passes the result on and settles T1
    const t2 = await call("/team/ticket", { ...R, member: "reviewer", kind: "claude", title: "review", task: "Review the haiku.", from: "T1" });
    expect(t2.body).toMatchObject({ ticket: "T2", thread: "T1", round: 1 });
    expect(o.get(id).tickets.T1).toMatchObject({ status: "closed", outcome: "done" });
    expect(o.get(id).tickets.T2!.inputs).toEqual([join(o.opts.home, "teams", id, "tickets", "T1", "result.md")]);
    expect(o.get(id).queue[0]!.state).toBe("handled");
    await step();
    const reviewer = o.get(id).members.reviewer!;
    expect(typed(reviewer.paneId!)[0]).toContain(`Read first: ${join(o.opts.home, "teams", id, "tickets", "T1", "result.md")}`);
    await call("/team/submit", { team: id, agent: "reviewer", status: "ready", note: "FAIL: syllables" });
    await step();
    await call("/team/take", R);
    const t3 = await call("/team/ticket", { ...R, member: "writer", title: "fix", task: "Apply the review.", from: "T2" });
    expect(t3.body).toMatchObject({ ticket: "T3", round: 2, started: false });
    await turn(herdrMemberName(id, "writer")); // it worked on T1 (and submitted it)
    expect(typed(writer.paneId!).at(-1)).toStartWith("[agent-flow] Ticket T3 for you (thread T1, round 2): fix.");
    await call("/team/submit", { team: id, agent: "writer", status: "ready" });
    await call("/team/ticket", { ...R, member: "reviewer", title: "review again", task: "Review again.", from: "T3" });
    await call("/team/submit", { team: id, agent: "reviewer", status: "ready", note: "FAIL again" });
    // a third round for the writer is over the thread's limit of 2
    const over = await call("/team/ticket", { ...R, member: "writer", title: "fix again", task: "Apply it.", from: "T4" });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("round_limit");
    expect(Object.values(o.get(id).attention).map((a) => a.kind)).toContain("loop_limit");
    expect((await call("/team/max", { ...R, thread: "T3", max: 3 })).body).toEqual({ thread: "T1", max: 3 });
    expect(Object.values(o.get(id).attention).map((a) => a.kind)).not.toContain("loop_limit");
    expect((await call("/team/ticket", { ...R, member: "writer", title: "fix again", task: "Apply it.", from: "T4" })).body).toMatchObject({ ticket: "T5", round: 3 });

    // the caller adds a request; the router takes it and opens a ticket for it: that deals with the request
    await call("/team/tell", { callerPane: lead, ref: "T1", text: "also a second haiku about snow" });
    expect(o.get(id).queue.at(-1)).toMatchObject({ kind: "user", text: "also a second haiku about snow" });
    await call("/team/take", R);
    await call("/team/ticket", { ...R, member: "writer2", kind: "claude", title: "snow", task: "Write a haiku about snow." });
    expect(o.get(id).queue.at(-1)!.state).toBe("handled");

    // the final report goes to the caller's queue and finishes the team's ticket there
    const rep = await call("/team/report", { ...R, text: "Done: the haiku is in haiku.md", done: true });
    expect(rep.status).toBe(200);
    const parent = o.get(o.get(id).meta!.parent!.team);
    expect(parent.tickets.T1).toMatchObject({ status: "submitted", report: { status: "ready" } });
    await step();
    expect(typed(lead).at(-1)).toContain("T1 team reported");
    const top = await call("/team/take", { callerPane: lead });
    expect(top.body.text).toContain("Team finished");
    expect(top.body.text).toContain("haiku.md");
    expect(o.get(parent.meta!.id).tickets.T1!.status).toBe("closed");
  });

  test("a gemini member gets its protocol as its first message (no extra folder to trust), then its ticket", async () => {
    const { o, backend, call, step, turn, typed, lead } = await setup();
    const made = await call("/team/new", { callerPane: lead, goal: "g", router: "gemini" });
    await step();
    const id = made.body.team;
    const router = o.get(id).members.router!;
    const rargs = backend.panes.get(router.paneId!)!.agent!.args.join(" ");
    expect(rargs).not.toContain("--include-directories");
    expect(rargs).not.toContain("-i");
    expect(typed(router.paneId!)[0]).toStartWith("# agent-flow router protocol");
    await turn(herdrMemberName(id, "router")); // "ready"
    expect(typed(router.paneId!)[1]).toContain("You are the router of team");
    await turn(herdrMemberName(id, "router"));
    await call("/team/ticket", { team: id, agent: "router", member: "rev", kind: "gemini", title: "review", task: "Review it." });
    await step();
    const rev = o.get(id).members.rev!;
    expect(typed(rev.paneId!)[0]).toStartWith("# agent-flow member protocol");
    expect(typed(rev.paneId!)[0]).toContain(`your team is ${id}, your name rev`);
    expect(o.get(id).tickets.T1!.status).toBe("open"); // the ticket waits for "ready"
    await turn(herdrMemberName(id, "rev"));
    expect(typed(rev.paneId!)[1]).toStartWith("[agent-flow] Ticket T1 for you: review.");
  });

  test("ask and reply; tell reaches a member when it is free; a router reminded of items it took and left", async () => {
    const { o, call, step, turn, typed, lead } = await setup();
    const made = await call("/team/new", { callerPane: lead, goal: "g" });
    await step();
    const id = made.body.team;
    const R = { team: id, agent: "router" };
    const router = o.get(id).members.router!;
    await turn(herdrMemberName(id, "router"));
    await call("/team/ticket", { ...R, member: "dev", kind: "claude", title: "build", task: "Build it." });
    await step();
    const dev = o.get(id).members.dev!;
    const asked = await call("/team/ask", { team: id, agent: "dev", text: "Which port?" });
    expect(asked.body).toMatchObject({ ticket: "T1", seq: 1 });
    await step();
    expect(typed(router.paneId!).at(-1)).toContain("T1 dev asks a question");
    const take = await call("/team/take", R);
    expect(take.body.text).toContain('af reply 1 "<answer>"');
    await call("/team/reply", { ...R, seq: 1, text: "8080" });
    await turn(herdrMemberName(id, "dev")); // it asked, ended its turn, and gets the answer
    expect(typed(dev.paneId!)).toContain("[agent-flow] Answer to your question #1: 8080");
    // it went on and stopped without submitting: the router hears of it
    await turn(herdrMemberName(id, "dev"));
    expect(o.get(id).queue.at(-1)).toMatchObject({ kind: "turn", ticket: "T1", seq: 2 });

    // a follow-up deals with that item, and is typed in when dev is free
    await call("/team/tell", { ...R, ref: "T1", text: "also add a health check" });
    expect(o.get(id).queue.find((q) => q.seq === 2)!.state).toBe("handled");
    await step();
    expect(typed(dev.paneId!).at(-1)).toBe("[agent-flow] More for T1 from the router: also add a health check");

    // again no submit; the router takes the item and does nothing: it is reminded once
    await turn(herdrMemberName(id, "dev"));
    expect(o.get(id).queue.at(-1)).toMatchObject({ kind: "turn", ticket: "T1", seq: 3 });
    await step();
    await call("/team/take", R);
    await turn(herdrMemberName(id, "router"));
    expect(typed(router.paneId!).at(-1)).toContain("You took 1 queue item(s) and did not act on: #3 T1");
    await call("/team/handled", { ...R, seqs: [3] });
    expect(o.get(id).queue.every((q) => q.state === "handled")).toBe(true);
  });

  test("state survives a restart: a queue item not yet told is told by the new server", async () => {
    const home = tmp("af-teams-restart-");
    const backend = new FakeBackend();
    const first = await setup({}, home, backend);
    const made = await first.call("/team/new", { callerPane: first.lead, goal: "g" });
    await first.step();
    const id = made.body.team;
    const R = { team: id, agent: "router" };
    await first.turn(herdrMemberName(id, "router"));
    await first.call("/team/ticket", { ...R, member: "dev", kind: "claude", title: "build", task: "Build it." });
    await first.step();
    // the router is busy when dev submits: the item waits
    backend.set(herdrMemberName(id, "router"), "working");
    await first.step();
    await first.call("/team/submit", { team: id, agent: "dev", status: "ready" });
    await first.step();
    expect(first.o.get(id).queue[0]!.notified).toBeUndefined();
    first.o.stop();

    // a new server on the same home and Herdr
    const w2 = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await w2.start(60_000);
    const o2 = new Teams({ home, backend, w: w2, sock: "/s", binDir: "/af/bin", protocolDir: SKILL, config: DEFAULT_CONFIG, settleMs: 0, noSubmitMs: 0, peek: async () => undefined });
    expect(o2.load()).toBe(2);
    expect(o2.get(id).tickets.T1).toMatchObject({ status: "submitted", assignee: "dev" });
    await Bun.sleep(5);
    backend.set(herdrMemberName(id, "router"), "idle");
    await w2.refresh();
    await o2.flush();
    const router = o2.get(id).members.router!;
    expect(backend.prompts.filter((p) => p.name === router.paneId).at(-1)!.text).toContain("1 new in your queue: T1 dev submitted");
  });
});

describe("reading what an agent said last", () => {
  test("the reply after the last user message, and that message; an error only when nothing came after it", () => {
    const claude = (type: string, content: unknown) => JSON.stringify({ type, message: { role: type, content }, uuid: Math.random().toString(36), timestamp: "2026-11-04T10:00:00Z" });
    const lines = [claude("user", "first"), claude("assistant", [{ type: "text", text: "old answer" }]), claude("user", "count them"), claude("assistant", [{ type: "text", text: "There are 4." }]), claude("assistant", [{ type: "text", text: "Done." }])];
    expect(lastReply("claude", lines)).toEqual({ reply: "There are 4.\n\nDone.", error: undefined, lastUser: "count them", lastUserAt: "2026-11-04T10:00:00Z", userTexts: ["first", "count them"] });
    expect(lastReply("claude", ["not json", ...lines.slice(0, 3)])).toEqual({ reply: undefined, error: undefined, lastUser: "count them", lastUserAt: "2026-11-04T10:00:00Z", userTexts: ["first", "count them"] });
    // a message agent-flow typed in ("[agent-flow] …", shown as a notice) starts a turn too
    const note = "[agent-flow] The project context changed. Read it again.";
    expect(lastReply("claude", [...lines, claude("user", note), claude("assistant", [{ type: "text", text: "Read it." }])])).toMatchObject({ reply: "Read it.", lastUser: note });
  });
});

describe("choosing a worktree, and preparing a member's folder", () => {
  test("in a git repository a new member must say --worktree or --no-worktree; elsewhere it need not", async () => {
    const { o, w, backend, call, step, lead, cwd } = await setup();
    // not a repository: no choice to make
    expect((await call("/task", { callerPane: lead, kind: "claude", task: "look around", name: "a" })).status).toBe(200);
    git(cwd, ["init", "-q", "-b", "main"]);
    writeFileSync(join(cwd, "f.txt"), "f\n");
    commitAll(cwd, "init");
    backend.panes.get(lead)!.cwd = cwd;
    await w.refresh();
    const r = await call("/task", { callerPane: lead, kind: "codex", task: "change f.txt", name: "b" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("worktree_choice");
    expect(r.body.error.message).toContain("--worktree if it changes files while other sessions change the same repository");
    const team = o.get(r.body.error ? (await call("/task", { callerPane: lead, kind: "codex", task: "read f.txt", name: "c", worktree: false })).body.team : "");
    await step();
    expect(team.members.c).toMatchObject({ cwd, branch: undefined });
    // an existing member needs no choice
    expect((await call("/task", { callerPane: lead, to: "c", task: "read it again" })).status).toBe(200);
  });

  test("--prepare runs once in the member's folder before it starts; a failure fails the ticket with the output", async () => {
    const { o, backend, call, step, typed, lead, cwd } = await setup();
    const ok = await call("/task", { callerPane: lead, kind: "claude", task: "use the data", name: "loader", prepare: "echo prepared > ready.txt && echo done" });
    await step();
    const team = ok.body.team;
    expect(readFileSync(join(cwd, "ready.txt"), "utf8")).toBe("prepared\n");
    expect(readFileSync(join(o.opts.home, "teams", team, "tickets", "T1", "prepare.log"), "utf8")).toContain("done");
    expect(typed(o.get(team).members.loader!.paneId!)[0]).toContain("\n\nuse the data\n\n");
    expect((await call("/task", { callerPane: lead, kind: "claude", task: "x", name: "user" })).body.error.code).toBe("bad_name");

    const bad = await call("/task", { callerPane: lead, kind: "claude", task: "never", name: "broken", prepare: "echo missing dependency; exit 3" });
    expect(bad.status).toBe(200);
    await step();
    expect(o.get(team).tickets.T2).toMatchObject({ status: "closed", outcome: "failed" });
    expect(o.get(team).members.broken!.status).toBe("exited");
    expect(o.get(team).queue.at(-1)).toMatchObject({ kind: "error", ticket: "T2" });
    expect(o.get(team).queue.at(-1)!.text).toContain("missing dependency");
    expect([...backend.panes.values()].some((p) => p.agent?.name === herdrMemberName(team, "broken"))).toBe(false);
  });
});

/** A session on the Mac and a connected SSH machine "gpu": its SSH runs commands in a local shell with a fake home. */
async function setupRemote() {
  const home = tmp("af-teams-rhome-local-");
  const rhome = tmp("af-teams-rhome-");
  const local = new FakeBackend();
  local.saved = [{ id: "p1", label: "gpu", target: "gpu", session: "default" }];
  const remote = new FakeBackend();
  const execs: string[] = [];
  const w = new Workspaces({
    home,
    backend: local,
    paneEnv: () => ({}),
    remotePollMs: 0,
    remote: (_spec, onChange) => {
      const r = {
        state: "offline" as any,
        home: rhome,
        async connect() {
          r.state = "online";
          onChange();
        },
        close() {},
        async exec(cmd: string, opts: { stdin?: Uint8Array } = {}) {
          execs.push(cmd);
          // Workspaces' background-work check (background.ts): nothing runs in the background on this fake machine
          if (cmd.startsWith("u=$(id -u)")) return { code: 0, out: Buffer.from(""), err: "" };
          // stdin like ssh's: what is given, else nothing (never the test runner's own stdin)
          const p = Bun.spawnSync(["sh", "-c", cmd], { env: { ...process.env, HOME: rhome }, stdin: Buffer.from(opts.stdin ?? new Uint8Array()), stdout: "pipe", stderr: "pipe" });
          return { code: p.exitCode ?? 1, out: Buffer.from(p.stdout), err: p.stderr.toString() };
        },
      };
      return { remote: r, backend: () => remote };
    },
  });
  await w.start(60_000);
  await w.connect("gpu");
  const replies = new Map<string, Peek>();
  const o = new Teams({ home, backend: local, w, sock: "/s", binDir: "/af/bin", protocolDir: SKILL, config: DEFAULT_CONFIG, playbooks: new PlaybookLibrary(join(SKILL, "playbooks"), join(home, "playbooks")), peek: async (pane) => replies.get(pane), settleMs: 0, noSubmitMs: 0 });
  o.load();
  const cwd = tmp("af-teams-rproj-local-");
  const ws = await local.createWorkspace("proj", cwd);
  await local.startAgent("lead", "claude", ws.paneId, []);
  mkdirSync(join(rhome, "proj"), { recursive: true });
  await w.refresh();
  const h = makeHandler(o, w, local);
  const call = async (path: string, body: object) => {
    const r = await h(new Request(`http://af${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as any };
  };
  const step = async () => {
    for (let i = 0; i < 2; i++) {
      await w.refresh();
      await o.flush();
    }
  };
  return { home, rhome, local, remote, execs, w, o, call, step, replies, lead: ws.paneId, h };
}

describe("members on another machine", () => {
  test("af task --on: a plain member in the team's workspace there; its task typed in; its reply comes back", async () => {
    const { o, remote, call, step, replies, lead, rhome } = await setupRemote();
    const r = await call("/task", { callerPane: lead, kind: "claude", task: "run the profile on the GPUs", name: "profile", machine: "gpu", cwd: "~/proj" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ machine: "gpu", cwd: join(rhome, "proj") });
    await step();
    const team = r.body.team;
    const m = o.get(team).members.profile!;
    expect(m).toMatchObject({ machine: "gpu", cwd: join(rhome, "proj") });
    expect(m.paneId).toStartWith("gpu~");
    const raw = m.paneId!.slice(4);
    const pane = remote.panes.get(raw)!;
    // the team's workspace on that machine (the session's is on the Mac); its PATH has that machine's af first
    expect(o.get(team).meta!.workspaces!.gpu).toBe(`gpu~${pane.workspaceId}`);
    expect(pane.env.PATH).toStartWith(`${rhome}/.agent-flow/bin:`);
    expect(pane.env.AF_OUT).toBe(`${rhome}/.agent-flow/teams/${team}/out`);
    // claude's SessionStart hook is a file on the Mac: not for another machine
    expect(pane.agent!.args.join(" ")).not.toContain("--settings");
    expect(pane.agent!.args).toContain("--session-id");
    expect(remote.prompts.at(-1)!.text).toContain("\n\nrun the profile on the GPUs\n\n");
    // its agent.md is copied there, with that machine's af
    const agentMd = join(rhome, ".agent-flow", "teams", team, "agent.md");
    expect(remote.prompts.at(-1)!.text).toStartWith(`Before you start, read ${agentMd}`);
    expect(readFileSync(agentMd, "utf8")).toContain(`${rhome}/.agent-flow/bin/af report`);
    replies.set(m.paneId!, { reply: "42 tokens/s on 2 GPUs" });
    remote.set(herdrMemberName(team, "profile"), "working");
    await step();
    await Bun.sleep(5);
    remote.set(herdrMemberName(team, "profile"), "idle");
    // a remote pane that went idle is finished once its background check (over SSH) has answered
    for (let i = 0; i < 4; i++) {
      await step();
      await Bun.sleep(20);
    }
    expect(o.get(team).queue.at(-1)).toMatchObject({ kind: "turn", ticket: "T1", from: "profile" });
    expect(readFileSync(join(o.opts.home, "teams", team, "tickets", "T1", "result.md"), "utf8")).toContain("42 tokens/s");
  });

  test("a router's member there: protocol and codex profile written there, task.md mirrored, result.md brought back", async () => {
    const { o, remote, call, step, rhome, lead, execs } = await setupRemote();
    const made = await call("/team/new", { callerPane: lead, goal: "profile it" });
    await step();
    const id = made.body.team;
    const R = { team: id, agent: "router" };
    const t1 = await call("/team/ticket", { ...R, member: "worker", kind: "codex", title: "profile", task: "Profile the engine.", machine: "gpu", cwd: "~/proj" });
    expect(t1.status).toBe(200);
    await step();
    const m = o.get(id).members.worker!;
    const pane = remote.panes.get(m.paneId!.slice(4))!;
    expect(pane.env).toMatchObject({ AF_TEAM: id, AF_AGENT: "worker" });
    expect(pane.agent!.args.slice(0, 2)).toEqual(["-p", "agent-flow-member"]);
    expect(readFileSync(join(rhome, ".codex", "agent-flow-member.config.toml"), "utf8")).toContain("agent-flow member protocol");
    const there = join(rhome, ".agent-flow", "teams", id, "tickets", "T1");
    expect(readFileSync(join(there, "task.md"), "utf8")).toBe("Profile the engine.\n");
    expect(remote.prompts.at(-1)!.text).toContain(`Read ${there}/task.md`);
    expect(remote.prompts.at(-1)!.text).toContain(`write ${there}/result.md`);
    // it writes its result there and submits: the Mac gets the copy
    writeFileSync(join(there, "result.md"), "done on the GPU\n");
    const sub = await call("/team/submit", { team: id, agent: "worker", status: "ready", note: "ok" });
    expect(sub.status).toBe(200);
    expect(readFileSync(join(o.opts.home, "teams", id, "tickets", "T1", "result.md"), "utf8")).toBe("done on the GPU\n");
    expect(o.get(id).queue.at(-1)!.text).toContain("done on the GPU");
    expect(execs.some((c) => c.includes("git rev-parse --show-toplevel"))).toBe(true);
  });

  test("the machine's af: only work commands, the caller's pane gets the machine's prefix, members speak for themselves", async () => {
    const { home, o, w, call, step, h, lead, rhome } = await setupRemote();
    const remoteBackend = (w as any).machines.get("gpu").backend as FakeBackend;
    const rws = await remoteBackend.createWorkspace("exp", join(rhome, "proj"));
    await remoteBackend.startAgent("me", "claude", rws.paneId, []);
    await w.refresh();
    const raf = new RemoteAf({ home, w, teams: o, handler: h, cliMain: join(import.meta.dir, "../../cli/src/main.ts") });
    const post = (path: string, body: object) => raf.serve("gpu", new Request(`http://af${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    // a session there hands out work: it is known as gpu~<its pane>, and its members go to gpu by default
    const r = await post("/task", { callerPane: rws.paneId, kind: "claude", task: "count files", name: "counter", worktree: false });
    const res = (await r.json()) as any;
    expect(r.status).toBe(200);
    await step();
    expect(o.get(res.team).meta).toMatchObject({ manager: { pane: `gpu~${rws.paneId}` }, machine: "gpu" });
    expect(o.get(res.team).members.counter!.paneId).toStartWith("gpu~");
    // not allowed from there
    expect((await post("/prompt", { pane: lead, text: "hi" })).status).toBe(403);
    expect((await post("/open-with", { path: "/etc/passwd" })).status).toBe(403);
    // af open from there: a file of that machine, in a pane there; never one of the Mac's, or another machine's pane
    writeFileSync(join(rhome, "proj", "notes.md"), "# Notes\n");
    const shown = await post("/show", { target: join(rhome, "proj", "notes.md"), pane: rws.paneId });
    expect(shown.status).toBe(200);
    expect((await shown.json()) as any).toMatchObject({ machine: "gpu", target: join(rhome, "proj", "notes.md") });
    // a pane it names is its machine's ("w1:p1" is gpu~w1:p1); a pane on another machine is refused
    const other = await post("/show", { target: join(rhome, "proj", "notes.md"), of: `ds03~${rws.paneId}` });
    expect(other.status).not.toBe(200);
    expect((await other.json()) as any).toMatchObject({ error: { code: "other_machine" } });
    expect((await post("/team/delegate", { callerPane: rws.paneId, on: true })).status).toBe(200);
    // a team member on the Mac cannot be spoken for from there
    const made = await call("/team/new", { callerPane: lead, goal: "g" });
    await step();
    expect((await post("/team/report", { team: made.body.team, agent: "router", text: "pretend" })).status).toBe(403);
    expect(parseCliBody(new TextEncoder().encode("/home/u/x\0t1\0dev\0w1:p2\0task\0claude\0do it\0"))).toEqual({ cwd: "/home/u/x", team: "t1", agent: "dev", pane: "w1:p2", argv: ["task", "claude", "do it"] });
  });

  test("a machine where af cannot be set up is tried again later and later, its reason logged once", async () => {
    const { home, o, w, h } = await setupRemote();
    const remote = w.remoteOf("gpu~x") as any;
    let forwards = 0;
    remote.forwardRemoteSocket = async () => {
      forwards++;
      throw new Error("this sshd does not forward Unix sockets");
    };
    const log: string[] = [];
    const raf = new RemoteAf({ home, w, teams: o, handler: h, cliMain: join(import.meta.dir, "../../cli/src/main.ts"), log: (m) => log.push(m) });
    await raf.ensure("gpu");
    await raf.ensure("gpu");
    await raf.ensure("gpu");
    expect(forwards).toBe(1); // the next try waits a minute
    expect(log).toEqual(["af on gpu: this sshd does not forward Unix sockets (trying again later, at most every 30 min)"]);
    (raf as any).failed.get("gpu").until = 0;
    await raf.ensure("gpu");
    expect(forwards).toBe(2);
    expect(log.length).toBe(1); // the same reason: not logged again
    expect((raf as any).failed.get("gpu").n).toBe(2);
    raf.stop();
  });

  test("af deliver there: the file is checked there, recorded for that machine and the caller's pane; GET /view for its viewer", async () => {
    const { home, rhome, o, w, h } = await setupRemote();
    const raf = new RemoteAf({ home, w, teams: o, handler: h, cliMain: join(import.meta.dir, "../../cli/src/main.ts") });
    writeFileSync(join(rhome, "proj", "report.md"), "# Report\n");
    const post = (path: string, body: object) => raf.serve("gpu", new Request(`http://af${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    // machine "local" in the body is ignored: the caller is on gpu
    const r = await post("/deliver", { path: join(rhome, "proj", "report.md"), pane: "w1:p2", title: "Report", machine: "local" });
    expect(r.status).toBe(200);
    const d = ((await r.json()) as any).delivery;
    expect(d).toMatchObject({ path: join(rhome, "proj", "report.md"), machine: "gpu", pane: "gpu~w1:p2", title: "Report" });
    expect((await post("/deliver", { path: join(rhome, "proj", "nope.md"), pane: "w1:p2" })).status).toBe(404);
    // a viewer pane there asks what it shows, by its own pane id
    w.register("gpu~w1:p9", join(rhome, "proj", "report.md"), "user", "gpu");
    const v = await raf.serve("gpu", new Request(`http://af/view?pane=w1:p9&format=text`));
    expect(await v.text()).toBe(join(rhome, "proj", "report.md"));
    raf.stop();
  });

  test("the af script: sends the command, prints the answer, and exits with its code", async () => {
    const dir = tmp("af-shim-");
    mkdirSync(join(dir, ".agent-flow", "bin"), { recursive: true });
    writeFileSync(join(dir, ".agent-flow", "bin", "af"), REMOTE_AF, { mode: 0o755 });
    let got: ReturnType<typeof parseCliBody> | undefined;
    const server = Bun.serve({
      unix: join(dir, ".agent-flow", "af.sock"),
      async fetch(req) {
        got = parseCliBody(new Uint8Array(await req.arrayBuffer()));
        return new Response(got.argv[0] === "fail" ? "3\naf: it failed\n" : `0\nran ${got.argv.join("|")}\n`);
      },
    });
    try {
      // async: the server answering it runs in this same process
      const run = async (args: string[]) => {
        const p = Bun.spawn([join(dir, ".agent-flow", "bin", "af"), ...args], { cwd: dir, env: { ...process.env, HOME: dir, AF_TEAM: "t9", AF_AGENT: "", HERDR_PANE_ID: "w2:p5" }, stdout: "pipe", stderr: "pipe" });
        const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        return { code: await p.exited, out, err };
      };
      const a = await run(["task", "codex", 'say "hi" & $HOME', "--no-worktree"]);
      expect(a.code).toBe(0);
      expect(a.out).toBe('ran task|codex|say "hi" & $HOME|--no-worktree\n');
      expect(got).toMatchObject({ cwd: realpathSync(dir), team: "t9", agent: "", pane: "w2:p5" });
      const b = await run(["fail"]);
      expect(b.code).toBe(3);
      expect(b.err).toBe("af: it failed\n");
    } finally {
      server.stop(true);
    }
    const none = Bun.spawnSync([join(dir, ".agent-flow", "bin", "af"), "whoami"], { env: { ...process.env, HOME: tmp("af-shim-none-") }, stdout: "pipe", stderr: "pipe" });
    expect(none.exitCode).toBe(1);
    expect(none.stderr.toString()).toContain("agent-flow is not connected to this machine");
  });
});
