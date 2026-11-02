import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatOp, HPane } from "@af/core";
import { parseClaude, parseCodex, parseOmp } from "../src/transcripts/parse.ts";
import { TranscriptFinder, TranscriptTail } from "../src/transcripts/index.ts";

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
    expect(edit.patch).toStartWith("[calc.js#6F9B]");
    expect(blocks(ops).slice(0, 3).map((b) => (b.kind === "tool" ? `${b.name}: ${b.summary}` : `${b.kind}: ${(b as any).text}`))).toEqual(["user: add div", "text: I’ll add `div`.", "read: calc.js"]);
    expect(ops.find((o) => o.op === "result")).toEqual({ op: "result", id: "k1", output: "export function add", error: false });
  });
});

describe("finding and following transcripts", () => {
  const pane = (over: Partial<HPane>): HPane => ({ id: "w1:p1", tabId: "w1:t1", workspaceId: "w1", agentStatus: "idle", cwd: "/proj", ...over });

  test("by session id, by Herdr-reported path and id, by argv, and by folder only when unambiguous", async () => {
    const root = tmp();
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    mkdirSync(join(claude, "-proj"), { recursive: true });
    mkdirSync(join(codex, "2026", "11", "02"), { recursive: true });
    const id = "11111111-2222-3333-4444-555555555555";
    writeFileSync(join(claude, "-proj", `${id}.jsonl`), JSON.stringify({ type: "user", cwd: "/proj", message: { content: "hi" } }) + "\n");
    const old = join(claude, "-proj", "99999999-2222-3333-4444-555555555555.jsonl");
    writeFileSync(old, JSON.stringify({ type: "user", cwd: "/proj" }) + "\n");
    utimesSync(old, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
    writeFileSync(join(codex, "2026", "11", "02", "rollout-2026-11-02T14-16-30-abc-123.jsonl"), "");
    const omp = join(root, "omp.jsonl");
    writeFileSync(omp, "");
    const f = new TranscriptFinder({ claude, codex });
    const none = async () => [] as string[][];

    const c = pane({ agent: "claude" });
    expect(await f.resolve({ pane: c, panes: [c], knownSession: id, argv: none })).toEqual({ source: { agent: "claude", path: join(claude, "-proj", `${id}.jsonl`), how: "session" } });
    expect(await f.resolve({ pane: c, panes: [c], argv: async () => [["claude", "--resume", id]] })).toMatchObject({ source: { how: "session" } });
    expect(await f.resolve({ pane: c, panes: [c], argv: none })).toEqual({ source: { agent: "claude", path: join(claude, "-proj", `${id}.jsonl`), how: "folder" } }); // newest for the folder
    const twin = pane({ id: "w1:p2", agent: "claude" });
    expect(await f.resolve({ pane: c, panes: [c, twin], argv: none })).toEqual({ reason: "2 claude agents run in /proj; cannot tell which transcript is this one" });

    const x = pane({ agent: "codex", session: { kind: "id", value: "abc-123" } });
    expect(await f.resolve({ pane: x, panes: [x], argv: none })).toMatchObject({ source: { agent: "codex", how: "session" } });
    const o = pane({ agent: "omp", session: { kind: "path", value: omp } });
    expect(await f.resolve({ pane: o, panes: [o], argv: none })).toEqual({ source: { agent: "omp", path: omp, how: "session" } });
    expect(await f.resolve({ pane: pane({ agent: "omp" }), panes: [], argv: none })).toEqual({ reason: "omp has not reported its session to Herdr yet" });
    expect(await f.resolve({ pane: pane({}), panes: [], argv: none })).toEqual({ reason: "no agent in this pane" });
  });

  test("the tail returns only appended entries, survives partial lines, and resets when the file is rewritten", () => {
    const path = join(tmp(), "t.jsonl");
    const line = (text: string) => JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
    writeFileSync(path, line("one") + "\n");
    const t = new TranscriptTail({ agent: "omp", path, how: "session" });
    expect(blocks(t.read().ops)).toEqual([{ kind: "text", text: "one" }]);
    const two = line("two");
    appendFileSync(path, two.slice(0, 20));
    expect(t.read().ops).toEqual([]);
    appendFileSync(path, two.slice(20) + "\n");
    expect(blocks(t.read().ops)).toEqual([{ kind: "text", text: "two" }]);
    writeFileSync(path, line("fresh") + "\n");
    const r = t.read();
    expect(r.reset).toBe(true);
    expect(blocks(r.ops)).toEqual([{ kind: "text", text: "fresh" }]);
  });
});
