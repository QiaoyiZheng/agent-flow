// omp (oh-my-pi) session files: synthetic lines shaped like the real ones.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEntry, ChatMeta, ChatOp, ToolBlock } from "@af/core";
import { prepareFork } from "../src/fork.ts";
import { parseOmp, parseOmpLine, unifiedFromOmp } from "../src/transcripts/parse/omp.ts";
import { LocalFS, SshFS, TranscriptTail } from "../src/transcripts/index.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "af-omp-")));
  dirs.push(d);
  return d;
};

/** What the UI ends up showing after applying the ops. */
class View {
  entries = new Map<string, ChatEntry>();
  tools = new Map<string, ToolBlock>();
  meta: ChatMeta = {};
  apply(ops: ChatOp[]) {
    for (const op of ops) {
      if (op.op === "add") {
        const e = { ...op.entry, block: { ...op.entry.block } } as ChatEntry;
        this.entries.set(e.key, e);
        if (e.block.kind === "tool") this.tools.set(e.block.id, e.block);
      } else if (op.op === "remove") op.keys.forEach((k) => this.entries.delete(k));
      else if (op.op === "result") {
        const t = this.tools.get(op.id);
        if (t) Object.assign(t, { output: op.output, error: op.error, ...(op.images ? { images: op.images } : {}), ...(op.background ? { background: true } : {}), done: !op.background });
      } else if (op.op === "update") Object.assign(this.tools.get(op.id) ?? {}, op.set);
      else if (op.op === "meta") Object.assign(this.meta, op.meta);
    }
    return this;
  }
  get blocks() {
    return [...this.entries.values()].map((e) => e.block);
  }
  /** One line per block: "user: hi", "tool bash: ls", "notice(error): …". */
  get lines() {
    return this.blocks.map((b) =>
      b.kind === "tool" ? `tool ${b.name}: ${b.summary}` : b.kind === "notice" ? `notice${b.tone ? `(${b.tone})` : ""}: ${b.text}` : `${b.kind}${b.kind === "user" && b.command ? ` ${b.command}` : ""}: ${b.text}`,
    );
  }
}

const run = (lines: any[]) => {
  const ctx = { n: 0 };
  return new View().apply(lines.flatMap((l) => parseOmp(l, ctx)));
};

// ---- builders for entries shaped like omp's ----
let seq = 0;
const ts = () => `2026-11-02T06:0${Math.floor(seq / 60) % 10}:${String(seq % 60).padStart(2, "0")}.000Z`;
const entry = (id: string, parentId: string | null, rest: object) => ({ ...rest, id, parentId, timestamp: (seq++, ts()) });
const user = (id: string, parent: string | null, text: string, extra: object = {}) =>
  entry(id, parent, { type: "message", message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: 1, ...extra } });
const usage = (input = 100, output = 20, cost = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const assistant = (id: string, parent: string | null, content: any[], extra: object = {}) =>
  entry(id, parent, { type: "message", message: { role: "assistant", content, api: "openai-completions", provider: "relay", model: "gpt-x", usage: usage(), stopReason: "stop", timestamp: 1, ...extra } });
const call = (callId: string, name: string, args: object) => ({ type: "toolCall", id: callId, name, arguments: args, partialArgs: JSON.stringify(args), streamIndex: 0 });
const result = (id: string, parent: string | null, callId: string, toolName: string, text: string, details: object = {}, isError = false) =>
  entry(id, parent, { type: "message", message: { role: "toolResult", toolCallId: callId, toolName, content: [{ type: "text", text }], details, isError, timestamp: 1 } });
const hidden = (id: string, parent: string | null, customType: string, data: object = {}) => entry(id, parent, { type: "custom", customType, data });
const header = { type: "session", version: 3, id: "01a19adc-3cae-7000-9310-8329217a306d", timestamp: "2026-11-02T06:04:47.150Z", cwd: "/work/proj" };
const titleSlot = { type: "title", v: 1, title: "", updatedAt: "2026-11-02T06:04:47.150Z", pad: " ".repeat(170) };

describe("errors, aborts and retries", () => {
  test("a provider error with no content shows its message; a recovered retry a dim note; a superseded attempt nothing", () => {
    const v = run([
      user("u1", null, "1"),
      assistant("a1", "u1", [], { stopReason: "error", usage: usage(0, 0), errorMessage: "Google API error (400): * contents[2].parts[0].function_response.name: Name cannot be empty.\n\nraw-http-request=/x/1.json" }),
      user("u2", "a1", "again"),
      assistant("a2", "u2", [call("c1", "bash", { command: "af inbox", i: "Reading inbox" })], {
        stopReason: "error",
        errorMessage: "The socket connection was closed unexpectedly.",
        retryRecovery: { kind: "auto-retry", status: "recovered", attempt: 1, recovery: "model", note: "switched model; retried" },
      }),
      result("r1", "a2", "c1", "bash", "Tool call was not executed because the provider stream ended with an error", {}, true),
      assistant("a3", "r1", [], { stopReason: "error", errorMessage: "503 busy", retryRecovery: { status: "superseded" } }),
    ]);
    expect(v.lines).toEqual(["user: 1", "notice(error): Google API error (400): * contents[2].parts[0].function_response.name: Name cannot be empty.", "user: again", "tool bash: af inbox", "notice: switched model; retried"]);
    expect((v.blocks[1] as any).detail).toContain("raw-http-request=/x/1.json");
    expect((v.blocks[4] as any).detail).toBe("The socket connection was closed unexpectedly.");
    expect(v.tools.get("c1")).toMatchObject({ error: true, done: true });
  });

  test("an interrupt shows once and stops the tools still running; a reason of its own is shown as is; a silent abort shows nothing", () => {
    const v = run([
      user("u1", null, "do it"),
      assistant("a1", "u1", [{ type: "thinking", thinking: "Planning", thinkingSignature: "x" }, call("c1", "bash", { command: "sleep 100" })], { stopReason: "toolUse" }),
      hidden("h1", "a1", "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "sleep 100" } }),
      assistant("a2", "h1", [], { stopReason: "aborted", errorMessage: "Interrupted by user" }),
      user("u2", "a2", "go on"),
      assistant("a3", "u2", [], { stopReason: "aborted", errorMessage: "Previous OMP process exited before completing the turn." }),
      assistant("a4", "a3", [], { stopReason: "aborted", errorMessage: "__omp.silent_abort__" }),
      assistant("a5", "a4", [], { stopReason: "aborted", errorMessage: "Request was aborted" }),
    ]);
    expect(v.lines).toEqual(["user: do it", "thinking: Planning", "tool bash: sleep 100", "notice(warn): Interrupted", "user: go on", "notice(warn): Previous OMP process exited before completing the turn.", "notice(warn): Interrupted"]);
    expect(v.tools.get("c1")).toMatchObject({ aborted: true, done: true });
  });

  test("the process exiting stops running and background tools", () => {
    const v = run([
      assistant("a1", null, [call("c1", "bash", { command: "make" }), call("c2", "bash", { command: "sleep 9" })], { stopReason: "toolUse" }),
      result("r2", "a1", "c2", "bash", "Backgrounded as job bg_1; result will be delivered automatically.", { async: { state: "running", jobId: "bg_1", type: "bash" } }),
      hidden("x1", "r2", "session_exit", { reason: "sighup", kind: "signal" }),
    ]);
    expect(v.tools.get("c1")).toMatchObject({ aborted: true, done: true });
    expect(v.tools.get("c2")).toMatchObject({ aborted: true, done: true, background: true });
  });
});

describe("the session tree: only the active branch", () => {
  const lines = () => [
    titleSlot,
    header,
    entry("m0", null, { type: "model_change", model: "relay/gpt-x" }),
    user("u1", "m0", "first"),
    assistant("a1", "u1", [{ type: "text", text: "answer 1" }]),
    user("u2", "a1", "second"),
    assistant("a2", "u2", [call("c1", "read", { path: "x.js", i: "Reading" })], { stopReason: "toolUse" }),
    hidden("h1", "a2", "tool_execution_start", { toolCallId: "c1", toolName: "read", args: { path: "x.js" } }),
    result("r1", "h1", "c1", "read", "1:x"),
    assistant("a3", "r1", [], { stopReason: "aborted", errorMessage: "Interrupted by user" }),
    // the user went back to a1 and asked again
    user("u3", "a1", "second"),
    assistant("a4", "u3", [{ type: "text", text: "answer 2" }]),
  ];

  test("an entry whose parent is not the last entry drops the branch left, once", () => {
    const ctx = { n: 0 };
    const ops = lines().flatMap((l) => parseOmp(l, ctx));
    const removes = ops.filter((o) => o.op === "remove");
    expect(removes).toHaveLength(1);
    expect((removes[0] as any).keys).toHaveLength(3); // user "second", the read call, its interrupt notice
    const v = new View().apply(ops);
    expect(v.lines).toEqual(["user: first", "text: answer 1", "notice: branched here", "user: second", "text: answer 2"]);
    expect((v.blocks[2] as any).detail).toContain("3 entries");
  });

  test("followed by the tail: everything shown comes from the active branch, also when written a piece at a time", async () => {
    const root = tmp();
    const path = join(root, "s.jsonl");
    const text = lines().map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(path, "");
    const t = new TranscriptTail({ agent: "omp", path, how: "session" }, new LocalFS());
    const v = new View();
    for (let i = 0; i < text.length; i += 97) {
      appendFileSync(path, text.slice(i, i + 97));
      const r = await t.read();
      expect(r.reset).toBe(false);
      v.apply(r.ops);
    }
    expect(v.lines).toEqual(["user: first", "text: answer 1", "notice: branched here", "user: second", "text: answer 2"]);
    // each entry's ref is the start of the line it came from
    const refs = [...v.entries.values()].map((e) => JSON.parse(text.slice(e.ref!, text.indexOf("\n", e.ref!))).id);
    expect(refs).toEqual(["u1", "a1", "u3", "u3", "a4"]);
  });

  test("opened in the middle: a branch from before the window drops everything shown so far on the old path", async () => {
    const root = tmp();
    const path = join(root, "s.jsonl");
    const all = [...lines(), user("u9", "m0", "fresh start")];
    const text = all.map((l) => JSON.stringify(l)).join("\n") + "\n";
    writeFileSync(path, text);
    const t = new TranscriptTail({ agent: "omp", path, how: "session" }, new LocalFS(), text.length - text.indexOf('"id":"a2"') + 40);
    const v = new View().apply((await t.read()).ops);
    expect(v.lines).toEqual(["notice: branched here", "user: fresh start"]);
  });

  test("a branch summary is shown as the note; a branch back to an earlier branch says what is missing", () => {
    const lines = [
      user("u1", null, "q"),
      assistant("a1", "u1", [{ type: "text", text: "A" }]),
      user("u2", "a1", "q2"),
      entry("b1", "a1", { type: "branch_summary", fromId: "a1", summary: "Tried q2; dropped it." }),
      user("u3", "b1", "q3"),
    ];
    const v = run(lines);
    expect(v.lines).toEqual(["user: q", "text: A", "notice: branched here · summary of the branch left", "user: q3"]);
    expect((v.blocks[2] as any).detail).toBe("Tried q2; dropped it.");
    // back onto the branch left above: its own entries were taken out when it was left
    expect(run([...lines, user("u4", "u2", "q4")]).lines).toEqual(["user: q", "text: A", "notice: branched here", "notice: continued on a branch left earlier", "user: q4"]);
  });

  test("lines without ids (older files, tests) are read in order; the remembered tree stays bounded", () => {
    expect(run([{ type: "message", message: { role: "user", content: "plain" } }, { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }]).lines).toEqual(["user: plain", "text: ok"]);
    const ctx: any = { n: 0 };
    let parent: string | null = null;
    for (let i = 0; i < 50_100; i++) {
      parseOmp({ type: "custom", customType: "todo_hud_state", data: {}, id: `n${i}`, parentId: parent }, ctx);
      parent = `n${i}`;
    }
    expect(ctx.state.omp.nodes.size).toBe(50_000);
  });
});

describe("assistant content, custom messages, compaction", () => {
  test("skill prompts are user messages with the skill as the command; agent-loaded skills a notice; hidden messages stay hidden", () => {
    const v = run([
      entry("s1", null, { type: "custom_message", customType: "skill-prompt", content: "[IMPORTANT: User invoked the \"herdr\" skill …]\n\n# Herdr\n…", display: true, details: { name: "herdr", path: "/s/herdr/SKILL.md", args: "list panes", lineCount: 197 }, attribution: "user" }),
      entry("s2", "s1", { type: "custom_message", customType: "skill-prompt", content: "…", display: true, details: { name: "grill-me", path: "/s/g.md", prompt: "please /skill:grill-me about the plan", lineCount: 9 }, attribution: "user" }),
      entry("s3", "s2", { type: "custom_message", customType: "skill-prompt", content: "…", display: true, details: { name: "auto", path: "/s/a.md", lineCount: 1 }, attribution: "agent" }),
      entry("s4", "s3", { type: "custom_message", customType: "todo-error-reminder", content: "<system-reminder>todo failed</system-reminder>", display: false, details: {} }),
      entry("s5", "s4", { type: "custom_message", customType: "lsp-late-diagnostic", content: "calc.js:3 error: x is not defined", display: true, details: { files: [] } }),
    ]);
    expect(v.lines).toEqual(["user /skill:herdr: list panes", "user /skill:grill-me: please /skill:grill-me about the plan", "notice: loaded skill auto", "notice: lsp late diagnostic: calc.js:3 error: x is not defined"]);
  });

  test("background jobs: the result marks the call as running in the background; the delivered output finishes it", () => {
    const delivered = (jobs: object[], text: string) => ({ type: "custom_message", customType: "async-result", content: `<system-notice>\n${text}\n</system-notice>`, display: true, details: { meta: {}, jobs }, attribution: "agent" });
    const v = run([
      assistant("a1", null, [call("c1", "bash", { command: "pip install -r req.txt" }), call("c2", "bash", { command: "make" }), call("c3", "bash", { command: "make test" })], { stopReason: "toolUse" }),
      result("r1", "a1", "c1", "bash", "Backgrounded as job bg_8; result will be delivered automatically.", { async: { state: "running", jobId: "bg_8", type: "bash" } }),
      result("r2", "r1", "c2", "bash", "Backgrounded as job bg_9; …", { async: { state: "running", jobId: "bg_9", type: "bash" } }),
      result("r3", "r2", "c3", "bash", "Backgrounded as job bg_10; …", { async: { state: "running", jobId: "bg_10", type: "bash" } }),
      entry("j1", "r3", delivered([{ jobId: "bg_8", type: "bash", label: "pip install", durationMs: 82565 }], "Background job bg_8 has completed. Resume your work using the result below.\nInstalled 3 packages")),
      entry("j2", "j1", delivered([{ jobId: "bg_9", type: "bash" }, { jobId: "bg_10", type: "bash" }, { jobId: "bg_77", type: "bash", label: "old job" }], "3 background jobs have completed. Resume your work using the results below.\n\n── Job bg_9 (make) ──\nbuilt\n── Job bg_10 (make test) ──\nall passed\n── Job bg_77 (old job) ──\nlate")),
    ]);
    expect(v.tools.get("c1")).toMatchObject({ output: "Installed 3 packages", done: true, background: true });
    expect(v.tools.get("c2")).toMatchObject({ output: "built", done: true });
    expect(v.tools.get("c3")).toMatchObject({ output: "all passed", done: true });
    expect(v.lines.at(-1)).toBe("notice: Background job bg_77 completed: old job");
    expect((v.blocks.at(-1) as any).detail).toBe("late");
  });

  test("a running background job collected by hub wait is done too", () => {
    const v = run([
      assistant("a1", null, [call("c1", "bash", { command: "sleep 12" })], { stopReason: "toolUse" }),
      result("r1", "a1", "c1", "bash", "Backgrounded as job bg_1; …", { async: { state: "running", jobId: "bg_1", type: "bash" } }),
      assistant("a2", "r1", [call("c2", "hub", { op: "wait", ids: ["bg_1"], i: "Waiting for sleep" })], { stopReason: "toolUse" }),
      result("r2", "a2", "c2", "hub", "## Completed (1) …", { op: "wait", jobs: [{ id: "bg_1", type: "bash", status: "completed", label: "sleep 12", durationMs: 12040, resultText: "(no output)" }] }),
    ]);
    expect(v.tools.get("c2")).toMatchObject({ summary: "wait bg_1", report: "- `bg_1` bash · **completed** (12s) · sleep 12" });
    expect(v.tools.get("c1")).toMatchObject({ output: "(no output)", done: true });
  });

  test("compaction is a divider with the summary folded under it; a /clear boundary is a divider", () => {
    const v = run([
      entry("k1", null, { type: "compaction", summary: "## Goal\nReproduce the paper.", firstKeptEntryId: "x", tokensBefore: 111569, tokensAfter: 43000, method: "handoff" }),
      entry("k2", "k1", { type: "reset_boundary" }),
    ]);
    expect(v.blocks).toEqual([
      { kind: "notice", text: "Compacted 112k → 43k tokens", divider: true, detail: "## Goal\nReproduce the paper." },
      { kind: "notice", text: "context cleared", divider: true },
    ]);
  });

  test("the user's !cmd, $python and @file", () => {
    const v = run([
      entry("b1", null, { type: "message", message: { role: "bashExecution", command: "ls -la", output: "total 0", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } }),
      entry("b2", "b1", { type: "message", message: { role: "bashExecution", command: "false", output: "", exitCode: 1, cancelled: false, truncated: false, timestamp: 1 } }),
      entry("b3", "b2", { type: "message", message: { role: "pythonExecution", code: "print(1+1)", output: "2", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 } }),
      entry("b4", "b3", { type: "message", message: { role: "fileMention", files: [{ path: "calc.js", content: "…", lineCount: 7 }, { path: "big.bin", content: "", skippedReason: "binary", byteSize: 9 }], timestamp: 1 } }),
    ]);
    expect(v.lines).toEqual(["tool !: ls -la", "tool !: false", "tool $: print(1+1)", "notice: read @calc.js (7 lines), @big.bin (skipped: binary)"]);
    expect(v.blocks[0]).toMatchObject({ output: "total 0", done: true });
    expect(v.blocks[1]).toMatchObject({ error: true, output: "\n(exit 1)" });
    expect(v.blocks[2]).toMatchObject({ output: "2", done: true });
  });

  test("developer reminders are hidden; steering messages show as the user's; a tool with no name is 'tool'; grep keeps its pattern", () => {
    const v = run([
      entry("d1", null, { type: "message", message: { role: "developer", content: [{ type: "text", text: "<system-reminder>Plan mode is active</system-reminder>" }], timestamp: 1 } }),
      user("u1", "d1", "stop after step 2", { steering: true }),
      assistant("a1", "u1", [call("c1", "", {}), call("c2", "grep", { pattern: "subsection|parindent", path: "paper/a.sty", i: "Checking headings" }), call("c3", "glob", { path: "src/**/*.ts", i: "Finding files" })], { stopReason: "toolUse" }),
    ]);
    expect(v.lines).toEqual(["user: stop after step 2", "tool tool: ", "tool grep: subsection|parindent in paper/a.sty", "tool glob: src/**/*.ts"]);
  });

  test("a tool omp starts while the message calling it still streams shows at once, and only once", () => {
    const v = run([
      user("u1", null, "go"),
      hidden("h1", "u1", "tool_execution_start", { toolCallId: "c1", toolName: "bash", args: { command: "af inbox" }, intent: "Reading inbox" }),
      assistant("a1", "h1", [{ type: "text", text: "Checking." }, call("c1", "bash", { command: "af inbox", i: "Reading inbox" })], { stopReason: "toolUse" }),
      result("r1", "a1", "c1", "bash", "no messages"),
    ]);
    expect(v.lines).toEqual(["user: go", "tool bash: af inbox", "text: Checking."]);
    expect(v.tools.get("c1")).toMatchObject({ output: "no messages", done: true });
  });

  test("model, thinking level, plan mode and usage go to the footer; a model the user picks is noted", () => {
    const ctx = { n: 0 };
    const ops = [
      entry("m1", null, { type: "model_change", model: "relay/gemini-4-argon", resolvedModelIsFallback: false }),
      entry("t1", "m1", { type: "thinking_level_change", thinkingLevel: "high", configured: null }),
      user("u1", "t1", "hi"),
      assistant("a1", "u1", [{ type: "text", text: "hello" }], { model: "gemini-4-argon", usage: usage(1200, 300, 0.0125), contextSnapshot: { promptTokens: 30000, nonMessageTokens: 9000, compactionEpoch: 0 } }),
      entry("m2", "a1", { type: "model_change", model: "relay/gpt-6-astra", role: "fallback", resolvedModelIsFallback: true }),
      entry("m3", "m2", { type: "model_change", model: "relay/kimi-k3", role: "smol" }),
      entry("m4", "m3", { type: "model_change", model: "relay/deepseek-v4", role: "default" }),
      entry("mo", "m4", { type: "mode_change", mode: "plan" }),
      entry("t2", "mo", { type: "thinking_level_change", thinkingLevel: "medium", configured: "auto" }),
      entry("mu", "t2", { type: "model_usage", purpose: "title", api: "x", provider: "relay", model: "tiny", usage: usage(10, 5, 0.0005), stopReason: "stop" }),
    ].flatMap((l) => parseOmp(l, ctx));
    const v = new View().apply(ops);
    expect(v.meta).toEqual({ model: "deepseek-v4", effort: "auto (medium)", mode: "plan", contextTokens: 30300, cost: 0.013 });
    expect(v.lines).toEqual(["user: hi", "text: hello", "notice: model: deepseek-v4"]);
    expect(ops.filter((o) => o.op === "meta").length).toBeLessThan(10); // only changes
  });

  test("images: blob references are read from omp's blob store; one that is not there is a placeholder", () => {
    const root = tmp();
    mkdirSync(join(root, "blobs"));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const hash = "a".repeat(64);
    writeFileSync(join(root, "blobs", hash), png);
    const prev = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    try {
      const v = run([
        entry("u1", null, { type: "message", message: { role: "user", content: [{ type: "text", text: "see" }, { type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" }, { type: "image", data: `blob:sha256:${"b".repeat(64)}`, mimeType: "image/png" }], timestamp: 1 } }),
        assistant("a1", "u1", [call("c1", "read", { path: "shot.png" })], { stopReason: "toolUse" }),
        entry("r1", "a1", { type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "Read image" }, { type: "image", data: png.toString("base64"), mimeType: "image/png" }], isError: false, timestamp: 1 } }),
      ]);
      expect(v.blocks[0]).toEqual({ kind: "user", text: "see\n[image]", images: [`data:image/png;base64,${png.toString("base64")}`] });
      expect(v.tools.get("c1")!.images).toEqual([`data:image/png;base64,${png.toString("base64")}`]);
    } finally {
      if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prev;
    }
  });

  test("never throws, whatever the line", () => {
    const ctx = { n: 0 };
    const odd = [null, 1, "x", [], {}, { type: "message" }, { type: "message", message: null }, { type: "message", message: { role: "assistant", content: "text?" } }, { type: "message", id: "q", parentId: "nope", message: { role: "toolResult" } }, { type: "custom_message", display: true, content: 5, details: [] }, { type: "compaction", tokensBefore: "many" }, { type: "custom", customType: "tool_execution_start", data: { toolCallId: 3 } }, { type: "message", message: { role: "assistant", content: [null, { type: "toolCall" }, { type: "thinking", thinking: 4 }], retryRecovery: "yes", stopReason: "error" } }];
    for (const l of odd) expect(() => parseOmpLine(l, ctx)).not.toThrow();
  });
});

describe("tools omp draws its own way", () => {
  test("edit: the per-file diffs omp records become one unified patch with line numbers", () => {
    const v = run([
      header,
      assistant("a1", null, [call("c1", "edit", { i: "Adding guarded division", input: "[calc.js#6F9B]\nPUT >7:\nexport function div\n[test.js#11AA]\nPUT >5:\nassert" })], { stopReason: "toolUse" }),
      result("r1", "a1", "c1", "edit", "[calc.js#4FAB]\n5:export function sub(a, b) {", {
        diff: " 5|export function sub(a, b) {\n…",
        perFileResults: [
          { path: "/work/proj/calc.js", diff: " 5|export function sub(a, b) {\n 6|  return a - b;\n 7|}\n+8|\n+9|export function div(a, b) {\n+10|  return a / b;\n+11|}", op: "update", oldText: "…", newText: "…" },
          { path: "/elsewhere/test.js", diff: " 4|assert.equal(add(2, 3), 5);\n+5|assert.equal(div(6, 3), 2);\n 5|console.log(\"ok\");\n\n 40|// end\n-41|old\n+42|new", op: "update" },
        ],
      }),
    ]);
    const t = v.tools.get("c1")!;
    expect(t.summary).toBe("2 files (+6 −1)");
    expect(t.files).toEqual(["calc.js", "test.js"]);
    expect(t.input).toBe("");
    expect(t.patch).toBe(
      [
        "--- a/calc.js",
        "+++ b/calc.js",
        "@@ -5,3 +5,7 @@",
        " export function sub(a, b) {",
        "   return a - b;",
        " }",
        "+",
        "+export function div(a, b) {",
        "+  return a / b;",
        "+}",
        "--- a/test.js",
        "+++ b/test.js",
        "@@ -4,2 +4,3 @@",
        " assert.equal(add(2, 3), 5);",
        "+assert.equal(div(6, 3), 2);",
        ' console.log("ok");',
        "@@ -40,2 +41,2 @@",
        " // end",
        "-old",
        "+new",
      ].join("\n"),
    );
  });

  test("edit: one file, a failed edit keeps its commands as the input", () => {
    const v = run([
      assistant("a1", null, [call("c1", "edit", { i: "Fixing add", input: "[add.js#63BB]\nSET 2:  return a + b;" }), call("c2", "edit", { i: "Again", input: "[add.js#0000]\nSET 2: x" })], { stopReason: "toolUse" }),
      result("r1", "a1", "c1", "edit", "[add.js#63BB]\n1:…", { diff: " 1|export function add(a, b) {\n-2|  return a - b;\n+2|  return a + b;\n 3|}", op: "update", path: "/work/proj/add.js" }),
      result("r2", "r1", "c2", "edit", "Hash mismatch", {}, true),
    ]);
    expect(v.tools.get("c1")).toMatchObject({ summary: "add.js (+1 −1)", files: ["add.js"], patch: "--- a/add.js\n+++ b/add.js\n@@ -1,3 +1,3 @@\n export function add(a, b) {\n-  return a - b;\n+  return a + b;\n }" });
    expect(v.tools.get("c2")).toMatchObject({ summary: "add.js — Again", input: "[add.js#0000]\nSET 2: x", error: true });
  });

  test("omp diff lines to hunks: gaps and jumps start a new hunk", () => {
    expect(unifiedFromOmp("+1|a\n+2|b").lines).toEqual(["@@ -1,0 +1,2 @@", "+a", "+b"]);
    // context lines carry the old line number (as omp writes them)
    expect(unifiedFromOmp(" 3|x\n-4|y\n 5|z\n...\n 20|p\n+20|q").lines).toEqual(["@@ -3,3 +3,2 @@", " x", "-y", " z", "@@ -20,1 +19,2 @@", " p", "+q"]);
    expect(unifiedFromOmp(" 1|a\n 9|b").lines).toEqual(["@@ -1,1 +1,1 @@", " a", "@@ -9,1 +9,1 @@", " b"]);
  });

  test("todo: a checklist from the arguments, then the list the result holds", () => {
    const v = run([
      assistant("a1", null, [call("c1", "todo", { i: "Tracking requested edits", op: "init", list: [{ phase: "Edits", items: ["Fix indent", "Cite SD"] }], items: [] })], { stopReason: "toolUse" }),
      assistant("a2", "a1", [call("c2", "todo", { i: "Clearing", op: "init", items: [], list: [] })], { stopReason: "toolUse" }),
    ]);
    expect(v.tools.get("c1")!.report).toBe("**Edits**\n\n- [ ] Fix indent\n- [ ] Cite SD");
    const ctx = { n: 0 };
    const after = new View().apply(
      [
        assistant("a1", null, [call("c1", "todo", { op: "done", task: "Fix indent" })], { stopReason: "toolUse" }),
        result("r1", "a1", "c1", "todo", "Remaining items (1)…", { op: "done", phases: [{ name: "Edits", tasks: [{ content: "Fix indent", status: "completed" }, { content: "Cite SD", status: "in_progress" }, { content: "Old idea", status: "abandoned" }] }, { name: "Sync", tasks: [{ content: "Push", status: "blocked", note: "no network" }] }], storage: "session" }),
        assistant("a2", "r1", [call("c2", "todo", { op: "init", items: ["x"] })], { stopReason: "toolUse" }),
        result("r2", "a2", "c2", "todo", "Todo list cleared.", { op: "init", phases: [], storage: "session" }),
      ].flatMap((l) => parseOmp(l, ctx)),
    );
    expect(after.tools.get("c1")).toMatchObject({ summary: "done Fix indent", report: "**Edits**\n\n- [x] Fix indent\n- [ ] **Cite SD**\n- [ ] ~~Old idea~~\n\n**Sync**\n\n- [ ] Push *(blocked: no network)*" });
    expect(after.tools.get("c2")!.report).toBe("");
    expect(v.tools.size).toBe(2);
  });

  test("eval: the code as a fenced block, the output from its cells", () => {
    const code = 'import re\nprint("a\\nb")';
    const v = run([
      assistant("a1", null, [call("c1", "eval", { language: "py", code, title: "Parse" })], { stopReason: "toolUse" }),
      result("r1", "a1", "c1", "eval", "", { language: "python", cells: [{ index: 0, title: "Parse", code, language: "python", output: "a\nb", status: "complete", exitCode: 0 }] }),
    ]);
    expect(v.tools.get("c1")).toMatchObject({ summary: "Parse", report: '```python\nimport re\nprint("a\\nb")\n```', output: "a\nb", done: true });
  });

  test("task: the subagent and its task, its report rendered; ask: the question and the answer", () => {
    const v = run([
      assistant("a1", null, [call("c1", "task", { agent: "scout", name: "Finder", task: "Find where the config is loaded" }), call("c2", "task", { context: "Shared notes", tasks: [{ agent: "reviewer", task: "Review a.ts" }, { name: "Tester", agent: "task", task: "Run tests" }] })], { stopReason: "toolUse" }),
      result("r1", "a1", "c1", "task", "done", { results: [{ index: 0, id: "1", agent: "scout", task: "Find…", exitCode: 0, output: "## Found\nIn `config.ts`.", durationMs: 9 }] }),
      result("r2", "r1", "c2", "task", "done", { results: [{ agent: "reviewer", output: "LGTM" }, { name: "Tester", agent: "task", output: "", error: "2 failed" }] }),
      assistant("a2", "r2", [call("c3", "ask", { questions: [{ id: "f", question: "Which format?", options: [{ label: "Markdown" }, { label: "LaTeX" }] }] })], { stopReason: "toolUse" }),
      result("r3", "a2", "c3", "ask", "User selected: Markdown", { question: "Which format?", options: ["Markdown", "LaTeX"], selectedOptions: ["Markdown"] }),
    ]);
    expect(v.tools.get("c1")).toMatchObject({ summary: "scout (Finder): Find where the config is loaded", report: "## Found\nIn `config.ts`." });
    expect(v.tools.get("c2")).toMatchObject({ summary: "2 subagents: reviewer, Tester", report: "### reviewer\n\nLGTM\n\n### Tester\n\n**Error:** 2 failed" });
    expect(v.tools.get("c3")).toMatchObject({ summary: "Which format?", input: "Which format?\n- Markdown\n- LaTeX", report: "**Which format?**\n→ Markdown" });
  });
});

describe("following and forking omp session files", () => {
  const line = (text: string, id: string, parentId: string | null) => JSON.stringify(entry(id, parentId, { type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: usage() } }));

  for (const [name, make] of [
    ["local files", () => new LocalFS()],
    [
      "files over SSH (shell commands)",
      () =>
        new SshFS(async (cmd) => {
          const p = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
          return { code: p.exitCode ?? -1, out: Buffer.from(p.stdout), err: p.stderr.toString() };
        }),
    ],
  ] as const) {
    test(`a rewrite of the same size or larger starts over; the title line changing in place does not — ${name}`, async () => {
      const root = tmp();
      const path = join(root, "s.jsonl");
      const slot = (title: string) => JSON.stringify({ ...titleSlot, title, pad: " ".repeat(200 - title.length) });
      const two = line("two", "e2", "e1");
      const body = [line("one", "e1", null), two, line("x".repeat(600), "e3", "e2")];
      writeFileSync(path, [slot(""), ...body].join("\n") + "\n");
      const t = new TranscriptTail({ agent: "omp", path, how: "session" }, make());
      expect((await t.read()).ops.filter((o) => o.op === "add")).toHaveLength(3);
      // omp updates the title in its fixed-width first line, then appends
      writeFileSync(path, readFileSync(path, "utf8").replace(slot(""), slot("Fix the tests")) + line("four", "e4", "e3") + "\n");
      let r = await t.read();
      expect(r.reset).toBe(false);
      expect(new View().apply(r.ops).lines).toEqual(["text: four"]);
      // rewritten as a whole the way omp does it (a new file renamed over the old one), to the same size
      const rewrite = (text: string) => {
        writeFileSync(`${path}.tmp`, text);
        renameSync(`${path}.tmp`, path);
      };
      rewrite(readFileSync(path, "utf8").replace("x".repeat(600), "y".repeat(600)));
      r = await t.read();
      expect(r.reset).toBe(true);
      expect(new View().apply(r.ops).lines).toEqual(["text: one", "text: two", `text: ${"y".repeat(600)}`, "text: four"]);
      // larger, even when written in place: what was read last is not where it was
      writeFileSync(path, readFileSync(path, "utf8").replace(two, two.replace('"two"', '"two, longer now"')) + line("five", "e5", "e4") + "\n");
      r = await t.read();
      expect(r.reset).toBe(true);
      expect(new View().apply(r.ops).lines).toEqual(["text: one", "text: two, longer now", `text: ${"y".repeat(600)}`, "text: four", "text: five"]);
      expect(await t.read()).toEqual({ ops: [], reset: false });
    });

    test(`fork from an entry: the copy ends on the fork point's parent even when another branch was written before it — ${name}`, async () => {
      const dir = tmp();
      const oldId = "01a19adc-3cae-7000-9310-8329217a306d";
      const src = join(dir, `2026-11-02T06-04-47-150Z_${oldId}.jsonl`);
      const lines = [
        JSON.stringify(titleSlot),
        JSON.stringify(header),
        JSON.stringify(user("u1", null, "first")),
        line("answer 1", "a1", "u1"),
        JSON.stringify(user("u2", "a1", "second")),
        line("answer 2 (left)", "a2", "u2"),
        JSON.stringify(user("u3", "a1", "second, asked again")),
        line("answer 3", "a3", "u3"),
        JSON.stringify(user("u4", "a3", "third")),
      ];
      const text = lines.join("\n") + "\n";
      writeFileSync(src, text);
      const source = { agent: "omp" as const, path: src, how: "session" as const };
      const at = (id: string) => text.lastIndexOf("\n", text.indexOf(`"id":"${id}"`)) + 1; // where its line starts
      const fs = make();
      // the UI forks from an entry's ref: the start of its line
      const view = new View().apply((await new TranscriptTail(source, new LocalFS()).read()).ops);
      const u3 = [...view.entries.values()].find((e) => e.block.kind === "user" && e.block.text === "second, asked again")!;
      expect(u3.ref).toBe(at("u3"));

      const plan = await prepareFork(fs, source, u3.ref, "22222222-2222-3333-4444-555555555555");
      const copy = readFileSync(plan.session!.path, "utf8");
      expect(copy.startsWith(text.slice(0, at("u3")).replaceAll(oldId, "22222222-2222-3333-4444-555555555555"))).toBe(true);
      const last = JSON.parse(copy.trimEnd().split("\n").at(-1)!);
      expect(last).toMatchObject({ type: "branch_summary", parentId: "a1", fromId: "a1", summary: "" });
      expect(last.id).toMatch(/^[0-9a-f]{8}$/);
      // what omp resumes: the path from the last entry back to the root
      const byId = new Map(copy.trimEnd().split("\n").map((l) => JSON.parse(l)).filter((e) => "parentId" in e).map((e) => [e.id, e]));
      const path: string[] = [];
      for (let e = last; e; e = byId.get(e.parentId)) path.unshift(e.id);
      expect(path).toEqual(["u1", "a1", last.id]);
      // and what agent-flow shows for the copy
      const shown = new View().apply((await new TranscriptTail({ ...source, path: plan.session!.path }, new LocalFS()).read()).ops);
      expect(shown.lines).toEqual(["user: first", "text: answer 1", "notice: branched here"]);

      // when the cut already ends on the parent, nothing is added
      const plain = await prepareFork(fs, source, at("u4"), "33333333-2222-3333-4444-555555555555");
      expect(readFileSync(plain.session!.path, "utf8")).toBe(text.slice(0, at("u4")).replaceAll(oldId, "33333333-2222-3333-4444-555555555555"));
    });
  }
});
