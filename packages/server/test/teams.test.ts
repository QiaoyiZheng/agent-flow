import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrMemberName, ticketStage } from "@af/core";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { makeHandler } from "../src/api.ts";
import { commitAll, git } from "../src/git.ts";
import { PlaybookLibrary } from "../src/playbooks.ts";
import { Teams, type TeamsOptions } from "../src/teams.ts";
import { lastReply } from "../src/transcripts/peek.ts";
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
  const replies = new Map<string, { reply?: string; error?: string; size?: number }>();
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
    expect(typed(m.paneId!)[0]).toStartWith("Count the exported functions in calc.js");
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
  test("the reply after the last user message; an error only when nothing came after it", () => {
    const claude = (type: string, content: unknown) => JSON.stringify({ type, message: { role: type, content }, uuid: Math.random().toString(36), timestamp: "2026-11-04T10:00:00Z" });
    const lines = [claude("user", "first"), claude("assistant", [{ type: "text", text: "old answer" }]), claude("user", "count them"), claude("assistant", [{ type: "text", text: "There are 4." }]), claude("assistant", [{ type: "text", text: "Done." }])];
    expect(lastReply("claude", lines)).toEqual({ reply: "There are 4.\n\nDone.", error: undefined });
    expect(lastReply("claude", ["not json", ...lines.slice(0, 3)])).toEqual({ reply: undefined, error: undefined });
  });
});
