// Git operations for run isolation. All calls are explicit `git -C <dir>`; nothing touches the user's
// checked-out branch. Integration happens in a dedicated worktree that has af/<run>/main checked out.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

const AUTHOR = ["-c", "user.name=agent-flow", "-c", "user.email=agent-flow@localhost", "-c", "commit.gpgsign=false"];

export function git(dir: string, args: string[], opts: { allowFail?: boolean } = {}) {
  const r = Bun.spawnSync(["git", ...AUTHOR, "-C", dir, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const out = r.stdout.toString();
  const err = r.stderr.toString();
  if (r.exitCode !== 0 && !opts.allowFail) throw new GitError(`git ${args.join(" ")} failed in ${dir}: ${err.trim()}`, err);
  return { ok: r.exitCode === 0, out: out.trim(), err: err.trim() };
}

/** Git top-level for `cwd`, or undefined when it is not inside a work tree. */
export function repoRoot(cwd: string): string | undefined {
  const r = git(cwd, ["rev-parse", "--show-toplevel"], { allowFail: true });
  return r.ok ? r.out : undefined;
}

export const headCommit = (dir: string) => git(dir, ["rev-parse", "HEAD"]).out;

export const hasCommits = (dir: string) => git(dir, ["rev-parse", "--verify", "HEAD"], { allowFail: true }).ok;

/** Make sure `pattern` is in .git/info/exclude so run files never show up in the user's `git status`. */
export function ensureExcluded(repo: string, pattern: string) {
  const gitDir = git(repo, ["rev-parse", "--git-common-dir"]).out;
  const file = join(gitDir.startsWith("/") ? gitDir : join(repo, gitDir), "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!cur.split("\n").includes(pattern)) appendFileSync(file, `${cur.endsWith("\n") || cur === "" ? "" : "\n"}${pattern}\n`);
}

export const branchExists = (repo: string, branch: string) => git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true }).ok;

/** Create `branch` at `start` and check it out in a new worktree at `path`. Idempotent when the worktree already exists. */
export function addWorktree(repo: string, path: string, branch: string, start: string) {
  if (existsSync(join(path, ".git"))) return;
  mkdirSync(dirname(path), { recursive: true });
  if (branchExists(repo, branch)) git(repo, ["worktree", "add", path, branch]);
  else git(repo, ["worktree", "add", "-b", branch, path, start]);
}

export const isDirty = (wt: string) => git(wt, ["status", "--porcelain"]).out.length > 0;

/** Commit everything in `wt`. Returns the new commit, or undefined when there was nothing to commit. */
export function commitAll(wt: string, message: string): string | undefined {
  if (!isDirty(wt)) return undefined;
  git(wt, ["add", "-A"]);
  git(wt, ["commit", "-q", "--no-verify", "-m", message]);
  return headCommit(wt);
}

export type MergeResult = { ok: true; commit: string; changed: boolean } | { ok: false; files: string[] };

/** Merge `branch` into whatever `wt` has checked out. On conflict the merge is aborted and the conflicting files are returned. */
export function mergeInto(wt: string, branch: string, message: string): MergeResult {
  const before = headCommit(wt);
  const r = git(wt, ["merge", "--no-ff", "--no-edit", "-m", message, branch], { allowFail: true });
  if (r.ok) {
    const after = headCommit(wt);
    return { ok: true, commit: after, changed: after !== before };
  }
  const files = git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true }).out.split("\n").filter(Boolean);
  git(wt, ["merge", "--abort"], { allowFail: true });
  if (!files.length) throw new GitError(`merge of ${branch} failed in ${wt}: ${r.err}`, r.err);
  return { ok: false, files };
}

/** Bring a node branch up to date with the integration branch before a re-run. Returns false on conflict (left untouched). */
export function refreshFrom(wt: string, branch: string): boolean {
  const r = git(wt, ["merge", "--no-edit", branch], { allowFail: true });
  if (r.ok) return true;
  git(wt, ["merge", "--abort"], { allowFail: true });
  return false;
}

/** Changes on `branch` since it forked from `base` (three-dot diff). */
export const diffSince = (repo: string, base: string, branch: string, stat = false) =>
  git(repo, ["diff", ...(stat ? ["--stat"] : []), `${base}...${branch}`]).out;
