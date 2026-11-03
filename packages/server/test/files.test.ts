import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReadable, expandPath, findFiles, listDir, statPath } from "../src/files.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function tree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "af-files-")));
  dirs.push(root);
  for (const d of ["docs", "src/web", "node_modules/pkg", ".git", "Notes 10", "Notes 9"]) mkdirSync(join(root, d), { recursive: true });
  for (const f of ["README.md", "docs/design.md", "docs/usage.md", "src/web/AgentView.tsx", "src/web/App.tsx", "node_modules/pkg/AgentView.tsx", ".env", "b.txt", "a.txt"]) writeFileSync(join(root, f), f);
  return root;
}

describe("browsing local files", () => {
  test("a folder lists folders first, then files, in natural order; dot files only when asked", () => {
    const root = tree();
    const l = listDir(root, [root]);
    expect(l.entries.map((e) => e.name)).toEqual(["docs", "node_modules", "Notes 9", "Notes 10", "src", "a.txt", "b.txt", "README.md"]);
    expect(l.hiddenCount).toBe(2);
    expect(l.parent).toBeDefined();
    expect(listDir(root, [root], true).entries.map((e) => e.name)).toContain(".env");
    // a file lists its folder
    expect(listDir(join(root, "docs/design.md"), [root]).path).toBe(join(root, "docs"));
  });

  test("reads stay inside the allowed folders", () => {
    const root = tree();
    expect(() => listDir("/etc", [root])).toThrow(/outside/);
    expect(() => listDir(join(root, "../.."), [root])).toThrow(/outside/);
    expect(() => checkReadable("relative/path", [root])).toThrow(/absolute/);
    expect(checkReadable(join(root, "docs/../README.md"), [root])).toBe(join(root, "README.md"));
    expect(expandPath("~/x")).toEndWith("/x");
    expect(() => listDir(join(root, "nope"), [root])).toThrow(/does not exist/);
  });

  test("find by name: words in order anywhere in the path, names first, skipping node_modules", () => {
    const root = tree();
    const f = findFiles(root, "agentview", [root]);
    expect(f.results.map((r) => r.rel)).toEqual([join("src", "web", "AgentView.tsx")]);
    expect(findFiles(root, "docs md", [root]).results.map((r) => r.rel).sort()).toEqual([join("docs", "design.md"), join("docs", "usage.md")]);
    expect(findFiles(root, "readme", [root]).results[0]!.rel).toBe("README.md");
    expect(findFiles(root, "   ", [root]).results).toEqual([]);
  });

  test("stat tells a file's size and change time", () => {
    const root = tree();
    const s = statPath(join(root, "README.md"), [root]);
    expect(s).toMatchObject({ name: "README.md", dir: false, size: "README.md".length });
    expect(s.mtime).toBeGreaterThan(0);
  });
});
