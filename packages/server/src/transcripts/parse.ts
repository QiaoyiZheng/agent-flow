// The transcript parsers, one file per agent under parse/. See parse/common.ts.

import type { ChatOp } from "@af/core";
import { parseClaude } from "./parse/claude.ts";
import { parseCodex } from "./parse/codex.ts";
import type { Agent, ParseCtx } from "./parse/common.ts";
import { parseOmp } from "./parse/omp.ts";
import { parseGemini } from "./parse/gemini.ts";

export { diffLines, hunksToPatch, partsOf } from "./parse/common.ts";
export type { Agent, ParseCtx } from "./parse/common.ts";
export { parseClaude, parseCodex, parseGemini, parseOmp };

export const PARSERS: Record<Agent, (line: any, ctx: ParseCtx) => ChatOp[]> = { claude: parseClaude, codex: parseCodex, omp: parseOmp, gemini: parseGemini };
