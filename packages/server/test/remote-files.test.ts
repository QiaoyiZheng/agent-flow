import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, contentType, parseFindLines, remoteChangedDocuments, remoteFind, remoteList, remotePath, remoteRead, remoteStat } from "../src/remote-files.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "af-rfiles-")));
  dirs.push(d);
  return d;
};

// the commands run in a local shell, as they would over SSH on the machine; GNU find is needed (Linux has it)
const gfind = Bun.which("gfind") ?? Bun.which("bfs") ?? (Bun.spawnSync(["find", "--version"], { stderr: "ignore" }).exitCode === 0 ? "find" : undefined);
const exec: Exec = async (cmd, opts = {}) => {
  const c = gfind && gfind !== "find" ? cmd.replace(/(^|[\s;|(])find /g, `$1${gfind} `) : cmd;
  const p = Bun.spawnSync(["sh", "-c", c], { stdin: Buffer.from(opts.stdin ?? new Uint8Array()), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: Buffer.from(p.stdout), err: p.stderr.toString() };
};

describe("files on a remote machine, read over SSH", () => {
  test("paths: absolute, ~ as that machine's home; nothing else", () => {
    expect(remotePath("~/proj/a.md", "/home/u")).toBe("/home/u/proj/a.md");
    expect(remotePath("/data/x/", "/home/u")).toBe("/data/x");
    expect(() => remotePath("proj/a.md", "/home/u")).toThrow(/absolute/);
    expect(() => remotePath("/a\nb")).toThrow(/absolute/);
    expect(contentType("/a/b.PNG")).toBe("image/png");
    expect(contentType("/a/b.md")).toContain("text/plain");
    expect(parseFindLines("d\t4096\t1793850000.5\t/p/sub\nf\t12\t1793850001\t/p/a b.md\n")).toEqual([
      { name: "sub", path: "/p/sub", dir: true, size: 4096, mtime: 1793850000500 },
      { name: "a b.md", path: "/p/a b.md", dir: false, size: 12, mtime: 1793850001000 },
    ]);
  });

  test("stat and read; a missing file says so", async () => {
    const d = tmp();
    writeFileSync(join(d, "r.md"), "# Report\n");
    const st = await remoteStat(exec, join(d, "r.md"));
    expect([st.dir, st.size, st.name]).toEqual([false, 9, "r.md"]);
    expect((await remoteStat(exec, d)).dir).toBe(true);
    expect((await remoteRead(exec, join(d, "r.md"))).toString()).toBe("# Report\n");
    expect((await remoteRead(exec, join(d, "r.md"), undefined, 3)).toString()).toBe("# R");
    await expect(remoteStat(exec, join(d, "nope.md"))).rejects.toThrow(/does not exist/);
    await expect(remoteRead(exec, d)).rejects.toThrow(/not a file/);
  });

  test.if(!!gfind)("a folder, a search, and the documents an agent changed in its turn", async () => {
    const d = tmp();
    for (const s of ["docs", "node_modules/x", ".claude", "sub"]) mkdirSync(join(d, s), { recursive: true });
    const old = Date.now() / 1000 - 3600;
    const write = (rel: string, text = "x", mtime?: number) => {
      writeFileSync(join(d, rel), text);
      if (mtime) utimesSync(join(d, rel), mtime, mtime);
    };
    write("docs/old.md", "old", old);
    write("docs/report.md", "new");
    write("docs/table.xlsx", "PK");
    write("src.ts", "code");
    write("node_modules/x/README.md", "dep");
    write(".claude/plan.md", "agent");
    write("docs/empty.md", "");
    write(".hidden.md", "h");
    const l = await remoteList(exec, d, d);
    expect(l.entries.map((e) => `${e.name}${e.dir ? "/" : ""}`)).toEqual(["docs/", "node_modules/", "sub/", "src.ts"]);
    expect(l.hiddenCount).toBe(2);
    expect(l.parent).toBe(d.replace(/\/[^/]+$/, ""));
    expect((await remoteList(exec, join(d, "docs", "report.md"))).path).toBe(join(d, "docs")); // a file: its folder
    expect((await remoteFind(exec, d, "docs rep")).results.map((r) => r.rel)).toEqual(["docs/report.md"]);
    const since = Date.now() - 60_000;
    expect((await remoteChangedDocuments(exec, d, since)).map((p) => p.slice(d.length + 1)).sort()).toEqual(["docs/report.md", "docs/table.xlsx"]);
  });
});
