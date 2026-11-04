// Fork an agent's conversation into a new agent in a new pane.
//
//   claude, omp: copy the transcript file (all of it, or up to a fork point: the byte where a user message
//                starts) under a new session id, then start the agent resuming the copy. The original
//                conversation is never touched. Verified with both CLIs: the copy resumes with exactly the
//                history before the fork point.
//   codex:       `codex fork <session id>` (whole conversation only).
//   gemini:      copy the session file (~/.gemini/tmp/<project>/chats/session-<time>-<id8>.jsonl) under a new
//                session id, then `gemini --resume <new id>` (it looks the id up in the project's chats folder).
//                Gemini writes a message again when it changes (same id, a later line), so a fork point is cut
//                where the user message's record first appears: everything before that line is the conversation
//                as it was when the message was sent. Verified with Gemini CLI 0.66: the copy resumes with the
//                history before the fork point.

import { basename, dirname, join } from "node:path";
import type { ChatSource } from "@af/core";
import type { TranscriptFS } from "./transcripts/index.ts";
import { AfError } from "./errors.ts";
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
  /** The new session, when we know it now (claude, omp, gemini). */
  session?: { id: string; path: string };
}

/** Create the forked conversation (if the agent needs a file) and say how to start the agent on it. */
export async function prepareFork(fs: TranscriptFS, source: ChatSource, before: number | undefined, newId = crypto.randomUUID()): Promise<ForkPlan> {
  if (source.agent === "gemini") return geminiFork(fs, source, before, newId);
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

/** Gemini names its files by the first 8 characters of the session id; the whole id is in the first line. */
async function geminiFork(fs: TranscriptFS, source: ChatSource, before: number | undefined, newId: string): Promise<ForkPlan> {
  const head = await lineFrom(fs, source.path, 0);
  const oldId = typeof head?.sessionId === "string" ? head.sessionId : undefined;
  if (!oldId || !UUID.test(oldId)) throw new AfError("no_session_id", `cannot tell the session id from ${basename(source.path)}`);
  let cut: number | undefined;
  if (before !== undefined) {
    if (!Number.isInteger(before) || before <= 0) throw new AfError("bad_fork_point", "the fork point must be a byte offset");
    const entry = await lineFrom(fs, source.path, before);
    if (entry?.type !== "user" || typeof entry.id !== "string" || (await lineBefore(fs, source.path, before)) === undefined) throw new AfError("bad_fork_point", "the fork point is not one of the user's messages");
    const at = await geminiCut(fs, source.path, entry.id, before);
    // nothing answered before it (the first message): Gemini does not resume a conversation without a reply, so the
    // fork is a new conversation (its file is named when Gemini starts: no session to remember yet)
    if (!at.replied) return { args: ["--session-id", newId] };
    cut = at.offset;
  }
  // the name Gemini gives a new session: session-<YYYY-MM-DDTHH-MM>-<first 8 of the id>.jsonl
  const path = join(dirname(source.path), `session-${new Date().toISOString().slice(0, 16).replace(/:/g, "-")}-${newId.slice(0, 8)}.jsonl`);
  await fs.copyPrefix(source.path, path, cut, oldId, newId);
  return { args: ["--resume", newId], session: { id: newId, path } };
}

/**
 * Where to cut a Gemini session for a fork before message `id` (its line at `end`): the first line that records it
 * (or `end`), and whether a reply from Gemini comes before that.
 */
async function geminiCut(fs: TranscriptFS, path: string, id: string, end: number): Promise<{ offset: number; replied: boolean }> {
  const r = await fs.readFrom(path, 0, end);
  if (!r) throw new AfError("fork_failed", "the conversation file is gone");
  const needle = Buffer.from(JSON.stringify(id));
  const reply = Buffer.from('"type":"gemini"');
  let replied = false;
  for (let at = 0; at < r.data.length; ) {
    const nl = r.data.indexOf(10, at);
    const line = r.data.subarray(at, nl < 0 ? r.data.length : nl);
    if (line.includes(needle) || line.includes(reply)) {
      try {
        const rec = JSON.parse(line.toString("utf8"));
        if (rec?.id === id && !("$patch" in rec)) return { offset: at, replied };
        if (rec?.type === "gemini") replied = true;
      } catch {}
    }
    if (nl < 0) break;
    at = nl + 1;
  }
  return { offset: end, replied };
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
