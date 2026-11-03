// Parsers for the agents' own transcript files. The formats are internal to each agent and undocumented,
// so every field is read defensively: an unknown line is skipped, never fatal.
//
// Each parser is fed one JSONL line at a time and returns ChatOps: "add" for a new entry, "result" when a
// tool call finishes (results arrive in a later line than their call).

import type { ChatBlock, ChatOp } from "@af/core";

export type Agent = "claude" | "codex" | "omp";

const MAX_OUTPUT = 6000;
const clip = (s: string, n = MAX_OUTPUT) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v, null, 2));
const oneLine = (s: string, n = 160) => {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};

/** Text a human typed versus text an agent harness injected. */
function userOrNotice(text: string): ChatBlock | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return { kind: "notice", text: `${cmd[1]!.trim()}${args ? ` ${args}` : ""}` };
  }
  if (/^<local-command-(stdout|stderr|caveat)>/.test(t)) return undefined;
  if (t.startsWith("[agent-flow]")) return { kind: "notice", text: t };
  if (/^\[Request interrupted/.test(t)) return { kind: "notice", text: "interrupted" };
  const cleaned = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return cleaned ? { kind: "user", text: cleaned } : undefined;
}

/** A tool call's one-line summary and the parts worth showing, from its name and input. */
function describeTool(name: string, input: any): Pick<Extract<ChatBlock, { kind: "tool" }>, "summary" | "input" | "patch" | "edit"> {
  const n = name.toLowerCase();
  const i = input && typeof input === "object" ? input : {};
  const path = i.file_path ?? i.path ?? i.notebook_path ?? i.filePath;
  if (n === "bash" || n === "shell" || n === "exec" || n === "exec_command" || n === "local_shell") {
    const cmd = Array.isArray(i.command) ? i.command.join(" ") : (i.command ?? i.cmd ?? (typeof input === "string" ? input : ""));
    return { summary: oneLine(str(cmd)), input: str(cmd).length > 160 ? str(cmd) : undefined };
  }
  if ((n === "edit" || n === "str_replace" || n === "replace") && path && (i.old_string !== undefined || i.old_str !== undefined))
    return { summary: path, edit: { path, before: str(i.old_string ?? i.old_str), after: str(i.new_string ?? i.new_str) } };
  if (n === "multiedit" && path && Array.isArray(i.edits))
    return { summary: `${path} (${i.edits.length} edits)`, patch: i.edits.map((e: any) => `@@\n${diffLines(str(e.old_string), str(e.new_string))}`).join("\n") };
  if ((n === "write" || n === "create") && path) return { summary: path, edit: { path, before: "", after: clip(str(i.content ?? i.file_text ?? i.text), 20000) } };
  if (n === "apply_patch" || (typeof input === "string" && input.includes("*** Begin Patch"))) {
    const patch = typeof input === "string" ? input : str(i.patch ?? i.input);
    const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]);
    return { summary: files.join(", ") || "patch", patch };
  }
  // omp's edit tool: {i: "<intent>", input: "[path#hash]\n<ops>"}
  const ompTarget = typeof i.input === "string" ? i.input.match(/^\[([^\]#\n]+)(?:#[^\]]*)?\]/) : null;
  if (ompTarget) return { summary: `${ompTarget[1]}${i.i ? ` — ${oneLine(str(i.i), 80)}` : ""}`, patch: i.input };
  if (path) return { summary: `${path}${i.offset ? ` @${i.offset}` : ""}` };
  if (i.pattern) return { summary: `${i.pattern}${i.path ? ` in ${i.path}` : ""}` };
  if (i.url) return { summary: i.url };
  if (i.query) return { summary: oneLine(str(i.query)) };
  if (i.description) return { summary: oneLine(str(i.description)), input: str(i.prompt ?? "") || undefined };
  const s = str(input);
  if (s === "{}" || s === "") return { summary: "" };
  return { summary: oneLine(s), input: s.length > 160 ? s : undefined };
}

/** A minimal line diff for display: removed lines, then added lines. */
export function diffLines(before: string, after: string) {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  return [...a.slice(Math.max(0, start - 2), start).map((l) => ` ${l}`), ...a.slice(start, endA).map((l) => `-${l}`), ...b.slice(start, endB).map((l) => `+${l}`), ...a.slice(endA, endA + 2).map((l) => ` ${l}`)].join("\n");
}

const tool = (id: string, name: string, input: unknown): ChatBlock => ({ kind: "tool", id, name, done: false, ...describeTool(name, input) });

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => (typeof c === "string" ? c : c?.type === "text" || c?.type === "input_text" || c?.type === "output_text" ? (c.text ?? "") : c?.type === "image" ? "[image]" : "")).join("")
      : "";

export interface ParseCtx {
  n: number;
  /** claude: prompts already shown from a queued_command, so a later plain copy is not shown twice. */
  queued?: Set<string>;
}

const add = (ctx: ParseCtx, block: ChatBlock | undefined, at?: string): ChatOp[] => (block ? [{ op: "add", entry: { key: `e${++ctx.n}`, at, block } }] : []);

// ------------------------------------------------------------------------------------------------
// claude: ~/.claude/projects/<slug>/<session>.jsonl
//   {type:"user"|"assistant", isMeta?, isSidechain?, timestamp, message:{role, content: string | [{type:text|thinking|tool_use|tool_result, ...}]}}

export function parseClaude(line: any, ctx: ParseCtx): ChatOp[] {
  // a message typed while the agent was working: claude records it as a queued_command attachment
  if (line?.type === "attachment" && line.attachment?.type === "queued_command" && !line.isSidechain) {
    const a = line.attachment;
    if ((a.origin?.kind && a.origin.kind !== "human") || (a.commandMode && a.commandMode !== "prompt")) return [];
    const text = typeof a.prompt === "string" ? a.prompt : textOf(a.prompt);
    (ctx.queued ??= new Set()).add(text.trim());
    return add(ctx, userOrNotice(text), a.timestamp ?? line.timestamp);
  }
  if (!line || (line.type !== "user" && line.type !== "assistant") || line.isMeta || line.isSidechain) return [];
  const at = line.timestamp;
  const content = line.message?.content;
  const ops: ChatOp[] = [];
  const userText = (t: string) => {
    if (ctx.queued?.delete(t.trim())) return undefined; // already shown when it was queued
    return userOrNotice(t);
  };
  if (typeof content === "string") return line.type === "user" ? add(ctx, userText(content), at) : add(ctx, { kind: "text", text: content }, at);
  for (const p of Array.isArray(content) ? content : []) {
    if (p?.type === "text" && p.text) ops.push(...add(ctx, line.type === "user" ? userText(p.text) : { kind: "text", text: p.text }, at));
    else if (p?.type === "tool_use") ops.push(...add(ctx, tool(p.id, p.name ?? "tool", p.input), at));
    else if (p?.type === "tool_result") ops.push({ op: "result", id: p.tool_use_id, output: clip(textOf(p.content)), error: !!p.is_error });
  }
  return ops;
}

// ------------------------------------------------------------------------------------------------
// codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
//   {type:"response_item", payload:{type:"message"|"function_call"|"function_call_output"|"custom_tool_call"|"custom_tool_call_output"|"reasoning", ...}}

const CODEX_INJECTED = /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>|<permissions instructions>|<turn_aborted>)/;

/** codex's code-mode `exec` tool wraps the shell command in JavaScript: pull the command back out. */
function codexExecCommand(input: string): string | undefined {
  const m = input.match(/\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return undefined;
  }
}

/** codex wraps tool output in a banner plus a JSON record; show the command's own output. */
function codexOutput(raw: unknown): string {
  const text = textOf(raw) || str(raw);
  const json = text.indexOf("{");
  if (json >= 0) {
    try {
      const rec = JSON.parse(text.slice(json));
      if (typeof rec.output === "string") return rec.output + (rec.exit_code ? `\n(exit ${rec.exit_code})` : "");
    } catch {}
  }
  return text;
}

export function parseCodex(line: any, ctx: ParseCtx): ChatOp[] {
  if (line?.type !== "response_item") return [];
  const p = line.payload ?? {};
  const at = line.timestamp;
  switch (p.type) {
    case "message": {
      const text = textOf(p.content);
      if (p.role === "assistant") return add(ctx, text.trim() ? { kind: "text", text } : undefined, at);
      if (p.role === "user" && !CODEX_INJECTED.test(text.trim())) return add(ctx, userOrNotice(text), at);
      return [];
    }
    case "function_call": {
      let args: any = p.arguments;
      try {
        args = JSON.parse(p.arguments);
      } catch {}
      return add(ctx, tool(p.call_id ?? p.id, p.name ?? "tool", args), at);
    }
    case "custom_tool_call": {
      const input = str(p.input);
      const cmd = p.name === "exec" ? codexExecCommand(input) : undefined;
      return add(ctx, tool(p.call_id ?? p.id, cmd ? "bash" : (p.name ?? "tool"), cmd ? { command: cmd } : input), at);
    }
    case "agent_message": {
      // a message between codex's own subagents (its payload is encrypted)
      const from = typeof p.author === "string" ? p.author : "a subagent";
      const to = typeof p.recipient === "string" ? p.recipient : "";
      return add(ctx, { kind: "notice", text: `subagent message ${from}${to ? ` → ${to}` : ""}` }, at);
    }
    case "local_shell_call":
      return add(ctx, tool(p.call_id ?? p.id, "bash", { command: p.action?.command }), at);
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output": {
      const out = typeof p.output === "object" && p.output && !Array.isArray(p.output) ? p.output.content : p.output;
      return [{ op: "result", id: p.call_id, output: clip(codexOutput(out)), error: p.output?.success === false }];
    }
  }
  return [];
}

// ------------------------------------------------------------------------------------------------
// omp: ~/.omp/agent/sessions/<slug>/<time>_<id>.jsonl
//   {type:"message", timestamp, message:{role:"user"|"assistant"|"toolResult", content:[{type:text|toolCall|thinking}], toolCallId?, isError?}}

export function parseOmp(line: any, ctx: ParseCtx): ChatOp[] {
  if (line?.type !== "message") return [];
  const m = line.message ?? {};
  const at = line.timestamp;
  if (m.role === "toolResult") return [{ op: "result", id: m.toolCallId, output: clip(textOf(m.content)), error: !!m.isError }];
  const ops: ChatOp[] = [];
  for (const p of Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : []) {
    if (p?.type === "text" && p.text) ops.push(...add(ctx, m.role === "user" ? userOrNotice(p.text) : { kind: "text", text: p.text }, at));
    else if (p?.type === "toolCall") {
      let args = p.arguments;
      if ((!args || !Object.keys(args).length) && p.partialArgs)
        try {
          args = JSON.parse(p.partialArgs);
        } catch {}
      ops.push(...add(ctx, tool(p.id, p.name ?? "tool", args), at));
    }
  }
  return ops;
}

export const PARSERS: Record<Agent, (line: any, ctx: ParseCtx) => ChatOp[]> = { claude: parseClaude, codex: parseCodex, omp: parseOmp };
