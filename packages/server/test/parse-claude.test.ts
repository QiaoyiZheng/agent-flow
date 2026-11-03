// The claude transcript parser, fed synthetic lines shaped like the ones current Claude Code writes.
import { describe, expect, test } from "bun:test";
import type { ChatBlock, ChatOp } from "@af/core";
import { contextWindow, duration, parseClaude } from "../src/transcripts/parse/claude.ts";
import type { ParseCtx } from "../src/transcripts/parse/common.ts";

const run = (lines: any[], ctx: ParseCtx = { n: 0 }) => lines.flatMap((l) => parseClaude(l, ctx));
const blocks = (ops: ChatOp[]) => ops.flatMap((o) => (o.op === "add" ? [o.entry.block] : []));
const updates = (ops: ChatOp[], id?: string) => ops.flatMap((o) => (o.op === "update" && (!id || o.id === id) ? [o.set] : []));
const results = (ops: ChatOp[]) => ops.flatMap((o) => (o.op === "result" ? [o] : []));
const notices = (ops: ChatOp[]) => blocks(ops).flatMap((b) => (b.kind === "notice" ? [b] : []));
/** What the UI ends up showing: adds, minus removed ones, with results and updates applied to tool cards. */
function view(ops: ChatOp[]): ChatBlock[] {
  let out: { key: string; block: any }[] = [];
  for (const o of ops) {
    if (o.op === "add") out.push({ key: o.entry.key, block: { ...o.entry.block } });
    else if (o.op === "remove") out = out.filter((e) => !o.keys.includes(e.key));
    else if (o.op === "result" || o.op === "update") {
      const e = out.find((x) => x.block.kind === "tool" && x.block.id === o.id);
      if (!e) continue;
      if (o.op === "update") Object.assign(e.block, o.set);
      else Object.assign(e.block, { output: o.output, error: o.error, ...(o.images ? { images: o.images } : {}), ...(o.background ? { background: true } : { done: true }) });
    }
  }
  return out.map((e) => e.block);
}

const asst = (content: any[], extra: any = {}) => ({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content }, ...extra });
const call = (id: string, name: string, input: any) => asst([{ type: "tool_use", id, name, input }]);
const res = (id: string, content: any, toolUseResult?: any, is_error = false) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] }, toolUseResult });
const prompt = (content: any, extra: any = {}) => ({ type: "user", message: { role: "user", content }, origin: { kind: "human" }, ...extra });
const note = (body: string) => ({ type: "user", message: { role: "user", content: `<task-notification>\n${body}\n</task-notification>` }, origin: { kind: "task-notification", producer: "session-task" } });

describe("background shell commands and Monitor", () => {
  test("a background command stays running until its task-notification; the notification is a notice, not a user bubble", () => {
    const ops = run([
      call("b1", "Bash", { command: "make all", description: "Build everything", run_in_background: true }),
      res("b1", "Command running in background with ID: t1. Output is being written to: /tmp/t1.output. You will be notified …", { stdout: "", stderr: "", backgroundTaskId: "t1" }),
      note('<task-id>t1</task-id>\n<tool-use-id>b1</tool-use-id>\n<output-file>/tmp/t1.output</output-file>\n<status>completed</status>\n<summary>Background command "Build everything" completed (exit code 0)</summary>'),
    ]);
    expect(results(ops)).toEqual([{ op: "result", id: "b1", output: "Running in the background (task t1)", error: false, background: true }]);
    expect(notices(ops)).toEqual([{ kind: "notice", text: 'Background command "Build everything" completed (exit code 0)' }]);
    expect(updates(ops, "b1")).toEqual([{ done: true, output: 'Background command "Build everything" completed (exit code 0)\nOutput: /tmp/t1.output' }]);
    const card = view(ops)[0] as any;
    expect(card).toMatchObject({ kind: "tool", name: "Bash", summary: "make all", background: true, done: true });
    expect(blocks(ops).some((b) => b.kind === "user")).toBe(false);
  });

  test("a failed one is an error; a stopped one (TaskStop) is aborted and named by what it was", () => {
    const ops = run([
      call("b1", "Bash", { command: "./deploy.sh", description: "Deploy", run_in_background: true }),
      res("b1", "Command running in background with ID: t1.", { backgroundTaskId: "t1" }),
      note("<task-id>t1</task-id>\n<tool-use-id>b1</tool-use-id>\n<status>failed</status>\n<summary>Background command \"Deploy\" failed with exit code 255</summary>"),
      call("b2", "Bash", { command: "sleep 999", description: "Wait", run_in_background: true }),
      res("b2", "Command running in background with ID: t2.", { backgroundTaskId: "t2" }),
      call("k", "TaskStop", { task_id: "t2" }),
      res("k", '{"message":"Successfully stopped task: t2 (sleep 999)"}', { message: "Successfully stopped task: t2 (sleep 999)", task_id: "t2", task_type: "local_bash" }),
    ]);
    expect(notices(ops)[0]).toMatchObject({ tone: "error" });
    expect(updates(ops, "b1")[0]).toMatchObject({ done: true, error: true });
    expect((blocks(ops).find((b) => b.kind === "tool" && b.id === "k") as any).summary).toBe("stop Wait");
    expect(updates(ops, "b2")).toEqual([{ done: true, aborted: true, output: "Stopped" }]);
  });

  test("Monitor: events go to its card and show as notices; expiry ends it", () => {
    const ops = run([
      call("m1", "Monitor", { description: "test failures", timeout_ms: 1800000, command: "tail -f log | grep FAIL" }),
      res("m1", "Monitor started (task w1, expires in 30m unless the source ends first; …)", { taskId: "w1", timeoutMs: 1800000, persistent: false }),
      note('<task-id>w1</task-id>\n<summary>Monitor event: "test failures"</summary>\n<event>10:01 FAIL a</event>'),
      // delivered while the agent was busy: a queued_command attachment
      { type: "attachment", attachment: { type: "queued_command", prompt: '<task-notification>\n<task-id>w1</task-id>\n<summary>Monitor event: "test failures"</summary>\n<event>10:02 FAIL b</event>\n</task-notification>', commandMode: "task-notification", origin: { kind: "task-notification" } } },
      note('<task-id>w1</task-id>\n<summary>Monitor event: "test failures"</summary>\n<event>[Monitor expired after 30m with 2 events delivered. Re-arm it if you still need the watch.]</event>'),
    ]);
    const card = view(ops)[0] as any;
    expect(card).toMatchObject({ name: "Monitor", summary: "test failures", input: "tail -f log | grep FAIL", background: true, done: true });
    expect(card.output).toBe("10:01 FAIL a\n10:02 FAIL b\n[Monitor expired after 30m with 2 events delivered. Re-arm it if you still need the watch.]\n");
    expect(notices(ops).map((n) => [n.text, n.detail])).toEqual([
      ['Monitor event: "test failures"', "10:01 FAIL a"],
      ['Monitor event: "test failures"', "10:02 FAIL b"],
      ['Monitor event: "test failures"', "[Monitor expired after 30m with 2 events delivered. Re-arm it if you still need the watch.]"],
    ]);
    expect(results(ops)[0]).toMatchObject({ output: "Watching (task w1, up to 30m)", background: true });
  });

  test("a notification for a call this window never saw (opened mid-file) is still a notice; orphans from a past session too", () => {
    const ops = run([
      note('<task-id>zz</task-id>\n<summary>Monitor event: "x"</summary>\n<event>hello</event>'),
      note("<task-id>a</task-id>\n<task-id>b</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>2 background shell command tasks didn't finish before the previous session ended.</summary>"),
      note("<fork-source>\nThis session began as a fork (copy) of another session that is still running: a session whose self-reported name is 'solver-47'. …\n</fork-source>"),
    ]);
    expect(blocks(ops)).toEqual([
      { kind: "notice", text: 'Monitor event: "x"', detail: "hello" },
      { kind: "notice", text: "2 background shell command tasks didn't finish before the previous session ended.", tone: "warn" },
      { kind: "notice", text: "Forked from “solver-47”", divider: true, detail: expect.stringContaining("fork (copy)") },
    ]);
  });
});

describe("subagents", () => {
  const launch = [
    call("ag", "Agent", { description: "Survey the parsers", subagent_type: "general-purpose", prompt: "Read the parsers and report." }),
    res("ag", [{ type: "text", text: "Async agent launched successfully. (This tool result is internal metadata …)\nagentId: a42 (internal ID …)" }], {
      isAsync: true,
      status: "async_launched",
      agentId: "a42",
      description: "Survey the parsers",
      outputFile: "/tmp/a42.output",
    }),
  ];
  const framing =
    "[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n";

  test("the Agent card stays in the background until the report arrives, then shows it", () => {
    const ops = run([
      ...launch,
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: `Another Claude session sent a message:\n<agent-message from="a42">\n${framing}  ## Findings\n  \n  - one <b>tag</b>\n</agent-message>\n\nThat "other Claude session" is …` },
        origin: { kind: "peer", from: "a42", name: "general-purpose", body: `${framing}  ## Findings\n  \n  - one <b>tag</b>`, handback: true, handbackReportText: "## Findings\n\n- one <b>tag</b>" },
      },
      note(
        '<task-id>a42</task-id>\n<tool-use-id>ag</tool-use-id>\n<status>completed</status>\n<summary>Agent "Survey the parsers" finished</summary>\n<result>This agent\'s report was delivered to you as a message from "a42" (its SubagentHandback call). Read it there; it is not repeated here.</result>\n<usage><subagent_tokens>76070</subagent_tokens><tool_uses>34</tool_uses><duration_ms>255082</duration_ms></usage>',
      ),
    ]);
    expect(results(ops)).toEqual([{ op: "result", id: "ag", output: "Working in the background", error: false, background: true }]);
    expect(notices(ops)).toEqual([{ kind: "notice", text: "Agent “Survey the parsers” reported back" }]); // the "finished" pointer adds nothing
    const card = view(ops)[0] as any;
    expect(card).toMatchObject({ name: "Agent", summary: "Survey the parsers", background: true, done: true, report: "## Findings\n\n- one <b>tag</b>" });
    expect(card.output).toContain("34 tool uses · 76k tokens · 4m 15s");
  });

  test("without handbackReportText the framing and indentation are taken off; a report with no card is a notice", () => {
    const peer = (from: string) => ({
      type: "user",
      isMeta: true,
      message: { role: "user", content: `Another Claude session sent a message:\n<agent-message from="${from}">\n${framing}  line 1\n    indented\n</agent-message>` },
      origin: { kind: "peer", from, name: "general-purpose", body: `${framing}  line 1\n    indented`, handback: true },
    });
    const ops = run([...launch, peer("a42"), peer("unknown")]);
    expect(updates(ops, "ag")[0]).toMatchObject({ report: "line 1\n  indented", done: true });
    expect(notices(ops)[1]).toEqual({ kind: "notice", text: "Report from general-purpose", detail: "line 1\n  indented" });
  });

  test("a harness note before the report is not part of it", () => {
    const note = "[harness: subagent output matched instruction-shaped pattern(s): harness-envelope-tag. Control tags below are neutralized.]\n\n";
    const ops = run([
      ...launch,
      { type: "user", isMeta: true, message: { role: "user", content: `<agent-message from="a42">…</agent-message>` }, origin: { kind: "peer", from: "a42", name: "general-purpose", body: "…", handback: true, handbackReportText: `${note}## Findings` } },
    ]);
    expect(updates(ops, "ag")[0]).toMatchObject({ report: "## Findings", done: true });
  });

  test("a SendMessage that resumes a finished agent waits for, and gets, its next report", () => {
    const peer = (text: string) => ({ type: "user", isMeta: true, message: { role: "user", content: `<agent-message from="a42">…</agent-message>` }, origin: { kind: "peer", from: "a42", name: "general-purpose", body: "…", handback: true, handbackReportText: text } });
    const ops = run([
      ...launch,
      peer("first"),
      call("sm", "SendMessage", { to: "a42", summary: "also check omp", message: "Also check omp." }),
      res("sm", '{"success":true,"message":"Resuming agent a42"}', { success: true, message: "Resuming agent a42", resumedAgentId: "a42" }),
      peer("second"),
    ]);
    expect(results(ops).at(-1)).toMatchObject({ id: "sm", background: true });
    expect(updates(ops, "sm")).toEqual([{ report: "second", output: "Reported back", done: true }]);
    expect(notices(ops).map((n) => n.text)).toEqual(["Agent “Survey the parsers” reported back", "Agent “Survey the parsers” reported back"]);
  });

  test("an older agent notification carries the result itself; another session's message is a notice", () => {
    const ops = run([
      call("ag", "Agent", { description: "Port", prompt: "…" }),
      res("ag", "Async agent launched successfully.", { status: "async_launched", agentId: "a7", description: "Port" }),
      note('<task-id>a7</task-id>\n<tool-use-id>ag</tool-use-id>\n<status>failed</status>\n<summary>Agent "Port" failed: API error</summary>\n<result>Half done: 3 of 5 ported.</result>'),
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: 'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/x.sock" from-name="lead" from-mode="prompting">\nDid you change the runner?\n</cross-session-message>' },
        origin: { kind: "peer", from: "uds:/tmp/x.sock", name: "lead", fromMode: "prompting", body: "Did you change the runner?" },
      },
    ]);
    expect(updates(ops, "ag")[0]).toMatchObject({ report: "Half done: 3 of 5 ported.", done: true, error: true });
    expect(notices(ops)).toEqual([
      { kind: "notice", text: 'Agent "Port" failed: API error', tone: "error" },
      { kind: "notice", text: "Message from lead", detail: "Did you change the runner?" },
    ]);
  });

  test("a workflow's JSON result becomes readable markdown", () => {
    const ops = run([
      call("wf", "Workflow", { script: "export const meta = {\n  name: 'review',\n  description: 'Review the change',\n}" }),
      res("wf", "Workflow launched in background. Task ID: w9", { status: "async_launched", taskId: "w9", workflowName: "review", summary: "Review the change" }),
      note('<task-id>w9</task-id>\n<tool-use-id>wf</tool-use-id>\n<status>completed</status>\n<summary>Dynamic workflow "Review the change" completed</summary>\n<result>[{"key":"rust","report":"All good."}]</result>'),
    ]);
    expect((blocks(ops)[0] as any).summary).toBe("Review the change");
    expect(updates(ops, "wf").at(-1)).toMatchObject({ report: "### rust\n\nAll good.", done: true });
  });
});

describe("slash commands, skills, bash mode", () => {
  test("a built-in command's output folds under it (system local_command, and the older user-record form with ANSI codes)", () => {
    const ops = run([
      { type: "system", subtype: "local_command", content: "<command-name>/fork</command-name>\n            <command-message>fork</command-message>\n            <command-args></command-args>", level: "info" },
      { type: "system", subtype: "local_command", content: "<local-command-stdout>session waiting for a prompt · Fix it · 74b8afff</local-command-stdout>", commandRun: { command: "fork", args: "" } },
      { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>The command below was run directly …</local-command-caveat>" } },
      prompt("<command-name>/effort</command-name>\n            <command-message>effort</command-message>\n            <command-args>max</command-args>"),
      prompt("<local-command-stdout>Set effort level to \u001b[1mmax\u001b[22m (this session only)</local-command-stdout>"),
      { type: "system", subtype: "local_command", content: "<local-command-stdout>Session renamed to x</local-command-stdout>", commandRun: { command: "rename", args: "x" } },
    ]);
    expect(view(ops)).toEqual([
      { kind: "notice", text: "/fork", detail: "session waiting for a prompt · Fix it · 74b8afff" },
      { kind: "notice", text: "/effort max", detail: "Set effort level to max (this session only)" },
      { kind: "notice", text: "/rename x", detail: "Session renamed to x" },
    ]);
  });

  test("a skill run with arguments is the user's message with a command badge (arguments may contain <)", () => {
    const ops = run([
      prompt("<command-message>grill-me</command-message>\n<command-name>/grill-me</command-name>\n<command-args>Plan: if a < b then <b>bold</b></command-args>"),
      { type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: …" }] } },
      prompt("<command-message>delivery-audit</command-message>\n<command-name>/delivery-audit</command-name>"),
      // the model's own Skill call also logs this (isMeta): the Skill card shows it already
      { type: "user", isMeta: true, message: { role: "user", content: "<command-message>herdr</command-message>\n<command-name>herdr</command-name>\n<skill-format>true</skill-format>" } },
    ]);
    expect(blocks(ops)).toEqual([
      { kind: "user", text: "Plan: if a < b then <b>bold</b>", command: "/grill-me" },
      { kind: "user", text: "", command: "/delivery-audit" },
    ]);
  });

  test("! bash mode is a shell card with its output", () => {
    const ops = run([prompt("<bash-input>ls -a</bash-input>"), prompt("<bash-stdout>.\n..\nfile</bash-stdout><bash-stderr></bash-stderr>"), prompt("<bash-stdout></bash-stdout><bash-stderr>\nboom</bash-stderr>")]);
    expect(view(ops)).toEqual([
      { kind: "tool", id: "bash-mode-1", name: "!", summary: "ls -a", input: undefined, done: true, output: ".\n..\nfile", error: false },
      { kind: "tool", id: "bash-mode-2", name: "!", summary: "(shell output)", output: "boom", done: true },
    ]);
  });
});

describe("compaction, loops, turns, errors", () => {
  test("compaction is one divider with the numbers and the summary folded", () => {
    const ops = run([
      { type: "system", subtype: "compact_boundary", content: "Conversation compacted", compactMetadata: { trigger: "auto", preTokens: 967986, postTokens: 22523 } },
      { type: "attachment", attachment: { type: "date" } },
      { type: "user", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "This session is being continued from a previous conversation.\n\n<system-reminder>tools</system-reminder>\nSummary: did X." } },
      { type: "attachment", attachment: { type: "file", filename: "/r/a.md", displayPath: "a.md", content: { type: "text", file: { filePath: "/r/a.md", content: "…", numLines: 12 } } } },
    ]);
    expect(view(ops)).toEqual([
      { kind: "notice", text: "Conversation compacted (auto · 968k → 23k tokens)", divider: true, detail: "This session is being continued from a previous conversation.\n\n\nSummary: did X." },
      { kind: "notice", text: "Read a.md (12 lines)" },
    ]);
    expect(ops.find((o) => o.op === "meta")).toEqual({ op: "meta", meta: { contextTokens: 22523 } });
  });

  test("a /loop wakeup says what it resumed with; the injected prompt is not shown", () => {
    const ops = run([
      { type: "system", subtype: "scheduled_task_fire", content: "Claude resuming /loop wakeup (Oct 28 10:12am)", prompt: "Check the runs", taskKind: "loop", cronKind: "loop" },
      { type: "user", isMeta: true, message: { role: "user", content: "Check the runs" } },
    ]);
    expect(blocks(ops)).toEqual([{ kind: "notice", text: "Resumed by /loop: Check the runs" }]);
  });

  test("long turns, recaps, warnings; API errors are error notices, not prose", () => {
    const ops = run([
      { type: "system", subtype: "turn_duration", durationMs: 12_000 },
      { type: "system", subtype: "turn_duration", durationMs: 312_000 },
      { type: "system", subtype: "away_summary", content: "We are fixing the parser. (disable recaps in /config)" },
      { type: "system", subtype: "informational", content: "Unknown command: /forl. Did you mean /fork?", level: "warning" },
      { type: "assistant", isApiErrorMessage: true, error: "server_error", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API Error: Connection lost mid-response." }], usage: { input_tokens: 0 } } },
      { type: "assistant", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "No response requested." }] } },
    ]);
    expect(blocks(ops)).toEqual([
      { kind: "notice", text: "Worked for 5m 12s" },
      { kind: "notice", text: "Recap: We are fixing the parser." },
      { kind: "notice", text: "Unknown command: /forl. Did you mean /fork?", tone: "warn" },
      { kind: "notice", text: "API Error: Connection lost mid-response.", tone: "error" },
    ]);
    expect(ops.some((o) => o.op === "meta")).toBe(false); // <synthetic> is not a model
  });
});

describe("assistant output and tools", () => {
  test("thinking with text is shown folded; empty thinking is skipped", () => {
    const ops = run([asst([{ type: "thinking", thinking: "", signature: "x" }]), asst([{ type: "thinking", thinking: "Checking the cache first.", signature: "x" }])]);
    expect(blocks(ops)).toEqual([{ kind: "thinking", text: "Checking the cache first." }]);
  });

  test("Edit and Write show claude's real hunks; Write over an existing file is not a new file", () => {
    const hunks = [{ oldStart: 12, oldLines: 3, newStart: 12, newLines: 3, lines: [" a", "-b", "+B", " c"] }];
    const ops = run([
      call("e1", "Edit", { file_path: "/r/x.ts", old_string: "b", new_string: "B" }),
      res("e1", "The file /r/x.ts has been updated.", { filePath: "/r/x.ts", oldString: "b", newString: "B", originalFile: "a\nb\nc", structuredPatch: hunks, userModified: false, replaceAll: false }),
      call("w1", "Write", { file_path: "/r/y.ts", content: "a\nB\nc" }),
      res("w1", "The file /r/y.ts has been updated.", { type: "update", filePath: "/r/y.ts", content: "a\nB\nc", originalFile: "a\nb\nc", structuredPatch: hunks }),
      call("w2", "Write", { file_path: "/r/new.ts", content: "hi" }),
      res("w2", "File created successfully at: /r/new.ts", { type: "create", filePath: "/r/new.ts", content: "hi", originalFile: null, structuredPatch: [] }),
    ]);
    const patch = "@@ -12,3 +12,3 @@\n a\n-b\n+B\n c";
    expect(updates(ops)).toEqual([{ patch, files: ["/r/x.ts"] }, { patch, files: ["/r/y.ts"] }, { files: ["/r/new.ts"] }]);
    expect((view(ops)[2] as any).edit).toEqual({ path: "/r/new.ts", before: "", after: "hi" });
  });

  test("a Bash call that edited files gets their diff and paths", () => {
    const ops = run([
      call("b", "Bash", { command: "sed -i s/a/b/ x.py && touch new.py" }),
      res("b", "", {
        stdout: "",
        stderr: "",
        bashEditDiff: {
          files: [
            { filePath: "/r/x.py", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-a", "+b"] }] },
            { filePath: "/r/new.py", hunks: [], created: true },
          ],
          moreFiles: 0,
          changedFiles: ["/r/x.py", "/r/new.py"],
        },
      }),
      call("b2", "Bash", { command: "ls" }),
      res("b2", "x.py", { stdout: "x.py", bashEditDiff: { files: [], moreFiles: 0, shared: true } }),
    ]);
    expect(updates(ops)).toEqual([{ patch: "--- a//r/x.py\n+++ b//r/x.py\n@@ -1,1 +1,1 @@\n-a\n+b\n--- /dev/null\n+++ b//r/new.py", files: ["/r/x.py", "/r/new.py"] }]);
  });

  test("images: pasted by the user, and returned by a tool", () => {
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    const ops = run([prompt([{ type: "text", text: "Rebuild this [Image #1]" }, img], { imagePasteIds: [1] }), call("r", "Read", { file_path: "/r/shot.png" }), res("r", [img], { type: "image", file: {} })]);
    expect(blocks(ops)[0]).toEqual({ kind: "user", text: "Rebuild this [Image #1]", images: ["data:image/png;base64,iVBORw0KGgo="] });
    expect(results(ops)[0]).toMatchObject({ id: "r", images: ["data:image/png;base64,iVBORw0KGgo="] });
  });

  test("tool results: loaded tools and documents say something; tool_use_error tags and rejections are cleaned up", () => {
    const ops = run([
      call("t", "ToolSearch", { query: "select:Monitor,TaskStop", max_results: 2 }),
      res("t", [{ type: "tool_reference", tool_name: "Monitor" }, { type: "tool_reference", tool_name: "TaskStop" }]),
      call("p", "Read", { file_path: "/r/cv.pdf" }),
      res("p", [{ type: "text", text: "PDF file read: /r/cv.pdf (131.8KB)" }, { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } }]),
      call("e", "Edit", { file_path: "/r/x", old_string: "a", new_string: "b" }),
      res("e", "<tool_use_error>File has been modified since read</tool_use_error>", "Error: File has been modified since read", true),
      call("q", "Bash", { command: "rm -rf build" }),
      res("q", "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.", "User rejected tool use", true),
    ]);
    expect(results(ops).map((r) => r.output)).toEqual(["Loaded Monitor, TaskStop", "PDF file read: /r/cv.pdf (131.8KB)\n(application/pdf attached)", "File has been modified since read", "Rejected by the user."]);
    expect(updates(ops, "q")).toEqual([{ aborted: true }]);
  });

  test("claude's own tools get readable summaries instead of JSON", () => {
    const ops = run([
      call("a", "AskUserQuestion", { questions: [{ question: "Which layout?", header: "Layout", multiSelect: false, options: [{ label: "Sidebar", description: "Nav on the left" }, { label: "Top bar" }] }] }),
      res("a", 'Your questions have been answered: "Which layout?"="Sidebar"', { questions: [{ question: "Which layout?" }], answers: { "Which layout?": "Sidebar" } }),
      call("s", "Skill", { skill: "herdr", args: "open a pane" }),
      call("w", "ScheduleWakeup", { delaySeconds: 1500, reason: "check the runs", prompt: "Continue: check the runs" }),
      call("w0", "ScheduleWakeup", { stop: true }),
      call("c", "CronCreate", { cron: "7 0 24 10 *", recurring: false, prompt: "Scheduled check" }),
      call("d", "CronDelete", { id: "92974a09" }),
      call("todo", "TodoWrite", { todos: [{ content: "Parse", status: "completed" }, { content: "Test", status: "in_progress" }, { content: "Ship", status: "pending" }] }),
      call("plan", "ExitPlanMode", { plan: "## Plan\n1. do it" }),
      call("mcp", "mcp__github__create_issue", { repo: "a/b", title: "Bug" }),
      call("nb", "NotebookEdit", { notebook_path: "/r/n.ipynb", cell_id: "c3", new_source: "print(1)", edit_mode: "replace" }),
      call("sm", "SendMessage", { to: "a42", summary: "use a private tmp dir", message: "Use a temp dir unique to you." }),
      call("la", "ListAgents", {}),
      call("x", "SomethingNew", { mode: "fast", count: 3, nested: { a: 1 } }),
    ]);
    const tools = blocks(ops).filter((b) => b.kind === "tool") as any[];
    expect(tools.map((t) => `${t.name}: ${t.summary}`)).toEqual([
      "AskUserQuestion: Layout",
      "Skill: /herdr open a pane",
      "ScheduleWakeup: wake in 25m: check the runs",
      "ScheduleWakeup: stop the loop",
      'CronCreate: once at "7 0 24 10 *": Scheduled check',
      "CronDelete: cancel 92974a09",
      "TodoWrite: 1/3 done",
      "ExitPlanMode: plan",
      "github · create_issue: repo: a/b, title: Bug",
      "NotebookEdit: /r/n.ipynb (replace cell c3)",
      "SendMessage: → a42: use a private tmp dir",
      "ListAgents: ",
      "SomethingNew: mode: fast, count: 3",
    ]);
    expect(tools[0].report).toBe("**Which layout?**\n- Sidebar — Nav on the left\n- Top bar");
    expect(updates(ops, "a")).toEqual([{ report: "**Which layout?**\n\n→ Sidebar" }]);
    expect(tools[6].report).toBe("- [x] Parse\n- [ ] Test _(in progress)_\n- [ ] Ship");
    expect(tools[7].report).toBe("## Plan\n1. do it");
  });
});

describe("footer meta", () => {
  test("mode, model, effort, context use and window, cost", () => {
    const usage = { input_tokens: 2, cache_read_input_tokens: 250_000, cache_creation_input_tokens: 1_000, output_tokens: 50 };
    const ops = run([
      { type: "permission-mode", permissionMode: "auto" },
      prompt("hi", { permissionMode: "auto" }),
      asst([{ type: "text", text: "a" }], { effort: "xhigh", message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "a" }], usage } }),
      asst([{ type: "text", text: "b" }], { effort: "xhigh", message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "b" }], usage } }),
      { type: "cost-state", totalCostUSD: 1.25 },
      { type: "permission-mode", permissionMode: "plan" },
    ]);
    expect(ops.flatMap((o) => (o.op === "meta" ? [o.meta] : []))).toEqual([
      { mode: "auto" },
      { model: "claude-opus-5-5", effort: "xhigh", contextTokens: 251_002, contextWindow: 1_000_000 },
      { cost: 1.25 },
      { mode: "plan" },
    ]);
  });

  test("context window by model id", () => {
    expect(contextWindow("claude-opus-5-5")).toBe(1_000_000);
    expect(contextWindow("claude-sonnet-4-6")).toBe(1_000_000);
    expect(contextWindow("claude-sonnet-4-5-20250929")).toBe(200_000);
    expect(contextWindow("claude-sonnet-4-5[1m]")).toBe(1_000_000);
    expect(contextWindow("claude-haiku-4-5")).toBe(200_000);
    expect(contextWindow("claude-3-7-sonnet-20250219")).toBe(200_000);
    expect([duration(45_000), duration(312_000), duration(900_000), duration(6_634_699)]).toEqual(["45s", "5m 12s", "15m", "1h 50m"]);
  });
});

describe("robustness", () => {
  test("a queued prompt is not shown twice when a plain copy follows soon; a much later identical message is shown", () => {
    const q = "继续";
    const queued = { type: "attachment", attachment: { type: "queued_command", prompt: q, commandMode: "prompt", origin: { kind: "human" } } };
    const filler = Array.from({ length: 60 }, () => ({ type: "attachment", attachment: { type: "hook_success" } }));
    const ops = run([queued, prompt(q), queued, ...filler, prompt(q)]);
    expect(blocks(ops)).toEqual([{ kind: "user", text: q }, { kind: "user", text: q }, { kind: "user", text: q }]);
  });

  test("garbage and odd shapes never throw; sidechain lines are skipped", () => {
    const odd = [null, 3, "x", [], {}, { type: "user" }, { type: "user", message: { content: [null, 1, { type: "tool_result" }] } }, { type: "assistant", message: { content: [{ type: "tool_use" }] } },
      { type: "system", subtype: "compact_boundary", compactMetadata: null }, { type: "attachment", attachment: { type: "queued_command", prompt: [{ type: "text", text: "hi" }] } },
      { type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification><status>completed</status></task-notification>" } },
      { type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "subagent chatter" }] } }];
    expect(() => run(odd)).not.toThrow();
    expect(blocks(run(odd)).some((b) => (b as any).text === "subagent chatter")).toBe(false);
  });
});

describe("claude rewinds (Esc Esc, /rewind)", () => {
  const u = (uuid: string, parentUuid: string | null, text: string) => ({ type: "user", uuid, parentUuid, message: { role: "user", content: text } });
  const a = (uuid: string, parentUuid: string, text: string) => ({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content: [{ type: "text", text }] } });
  const r = (uuid: string, parentUuid: string, tool: string) => ({ type: "user", uuid, parentUuid, toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "ok" }] } });
  const shown = (lines: object[]) => {
    const ctx = { n: 0 };
    const view = new Map<string, string>();
    for (const l of lines)
      for (const op of parseClaude(l, ctx) as any[]) {
        if (op.op === "add" && (op.entry.block.kind === "user" || op.entry.block.kind === "text")) view.set(op.entry.key, op.entry.block.text);
        if (op.op === "remove") for (const k of op.keys) view.delete(k);
      }
    return [...view.values()];
  };

  test("a prompt continuing from an earlier point drops the rewound turns", () => {
    expect(shown([u("1", null, "one"), a("2", "1", "1!"), u("3", "2", "two"), a("4", "3", "2!"), u("5", "2", "three"), a("6", "5", "3!")])).toEqual(["one", "1!", "three", "3!"]);
    // back to the start: claude continues from the line before the first prompt (a session-start line)
    const start = { type: "system", uuid: "0", parentUuid: null, subtype: "session_start" };
    expect(shown([start, u("1", "0", "one"), a("2", "1", "1!"), u("3", "2", "two"), a("4", "3", "2!"), u("5", "0", "again")])).toEqual(["again"]);
  });

  test("lines sharing a parent for other reasons are kept: tool results, hooks, parallel tool calls", () => {
    const tool = (uuid: string, parentUuid: string, id: string) => ({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }] } });
    const hook = (uuid: string, parentUuid: string) => ({ type: "attachment", uuid, parentUuid, attachment: { type: "hook_success" } });
    expect(shown([u("1", null, "go"), tool("2", "1", "t1"), hook("h", "2"), r("3", "2", "t1"), tool("4", "3", "t2"), tool("5", "3", "t3"), r("6", "4", "t2"), r("7", "5", "t3"), a("8", "7", "done"), u("9", "8", "next")])).toEqual(["go", "done", "next"]);
  });

  test("a file opened in the middle (parents never seen) just continues", () => {
    expect(shown([a("20", "19", "late reply"), u("21", "20", "more"), a("22", "21", "ok")])).toEqual(["late reply", "more", "ok"]);
  });
});
