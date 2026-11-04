// Transcript parser for Gemini CLI. See common.ts for the shared pieces and the ChatOps a parser returns.
// ~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl (Gemini CLI 0.66): not written yet.
import type { ChatOp } from "@af/core";
import type { ParseCtx } from "./common.ts";

export function parseGemini(_line: any, _ctx: ParseCtx): ChatOp[] {
  return [];
}
