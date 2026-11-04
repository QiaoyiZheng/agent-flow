// Gemini CLI session files: synthetic lines shaped like the real ones (Gemini CLI 0.66), and finding a pane's file.
import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEntry, ChatMeta, ChatOp, HPane, ToolBlock } from "@af/core";
import { fileDiffToPatch, parseGemini, parseGeminiLine } from "../src/transcripts/parse/gemini.ts";
import { LocalFS, SshFS, type TranscriptFS, TranscriptTail, parseGeminiStart, resolveTranscript } from "../src/transcripts/index.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "af-gem-")));
  dirs.push(d);
  return d;
};

/** What the UI ends up showing after applying the ops. */
class View {
  entries = new Map<string, ChatEntry>();
  tools = new Map<string, ToolBlock>();
  meta: ChatMeta = {};
  adds = 0;
  apply(ops: ChatOp[]) {
    for (const op of ops) {
      if (op.op === "add") {
        this.adds++;
        const e = { ...op.entry, block: { ...op.entry.block } } as ChatEntry;
        expect(this.entries.has(e.key)).toBe(false);
        this.entries.set(e.key, e);
        if (e.block.kind === "tool") {
          expect([...this.entries.values()].filter((x) => x.block.kind === "tool" && x.block.id === (e.block as ToolBlock).id)).toHaveLength(1);
          this.tools.set(e.block.id, e.block);
        }
      } else if (op.op === "remove") op.keys.forEach((k) => this.entries.delete(k));
      else if (op.op === "result") {
        const t = this.tools.get(op.id);
        if (t) Object.assign(t, { output: op.output, error: op.error, ...(op.images ? { images: op.images } : {}), done: true });
      } else if (op.op === "update") Object.assign(this.tools.get(op.id) ?? {}, op.set);
      else if (op.op === "meta") Object.assign(this.meta, op.meta);
    }
    return this;
  }
  get blocks() {
    return [...this.entries.values()].map((e) => e.block);
  }
  /** One line per block: "user: hi", "tool Shell: ls", "notice(warn): …". */
  get lines() {
    return this.blocks.map((b) =>
      b.kind === "tool"
        ? `tool ${b.name}: ${b.summary}${b.error ? " [error]" : ""}${b.aborted ? " [aborted]" : ""}`
        : b.kind === "notice"
          ? `notice${b.tone ? `(${b.tone})` : ""}${b.divider ? "[divider]" : ""}: ${b.text}`
          : `${b.kind}: ${b.text}`,
    );
  }
}

const run = (lines: any[], ctx = { n: 0 }) => new View().apply(lines.flatMap((l) => parseGeminiLine(l, ctx)));

// ---- builders for records shaped like Gemini CLI's ----
let clock = Date.parse("2026-11-04T03:40:47.000Z");
const ts = () => new Date((clock += 1000)).toISOString();
const ENV_ID = "d04923d38bb0f6017037e74183378ef4";
const header = (id = "4aefe073-68f6-449b-b275-513718ade5a4") => ({ sessionId: id, projectHash: "e5f0", startTime: ts(), lastUpdated: ts(), kind: "main" });
const set = () => ({ $set: { lastUpdated: ts() } });
const env = () => ({ id: ENV_ID, timestamp: ts(), type: "user", content: [{ text: "<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat.\n</session_context>" }] });
const user = (id: string, text: string, extra: object = {}) => ({ id, timestamp: ts(), type: "user", content: [{ text }], ...extra });
const tokens = (input = 300, output = 20) => ({ input, output, cached: 0, thoughts: 0, tool: 0, total: input + output });
const gemini = (id: string, content: unknown, extra: object = {}) => ({ id, timestamp: ts(), type: "gemini", content, thoughts: [], tokens: tokens(), model: "gemini-3.8-flash", ...extra });
const response = (id: string, name: string, response: object) => ({ functionResponse: { id, name, response } });
const call = (name: string, n: number, args: object, rest: object = {}) => {
  const id = `${name}__${name}_17937636524${n}_0`;
  return { id, name, args, result: [response(id, name, { output: "ok" })], status: "success", timestamp: ts(), displayName: name, description: "", renderOutputAsMarkdown: true, ...rest };
};
const results = (id: string, calls: any[]) => ({ id, timestamp: ts(), type: "user", content: calls.map((c) => c.result[0]) });
const shellOut = (out: string, exit?: number) => `<untrusted_context>\nOutput: ${out}${exit !== undefined ? `\nExit Code: ${exit}` : ""}\nProcess Group PGID: 57415\n</untrusted_context>`;
const fileDiff = (name: string, hunk: string, isNewFile = false) => ({
  fileDiff: `Index: ${name}\n===================================================================\n--- ${name}\tCurrent\n+++ ${name}\tProposed\n${hunk}\n`,
  fileName: name,
  filePath: `/work/proj/${name}`,
  originalContent: "",
  newContent: "",
  diffStat: { model_added_lines: (hunk.match(/^\+/gm) ?? []).length, model_removed_lines: (hunk.match(/^-/gm) ?? []).length },
  isNewFile,
});

describe("messages, tools and the repeated copies of a message", () => {
  test("a turn with file writes, edits, shell commands and searches; each message once, however often it is written", () => {
    const write = call("write_file", 1, { file_path: "notes.md", content: "- apple\n- banana\n" }, { displayName: "WriteFile", resultDisplay: fileDiff("notes.md", "@@ -0,0 +1,2 @@\n+- apple\n+- banana", true) });
    const edit = call("replace", 2, { file_path: "notes.md", old_string: "- banana", new_string: "- mango", instruction: "rename" }, { displayName: "Edit", resultDisplay: fileDiff("notes.md", "@@ -1,2 +1,2 @@\n - apple\n-- banana\n+- mango") });
    const ls = call("run_shell_command", 3, { command: "ls -la", description: "List" }, { displayName: "Shell", description: "ls -la", resultDisplay: "total 16\nnotes.md" });
    ls.result = [response(ls.id, "run_shell_command", { output: shellOut("total 16\nnotes.md") })];
    const cat = call("run_shell_command", 4, { command: "cat missing.txt" }, { displayName: "Shell", resultDisplay: "cat: missing.txt: No such file or directory" });
    cat.result = [response(cat.id, "run_shell_command", { output: shellOut("cat: missing.txt: No such file or directory", 1) })];
    const glob = call("glob", 5, { pattern: "*.md" }, { displayName: "FindFiles", resultDisplay: "Found 1 matching file(s)" });
    const grep = call("grep_search", 6, { pattern: "mango", dir_path: "src" }, { displayName: "SearchText", resultDisplay: { summary: "Found 1 match", matches: [] } });
    const read = call("read_file", 7, { file_path: "seed.txt", start_line: 2, end_line: 9 }, { displayName: "ReadFile" });
    const all = [write, edit, ls, cat, glob, grep, read];
    const v = run([
      header(),
      env(),
      set(),
      user("u1", "Do the steps"),
      set(),
      gemini("g1", "I will do it."),
      set(),
      gemini("g1", "I will do it.", { toolCalls: all }),
      results("r1", all),
      set(),
      gemini("g2", "## Done\n\n| a | b |\n|---|---|\n| 1 | 2 |", { tokens: tokens(1200, 80) }),
      gemini("g2", "## Done\n\n| a | b |\n|---|---|\n| 1 | 2 |", { tokens: tokens(1200, 80) }),
    ]);
    expect(v.lines).toEqual([
      "user: Do the steps",
      "text: I will do it.",
      "tool WriteFile: notes.md (+2 −0)",
      "tool Edit: notes.md (+1 −1)",
      "tool Shell: ls -la",
      "tool Shell: cat missing.txt [error]",
      "tool FindFiles: *.md",
      "tool SearchText: mango in src",
      "tool ReadFile: seed.txt @2-9",
      "text: ## Done\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    ]);
    expect(v.tools.get(write.id)).toMatchObject({ patch: "--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+- apple\n+- banana", files: ["/work/proj/notes.md"], done: true });
    expect(v.tools.get(edit.id)!.patch).toBe("--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,2 @@\n - apple\n-- banana\n+- mango");
    expect(v.tools.get(edit.id)!.edit).toBeUndefined(); // the real diff, not before/after
    expect(v.tools.get(ls.id)!.output).toBe("total 16\nnotes.md"); // as shown, not the model's "Output: …" wrapping
    expect(v.tools.get(cat.id)).toMatchObject({ error: true, output: "cat: missing.txt: No such file or directory" });
    expect(v.meta).toEqual({ model: "gemini-3.8-flash", contextTokens: 1280, contextWindow: 1_048_576 });
  });

  test("the first copy without tool calls, the second with them; the model's topic as a notice; its result not shown", () => {
    const topic = call("update_topic", 1, { title: "Reading files", summary: "Starting.", strategic_intent: "Read first." }, { displayName: "Update Topic Context" });
    const ls = call("run_shell_command", 2, { command: "ls" }, { displayName: "Shell" });
    const ctx = { n: 0 };
    const first = run([user("u1", "go"), gemini("g1", "")], ctx);
    expect(first.lines).toEqual(["user: go"]);
    const ops = [gemini("g1", "", { toolCalls: [topic, ls] }), results("r1", [topic, ls])].flatMap((l) => parseGeminiLine(l, ctx));
    expect(ops.filter((o) => o.op === "remove")).toEqual([]);
    const v = first.apply(ops);
    expect(v.lines).toEqual(["user: go", "notice: Topic: Reading files", "tool Shell: ls"]);
    expect((v.blocks[1] as any).detail).toBe("Starting.\n\nRead first.");
  });

  test("a later copy that changes a tool call updates it; an identical one sends nothing", () => {
    const c = call("run_shell_command", 1, { command: "make" }, { displayName: "Shell", status: "error", resultDisplay: "make: *** no rule" });
    const ctx = { n: 0 };
    const v = run([gemini("g1", "", { toolCalls: [c] })], ctx);
    expect(parseGeminiLine(gemini("g1", "", { toolCalls: [c] }), ctx)).toEqual([]);
    const ops = parseGeminiLine(gemini("g1", "", { toolCalls: [{ ...c, status: "success", resultDisplay: "built" }] }), ctx);
    expect(ops).toEqual([{ op: "update", id: c.id, set: expect.objectContaining({ output: "built" }) }]);
  });

  test("thoughts are thinking; the shell's screen (styled tokens) is its output; '!' commands are tool calls", () => {
    const tok = (text: string) => ({ text, bold: false, italic: false, underline: false, dim: false, inverse: false, fg: "", bg: "" });
    const sh = call("run_shell_command", 1, { command: "echo hi" }, { displayName: "Shell", resultDisplay: [[tok("hi"), tok("        ")], [tok(" ")]] });
    const v = run([
      gemini("g1", "Here.", { thoughts: [{ subject: "Planning", description: "Look at the files first.", timestamp: ts() }, { subject: "", description: "Then answer." }] }),
      gemini("g2", "", { toolCalls: [sh] }),
      user("u2", "I ran the following shell command:\n```sh\ngit status\n```\n\nThis produced the following result:\n```\nOn branch main\n```"),
    ]);
    expect(v.lines).toEqual(["thinking: **Planning**\nLook at the files first.\n\nThen answer.", "text: Here.", "tool Shell: echo hi", "tool !: git status"]);
    expect(v.tools.get(sh.id)!.output).toBe("hi");
    expect(v.tools.get("sh-u2")!.output).toBe("On branch main");
  });

  test("other tools: summaries from their arguments, reports for subagents and todo lists", () => {
    const agent = call("invoke_agent", 1, { agent_name: "generalist", prompt: "Read a.txt" }, { displayName: "Invoke Subagent", resultDisplay: { isSubagentProgress: true, agentName: "generalist", recentActivity: [], state: "completed", result: "**hello**" } });
    const todos = call("write_todos", 2, { todos: [{ description: "plan", status: "completed" }, { description: "build", status: "in_progress" }] }, { displayName: "WriteTodos" });
    const fetch = call("web_fetch", 3, { prompt: "Summarize https://example.com/a and more" }, { displayName: "WebFetch" });
    const search = call("google_web_search", 4, { query: "bun test" }, { displayName: "GoogleSearch" });
    const many = call("read_many_files", 5, { include: ["src/**/*.ts", "README.md"] }, { displayName: "ReadManyFiles" });
    const bad = call("read_file", 6, {}, { displayName: "ReadFile", status: "error", description: "Reads and returns the content of a specified file.", resultDisplay: "params must have required property 'file_path'" });
    bad.result = [response(bad.id, "read_file", { error: "params must have required property 'file_path'" })];
    const mcp = call("srv__lookup", 7, { key: "x" }, { displayName: "lookup (srv MCP Server)", description: "lookup x" });
    const v = run([gemini("g1", "", { toolCalls: [agent, todos, fetch, search, many, bad, mcp] })]);
    expect(v.lines).toEqual([
      "tool Invoke Subagent: generalist: Read a.txt",
      "tool WriteTodos: build",
      "tool WebFetch: https://example.com/a",
      "tool GoogleSearch: bun test",
      "tool ReadManyFiles: src/**/*.ts, README.md",
      "tool ReadFile:  [error]", // the tool's documentation is no summary
      "tool lookup (srv MCP Server): lookup x",
    ]);
    expect(v.tools.get(agent.id)!.report).toBe("**hello**");
    expect(v.tools.get(todos.id)!.report).toBe("- [x] plan\n- [ ] **build**");
    expect(v.tools.get(bad.id)!.output).toBe("params must have required property 'file_path'");
  });

  test("images: pasted with @file (what was typed is shown), and read by a tool", () => {
    const png = Buffer.from("png-bytes").toString("base64");
    const read = call("read_file", 1, { file_path: "red.png" }, { displayName: "ReadFile", resultDisplay: "Read image file: red.png" });
    read.result = [response(read.id, "read_file", { output: "Binary content provided (1 item(s))." }), { inlineData: { data: png, mimeType: "image/png" } } as any];
    const v = run([
      user("u1", "What color is @red.png?", {
        content: [{ text: "What color is @red.png?" }, { text: "\n--- Content from referenced files ---" }, { inlineData: { data: png, mimeType: "image/png" } }, { text: "\n--- End of content ---" }],
        displayContent: [{ text: "What color is @red.png?" }],
      }),
      gemini("g1", "", { toolCalls: [read] }),
      { id: "r1", timestamp: ts(), type: "user", content: read.result },
    ]);
    expect(v.lines).toEqual(["user: What color is @red.png?", "tool ReadFile: red.png"]);
    expect((v.blocks[0] as any).images).toEqual([`data:image/png;base64,${png}`]);
    expect(v.tools.get(read.id)!.images).toEqual([`data:image/png;base64,${png}`]);
  });

  test("injected context is hidden; agent-flow's instructions are one line, and the model's 'ready' to them nothing", () => {
    const v = run([
      header(),
      env(),
      user("u1", "@worker.md These are your agent-flow instructions for this whole session. Reply only: ready", {
        content: [{ text: "@worker.md These are your agent-flow instructions for this whole session. Reply only: ready" }, { text: "\n--- Content from referenced files ---" }, { text: "\nContent from @worker.md:\n" }, { text: "# protocol\n..." }],
      }),
      gemini("g1", "ready"),
      gemini("g1", "ready"),
      user("u2", "- **Workspace Directories:**\n  - /work/proj\n- **Directory Structure:**\n"),
      user("u3", "[agent-flow] New message m3 from lead. Run: af inbox"),
      gemini("g2", "ready"),
    ]);
    expect(v.lines).toEqual(["notice: agent-flow instructions loaded", "notice: [agent-flow] New message m3 from lead. Run: af inbox", "text: ready"]);
  });

  test("notices: info, warning and error records; an interrupted reply; a lost tool response", () => {
    const c = call("run_shell_command", 1, { command: "sleep 99" }, { displayName: "Shell" });
    const v = run([
      { id: "i1", timestamp: ts(), type: "info", content: "Conversation checkpoint saved with tag: t." },
      { id: "w1", timestamp: ts(), type: "warning", content: "Potential loop detected" },
      { id: "e1", timestamp: ts(), type: "error", content: "[API Error: 429 Too Many Requests]\nretry later" },
      { id: "i2", timestamp: ts(), type: "info", content: "" },
      gemini("g1", "", { content: [{ functionCall: { id: c.id, name: "run_shell_command", args: { command: "sleep 99" } } }] }),
      { id: "r1", timestamp: ts(), type: "user", content: [response(c.id, "run_shell_command", { error: "Response was lost or interrupted." })] },
      gemini("g2", [{ text: "[The previous response was interrupted before it completed.]" }]),
      { id: "e2", timestamp: ts(), type: "error", content: `[API Error: ${JSON.stringify({ error: { message: JSON.stringify({ error: { message: "Invalid request parameter", type: "upstream_error" } }) } })}]` },
      user("n1", "[System: You successfully executed a tool but returned an empty response. Please analyze the tool output and explain your progress or final answer.]"),
    ]);
    expect(v.lines).toEqual([
      "notice: Conversation checkpoint saved with tag: t.",
      "notice(warn): Potential loop detected",
      "notice(error): [API Error: 429 Too Many Requests]",
      "tool Shell: sleep 99 [aborted]",
      "notice(warn): Interrupted",
      "notice(error): API Error: Invalid request parameter",
      "notice: Empty answer: Gemini CLI asked the model to go on",
    ]);
    expect((v.blocks[2] as any).detail).toBe("[API Error: 429 Too Many Requests]\nretry later");
    expect((v.blocks[5] as any).detail).toContain("upstream_error");
  });

  test("ask_user: the questions, and the answers as a report", () => {
    const ask = call("ask_user", 1, { questions: [{ header: "Format", question: "Which output format?", type: "choice", options: [{ label: "Markdown" }, { label: "LaTeX" }] }] }, { displayName: "Ask User", resultDisplay: "**User answered:**\n  Format: Which output format?\n    → Plain text" });
    const v = run([gemini("g1", "", { toolCalls: [ask] })]);
    expect(v.tools.get(ask.id)).toMatchObject({ summary: "Which output format?", input: "Which output format?\n- Markdown\n- LaTeX", report: "**User answered:**\n  Format: Which output format?\n    → Plain text" });
  });

  test("lines that are not records, or broken ones, are skipped", () => {
    const ctx = { n: 0 };
    for (const l of [null, 1, "x", [], {}, { id: 5 }, { $patch: null }, { $patch: { removeIds: "x", updates: [null, { id: 3 }] } }, { $rewindTo: 4 }, { $set: { messages: [null, 1] } }, { id: "a", type: "gemini", toolCalls: [null, { id: 1 }, {}] }])
      expect(() => parseGeminiLine(l, ctx)).not.toThrow();
    expect(parseGemini({ id: "x", type: "user", content: { get text(): string { throw new Error("boom"); } } }, ctx)).toEqual([]);
  });
});

describe("history written again: cancelled turns, rewinds, errors, compression, resume", () => {
  test("a declined tool call stays shown with the cancel notice, though Gemini drops both from its history", () => {
    const ok = call("run_shell_command", 1, { command: "touch a.txt" }, { displayName: "Shell" });
    const declined = call("run_shell_command", 2, { command: "touch b.txt" }, { displayName: "Shell", status: "cancelled", resultDisplay: null });
    declined.result = [response(declined.id, "run_shell_command", { error: "[Operation Cancelled] Reason: User denied execution." })];
    const v = run([
      user("u1", "touch a"),
      gemini("g1", "Creating it.", { toolCalls: [ok] }),
      results("r1", [ok]),
      gemini("g2", "TOKEN"),
      user("u2", "touch b"),
      gemini("g3", ""),
      gemini("g3", "", { toolCalls: [declined] }),
      { id: "c1", timestamp: ts(), type: "info", content: "Request cancelled." },
      set(),
      // the history synced: earlier messages written as parts, the declined turn and the notice "removed"
      { $patch: { updates: [{ id: "g1", content: [{ text: "Creating it." }, { functionCall: { name: "run_shell_command", args: { command: "touch a.txt" }, id: ok.id } }] }, { id: "g2", content: [{ text: "TOKEN" }] }], removeIds: ["g3", "c1"] } },
      set(),
    ]);
    expect(v.lines).toEqual(["user: touch a", "text: Creating it.", "tool Shell: touch a.txt", "text: TOKEN", "user: touch b", "tool Shell: touch b.txt [aborted]", "notice(warn): Request cancelled"]);
    expect(v.tools.get(declined.id)!.output).toBe("User denied execution.");
    expect(v.tools.get(ok.id)!.output).toBe("ok"); // the re-written copy without a result does not undo it
  });

  test("Esc takes the whole turn back ($rewindTo): it stays shown, and the notice says so", () => {
    const c = call("read_file", 1, { file_path: "a.txt" }, { displayName: "ReadFile" });
    const v = run([
      user("u1", "first"),
      gemini("g1", "one"),
      user("u2", "write an essay"),
      gemini("g2", "", { toolCalls: [c] }),
      results("r2", [c]),
      { id: "c1", timestamp: ts(), type: "info", content: "Request cancelled." },
      { $rewindTo: "u2" },
      set(),
      user("u3", "next"),
    ]);
    expect(v.lines).toEqual(["user: first", "text: one", "user: write an essay", "tool ReadFile: a.txt", "notice(warn): Request cancelled", "user: next"]);
    expect((v.blocks[4] as any).detail).toContain("taken back");
  });

  test("/rewind takes the turns out; a prompt that failed stays (the error comes after); one rewound to be edited goes", () => {
    const v = run([
      user("u1", "first"),
      gemini("g1", "one"),
      user("u2", "second"),
      gemini("g2", "two"),
      { $rewindTo: "u2" },
      set(),
      user("u3", "fails"),
      { $rewindTo: "u3" },
      set(),
      { id: "e1", timestamp: ts(), type: "error", content: "[API Error: quota]" },
      user("u4", "edit me"),
      { $rewindTo: "u4" },
      set(),
      user("u5", "edited"),
      gemini("g5", "ok"),
    ]);
    expect(v.lines).toEqual(["user: first", "text: one", "user: fails", "notice(error): [API Error: quota]", "user: edited", "text: ok"]);
  });

  test("compression: a divider with the summary; the old turns stay; the copies of the turns it keeps are not shown twice", () => {
    const c = call("read_file", 1, { file_path: "a.txt" }, { displayName: "ReadFile" });
    const before = [header(), env(), user("u1", "old question"), gemini("g1", "old answer"), user("u2", "read a"), gemini("g2", "", { toolCalls: [c] }), results("r2", [c]), gemini("g3", "it says ok")];
    const compression = [
      { $set: { sessionId: "4aefe073-68f6-449b-b275-513718ade5a4" } },
      user("s1", "<state_snapshot>\n<overall_goal>read a</overall_goal>\n</state_snapshot>"),
      gemini("s2", [{ text: "Got it. Thanks for the additional context!" }]),
      // the kept turns, copied with new ids (calls as functionCall parts, same call ids)
      user("k1", "read a"),
      gemini("k2", [{ functionCall: { id: c.id, name: "read_file", args: { file_path: "a.txt" } } }]),
      { id: "k3", timestamp: ts(), type: "user", content: [c.result[0]] },
      gemini("k4", [{ text: "it says ok" }]),
      { $patch: { updates: [{ id: ENV_ID, content: [{ text: "<session_context>\n</session_context>" }] }], removeIds: ["u1", "g1", "u2", "g2", "r2", "g3"] } },
      set(),
    ];
    const after = [user("u5", "and now?"), gemini("g5", "now this")];
    const v = run([...before, ...compression, ...after]);
    expect(v.lines).toEqual(["user: old question", "text: old answer", "user: read a", "tool ReadFile: a.txt", "text: it says ok", "notice[divider]: Context compressed", "user: and now?", "text: now this"]);
    expect((v.blocks[5] as any).detail).toContain("<overall_goal>read a</overall_goal>");
    // opened after the old turns (they are before the window): the kept turns are shown from their copies
    const w = run([...compression, ...after]);
    expect(w.lines).toEqual(["notice[divider]: Context compressed", "user: read a", "tool ReadFile: a.txt", "text: it says ok", "user: and now?", "text: now this"]);
    expect(w.tools.get(c.id)).toMatchObject({ output: "ok", done: true });
  });

  test("a resumed session: a divider where it goes on; notices Gemini drops from its history stay", () => {
    const v = run([
      header("fa9c7c4e-2be6-474b-80c2-93ba1367a07c"),
      env(),
      user("u1", "hi"),
      gemini("g1", "hello"),
      { id: "i1", timestamp: ts(), type: "info", content: "Conversation checkpoint saved with tag: t." },
      set(),
      { $set: { sessionId: "fa9c7c4e-2be6-474b-80c2-93ba1367a07c" } },
      { $patch: { updates: [{ id: ENV_ID, content: [{ text: "<session_context>\n</session_context>" }] }, { id: "g1", content: [{ text: "hello" }] }], removeIds: ["i1"] } },
      set(),
      user("u2", "again"),
      gemini("g2", "yes"),
    ]);
    expect(v.lines).toEqual(["user: hi", "text: hello", "notice: Conversation checkpoint saved with tag: t.", "notice[divider]: Session resumed", "user: again", "text: yes"]);
  });

  test("another history put in place (/chat resume <tag>): the turns it replaces go, notices stay", () => {
    const v = run([user("u1", "a"), gemini("g1", "b"), { id: "i1", timestamp: ts(), type: "info", content: "saved" }, user("n1", "tagged q"), gemini("n2", [{ text: "tagged a" }]), { $patch: { removeIds: ["u1", "g1", "i1"] } }]);
    expect(v.lines).toEqual(["notice: saved", "user: tagged q", "text: tagged a"]);
  });

  test("a tail of the file: appended copies update what is shown, nothing twice", async () => {
    const root = tmp();
    const path = join(root, "session-2026-11-04T03-40-4aefe073.jsonl");
    const c = call("run_shell_command", 1, { command: "ls" }, { displayName: "Shell" });
    writeFileSync(path, [header(), env(), user("u1", "list"), gemini("g1", "Listing.")].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const t = new TranscriptTail({ agent: "gemini", path, how: "session" }, new LocalFS());
    const v = new View().apply((await t.read()).ops);
    expect(v.lines).toEqual(["user: list", "text: Listing."]);
    appendFileSync(path, [set(), gemini("g1", "Listing.", { toolCalls: [c] }), results("r1", [c]), set(), gemini("g2", "Done.")].map((l) => JSON.stringify(l)).join("\n") + "\n");
    v.apply((await t.read()).ops);
    expect(v.lines).toEqual(["user: list", "text: Listing.", "tool Shell: ls", "text: Done."]);
    expect(v.adds).toBe(4);
  });

  test("Gemini CLI's diff as a unified diff", () => {
    expect(fileDiffToPatch("Index: a.js\n===\n--- a.js\tOriginal\n+++ a.js\tWritten\n@@ -1 +1 @@\n-x\n+y\n\\ No newline at end of file\n", "a.js")).toBe("--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-x\n+y");
    expect(fileDiffToPatch("Index: a.js\n", "a.js")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Finding a gemini pane's session file.

describe("finding a gemini pane's session", () => {
  const pane = (over: Partial<HPane>): HPane => ({ machine: "local", id: "w1:p1", tabId: "w1:t1", workspaceId: "w1", agentStatus: "idle", cwd: "/proj", agent: "gemini", ...over });
  const none = async () => [] as string[][];

  /** A fake home with Gemini CLI's project registry and session files for /proj. */
  function home() {
    const root = tmp();
    const g = join(root, ".gemini");
    mkdirSync(join(g, "tmp/proj/chats"), { recursive: true });
    mkdirSync(join(g, "tmp/other/chats"), { recursive: true });
    writeFileSync(join(g, "projects.json"), JSON.stringify({ projects: { "/proj": "proj", "/other": "other" } }, null, 2));
    writeFileSync(join(g, "tmp/proj/.project_root"), "/proj");
    writeFileSync(join(g, "tmp/other/.project_root"), "/other");
    return { root, chats: join(g, "tmp/proj/chats") };
  }
  /** A session file whose session started `ago` ms ago and was last written `written` ms ago. */
  const session = (chats: string, id: string, ago: number, written: number, lines: object[] = []) => {
    const start = new Date(Date.now() - ago);
    const path = join(chats, `session-${start.toISOString().slice(0, 16).replace(/:/g, "-")}-${id.slice(0, 8)}.jsonl`);
    writeFileSync(path, [{ sessionId: id, projectHash: "x", startTime: start.toISOString(), lastUpdated: start.toISOString(), kind: "main" }, env(), ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const t = new Date(Date.now() - written);
    utimesSync(path, t, t);
    return path;
  };
  /** A running process that looks like gemini to ps (its command is …/gemini). */
  const fakeGemini = (root: string) => {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gemini"), "#!/bin/sh\nsleep 30\n");
    chmodSync(join(bin, "gemini"), 0o755);
    return Bun.spawn(["sh", join(bin, "gemini")], { stdout: "ignore", stderr: "ignore" });
  };
  const shellFs = (root: string) =>
    new SshFS(async (cmd) => {
      const { GEMINI_CLI_HOME: _g, ...env } = process.env;
      const p = Bun.spawnSync(["sh", "-c", cmd], { env: { ...env, HOME: root }, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode ?? -1, out: Buffer.from(p.stdout), err: p.stderr.toString() };
    });

  test("ps's answer: the youngest gemini process, not a command that only mentions gemini", () => {
    const out = "  101 1-02:03:04 node /opt/lib/gemini-cli/bundle/gemini.js --yolo\n  102     00:05 /usr/local/bin/gemini\n  103     00:01 bash -c ls ~/.gemini\n#now 1793764000\n";
    expect(parseGeminiStart(out)).toBe((1793764000 - 5) * 1000);
    expect(parseGeminiStart("  103 00:01 bash -c ls ~/.gemini\n#now 1793764000\n")).toBeUndefined();
    expect(parseGeminiStart("")).toBeUndefined();
  });

  for (const [name, make] of [
    ["local files", (root: string) => new LocalFS({ claude: join(root, ".claude/projects"), codex: join(root, ".codex/sessions"), gemini: join(root, ".gemini") }) as TranscriptFS],
    ["files over SSH (shell commands)", shellFs],
  ] as const) {
    test(`by id, and by folder when the process cannot be asked — ${name}`, async () => {
      const { root, chats } = home();
      const fs = make(root);
      const old = session(chats, "aaaaaaaa-1111-2222-3333-444444444444", 7200_000, 3600_000, [user("u1", "the old one")]);
      const newer = session(chats, "bbbbbbbb-1111-2222-3333-444444444444", 600_000, 60_000, [user("u1", "explain the Cauchy-Schwarz inequality please"), gemini("g1", "It bounds an inner product by the product of the norms.")]);
      session(join(root, ".gemini/tmp/other/chats"), "cccccccc-1111-2222-3333-444444444444", 60_000, 1000);
      const g = pane({});
      expect(await fs.geminiById("aaaaaaaa-1111-2222-3333-444444444444")).toBe(old);
      expect(await fs.geminiById("aaaaaaaa-0000-0000-0000-000000000000")).toBeUndefined(); // same first 8, another session
      expect((await fs.geminiForFolder("/proj", 5)).map((c) => c.path)).toEqual([newer, old]);
      expect(await resolveTranscript(fs, { pane: g, panes: [g], knownSession: "aaaaaaaa-1111-2222-3333-444444444444", argv: none })).toEqual({ source: { agent: "gemini", path: old, how: "session" } });
      expect(await resolveTranscript(fs, { pane: g, panes: [g], argv: none })).toEqual({ source: { agent: "gemini", path: newer, how: "folder" } });
      // a session id agent-flow knows but gemini never wrote does not lock the pane
      expect(await resolveTranscript(fs, { pane: g, panes: [g], knownSession: "dddddddd-1111-2222-3333-444444444444", argv: none })).toMatchObject({ source: { path: newer } });
      const twin = pane({ id: "w1:p2" });
      expect(await resolveTranscript(fs, { pane: g, panes: [g, twin], argv: none })).toMatchObject({ reason: expect.stringContaining("2 gemini agents") });
      const screen = async () => " > explain the Cauchy-Schwarz inequality please\n\n✦ It bounds an inner product by the product of the norms.\n";
      expect(await resolveTranscript(fs, { pane: g, panes: [g, twin], argv: none, screen })).toEqual({ source: { agent: "gemini", path: newer, how: "screen" } });
      expect(await resolveTranscript(fs, { pane: pane({ cwd: "/nowhere" }), panes: [], argv: none })).toEqual({ reason: "no gemini session for this folder yet" });
    });

    test(`the running process: the newest session written since it started; nothing yet means its file is coming — ${name}`, async () => {
      const { root, chats } = home();
      const fs = make(root);
      const proc = fakeGemini(root);
      try {
        await Bun.sleep(300);
        expect(await fs.geminiStartOfPids([proc.pid])).toBeGreaterThan(Date.now() - 10_000);
        const g = pane({});
        const pids = async () => [proc.pid];
        // only sessions from before it started: it is starting, its file comes in a moment (not the old one)
        const old = session(chats, "aaaaaaaa-1111-2222-3333-444444444444", 7200_000, 3600_000);
        expect(await resolveTranscript(fs, { pane: g, panes: [g], argv: none, pids })).toEqual({ source: { agent: "gemini", path: "", how: "session", pending: true } });
        // a session agent-flow was told of, last written before this process started (gemini restarted): not it
        expect(await resolveTranscript(fs, { pane: g, panes: [g], argv: none, pids, knownPath: old })).toMatchObject({ source: { pending: true } });
        // its file, written at startup
        const mine = session(chats, "bbbbbbbb-1111-2222-3333-444444444444", 0, 0);
        expect(await resolveTranscript(fs, { pane: g, panes: [g], argv: none, pids })).toEqual({ source: { agent: "gemini", path: mine, how: "session" } });
        // another gemini in the folder appends to its older session: this process's own session is still known
        const twin = pane({ id: "w1:p2" });
        const theirs = session(chats, "cccccccc-1111-2222-3333-444444444444", 3600_000, 0);
        expect(await resolveTranscript(fs, { pane: g, panes: [g, twin], argv: none, pids })).toEqual({ source: { agent: "gemini", path: mine, how: "session" } });
        // alone in the folder, the last written since it started is the one shown (it resumed `theirs`)
        expect(await resolveTranscript(fs, { pane: g, panes: [g], argv: none, pids })).toMatchObject({ source: { how: "session" } });
        // two sessions started since (another agent started too, or /clear): the screen decides
        const late = session(chats, "eeeeeeee-1111-2222-3333-444444444444", 0, 0, [user("u1", "summarize the build log for me"), gemini("g1", "The build failed in the linker step.")]);
        expect(await resolveTranscript(fs, { pane: g, panes: [g, twin], argv: none, pids })).toMatchObject({ reason: expect.stringContaining("2 gemini agents") });
        const screen = async () => " > summarize the build log for me\n✦ The build failed in the linker step.\n";
        expect(await resolveTranscript(fs, { pane: g, panes: [g, twin], argv: none, pids, screen })).toEqual({ source: { agent: "gemini", path: late, how: "screen" } });
        void theirs;
      } finally {
        proc.kill();
      }
    });
  }
});
