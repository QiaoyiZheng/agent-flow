// A quick look at the end of an agent's conversation, for watching team members (docs/design.md 4.6): what it said
// last (its reply after the last user message), whether its last turn ended in an error, and how long the file is
// (a file that stops growing while the agent works may mean it is stuck).

import type { ChatBlock, ChatOp } from "@af/core";
import { PARSERS, type Agent } from "./parse.ts";
import type { TranscriptFS } from "./index.ts";

export interface Peek {
  /** The assistant's prose since the last message typed in (the user's, or agent-flow's own), as written. */
  reply?: string;
  /** The last error notice since the last user message (an API error, a failed request). */
  error?: string;
  /** The transcript's size in bytes. */
  size?: number;
  /** The last message typed in ("/command args" for a skill or custom command; agent-flow's own "[agent-flow] …"). */
  lastUser?: string;
  /** When it was written (ISO), if the transcript says. */
  lastUserAt?: string;
  /** Tokens in its context after its last turn, and the window's size (as the footer's meter shows them). */
  contextTokens?: number;
  contextWindow?: number;
}

const TAIL = 2 * 1024 * 1024;

/** Parse the last part of a transcript and return what the agent said last. */
export async function peekTranscript(fs: TranscriptFS, agent: Agent, path: string): Promise<Peek | undefined> {
  const head = await fs.readFrom(path, 0, 0);
  if (!head) return undefined;
  const from = Math.max(0, head.size - TAIL);
  const chunk = await fs.readFrom(path, from, TAIL);
  if (!chunk) return { size: head.size };
  const text = chunk.data.toString("utf8");
  // a read from the middle of the file starts inside a line: drop that part
  const lines = (from > 0 ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
  return { ...lastReply(agent, lines), size: chunk.size };
}

/** The reply and error after the last user message, from transcript lines (oldest first). */
export function lastReply(agent: Agent, lines: string[]): Omit<Peek, "size"> {
  const parse = PARSERS[agent];
  const ctx = { n: 0 };
  // entries by key, in order; a later "add" with the same key replaces it, "remove" takes it out (gemini rewrites)
  const entries = new Map<string, ChatBlock>();
  const times = new Map<ChatBlock, string | undefined>();
  const meta: { contextTokens?: number; contextWindow?: number } = {};
  for (const line of lines) {
    if (line.length < 2) continue;
    let ops: ChatOp[];
    try {
      ops = parse(JSON.parse(line), ctx);
    } catch {
      continue;
    }
    for (const op of ops) {
      if (op.op === "add") (entries.set(op.entry.key, op.entry.block), times.set(op.entry.block, op.entry.at));
      else if (op.op === "remove") for (const k of op.keys) entries.delete(k);
      else if (op.op === "meta") {
        if (op.meta.contextTokens !== undefined) meta.contextTokens = op.meta.contextTokens;
        if (op.meta.contextWindow !== undefined) meta.contextWindow = op.meta.contextWindow;
      }
    }
  }
  const blocks = [...entries.values()];
  // a turn starts with a message typed in: the user's, or agent-flow's own (shown as a notice: "[agent-flow] …")
  const typedIn = (b: ChatBlock) => b.kind === "user" || (b.kind === "notice" && b.text.startsWith("[agent-flow]"));
  let last = -1;
  blocks.forEach((b, i) => {
    if (typedIn(b)) last = i;
  });
  const after = blocks.slice(last + 1);
  const reply = after
    .filter((b): b is Extract<ChatBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const err = [...after].reverse().find((b) => b.kind === "notice" && b.tone === "error") as Extract<ChatBlock, { kind: "notice" }> | undefined;
  // an error counts only when nothing came after it: the agent went on after an error it recovered from
  const tail = after.at(-1);
  const u = blocks[last];
  const lastUser = u?.kind === "user" ? (u.command ? `${u.command} ${u.text}`.trim() : u.text) : u?.kind === "notice" ? u.text : undefined;
  const lastUserAt = u ? times.get(u) : undefined;
  return { reply: reply || undefined, error: err && tail === err ? err.detail ?? err.text : undefined, lastUser, ...(lastUserAt ? { lastUserAt } : {}), ...meta };
}

/** An error that goes away by itself: rate limits, overload, server errors, dropped connections, timeouts. */
export const TRANSIENT = /\b(429|5\d\d)\b|rate.?limit|overloaded|too many requests|temporar|unavailable|ECONNRESET|ETIMEDOUT|socket hang up|connection (reset|error|closed)|network|timed? ?out|fetch failed|stream (error|disconnected)/i;
