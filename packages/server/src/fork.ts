// Fork an agent's conversation into a new agent in a new pane.
//
//   claude, omp: copy the transcript file (all of it, or up to a fork point: the byte where a user message
//                starts) under a new session id, then start the agent resuming the copy. The original
//                conversation is never touched. Verified with both CLIs: the copy resumes with exactly the
//                history before the fork point.
//   codex:       `codex fork <session id>` (whole conversation only).

import { basename, dirname, join } from "node:path";
import type { ChatSource } from "@af/core";
import type { TranscriptFS } from "./transcripts/index.ts";
import { AfError } from "./orchestrator.ts";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function sessionIdOf(source: ChatSource): string {
  const m = basename(source.path).match(new RegExp(`(${UUID.source})\\.jsonl$`, "i"));
  if (!m) throw new AfError("no_session_id", `cannot tell the session id from ${basename(source.path)}`);
  return m[1]!;
}

export interface ForkPlan {
  /** Arguments for the agent's command line in the new pane. */
  args: string[];
  /** The new session, when we know it now (claude, omp). */
  session?: { id: string; path: string };
}

/** Create the forked conversation (if the agent needs a file) and say how to start the agent on it. */
export async function prepareFork(fs: TranscriptFS, source: ChatSource, before: number | undefined, newId = crypto.randomUUID()): Promise<ForkPlan> {
  const oldId = sessionIdOf(source);
  if (source.agent === "codex") {
    if (before !== undefined) throw new AfError("fork_point_unsupported", "codex can only fork the whole conversation");
    // no update prompt (it would block the new pane); keep scrollback for the UI
    return { args: ["fork", "-c", "check_for_update_on_startup=false", "--no-alt-screen", oldId] };
  }
  const dir = dirname(source.path);
  const path =
    source.agent === "claude"
      ? join(dir, `${newId}.jsonl`)
      : // omp names sessions "<time>_<id>.jsonl"
        join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${newId}.jsonl`);
  if (before !== undefined && (!Number.isInteger(before) || before < 0)) throw new AfError("bad_fork_point", "the fork point must be a byte offset");
  await fs.copyPrefix(source.path, path, before, oldId, newId);
  return {
    args: source.agent === "claude" ? ["--resume", newId] : [`--resume=${path}`],
    session: { id: newId, path },
  };
}
