import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deliveries } from "../src/deliveries.ts";
import { fileKind, openArgv } from "../src/open-with.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "af-open-")));
  dirs.push(d);
  return d;
};

describe("opening files in apps", () => {
  test("kinds of files", () => {
    expect(fileKind("/a/report.md")).toBe("markdown");
    expect(fileKind("/a/paper.tex")).toBe("text");
    expect(fileKind("/a/x.ts")).toBe("text");
    expect(fileKind("/a/deck.PPTX")).toBe("document");
    expect(fileKind("/a/paper.pdf")).toBe("document");
  });

  test.if(process.platform === "darwin")("commands on a Mac: Obsidian by vault or by app, the default app, Finder", () => {
    const vault = "/Users/me/Documents/Obsidian Vault";
    expect(openArgv("obsidian", `${vault}/notes/a b.md`, undefined, [vault])).toEqual(["open", `obsidian://open?path=${encodeURIComponent(`${vault}/notes/a b.md`)}`]);
    expect(openArgv("obsidian", "/Users/me/lxc/report.md", undefined, [vault]).slice(0, 2)).toEqual(["open", "-a"]);
    expect(openArgv("obsidian", "/Users/me/lxc/report.md", undefined, [vault]).at(-1)).toBe("/Users/me/lxc/report.md");
    expect(openArgv("default", "/x/deck.pptx")).toEqual(["open", "/x/deck.pptx"]);
    expect(openArgv("finder", "/x/deck.pptx")).toEqual(["open", "-R", "/x/deck.pptx"]);
  });

  test("files on another machine open only in VS Code, over Remote-SSH, with ~ expanded", () => {
    const remote = { target: "tea2", label: "tea2", home: "/home/zq" };
    const argv = openArgv("vscode", "~/proj/report.md", remote);
    expect(argv.join(" ")).toContain("ssh-remote+tea2/home/zq/proj/report.md");
    expect(() => openArgv("obsidian", "/home/zq/proj/report.md", remote)).toThrow(/only VS Code/);
    expect(() => openArgv("default", "/home/zq/deck.pptx", remote)).toThrow(/only VS Code/);
    expect(() => openArgv("vscode", "relative.md", remote)).toThrow(/absolute/);
  });
});

describe("documents handed over", () => {
  test("one item per file, done when opened or dismissed; settings choose the app and survive a restart", () => {
    const home = tmp();
    const d = new Deliveries(home);
    expect(d.settings).toEqual({ auto: false, markdown: "obsidian", text: "vscode", document: "default" });
    const a = d.add({ path: "/p/report.md", machine: "local", pane: "w1:p1", title: "Report" });
    d.add({ path: "/p/report.md", machine: "local", pane: "w1:p1", title: "Report v2" }); // handed over again
    expect(d.list.filter((x) => !x.done).map((x) => x.title)).toEqual(["Report v2"]);
    expect(d.list.some((x) => x.id === a.id)).toBe(false);
    d.done(d.list[0]!.id);
    expect(d.list.filter((x) => !x.done)).toEqual([]);
    expect(d.appFor("/p/a.md")).toBe("obsidian");
    expect(d.appFor("/p/a.tex")).toBe("vscode");
    expect(d.appFor("/p/a.pptx")).toBe("default");
    d.setSettings({ auto: true, markdown: "vscode", text: "nonsense" as any });
    expect(d.settings).toEqual({ auto: true, markdown: "vscode", text: "vscode", document: "default" });
    writeFileSync(join(home, "other.json"), "{}");
    const again = new Deliveries(home);
    expect(again.settings.auto).toBe(true);
    expect(again.list.length).toBe(1);
  });
});

import { changedDocuments, isDocument } from "../src/doc-watch.ts";
import { mkdirSync, utimesSync } from "node:fs";

describe("documents an agent changed during its turn", () => {
  test("documents count; code, data, build outputs, agents' own files and hidden folders do not", () => {
    for (const f of ["/p/docs/实验预测表.md", "/p/paper/main.tex", "/p/deck.pptx", "/p/report.pdf", "/p/notes.txt", "/p/index.html"]) expect(isDocument(f)).toBe(true);
    for (const f of ["/p/src/a.ts", "/p/data.json", "/p/AGENTS.md", "/p/CLAUDE.md", "/p/paper/main.aux", "/p/paper/main.log", "/p/a.md.bak", "/p/.notes.md"]) expect(isDocument(f)).toBe(false);
  });

  test("only files changed after the turn started, newest first", () => {
    const root = tmp();
    for (const d of ["docs", "node_modules/x", ".claude", "build"]) mkdirSync(join(root, d), { recursive: true });
    const old = Date.now() / 1000 - 3600;
    const write = (rel: string, text = "x", mtime?: number) => {
      writeFileSync(join(root, rel), text);
      if (mtime) utimesSync(join(root, rel), mtime, mtime);
    };
    write("docs/old.md", "old", old);
    write("docs/report.md", "new");
    write("docs/table.xlsx", "PK");
    write("src.ts", "code");
    write("node_modules/x/README.md", "dep");
    write(".claude/plan.md", "agent");
    write("build/out.html", "built");
    write("docs/empty.md", "");
    const since = Date.now() - 60_000;
    expect(changedDocuments(root, since).map((p) => p.slice(root.length + 1)).sort()).toEqual(["docs/report.md", "docs/table.xlsx"]);
  });
});

import { deliverSkillText, installSkill, skillText } from "../src/skills.ts";
import { readFileSync } from "node:fs";

describe("skills written on server start", () => {
  test("agent-flow and deliver-document, for each installed agent (claude, codex, gemini), with this server's af path", () => {
    const home = tmp();
    for (const d of [".claude", ".codex", ".gemini"]) mkdirSync(join(home, d));
    const files = installSkill("/srv/af/bin/af", home);
    expect(files).toEqual([".claude", ".codex", ".gemini"].flatMap((d) => [join(home, d, "skills/agent-flow/SKILL.md"), join(home, d, "skills/deliver-document/SKILL.md")]));
    expect(readFileSync(files[0]!, "utf8")).toStartWith("---\nname: agent-flow\ndescription: ");
    const deliver = readFileSync(files[1]!, "utf8");
    expect(deliver).toStartWith("---\nname: deliver-document\ndescription: ");
    expect(deliver).toContain("/srv/af/bin/af deliver <file>");
    expect(deliver).toContain("a script"); // written by a script counts too
    for (const t of [skillText("X"), deliverSkillText("X")]) expect(t).not.toContain("undefined");
    // an agent that is not installed gets nothing
    const bare = tmp();
    mkdirSync(join(bare, ".claude"));
    expect(installSkill("/af", bare).map((f) => f.slice(bare.length))).toEqual(["/.claude/skills/agent-flow/SKILL.md", "/.claude/skills/deliver-document/SKILL.md"]);
  });
});
