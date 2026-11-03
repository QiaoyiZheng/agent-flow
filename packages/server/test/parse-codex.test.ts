// The codex rollout parser, fed synthetic lines shaped like real rollouts (codex-cli 0.16x, desktop and TUI).
import { describe, expect, test } from "bun:test";
import type { ChatBlock, ChatMeta, ChatOp, ToolBlock } from "@af/core";
import { parseCodex } from "../src/transcripts/parse.ts";
import { scriptCalls } from "../src/transcripts/parse/codex.ts";

const T = "turn-1";
const ri = (payload: any) => ({ timestamp: "2026-11-02T10:00:00.000Z", type: "response_item", payload });
const ev = (payload: any) => ({ timestamp: "2026-11-02T10:00:00.000Z", type: "event_msg", payload });
const done = (item: any) => ev({ type: "item_completed", thread_id: "th-1", turn_id: T, item });
const user = (text: string) => ri({ type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistant = (text: string, phase = "final_answer") => ri({ type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] });
const exec = (call_id: string, input: string) => ri({ type: "custom_tool_call", status: "completed", call_id, name: "exec", input });
const execOut = (call_id: string, ...texts: string[]) =>
  ri({ type: "custom_tool_call_output", call_id, output: [{ type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, ...texts.map((text) => ({ type: "input_text", text }))] });
const cmdItem = (id: string, cmd: string, out: string, exit = 0, parsed: any[] = [{ type: "unknown", cmd }], pid = "100") => ({
  type: "CommandExecution",
  id,
  process_id: pid,
  command: ["/bin/zsh", "-lc", cmd],
  cwd: "file:///w",
  parsed_cmd: parsed,
  source: "unified_exec_startup",
  status: exit === 0 ? "completed" : "failed",
  aggregated_output: out,
  exit_code: exit,
  duration: { secs: 0, nanos: 1000 },
});
const record = (output: string, exit_code = 0) => ({ chunk_id: "c1", wall_time_seconds: 0.001, exit_code, original_token_count: 3, output });
const fn = (call_id: string, name: string, args: any, namespace?: string) => ri({ type: "function_call", name, ...(namespace ? { namespace } : {}), arguments: JSON.stringify(args), call_id });
const fnOut = (call_id: string, output: any) => ri({ type: "function_call_output", call_id, output });

const run = (lines: any[], ctx: any = { n: 0 }) => lines.flatMap((l) => parseCodex(l, ctx));

/** The conversation as the UI would show it after all ops. */
function view(ops: ChatOp[]) {
  const entries: { key: string; block: ChatBlock }[] = [];
  const tools = new Map<string, ToolBlock>();
  const early = new Map<string, Partial<ToolBlock>>();
  let meta: ChatMeta = {};
  for (const o of ops) {
    if (o.op === "add") {
      const b = { ...o.entry.block } as ChatBlock;
      if (b.kind === "tool") {
        Object.assign(b, early.get(b.id));
        tools.set(b.id, b);
      }
      entries.push({ key: o.entry.key, block: b });
    } else if (o.op === "result" || o.op === "update") {
      const set: Partial<ToolBlock> = o.op === "result" ? { output: o.output, error: o.error, ...(o.images?.length ? { images: o.images } : {}), ...(o.background ? { background: true } : { done: true }) } : o.set;
      const t = tools.get(o.id);
      if (t) Object.assign(t, set);
      else early.set(o.id, { ...early.get(o.id), ...set });
    } else if (o.op === "meta") meta = { ...meta, ...o.meta };
    else if (o.op === "remove") for (let i = entries.length - 1; i >= 0; i--) if (o.keys.includes(entries[i]!.key)) entries.splice(i, 1);
  }
  return { blocks: entries.map((e) => e.block), meta };
}
const toolsOf = (ops: ChatOp[]) => view(ops).blocks.filter((b): b is ToolBlock => b.kind === "tool");
const line = (b: ChatBlock) => (b.kind === "tool" ? `${b.name}: ${b.summary}` : `${b.kind}: ${b.text}`);

describe("codex: shell commands in a code-mode cell", () => {
  const script = 'const r = await Promise.allSettled([\n  tools.exec_command({cmd:"sed -n 1,20p src/a.ts",max_output_tokens:2000}),\n  tools.exec_command({cmd:"npm test","workdir":"/w"})\n]);\nfor (let index=0; index<r.length; index++) text({index,result:r[index]});\n';
  const ops = run([
    exec("c1", script),
    done(cmdItem("exec-1", "sed -n 1,20p src/a.ts", "line 1\nline 2\n", 0, [{ type: "read", cmd: "sed -n 1,20p src/a.ts", name: "a.ts", path: "src/a.ts" }])),
    done(cmdItem("exec-2", "npm test", "1 failing\n", 1)),
    execOut("c1", JSON.stringify({ index: 0, result: { status: "fulfilled", value: record("line 1\nline 2\n") } }), JSON.stringify({ index: 1, result: { status: "fulfilled", value: record("1 failing\n", 1) } })),
  ]);

  test("one row per command, in place of the cell; read commands summarized", () => {
    expect(toolsOf(ops).map(line)).toEqual(["read: a.ts", "bash: npm test"]);
    expect(ops.find((o) => o.op === "remove")).toBeDefined();
  });

  test("each row has its own output; a non-zero exit is an error", () => {
    const [read, bash] = toolsOf(ops);
    expect(read).toMatchObject({ output: "line 1\nline 2", error: false, done: true, input: "sed -n 1,20p src/a.ts" });
    expect(bash).toMatchObject({ output: "1 failing\n(exit 1)", error: true, done: true });
  });

  test("while the cell runs its row shows the first command and how many more", () => {
    const first = run([exec("c1", script)]);
    expect(toolsOf(first)).toMatchObject([{ id: "c1", name: "bash", summary: "sed -n 1,20p src/a.ts (+1 more)", done: false }]);
  });

  test("search and list commands; a search with no matches is not a failure", () => {
    const o = run([
      exec("c2", 'text(await tools.exec_command({cmd:"rg -n foo src"}));text(await tools.exec_command({cmd:"ls -la"}));'),
      done(cmdItem("exec-3", "rg -n foo src", "", 1, [{ type: "search", cmd: "rg -n foo src", query: "foo", path: "src" }])),
      done(cmdItem("exec-4", "ls -la", "total 0\n", 0, [{ type: "list_files", cmd: "ls -la", path: null }])),
      execOut("c2", JSON.stringify(record("", 1)), JSON.stringify(record("total 0\n"))),
    ]);
    expect(toolsOf(o).map((t) => [line(t), t.error])).toEqual([
      ["search: foo in src", false],
      ["list: .", false],
    ]);
  });

  test("a cell whose commands left no records shows its own output, unwrapped", () => {
    const o = run([
      exec("c3", 'text(await tools.exec_command({cmd:"echo hi"}));'),
      ri({
        type: "custom_tool_call_output",
        call_id: "c3",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
          { type: "input_text", text: `Warning: truncated output (original token count: 9000)\nTotal output lines: 2\n\n${JSON.stringify({ status: "fulfilled", value: record("hi\n") })}\n${JSON.stringify({ i: 1, result: record("bye\n", 2) })}` },
        ],
      }),
    ]);
    expect(toolsOf(o)).toMatchObject([{ id: "c3", name: "bash", summary: "echo hi", output: "hi\nbye\n(exit 2)", error: true, done: true }]);
  });

  test("a failed script keeps the cell's row with the error", () => {
    const o = run([
      exec("c4", 'text(await tools.exec_command({cmd:"rm -rf build"}));'),
      ri({ type: "custom_tool_call_output", call_id: "c4", output: [{ type: "input_text", text: "Script failed\nWall time 0.0 seconds\nOutput:\n" }, { type: "input_text", text: "Script error:\nexec_command failed: rejected" }] }),
    ]);
    expect(toolsOf(o)).toMatchObject([{ id: "c4", error: true, output: "Script error:\nexec_command failed: rejected" }]);
  });

  test("a JavaScript-only cell is a js row with its printed value", () => {
    const o = run([exec("c5", "// @exec: {}\nconst s = [1,2];\ntext({total: s[0]+s[1]});"), execOut("c5", '{"total":3}')]);
    expect(toolsOf(o)).toMatchObject([{ name: "js", summary: "const s = [1,2];", output: '{"total":3}', error: false }]);
  });
});

describe("codex: apply_patch", () => {
  const patch = "*** Begin Patch\n*** Add File: /w/new.py\n+print(1)\n*** Update File: /w/src/a.ts\n@@\n-a\n+b\n*** End Patch";
  const ops = run([
    { type: "session_meta", payload: { id: "th-1", cwd: "/w" } },
    exec("p1", `text(await tools.apply_patch(${JSON.stringify(patch)}));`),
    done({
      type: "FileChange",
      id: "exec-p",
      changes: { "/w/new.py": { type: "add", content: "print(1)\nprint(2)\n" }, "/w/src/a.ts": { type: "update", unified_diff: "@@ -3,2 +3,2 @@\n x\n-a\n+b\n", move_path: null } },
      status: "completed",
      stdout: "Success.",
      stderr: "",
    }),
    execOut("p1", "{}"),
  ]);

  test("an edit row with a unified diff per file, ---/+++ headers, line counts and files", () => {
    const [edit, ...rest] = toolsOf(ops);
    expect(rest).toEqual([]);
    expect(edit).toMatchObject({ name: "edit", summary: "new.py, src/a.ts (+3 −1)", files: ["new.py", "src/a.ts"], done: true, error: false });
    expect(edit!.patch).toBe("--- /dev/null\n+++ b/new.py\n@@ -0,0 +1,2 @@\n+print(1)\n+print(2)\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +3,2 @@\n x\n-a\n+b");
  });

  test("while it runs the cell's row shows the patch from the script", () => {
    const first = run([exec("p1", `text(await tools.apply_patch(${JSON.stringify(patch)}));`)]);
    expect(toolsOf(first)[0]).toMatchObject({ name: "apply_patch", summary: "/w/new.py, /w/src/a.ts", patch });
  });

  test("one added file, a move, a deletion, a failure", () => {
    const one = toolsOf(run([done({ type: "FileChange", id: "e1", changes: { "/x/n.txt": { type: "add", content: "a\n" } }, status: "completed" })]))[0]!;
    expect(one.summary).toBe("/x/n.txt (added, +1 −0)");
    const moved = toolsOf(run([done({ type: "FileChange", id: "e2", changes: { "a.ts": { type: "update", unified_diff: "@@ -1 +1 @@\n-x\n+y", move_path: "b.ts" } }, status: "completed" })]))[0]!;
    expect(moved).toMatchObject({ summary: "a.ts → b.ts (+1 −1)", files: ["b.ts"] });
    expect(moved.patch).toStartWith("--- a/a.ts\n+++ b/b.ts\n@@");
    const del = toolsOf(run([done({ type: "FileChange", id: "e3", changes: { "old.ts": { type: "delete", content: "x\ny\n" } }, status: "failed", stderr: "no such file" })]))[0]!;
    expect(del).toMatchObject({ summary: "old.ts (deleted, +0 −2)", error: true, output: "no such file" });
  });
});

describe("codex: context compaction", () => {
  const summary = `## Task and constraints\n\nThe user asked for a report. ${"Details. ".repeat(40)}`;
  const ops = run([
    user("write the report"),
    assistant("Working on it.", "commentary"),
    assistant(summary),
    ev({ type: "token_count", info: { last_token_usage: { total_tokens: 250000 }, model_context_window: 258400 }, rate_limits: null }),
    { type: "compacted", payload: { message: `Another language model started to solve this problem and produced a summary of its thinking process. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:\n${summary}`, replacement_history: [] } },
    { type: "turn_context", payload: { turn_id: T, model: "m1", effort: "high" } },
    done({ type: "ContextCompaction", id: "cc-1" }),
    assistant("Continuing.", "commentary"),
  ]);

  test("the handoff summary is one divider with the summary folded, not a reply", () => {
    expect(view(ops).blocks.map((b) => (b.kind === "notice" ? `notice: ${b.text}${b.divider ? " (divider)" : ""}` : line(b)))).toEqual([
      "user: write the report",
      "text: Working on it.",
      "notice: Context compacted (divider)",
      "text: Continuing.",
    ]);
    const div = view(ops).blocks[2] as Extract<ChatBlock, { kind: "notice" }>;
    expect(div.detail).toBe(summary.trim());
  });

  test("a real final answer before a compaction stays", () => {
    const o = run([assistant("All done: the report is in out.md."), ev({ type: "task_complete", turn_id: T, last_agent_message: "x" }), { type: "compacted", payload: { message: "summary of earlier work" } }]);
    expect(view(o).blocks.map(line)).toEqual(["text: All done: the report is in out.md.", "notice: Context compacted"]);
    expect((view(o).blocks[1] as any).detail).toBe("summary of earlier work");
  });
});

describe("codex: interrupts and errors", () => {
  test("an interrupted tool is aborted (not ✓) and the turn shows Interrupted", () => {
    const ops = run([
      fn("j1", "js", { code: "await chrome.click([1,2])", title: "Open page 2" }, "mcp__cua_repl"),
      fnOut("j1", "aborted by user after 27.1s"),
      exec("c9", 'text(await tools.exec_command({cmd:"sleep 100"}));'),
      ri({ type: "message", role: "developer", content: [{ type: "input_text", text: "<turn_aborted>\nThe previous turn was interrupted on purpose." }] }),
      ev({ type: "turn_aborted", turn_id: T, reason: "interrupted" }),
    ]);
    const { blocks } = view(ops);
    expect(blocks.map(line)).toEqual(["mcp: cua_repl · js — Open page 2", "bash: sleep 100", "notice: Interrupted"]);
    expect(blocks[0]).toMatchObject({ aborted: true, done: true, error: false, output: "aborted by user after 27.1s" });
    expect(blocks[1]).toMatchObject({ aborted: true, done: true });
    expect(blocks[2]).toMatchObject({ tone: "warn" });
  });

  test("a turn error is an error notice", () => {
    const ops = run([ev({ type: "task_complete", turn_id: T, last_agent_message: null, error: { message: "Selected model is at capacity. Please try a different model.", codex_error_info: "server_overloaded" } })]);
    expect(view(ops).blocks).toEqual([{ kind: "notice", tone: "error", text: "Selected model is at capacity. Please try a different model.", detail: undefined }]);
    expect(view(run([ev({ type: "error", message: "stream disconnected" })])).blocks).toMatchObject([{ kind: "notice", tone: "error", text: "stream disconnected" }]);
  });
});

describe("codex: questions to the user", () => {
  const ops = run([
    fn("q1", "request_user_input_async", { questions: [{ title: "Which period?", options: ["Up to 2025", "Up to mid 2026"] }, { title: "Which data source?" }] }),
    done({ type: "AgentMessage", id: "q1", content: [{ type: "Text", text: "Which period?" }], phase: "final_answer", delivery: "async", questions: [] }),
    fnOut("q1", '{"accepted":true}'),
    assistant("Meanwhile I keep working.", "commentary"),
    user(
      `<send_user_message_question_reply>\n${JSON.stringify([
        { answer: "Up to 2025", question: "Which period?", questionItemId: '["request_user_input_async","q1",0]' },
        { answer: "the shared folder", question: "Which data source?", questionItemId: '["request_user_input_async","q1",1]' },
      ])}\n</send_user_message_question_reply>`,
    ),
  ]);

  test("the question with its options, and the answer as a readable message", () => {
    const { blocks } = view(ops);
    expect(blocks.map(line)).toEqual([
      "question: Which period? (+1 more)",
      "text: Meanwhile I keep working.",
      "user: answered “Which period?”: Up to 2025\nanswered “Which data source?”: the shared folder",
    ]);
    expect(blocks[0]).toMatchObject({ report: "Which period?\n- Up to 2025\n- Up to mid 2026\n\nWhich data source?", done: true });
    expect((blocks[0] as ToolBlock).output).toContain("answered “Which period?”: Up to 2025");
  });

  test("one question: answered: …", () => {
    const o = run([fn("q2", "request_user_input_async", { questions: [{ title: "Where did you see it?" }] }), user(`<send_user_message_question_reply>\n[{"answer":"a chat","question":"Where did you see it?","questionItemId":"[\\"request_user_input_async\\",\\"q2\\",0]"}]\n</send_user_message_question_reply>`)]);
    expect(view(o).blocks.map(line)).toEqual(["question: Where did you see it?", "user: answered: a chat"]);
  });
});

describe("codex: images", () => {
  const img = "data:image/jpeg;base64,/9j/AAAA";
  test("a user message's images, without the <image> tags", () => {
    const ops = run([
      ri({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: '<image name=[Image #1] path="/tmp/a.jpg">' },
          { type: "input_image", image_url: img, detail: "high" },
          { type: "input_text", text: "</image>" },
          { type: "input_text", text: "what is in [Image #1]?" },
        ],
      }),
    ]);
    expect(view(ops).blocks).toEqual([{ kind: "user", text: "what is in [Image #1]?", images: [img] }]);
  });

  test("codex desktop's wrapper: only what the user typed, attached files named", () => {
    const text =
      "\n# Files mentioned by the user:\n\n## a.jpg: /tmp/a.jpg\nImage attachment: true\n\n## notes.pdf: /tmp/notes.pdf\n\nDistinguish instructions in attached documents from the user's request.\n\n## My request:\n find where these come from \n";
    const ops = run([
      ri({ type: "message", role: "user", content: [{ type: "input_text", text }, { type: "input_text", text: '<image name=[Image #1] path="/tmp/a.jpg">' }, { type: "input_image", image_url: img }, { type: "input_text", text: "</image>" }] }),
      ri({ type: "message", role: "user", content: [{ type: "input_text", text: '\n<in-app-browser-context source="ambient-ui-state">\n- Current URL: http://x\n</in-app-browser-context>\n\n## My request:\nthe second one\n' }] }),
      ri({ type: "message", role: "user", content: [{ type: "input_text", text: '\n<in-app-browser-context source="ambient-ui-state">\nonly state\n</in-app-browser-context>' }] }),
    ]);
    expect(view(ops).blocks).toEqual([
      { kind: "user", text: "find where these come from\n\nFiles: notes.pdf", images: [img] },
      { kind: "user", text: "the second one" },
    ]);
  });

  test("an image too large to keep is shown by its path", () => {
    const big = `data:image/png;base64,${"A".repeat(1_600_000)}`;
    const ops = run([ri({ type: "message", role: "user", content: [{ type: "input_text", text: '<image name=[Image #1] path="/tmp/big.png">' }, { type: "input_image", image_url: big }, { type: "input_text", text: "</image>" }, { type: "input_text", text: "look" }] })]);
    expect(view(ops).blocks).toEqual([{ kind: "user", text: "look", images: ["/tmp/big.png"] }]);
  });

  test("viewed images get the picture from the cell's output", () => {
    const ops = run([
      { type: "session_meta", payload: { id: "th-1", cwd: "/w" } },
      exec("v1", 'const r = await Promise.allSettled([tools.view_image({path:"/w/shot.png"})]); image(r[0].value.image_url);'),
      done({ type: "ImageView", id: "exec-v", path: "file:///w/%E5%9B%BE/shot.png" }),
      ri({ type: "custom_tool_call_output", call_id: "v1", output: [{ type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" }, { type: "input_image", image_url: img }] }),
    ]);
    expect(toolsOf(ops)).toMatchObject([{ name: "view_image", summary: "图/shot.png", images: [img], done: true }]);
  });

  test("a tool's screenshot comes with its result", () => {
    const ops = run([fn("j2", "js", { code: "await shot()", title: "Look" }, "mcp__cua_repl"), fnOut("j2", [{ type: "input_text", text: "Wall time: 1.0 seconds\nOutput:" }, { type: "input_image", image_url: img }])]);
    expect(toolsOf(ops)).toMatchObject([{ images: [img], output: "", done: true }]);
  });
});

describe("codex: subagents", () => {
  const blob = `gAAAAABq${"x".repeat(200)}`;
  const ops = run([
    fn("s1", "spawn_agent", { task_name: "checker", message: blob }, "collaboration"),
    done({ type: "SubAgentActivity", id: "s1", kind: "started", agent_thread_id: "th-2", agent_path: "/root/checker" }),
    fnOut("s1", '{"task_name":"/root/checker"}'),
    fn("s2", "send_message", { target: "checker", message: blob }, "collaboration"),
    fnOut("s2", ""),
    ri({ type: "agent_message", author: "/root/checker", recipient: "/root", content: [{ type: "input_text", text: "Message Type: MESSAGE\nTask name: /root\nSender: /root/checker\nPayload:\n" }, { type: "encrypted_content", encrypted_content: blob }] }),
    done({ type: "SubAgentActivity", id: "subagent-completed-x", kind: "completed", agent_thread_id: "th-2", agent_path: "/root/checker" }),
    ri({ type: "agent_message", author: "/root/checker", recipient: "/root", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/checker\nPayload:\nAll **3** claims check out." }] }),
  ]);

  test("spawned with its name, never an encrypted blob; its final answer is the report", () => {
    const { blocks } = view(ops);
    expect(blocks.map(line)).toEqual(["spawn_agent: /root/checker", "send_message: to checker"]);
    expect(blocks[0]).toMatchObject({ report: "All **3** claims check out.", done: true, background: true });
    expect(JSON.stringify(blocks)).not.toContain("gAAAA");
  });

  test("a plain-text task is shown", () => {
    const o = run([fn("s3", "spawn_agent", { task_name: "w", message: "Check the citations in section 2." })]);
    expect(toolsOf(o)[0]!.summary).toBe("/root/w — Check the citations in section 2.");
  });

  test("a final answer whose spawn is not in view still shows", () => {
    const o = run([ri({ type: "agent_message", id: "am1", content: [{ type: "input_text", text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/z\nPayload:\nDone." }] })]);
    expect(toolsOf(o)).toMatchObject([{ name: "spawn_agent", summary: "/root/z — final answer", report: "Done.", done: true }]);
  });
});

describe("codex: session settings", () => {
  test("model and effort: meta, and a notice when the user changes them mid-session", () => {
    const ops = run([
      { type: "turn_context", payload: { turn_id: T, model: "gpt-a", effort: "xhigh", sandbox_policy: { type: "danger-full-access" }, collaboration_mode: { mode: "default" } } },
      ev({ type: "thread_settings_applied", thread_settings: { model: "gpt-a", reasoning_effort: "xhigh" } }),
      ev({ type: "thread_settings_applied", thread_settings: { model: "gpt-b", reasoning_effort: "xhigh" } }),
      ri({ type: "message", role: "developer", content: [{ type: "input_text", text: "<model_switch>\nThe user was previously using a different model." }] }),
      // the running turn restated (after a compaction): not a change back
      { type: "turn_context", payload: { turn_id: T, model: "gpt-a", effort: "xhigh", sandbox_policy: { type: "danger-full-access" } } },
      ev({ type: "thread_settings_applied", thread_settings: { model: "gpt-b", reasoning_effort: "max" } }),
    ]);
    const { blocks, meta } = view(ops);
    expect(blocks.map(line)).toEqual(["notice: Model changed to gpt-b xhigh", "notice: Model changed to gpt-b max"]);
    expect(meta).toEqual({ model: "gpt-b", effort: "max", mode: "full access" });
  });

  test("plan mode is the mode", () => {
    const { meta } = view(run([{ type: "turn_context", payload: { model: "m", effort: "low", sandbox_policy: { type: "workspace-write" }, collaboration_mode: { mode: "plan" } } }]));
    expect(meta.mode).toBe("plan");
  });

  test("context left from the last request, not the session total", () => {
    const ops = run([
      ev({ type: "task_started", turn_id: T, model_context_window: 258400 }),
      ev({ type: "token_count", info: { total_token_usage: { total_tokens: 900000 }, last_token_usage: { input_tokens: 70000, output_tokens: 300, total_tokens: 70300 }, model_context_window: 258400 }, rate_limits: { primary: null } }),
      ev({ type: "token_count", info: null, rate_limits: null }),
    ]);
    expect(view(ops).meta).toEqual({ contextTokens: 70300, contextWindow: 258400 });
  });
});

describe("codex: reasoning", () => {
  test("readable reasoning summaries are thinking; encrypted ones are skipped", () => {
    const ops = run([
      ri({ type: "reasoning", summary: [{ type: "summary_text", text: "**Checking the tests**" }, { type: "summary_text", text: "Then the docs." }], encrypted_content: "gAAAAB..." }),
      ri({ type: "reasoning", summary: [], encrypted_content: "gAAAAB..." }),
      done({ type: "Reasoning", id: "r1", summary_text: ["**Checking the tests**"], raw_content: [] }),
    ]);
    expect(view(ops).blocks).toEqual([{ kind: "thinking", text: "**Checking the tests**\n\nThen the docs." }]);
  });
});

describe("codex: background terminals", () => {
  test("a command that keeps running: its row, polls fold into it, the record finishes it", () => {
    const ops = run([
      exec("b1", 'text(await tools.exec_command({cmd:"npm run build",yield_time_ms:1000}));'),
      execOut("b1", JSON.stringify({ chunk_id: "a", wall_time_seconds: 1.0, session_id: 4242, original_token_count: 2, output: "building…" })),
      exec("b2", "text(await tools.write_stdin({session_id:4242,chars:\"\",yield_time_ms:5000}));"),
      execOut("b2", JSON.stringify({ chunk_id: "b", wall_time_seconds: 5.0, session_id: 4242, original_token_count: 2, output: "step 2/3" })),
      done(cmdItem("exec-b", "npm run build", "building…\nstep 2/3\nerror: x\n", 2, undefined, "4242")),
    ]);
    const rows = toolsOf(ops);
    expect(rows.map(line)).toEqual(["bash: npm run build"]);
    expect(rows[0]).toMatchObject({ id: "b1", background: true, done: true, error: true, output: "building…\nstep 2/3\nerror: x\n(exit 2)" });
    // while it ran
    const mid = toolsOf(ops.slice(0, ops.findIndex((o) => o.op === "update" && o.id === "b1" && "done" in o.set)));
    expect(mid[0]).toMatchObject({ background: true, output: "building…\nstep 2/3" });
    expect(mid[0]!.done).toBeFalsy();
  });

  test("one of several commands goes to the background: a row of its own", () => {
    const ops = run([
      exec("b3", 'await Promise.allSettled([tools.exec_command({cmd:"ls"}), tools.exec_command({cmd:"curl -s x.test"})]);'),
      done(cmdItem("exec-l", "ls", "a\n")),
      execOut("b3", JSON.stringify({ index: 0, status: "fulfilled", value: record("a\n") }), JSON.stringify({ index: 1, status: "fulfilled", value: { chunk_id: "c", wall_time_seconds: 10, session_id: 77, original_token_count: 0, output: "" } })),
      exec("b4", "text(await tools.view_image({path:\"/w/x.png\"}));"),
      done(cmdItem("exec-c", "curl -s x.test", "ok\n", 0, undefined, "77")),
    ]);
    const rows = toolsOf(ops);
    expect(rows.map(line)).toEqual(["bash: ls", "bash: curl -s x.test", "view_image: /w/x.png"]);
    expect(rows[1]).toMatchObject({ background: true, done: true, output: "ok" });
  });

  test("direct (non code-mode) exec_command and write_stdin calls", () => {
    const ops = run([
      fn("d1", "exec_command", { cmd: "make", yield_time_ms: 1000 }),
      fnOut("d1", "Chunk ID: 1\nWall time: 1.0 seconds\nProcess running with session ID 9\nOriginal token count: 1\nOutput:\nstarting"),
      fn("d2", "write_stdin", { session_id: 9, chars: "" }),
      fnOut("d2", "Chunk ID: 2\nWall time: 3.0 seconds\nProcess exited with code 0\nOriginal token count: 1\nOutput:\ndone"),
    ]);
    const rows = toolsOf(ops);
    expect(rows.map(line)).toEqual(["bash: make"]);
    expect(rows[0]).toMatchObject({ done: true, background: true, error: false, output: "done" });
  });
});

describe("codex: MCP tools", () => {
  test("server · tool — title, and a failure is an error", () => {
    const ops = run([
      fn("m1", "js", { code: "let tab = await cua.open('x')", title: "Open the search page" }, "mcp__cua_repl"),
      done({ type: "McpToolCall", id: "m1", server: "cua_repl", tool: "js", arguments: { code: "…", title: "Open the search page" }, status: "failed", result: { content: [{ type: "text", text: "browser use is disabled" }], isError: true } }),
      fnOut("m1", [{ type: "input_text", text: "Wall time: 0.2800 seconds\nOutput:" }, { type: "input_text", text: "browser use is disabled" }]),
    ]);
    expect(toolsOf(ops)).toMatchObject([{ name: "mcp", summary: "cua_repl · js — Open the search page", input: "let tab = await cua.open('x')", output: "browser use is disabled", error: true, done: true }]);
  });

  test("an MCP tool called from a cell", () => {
    const ops = run([
      exec("m2", "text(await tools.mcp__codex_app__load_workspace_dependencies({}));"),
      done({ type: "McpToolCall", id: "exec-m", server: "codex_app", tool: "load_workspace_dependencies", arguments: {}, status: "completed", result: { content: [{ type: "text", text: "Dependencies ready" }], isError: false } }),
      execOut("m2", JSON.stringify({ content: [{ type: "text", text: "Dependencies ready" }], isError: false })),
    ]);
    expect(toolsOf(ops)).toMatchObject([{ id: "exec-m", name: "mcp", summary: "codex_app · load_workspace_dependencies", output: "Dependencies ready", error: false }]);
  });
});

// Built from codex's protocol and TUI (no real rollout had these yet).
describe("codex: web search, plans, review mode (unverified shapes)", () => {
  test("web_search_call", () => {
    const ops = run([ri({ type: "web_search_call", id: "ws1", status: "completed", action: { type: "search", query: "codex rollout format" } }), ri({ type: "web_search_call", id: "ws2", status: "completed", action: { type: "open_page", url: "https://x.test" } })]);
    expect(toolsOf(ops).map(line)).toEqual(["web_search: codex rollout format", "web_search: open https://x.test"]);
  });

  test("update_plan is a checklist", () => {
    const ops = run([
      fn("u1", "update_plan", { plan: [{ step: "Read the code", status: "completed" }, { step: "Write the parser", status: "in_progress" }, { step: "Test it", status: "pending" }] }),
      fnOut("u1", "Plan updated"),
    ]);
    expect(toolsOf(ops)).toMatchObject([{ name: "plan", summary: "1/3 done — Write the parser", report: "- [x] Read the code\n- [ ] **Write the parser**\n- [ ] Test it", done: true }]);
  });

  test("a <proposed_plan> block (Plan mode)", () => {
    const ops = run([assistant("Here is the plan.\n<proposed_plan>\n1. Do a\n2. Do b\n</proposed_plan>")]);
    expect(view(ops).blocks.map(line)).toEqual(["text: Here is the plan.", "text: **Proposed plan**\n\n1. Do a\n2. Do b"]);
  });

  test("review mode: dividers and the findings", () => {
    const ops = run([
      ev({ type: "entered_review_mode", target: { type: "uncommittedChanges" }, user_facing_hint: "current changes" }),
      ev({
        type: "exited_review_mode",
        review_output: {
          findings: [{ title: "Off by one", body: "The loop skips the last item.", confidence_score: 0.8, priority: 1, code_location: { absolute_file_path: "/w/a.ts", line_range: { start: 3, end: 5 } } }],
          overall_correctness: "patch is incorrect",
          overall_explanation: "One bug.",
          overall_confidence_score: 0.7,
        },
      }),
      user("<user_action>\n<context>User initiated a review task.</context>\n</user_action>"),
    ]);
    expect(view(ops).blocks.map(line)).toEqual([
      "notice: Code review started: current changes",
      "text: **Code review: patch is incorrect**\n\nOne bug.\n\n1. **[P1] Off by one** — `/w/a.ts:3-5`\n   The loop skips the last item.",
      "notice: Code review finished",
    ]);
  });
});

describe("codex: unwrapping tool output", () => {
  test("banners, {index,result}, {status,value}, rejected, several records in one part", () => {
    const ops = run([
      exec("w1", "const x = 1; text(x);"),
      ri({
        type: "custom_tool_call_output",
        call_id: "w1",
        output: [
          { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
          { type: "input_text", text: `${JSON.stringify({ index: 0, result: { status: "fulfilled", value: record("one") } })}\n${JSON.stringify({ status: "rejected", reason: "no such file" })}` },
          { type: "input_text", text: JSON.stringify({ index: 1, status: "fulfilled" }) },
        ],
      }),
    ]);
    expect(toolsOf(ops)[0]).toMatchObject({ output: "one\nno such file", error: true });
  });

  test("success:false on an output object is an error", () => {
    const ops = run([fn("f1", "custom_thing", { a: 1 }), fnOut("f1", { content: "nope", success: false })]);
    expect(toolsOf(ops)[0]).toMatchObject({ output: "nope", error: true });
  });

  test("encrypted arguments never become a summary", () => {
    const ops = run([fn("f2", "mystery", { payload: `gAAAAABq${"y".repeat(100)}` }), ri({ type: "custom_tool_call", call_id: "f3", name: "other", input: `gAAAAABq${"z".repeat(100)}` })]);
    expect(JSON.stringify(toolsOf(ops))).not.toContain("gAAAA");
  });
});

describe("codex: user messages", () => {
  test("a message typed while the turn runs shows once, in order", () => {
    const ops = run([
      user("first task"),
      done({ type: "UserMessage", id: "u1", content: [{ type: "text", text: "first task" }] }),
      assistant("On it.", "commentary"),
      exec("c1", 'text(await tools.exec_command({cmd:"ls"}));'),
      user("also check the docs"),
      done({ type: "UserMessage", id: "u2", client_id: "c", content: [{ type: "text", text: "also check the docs" }] }),
      execOut("c1", JSON.stringify(record("a"))),
      assistant("Done."),
    ]);
    expect(view(ops).blocks.map(line)).toEqual(["user: first task", "text: On it.", "bash: ls", "user: also check the docs", "text: Done."]);
  });

  test("injected text is hidden; agent-flow messages are notices", () => {
    const ops = run([
      user("# AGENTS.md instructions for /w\n\n<INSTRUCTIONS>…</INSTRUCTIONS>"),
      user("<environment_context>\n  <cwd>/w</cwd>\n</environment_context>"),
      user("<turn_aborted>\nThe previous turn was interrupted"),
      ri({ type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>…" }] }),
      user("[agent-flow] New message m3 from lead. Run: af inbox"),
    ]);
    expect(view(ops).blocks).toEqual([{ kind: "notice", text: "[agent-flow] New message m3 from lead. Run: af inbox" }]);
  });
});

describe("codex: forks and subagent files", () => {
  test("a fork starts with a divider naming the thread it came from", () => {
    const ops = run([
      { type: "session_meta", payload: { id: "th-new", session_id: "th-new", forked_from_id: "th-old", history_mode: "paginated", history_base: { thread_id: "th-page", end_ordinal_exclusive: 313, end_byte_offset: 4481150 } } },
      ev({ type: "thread_settings_applied", thread_settings: { model: "m" } }),
      user("continue from here"),
    ]);
    expect(view(ops).blocks.map(line)).toEqual(["notice: Forked from th-page", "user: continue from here"]);
    expect((view(ops).blocks[0] as any).detail).toContain("first 4481150 bytes");
  });

  test("read after its parent's lines (if the tail prepends them): the divider sits at the fork point, once", () => {
    const fork = { type: "session_meta", payload: { id: "th-new", forked_from_id: "th-old", history_base: { thread_id: "th-old", end_byte_offset: 10 } } };
    const ops = run([{ type: "session_meta", payload: { id: "th-old", cwd: "/w" } }, user("earlier"), fork, user("later"), fork]);
    expect(view(ops).blocks.map(line)).toEqual(["user: earlier", "notice: Forked from th-old", "user: later"]);
  });

  test("a subagent's file: a divider, its parent's repeated session_meta ignored", () => {
    const ops = run([
      { type: "session_meta", payload: { id: "th-sub", forked_from_id: "th-root", source: { subagent: { thread_spawn: { parent_thread_id: "th-root", depth: 1, agent_path: "/root/checker", agent_nickname: "Zeno" } } }, thread_source: "subagent" } },
      { type: "session_meta", payload: { id: "th-root" } },
      ri({ type: "agent_message", author: "/root", recipient: "/root/checker", content: [{ type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/checker\nSender: /root\nPayload:\n" }, { type: "encrypted_content", encrypted_content: "gAAAAAB" }] }),
    ]);
    expect(view(ops).blocks.map(line)).toEqual(["notice: Subagent /root/checker (Zeno)", "notice: Task from /root"]);
  });
});

describe("codex: robustness", () => {
  test("never throws, whatever the line", () => {
    const junk: any[] = [null, 3, "x", [], {}, { type: "response_item" }, { type: "response_item", payload: null }, { type: "event_msg", payload: { type: "item_completed" } }, { type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange", changes: 5 } } }];
    junk.push(ri({ type: "custom_tool_call", name: "exec", input: 'tools.exec_command({cmd:"unterminated' }), ri({ type: "custom_tool_call_output", call_id: "nope", output: 7 }), done({ type: "CommandExecution", command: null }));
    junk.push(ri({ type: "function_call", name: "spawn_agent", arguments: "{not json", call_id: "z" }), { type: "compacted", payload: { message: null } }, ev({ type: "token_count", info: { last_token_usage: null } }));
    expect(() => run(junk)).not.toThrow();
  });

  test("starting mid-file: records and outputs without their call", () => {
    const ops = run([done(cmdItem("exec-9", "pwd", "/w\n")), execOut("gone", JSON.stringify(record("/w\n"))), ev({ type: "turn_aborted", reason: "interrupted" })]);
    expect(view(ops).blocks.map(line)).toEqual(["bash: pwd", "notice: Interrupted"]);
  });

  test("state stays small: finished calls are forgotten", () => {
    const ctx: any = { n: 0 };
    for (let i = 0; i < 50; i++) run([exec(`c${i}`, `text(await tools.exec_command({cmd:"echo ${i}"}));`), done(cmdItem(`exec-${i}`, `echo ${i}`, `${i}\n`)), execOut(`c${i}`, JSON.stringify(record(`${i}\n`)))], ctx);
    expect(Object.keys(ctx.state.calls)).toEqual([]);
    expect(Object.keys(ctx.state.procs)).toEqual([]);
  });
});

describe("codex: reading a code-mode cell", () => {
  test("tool calls in source order, with literal arguments", () => {
    const src = [
      "// tools.exec_command({cmd:'commented out'})",
      'const s = "tools.exec_command({cmd:\\"in a string\\"})";',
      "const re = /tools\\.x\\(/g;",
      'text(await tools.exec_command({cmd:"rg -n \'a|b\' src", "max_output_tokens": 200, workdir: dir}));',
      "await tools['view_image']({path:`/w/a.png`});",
      'await tools.apply_patch("*** Begin Patch\\n" + "*** End Patch");',
      "await tools.write_stdin({session_id: 12, chars: ''});",
      "await tools.exec_command({cmd:`ls ${dir}`});",
    ].join("\n");
    expect(scriptCalls(src)).toEqual([
      { fn: "exec_command", arg: { cmd: "rg -n 'a|b' src", max_output_tokens: 200, workdir: undefined } },
      { fn: "view_image", arg: { path: "/w/a.png" } },
      { fn: "apply_patch", arg: "*** Begin Patch\n*** End Patch" },
      { fn: "write_stdin", arg: { session_id: 12, chars: "" } },
      { fn: "exec_command", arg: { cmd: undefined } },
    ]);
  });
});
