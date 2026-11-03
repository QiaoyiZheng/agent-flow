import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatOp, HPane } from "@af/core";
import { parseClaude, parseCodex, parseOmp } from "../src/transcripts/parse.ts";
import { LocalFS, SshFS, type TranscriptFS, TranscriptTail, claudeTitle, matchByScreen, resolveTranscript, screenSnippets } from "../src/transcripts/index.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "af-tr-")));
  dirs.push(d);
  return d;
};

const run = (parse: (l: any, c: { n: number }) => ChatOp[], lines: any[]) => {
  const ctx = { n: 0 };
  return lines.flatMap((l) => parse(l, ctx));
};
const blocks = (ops: ChatOp[]) => ops.flatMap((o) => (o.op === "add" ? [o.entry.block] : []));

describe("claude transcript", () => {
  const lines = [
    { type: "user", message: { role: "user", content: "Prove that $a^2+b^2=c^2$ <system-reminder>ignore me</system-reminder>" }, timestamp: "t1" },
    { type: "user", isMeta: true, message: { role: "user", content: "Caveat: injected" } },
    { type: "user", message: { role: "user", content: "<command-name>/model</command-name>\n<command-args>opus</command-args>" } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "x" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "## Proof\n$$c^2 = a^2 + b^2$$" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la", description: "list" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a\nb", is_error: false }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/r/calc.js", old_string: "a - b", new_string: "a + b" } }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "failed" }], is_error: true }] } },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } },
    { type: "attachment", foo: 1 },
    { type: "user", message: { role: "user", content: "[agent-flow] New message m3 from lead. Run: af inbox" } },
  ];

  test("text, tools, results and notices; injected and sidechain lines skipped", () => {
    const ops = run(parseClaude, lines);
    expect(blocks(ops)).toEqual([
      { kind: "user", text: "Prove that $a^2+b^2=c^2$" },
      { kind: "notice", text: "/model opus" },
      { kind: "text", text: "## Proof\n$$c^2 = a^2 + b^2$$" },
      { kind: "tool", id: "t1", name: "Bash", done: false, summary: "ls -la", input: undefined },
      { kind: "tool", id: "t2", name: "Edit", done: false, summary: "/r/calc.js", edit: { path: "/r/calc.js", before: "a - b", after: "a + b" } },
      { kind: "notice", text: "[agent-flow] New message m3 from lead. Run: af inbox" },
    ]);
    expect(ops.filter((o) => o.op === "result")).toEqual([
      { op: "result", id: "t1", output: "a\nb", error: false },
      { op: "result", id: "t2", output: "failed", error: true },
    ]);
  });
});

describe("claude: messages sent while the agent works", () => {
  test("a queued_command attachment is the user's message; a later plain copy is not shown twice", () => {
    const q = "第二条：这条是在你忙的时候发的";
    const ops = run(parseClaude, [
      { type: "queue-operation", operation: "enqueue", content: q },
      { type: "attachment", attachment: { type: "queued_command", prompt: q, commandMode: "prompt", origin: { kind: "human" }, timestamp: "t9" }, timestamp: "t9" },
      { type: "attachment", attachment: { type: "queued_command", prompt: "from a task", commandMode: "prompt", origin: { kind: "task" } } },
      { type: "attachment", attachment: { type: "hook_success" } },
      { type: "user", message: { role: "user", content: q } },
      { type: "user", message: { role: "user", content: q } },
    ]);
    expect(blocks(ops)).toEqual([{ kind: "user", text: q }, { kind: "user", text: q }]); // the queued one, then a genuine second send
    expect(ops[0]).toMatchObject({ op: "add", entry: { at: "t9" } });
  });
});

describe("codex transcript", () => {
  test("assistant text, exec commands unwrapped, outputs unwrapped, injected user text skipped", () => {
    const ops = run(parseCodex, [
      { type: "session_meta", payload: {} },
      { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "# protocol" }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions\n..." }] } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the bug" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading the task.\n" }] } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "c1", name: "exec", input: 'text(await tools.exec_command({cmd:"af inbox",workdir:"/w"}));\n' } },
      {
        type: "response_item",
        payload: { type: "custom_tool_call_output", call_id: "c1", output: [{ type: "input_text", text: "Script completed\nOutput:\n" }, { type: "input_text", text: '{"exit_code":0,"output":"--- m12 from lead ---"}' }] },
      },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "*** Begin Patch\n*** Update File: calc.js\n@@\n-a\n+b\n*** End Patch" } },
      { type: "response_item", payload: { type: "function_call", call_id: "c3", name: "shell", arguments: '{"command":["bash","-lc","npm test"]}' } },
      { type: "response_item", payload: { type: "reasoning", encrypted_content: "x" } },
    ]);
    expect(blocks(ops).map((b) => (b.kind === "tool" ? `${b.name}: ${b.summary}` : `${b.kind}: ${(b as any).text}`))).toEqual([
      "user: fix the bug",
      "text: Reading the task.\n",
      "bash: af inbox",
      "apply_patch: calc.js",
      "shell: bash -lc npm test",
    ]);
    expect(ops.find((o) => o.op === "result")).toEqual({ op: "result", id: "c1", output: "--- m12 from lead ---", error: false });
  });
});

describe("omp transcript", () => {
  test("text, tool calls (with partialArgs fallback) and results", () => {
    const ops = run(parseOmp, [
      { type: "session" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "add div" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "I’ll add `div`." }, { type: "toolCall", id: "k1", name: "read", arguments: {}, partialArgs: '{"path":"calc.js"}' }] } },
      { type: "message", message: { role: "toolResult", toolCallId: "k1", content: [{ type: "text", text: "export function add" }], isError: false } },
      { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "k2", name: "edit", arguments: { i: "Adding guarded division", input: "[calc.js#6F9B]\nPUT >7:\nexport function div" } }] } },
    ]);
    const edit = blocks(ops).at(-1) as any;
    expect(edit.summary).toBe("calc.js — Adding guarded division");
    // omp's edit commands are not a diff: they are the input; the real diff comes with the result (parse-omp.test.ts)
    expect(edit.patch).toBeUndefined();
    expect(edit.input).toStartWith("[calc.js#6F9B]");
    expect(blocks(ops).slice(0, 3).map((b) => (b.kind === "tool" ? `${b.name}: ${b.summary}` : `${b.kind}: ${(b as any).text}`))).toEqual(["user: add div", "text: I’ll add `div`.", "read: calc.js"]);
    expect(ops.find((o) => o.op === "result")).toEqual({ op: "result", id: "k1", output: "export function add", error: false });
  });
});

describe("finding and following transcripts", () => {
  const pane = (over: Partial<HPane>): HPane => ({ machine: "local", id: "w1:p1", tabId: "w1:t1", workspaceId: "w1", agentStatus: "idle", cwd: "/proj", ...over });
  const id = "11111111-2222-3333-4444-555555555555";

  /** A fake home with claude, codex and omp transcripts. */
  function home() {
    const root = tmp();
    mkdirSync(join(root, ".claude/projects/-proj"), { recursive: true });
    mkdirSync(join(root, ".codex/sessions/2026/11/02"), { recursive: true });
    writeFileSync(join(root, ".claude/projects/-proj", `${id}.jsonl`), JSON.stringify({ type: "user", cwd: "/proj", message: { content: "hi" } }) + "\n");
    const old = join(root, ".claude/projects/-proj/99999999-2222-3333-4444-555555555555.jsonl");
    writeFileSync(old, JSON.stringify({ type: "user", cwd: "/proj" }) + "\n");
    utimesSync(old, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    writeFileSync(join(root, ".codex/sessions/2026/11/02/rollout-2026-11-02T14-16-30-abc-123.jsonl"), "");
    writeFileSync(join(root, "omp.jsonl"), "");
    return root;
  }

  /** The SSH file access, run for real in a local shell with HOME pointing at the fake home. */
  const shellFs = (root: string) =>
    new SshFS(async (cmd) => {
      const p = Bun.spawnSync(["sh", "-c", cmd], { env: { ...process.env, HOME: root }, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode ?? -1, out: Buffer.from(p.stdout), err: p.stderr.toString() };
    });

  for (const [name, make] of [
    ["local files", (root: string) => new LocalFS({ claude: join(root, ".claude/projects"), codex: join(root, ".codex/sessions") }) as TranscriptFS],
    ["files over SSH (shell commands)", shellFs],
  ] as const) {
    test(`resolve by session id, Herdr path/id, argv, and folder only when unambiguous — ${name}`, async () => {
      const root = home();
      const fs = make(root);
      const none = async () => [] as string[][];
      const claudeFile = join(root, ".claude/projects/-proj", `${id}.jsonl`);
      const c = pane({ agent: "claude" });
      expect(await resolveTranscript(fs, { pane: c, panes: [c], knownSession: id, argv: none })).toEqual({ source: { agent: "claude", path: claudeFile, how: "session" } });
      expect(await resolveTranscript(fs, { pane: c, panes: [c], argv: async () => [["claude", "--resume", id]] })).toMatchObject({ source: { how: "session" } });
      expect(await resolveTranscript(fs, { pane: c, panes: [c], argv: none })).toEqual({ source: { agent: "claude", path: claudeFile, how: "folder" } }); // newest for the folder
      const twin = pane({ id: "w1:p2", agent: "claude" });
      expect(await resolveTranscript(fs, { pane: c, panes: [c, twin], argv: none })).toEqual({ reason: "2 claude agents run in /proj and the screen does not show which conversation is this one yet" });
      const elsewhere = pane({ id: "ds03~w1:p2", machine: "ds03", agent: "claude" });
      expect(await resolveTranscript(fs, { pane: c, panes: [c, elsewhere], argv: none })).toMatchObject({ source: { how: "folder" } }); // same folder on another machine does not count
      const x = pane({ agent: "codex", session: { kind: "id", value: "abc-123" } });
      expect(await resolveTranscript(fs, { pane: x, panes: [x], argv: none })).toMatchObject({ source: { agent: "codex", how: "session" } });
      const o = pane({ agent: "omp", session: { kind: "path", value: join(root, "omp.jsonl") } });
      expect(await resolveTranscript(fs, { pane: o, panes: [o], argv: none })).toEqual({ source: { agent: "omp", path: join(root, "omp.jsonl"), how: "session" } });
      expect(await resolveTranscript(fs, { pane: pane({ agent: "omp" }), panes: [], argv: none })).toEqual({ reason: "omp has not reported its session to Herdr yet" });
      expect(await resolveTranscript(fs, { pane: pane({}), panes: [], argv: none })).toEqual({ reason: "no agent in this pane" });
    });

    test(`the tail returns only appended entries, survives partial and multi-byte lines, resets on rewrite — ${name}`, async () => {
      const root = tmp();
      const path = join(root, "t.jsonl");
      const fs = make(root);
      const line = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
      writeFileSync(path, line("one") + "\n");
      const t = new TranscriptTail({ agent: "omp", path, how: "session" }, fs);
      expect(blocks((await t.read()).ops)).toEqual([{ kind: "text", text: "one" }]);
      const two = Buffer.from(line("二是中文") + "\n");
      const cut = two.indexOf(Buffer.from("中")) + 1; // inside a multi-byte character
      appendFileSync(path, two.subarray(0, cut));
      expect((await t.read()).ops).toEqual([]);
      appendFileSync(path, two.subarray(cut));
      expect(blocks((await t.read()).ops)).toEqual([{ kind: "text", text: "二是中文" }]);
      writeFileSync(path, line("fresh") + "\n");
      const r = await t.read();
      expect(r.reset).toBe(true);
      expect(blocks(r.ops)).toEqual([{ kind: "text", text: "fresh" }]);
    });
  }

  test("several claude agents in one folder: the screen tells which transcript is whose", async () => {
    const root = tmp();
    const dir = join(root, ".claude/projects/-proj");
    mkdirSync(dir, { recursive: true });
    const conv = (id: string, prompt: string, reply: string) => {
      const lines = [
        { type: "user", cwd: "/proj", message: { role: "user", content: prompt } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } },
        { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: "node test.js" } }] } },
      ];
      writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return join(dir, `${id}.jsonl`);
    };
    const lead = conv("aaaaaaaa-0000-0000-0000-000000000001", "[agent-flow] New message m16 from agent-flow. Run: af inbox", "**mul** and **div** are both in calc.js, and all tests pass.");
    const other = conv("aaaaaaaa-0000-0000-0000-000000000002", "explain the Cauchy-Schwarz inequality", "柯西-施瓦茨不等式：在任意内积空间中，两个向量内积的绝对值不超过它们范数的乘积");
    const fs = new LocalFS({ claude: join(root, ".claude/projects"), codex: join(root, "none") });
    const leadScreen = "❯ [agent-flow] New message m16 from agent-flow. Run: af inbox\n\n● mul and div are both in calc.js, and all tests pass.\n● Bash(node test.js)\n  ⎿  all tests passed\n\n❯ 我";
    expect(screenSnippets(leadScreen).length).toBe(3); // the half-typed "我" is too short to count
    expect(await matchByScreen(fs, [lead, other], leadScreen)).toBe(lead);
    expect(await matchByScreen(fs, [lead, other], "● 柯西-施瓦茨不等式：在任意内积空间中，两个向量内积的绝对值\n❯ explain the Cauchy-Schwarz inequality")).toBe(other);
    expect(await matchByScreen(fs, [lead, other], "❯ something neither of them said at all")).toBeUndefined();

    const a = pane({ agent: "claude" });
    const b = pane({ id: "w1:p2", agent: "claude" });
    expect(await resolveTranscript(fs, { pane: a, panes: [a, b], argv: async () => [], screen: async () => leadScreen })).toEqual({ source: { agent: "claude", path: lead, how: "screen" } });
    expect(await resolveTranscript(fs, { pane: a, panes: [a, b], argv: async () => [], screen: async () => "" })).toMatchObject({ reason: expect.stringContaining("does not show which conversation") });
    // a path reported by the SessionStart hook wins over everything
    expect(await resolveTranscript(fs, { pane: a, panes: [a, b], knownPath: other, argv: async () => [], screen: async () => leadScreen })).toEqual({ source: { agent: "claude", path: other, how: "session" } });
  });

  for (const [name, make] of [
    ["local files", (root: string) => new LocalFS({ claude: join(root, ".claude/projects"), codex: join(root, ".codex/sessions") }) as TranscriptFS],
    ["files over SSH (shell commands)", shellFs],
  ] as const)
    test(`the running process says which conversation is the pane's: claude's session registry, codex's open rollout — ${name}`, async () => {
      const root = home();
      const fs = make(root);
      const dir = join(root, ".claude/projects/-proj");
      const mine = join(dir, "22222222-2222-3333-4444-555555555555.jsonl");
      writeFileSync(mine, JSON.stringify({ type: "user", cwd: "/proj", message: { content: "mine" } }) + "\n");
      mkdirSync(join(root, ".claude/sessions"), { recursive: true });
      writeFileSync(join(root, ".claude/sessions/4242.json"), JSON.stringify({ pid: 4242, sessionId: "22222222-2222-3333-4444-555555555555", cwd: "/proj" }));
      writeFileSync(join(root, ".claude/sessions/4343.json"), JSON.stringify({ pid: 9999, sessionId: id })); // a stale file for another pid
      const a = pane({ agent: "claude" });
      const twin = pane({ id: "w1:p2", agent: "claude" });
      const none = async () => [] as string[][];
      // two claude agents in /proj: only the process tells them apart (no title, no screen)
      expect(await resolveTranscript(fs, { pane: a, panes: [a, twin], argv: none, pids: async () => [4242] })).toEqual({ source: { agent: "claude", path: mine, how: "session" } });
      expect(await resolveTranscript(fs, { pane: a, panes: [a, twin], argv: none, pids: async () => [4343] })).toMatchObject({ reason: expect.stringContaining("2 claude agents") });
      expect(await fs.claudeSessionOfPid(-1)).toBeUndefined();

      // codex: the rollout its process holds open
      const lsof = Bun.spawnSync(["sh", "-c", "command -v lsof"]).exitCode === 0;
      if (!lsof) return;
      const rollout = join(root, ".codex/sessions/2026/11/02/rollout-2026-11-02T15-00-00-held-open.jsonl");
      writeFileSync(rollout, "");
      const holder = Bun.spawn(["sh", "-c", `exec 3>>'${rollout}'; sleep 20`]);
      try {
        await Bun.sleep(300);
        const x = pane({ agent: "codex" });
        const x2 = pane({ id: "w1:p3", agent: "codex" });
        expect(await resolveTranscript(fs, { pane: x, panes: [x, x2], argv: none, pids: async () => [holder.pid] })).toEqual({ source: { agent: "codex", path: rollout, how: "session" } });
      } finally {
        holder.kill();
      }
    });

  test("a fresh agent is locked to its own conversation before writing anything, and never shown an older one", async () => {
    const root = home(); // has an older claude transcript for /proj, and a codex rollout
    const fs = new LocalFS({ claude: join(root, ".claude/projects"), codex: join(root, ".codex/sessions") });
    const none = async () => [] as string[][];
    const fresh = "33333333-2222-3333-4444-555555555555";
    mkdirSync(join(root, ".claude/sessions"), { recursive: true });
    writeFileSync(join(root, ".claude/sessions/5151.json"), JSON.stringify({ pid: 5151, sessionId: fresh, cwd: "/proj" }));
    const c = pane({ agent: "claude" });

    // claude alone in /proj, nothing sent: its own (empty) conversation, not the older one in the folder
    expect(await resolveTranscript(fs, { pane: c, panes: [c], argv: none, pids: async () => [5151] })).toEqual({ source: { agent: "claude", path: "", how: "session", pending: true } });
    expect(await resolveTranscript(fs, { pane: c, panes: [c], argv: none })).toMatchObject({ source: { how: "folder" } }); // without the process: the old guess
    // ... claude --resume <id> shows that conversation until it writes its own
    expect(await resolveTranscript(fs, { pane: c, panes: [c], argv: async () => [["claude", "--resume", id]], pids: async () => [5151] })).toMatchObject({ source: { how: "session", path: expect.stringContaining(id) } });
    // the first message creates the file: from then on it is that file
    const file = join(root, ".claude/projects/-proj", `${fresh}.jsonl`);
    writeFileSync(file, JSON.stringify({ type: "user", cwd: "/proj", message: { content: "hello" } }) + "\n");
    expect(await resolveTranscript(fs, { pane: c, panes: [c], argv: none, pids: async () => [5151] })).toEqual({ source: { agent: "claude", path: file, how: "session" } });

    // omp: Herdr knows the path at once; the file comes with the first message
    const later = join(root, "omp-later.jsonl");
    const o = pane({ agent: "omp", session: { kind: "path", value: later } });
    expect(await resolveTranscript(fs, { pane: o, panes: [o], argv: none })).toEqual({ source: { agent: "omp", path: later, how: "session", pending: true } });
    // a session agent-flow gave the agent, not written yet
    expect(await resolveTranscript(fs, { pane: c, panes: [c], argv: none, knownSession: "44444444-2222-3333-4444-555555555555" })).toMatchObject({ source: { pending: true } });

    // codex: no rollout open means nothing sent yet (not the newest rollout in the folder)
    const stub = (open: string | null | undefined) => Object.assign(Object.create(fs), { codexRolloutOfPids: async () => open }) as TranscriptFS;
    const x = pane({ agent: "codex" });
    expect(await resolveTranscript(stub(null), { pane: x, panes: [x], argv: none, pids: async () => [7] })).toEqual({ source: { agent: "codex", path: "", how: "session", pending: true } });
    const rollout = join(root, ".codex/sessions/2026/11/02/rollout-2026-11-02T14-16-30-abc-123.jsonl");
    expect(await resolveTranscript(stub(rollout), { pane: x, panes: [x], argv: none, pids: async () => [7] })).toEqual({ source: { agent: "codex", path: rollout, how: "session" } });
    // codex resume <id>: that conversation, before it writes anything of its own
    const resumed = join(root, ".codex/sessions/2026/11/02/rollout-2026-11-02T15-00-00-01a19ae6-f5c1-7b70-bf1d-6b1cd834650a.jsonl");
    writeFileSync(resumed, "");
    expect(await resolveTranscript(stub(null), { pane: x, panes: [x], argv: async () => [["codex", "resume", "01a19ae6-f5c1-7b70-bf1d-6b1cd834650a"]], pids: async () => [7] })).toEqual({ source: { agent: "codex", path: resumed, how: "session" } });
    // lsof could not run: the old guesses
    writeFileSync(rollout, JSON.stringify({ type: "session_meta", payload: { cwd: "/proj" } }) + "\n");
    expect(await resolveTranscript(stub(undefined), { pane: x, panes: [x], argv: none, pids: async () => [7] })).toMatchObject({ source: { how: "folder" } });
  });

  test("several claude agents in one folder: the conversation title (the terminal title) tells which is whose", async () => {
    const root = tmp();
    const dir = join(root, ".claude/projects/-proj");
    mkdirSync(dir, { recursive: true });
    const conv = (id: string, titles: string[], filler = 0) => {
      const lines: object[] = [{ type: "user", cwd: "/proj", message: { role: "user", content: "hi" } }];
      for (const t of titles) {
        lines.push({ type: "ai-title", aiTitle: t, sessionId: id });
        for (let i = 0; i < filler; i++) lines.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1000) }] } });
      }
      writeFileSync(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      return join(dir, `${id}.jsonl`);
    };
    // the title was set early and the file grew a lot since: still found
    const ppt = conv("bbbbbbbb-0000-0000-0000-000000000001", ["PPT 大纲", "技术创新与\"卡脖子\"问题PPT"], 400);
    const paper = conv("bbbbbbbb-0000-0000-0000-000000000002", ["同步远程的paper撰写"]);
    const fork = conv("bbbbbbbb-0000-0000-0000-000000000003", ["同步远程的paper撰写", "同步远程的paper撰写 ⑂"]);
    const fs = new LocalFS({ claude: join(root, ".claude/projects"), codex: join(root, "none") });
    expect(await claudeTitle(fs, ppt)).toBe('技术创新与"卡脖子"问题PPT');
    const a = pane({ agent: "claude", title: '技术创新与"卡脖子"问题PPT' });
    const b = pane({ id: "w1:p2", agent: "claude", title: "同步远程的paper撰写" });
    const c = pane({ id: "w1:p3", agent: "claude", title: "同步远程的paper撰写 ⑂" });
    const panes = [a, b, c];
    const blank = { argv: async () => [], screen: async () => "" };
    expect(await resolveTranscript(fs, { pane: a, panes, ...blank })).toEqual({ source: { agent: "claude", path: ppt, how: "title" } });
    expect(await resolveTranscript(fs, { pane: b, panes, ...blank })).toEqual({ source: { agent: "claude", path: paper, how: "title" } });
    expect(await resolveTranscript(fs, { pane: c, panes, ...blank })).toEqual({ source: { agent: "claude", path: fork, how: "title" } });
    // a title that is not unique, or not a conversation title at all, decides nothing
    conv("bbbbbbbb-0000-0000-0000-000000000004", ["同步远程的paper撰写"]);
    expect(await resolveTranscript(fs, { pane: b, panes, ...blank })).toMatchObject({ reason: expect.stringContaining("does not show which conversation") });
    expect(await resolveTranscript(fs, { pane: pane({ agent: "claude", title: "Claude Code" }), panes, ...blank })).toMatchObject({ reason: expect.any(String) });
  });

  test("a large transcript opens at its last part, from a whole line", async () => {
    const root = tmp();
    const path = join(root, "big.jsonl");
    const line = (n: number) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: `entry ${n} ${"x".repeat(80)}` }] } });
    writeFileSync(path, Array.from({ length: 200 }, (_, i) => line(i)).join("\n") + "\n");
    const t = new TranscriptTail({ agent: "omp", path, how: "session" }, new LocalFS(), 5000);
    const got = blocks((await t.read()).ops).map((b: any) => Number(b.text.split(" ")[1]));
    expect(got.at(-1)).toBe(199);
    expect(got.length).toBeLessThan(60); // ~5000 bytes of ~140-byte lines
    expect(got.length).toBeGreaterThan(20);
    expect(got).toEqual(Array.from({ length: got.length }, (_, i) => 200 - got.length + i)); // contiguous, newest last
    expect(t.skipped).toBeGreaterThan(0);
  });
});
