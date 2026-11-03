// Transcript parser for codex. See common.ts for the shared pieces and the ChatOps a parser returns.
import type { ChatOp } from "@af/core";
import { type ParseCtx, add, clip, describeTool, oneLine, str, textOf, tool, userOrNotice } from "./common.ts";

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
