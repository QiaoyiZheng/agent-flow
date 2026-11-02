import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addWorktree, commitAll, diffSince, ensureExcluded, git, headCommit, isDirty, mergeInto, refreshFrom, repoRoot } from "../src/git.ts";

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "af-git-"));
  roots.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "app.txt"), "line1\nline2\nline3\n");
  commitAll(dir, "init");
  return dir;
}

describe("git isolation", () => {
  let r: string;
  beforeEach(() => (r = repo()));

  test("repoRoot finds the top level, and is undefined outside a repo", () => {
    expect(repoRoot(r)).toBe(realpathSync(r));
    mkdirSync(join(r, "sub/deeper"), { recursive: true });
    expect(repoRoot(join(r, "sub/deeper"))).toBe(realpathSync(r));
    const plain = mkdtempSync(join(tmpdir(), "af-plain-"));
    roots.push(plain);
    expect(repoRoot(plain)).toBeUndefined();
  });

  test("worktrees under .agent-flow stay out of the user's git status", () => {
    ensureExcluded(r, ".agent-flow/");
    ensureExcluded(r, ".agent-flow/"); // idempotent
    addWorktree(r, join(r, ".agent-flow/worktrees/r1/_main"), "af/r1/main", "HEAD");
    expect(isDirty(r)).toBe(false);
    const excl = readFileSync(join(r, ".git/info/exclude"), "utf8");
    expect(excl.split("\n").filter((l) => l === ".agent-flow/").length).toBe(1);
    expect(git(r, ["branch", "--show-current"]).out).toBe("main");
  });

  test("node branch → integration merge, then a conflicting parallel node is reported and aborted", () => {
    ensureExcluded(r, ".agent-flow/");
    const base = headCommit(r);
    const integ = join(r, ".agent-flow/worktrees/r1/_main");
    addWorktree(r, integ, "af/r1/main", base);
    const a = join(r, ".agent-flow/worktrees/r1/a");
    const b = join(r, ".agent-flow/worktrees/r1/b");
    addWorktree(r, a, "af/r1/node/a", "af/r1/main");
    addWorktree(r, b, "af/r1/node/b", "af/r1/main");
    writeFileSync(join(a, "app.txt"), "line1\nA\nline3\n");
    writeFileSync(join(b, "app.txt"), "line1\nB\nline3\n");
    expect(commitAll(a, "a#1")).toBeString();
    expect(commitAll(b, "b#1")).toBeString();
    expect(commitAll(b, "nothing")).toBeUndefined();
    expect(git(a, ["log", "-1", "--format=%an"]).out).toBe("agent-flow");

    const m1 = mergeInto(integ, "af/r1/node/a", "merge a#1");
    expect(m1.ok).toBe(true);
    expect(readFileSync(join(integ, "app.txt"), "utf8")).toContain("A");

    const m2 = mergeInto(integ, "af/r1/node/b", "merge b#1");
    expect(m2).toEqual({ ok: false, files: ["app.txt"] });
    expect(isDirty(integ)).toBe(false); // aborted cleanly
    expect(diffSince(r, "af/r1/main", "af/r1/node/b")).toContain("+B");

    // b resolves by refreshing from integration: conflict, so refresh refuses and leaves b untouched
    expect(refreshFrom(b, "af/r1/main")).toBe(false);
    expect(isDirty(b)).toBe(false);
    // user's branch never moved
    expect(git(r, ["rev-parse", "main"]).out).toBe(base);
  });

  test("a re-run refreshes its branch from integration without conflicts", () => {
    const integ = join(r, ".agent-flow/worktrees/r1/_main");
    addWorktree(r, integ, "af/r1/main", "HEAD");
    const a = join(r, ".agent-flow/worktrees/r1/a");
    const c = join(r, ".agent-flow/worktrees/r1/c");
    addWorktree(r, a, "af/r1/node/a", "af/r1/main");
    addWorktree(r, c, "af/r1/node/c", "af/r1/main");
    writeFileSync(join(c, "other.txt"), "c\n");
    commitAll(c, "c#1");
    expect(mergeInto(integ, "af/r1/node/c", "merge c#1").ok).toBe(true);
    expect(refreshFrom(a, "af/r1/main")).toBe(true);
    expect(readFileSync(join(a, "other.txt"), "utf8")).toBe("c\n");
  });
});
