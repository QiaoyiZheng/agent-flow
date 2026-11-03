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
