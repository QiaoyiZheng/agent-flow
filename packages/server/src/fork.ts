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
import { sq } from "./remote.ts";

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
  // omp resumes the branch that ends at the file's last entry: if the copy would end on another branch (the user went
  // back and re-asked before the fork point), add a marker entry that moves the leaf to the fork point's parent
  const leafFix = source.agent === "omp" && before !== undefined ? await ompLeafMarker(fs, source.path, before) : undefined;
  await fs.copyPrefix(source.path, path, before, oldId, newId);
  if (leafFix) {
    const ok = await fs.sh(`printf '%s\\n' ${sq(leafFix)} >> ${sq(path)} && echo ok`);
    if (ok.trim() !== "ok") throw new AfError("fork_failed", "could not finish the forked conversation");
  }
  return {
    args: source.agent === "claude" ? ["--resume", newId] : [`--resume=${path}`],
    session: { id: newId, path },
  };
}

/**
 * omp keeps a session as a tree (entries have id and parentId) and resumes the branch that ends at the file's last
 * entry. A copy cut at `before` ends with whatever line comes before the fork point, which can be on a branch the user
 * left. Returns the line to append so the copy's last entry is the fork point's parent (an empty branch_summary: omp's
 * own metadata-only marker for moving the leaf), or undefined when the cut already ends there.
 */
export async function ompLeafMarker(fs: TranscriptFS, path: string, before: number): Promise<string | undefined> {
  if (before === 0) return undefined;
  const entry = await lineFrom(fs, path, before);
  if (!entry || typeof entry.id !== "string" || !("parentId" in entry)) return undefined;
  const parent: string | null = typeof entry.parentId === "string" ? entry.parentId : null;
  const last = await lineBefore(fs, path, before);
  if (last === undefined) return undefined;
  const leaf: string | null = last && typeof last.id === "string" && "parentId" in last ? last.id : null;
  if (leaf === parent) return undefined;
  return JSON.stringify({ type: "branch_summary", id: crypto.randomUUID().slice(-8), parentId: parent, timestamp: new Date().toISOString(), fromId: parent ?? "root", summary: "" });
}

/** The JSON line that starts at byte `at` (lines can be megabytes: read more until its end). */
async function lineFrom(fs: TranscriptFS, path: string, at: number): Promise<any> {
  for (let n = 64 * 1024; n <= 256 * 1024 * 1024; n *= 8) {
    const r = await fs.readFrom(path, at, n);
    if (!r) return undefined;
    const nl = r.data.indexOf(10);
    if (nl < 0 && r.data.length >= n) continue;
    try {
      return JSON.parse(r.data.subarray(0, nl < 0 ? r.data.length : nl).toString("utf8"));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The JSON line that ends just before byte `end`: null if it is not JSON, undefined if `end` does not start a line. */
async function lineBefore(fs: TranscriptFS, path: string, end: number): Promise<any> {
  for (let n = 64 * 1024; ; n *= 8) {
    const from = Math.max(0, end - n);
    const r = await fs.readFrom(path, from, end - from);
    if (!r || r.data.length !== end - from || r.data[r.data.length - 1] !== 10) return undefined;
    const nl = r.data.lastIndexOf(10, r.data.length - 2);
    if (nl < 0 && from > 0) continue;
    try {
      return JSON.parse(r.data.subarray(nl + 1, r.data.length - 1).toString("utf8"));
    } catch {
      return null;
    }
  }
}
