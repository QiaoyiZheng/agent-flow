// Transcript parser for omp. See common.ts for the shared pieces and the ChatOps a parser returns.
import type { ChatOp } from "@af/core";
import { type ParseCtx, add, clip, describeTool, oneLine, str, textOf, tool, userOrNotice } from "./common.ts";

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
