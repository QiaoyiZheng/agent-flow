// Transcript parser for claude. See common.ts for the shared pieces and the ChatOps a parser returns.
import type { ChatOp } from "@af/core";
import { type ParseCtx, add, clip, describeTool, oneLine, str, textOf, tool, userOrNotice } from "./common.ts";

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
