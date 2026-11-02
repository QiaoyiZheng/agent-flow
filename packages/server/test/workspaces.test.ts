import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LayoutNode } from "@af/core";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { makeHandler } from "../src/api.ts";
import { commitAll, git } from "../src/git.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeBackend } from "./fake.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};

async function setup() {
  const home = tmp("af-ws-home-");
  const backend = new FakeBackend();
  const w = new Workspaces({ home, backend, paneEnv: () => ({ AF_SOCK: "/s", PATH: "/af/bin:/usr/bin" }) });
  await w.start(60_000);
  const ws = await backend.createWorkspace("proj", home);
  await w.refresh();
  return { home, backend, w, ws };
}

const leaves = (n: LayoutNode): string[] => (n.type === "pane" ? [n.paneId] : [...leaves(n.first), ...leaves(n.second)]);

describe("workspaces: mirror Herdr", () => {
  test("the model follows Herdr: workspaces, tabs, panes and split trees", async () => {
    const { backend, w, ws } = await setup();
    expect(w.model.workspaces.map((x) => x.label)).toEqual(["proj"]);
    const { paneId } = await w.split(ws.paneId, "down");
    const layout = w.model.layouts[ws.tabId]!;
    expect(layout.root).toMatchObject({ type: "split", direction: "down", ratio: 0.5 });
    expect(leaves(layout.root)).toEqual([ws.paneId, paneId]);
    expect(backend.panes.get(paneId)!.env.PATH).toStartWith("/af/bin:"); // af works in new panes

    await w.setRatio(ws.tabId, [], 0.3);
    expect(backend.ratios.at(-1)).toEqual({ tabId: ws.tabId, path: [], ratio: 0.3 });
    expect((w.model.layouts[ws.tabId]!.root as any).ratio).toBe(0.3);
    await expect(w.setRatio(ws.tabId, [], 0.99)).rejects.toThrow(/between/);

    await w.close(paneId);
    expect(w.model.layouts[ws.tabId]!.root).toEqual({ type: "pane", paneId: ws.paneId });
  });

  test("only tabs whose layout changed are exported again", async () => {
    const { backend, w, ws } = await setup();
    const t2 = await w.newTab(ws.workspaceId);
    let exports = 0;
    const orig = backend.exportLayout.bind(backend);
    backend.exportLayout = async (id) => (exports++, orig(id));
    await w.refresh();
    expect(exports).toBe(0);
    await backend.splitPane(t2.paneId, "right", undefined, {});
    await w.refresh();
    expect(exports).toBe(1);
  });

  test("changes made outside agent-flow (Herdr TUI, herdr CLI) show up through lifecycle events", async () => {
    const { backend, w, ws } = await setup();
    let pushes = 0;
    w.onChange(() => pushes++);
    await backend.splitPane(ws.paneId, "right", undefined, {}); // fires the lifecycle watcher
    await Bun.sleep(150); // debounce
    expect(leaves(w.model.layouts[ws.tabId]!.root).length).toBe(2);
    expect(pushes).toBeGreaterThan(0);
  });
});

describe("workspaces: viewer panes", () => {
  test("show splits the caller's pane, starts the viewer, and registers it; --in retargets; close forgets it", async () => {
    const { home, backend, w, ws } = await setup();
    const f1 = join(home, "a.ts");
    const f2 = join(home, "b.md");
    writeFileSync(f1, "export const a = 1;\n");
    writeFileSync(f2, "# b\n");
    const v = await w.show({ target: f1, pane: ws.paneId }, "lead");
    expect(v).toMatchObject({ target: f1, by: "lead" });
    expect(v.paneId).not.toBe(ws.paneId);
    expect(backend.panes.get(v.paneId)!.typed).toEqual(["exec af viewer"]);
    expect(backend.panes.get(v.paneId)!.label).toBe("≡ a.ts");
    expect(w.view(v.paneId)!.target).toBe(f1);

    const again = await w.show({ target: f2, in: v.paneId }, "coder");
    expect(again.paneId).toBe(v.paneId);
    expect(w.view(v.paneId)!.target).toBe(f2);
    expect(backend.panes.size).toBe(2); // no new pane

    await expect(w.show({ target: f2, in: ws.paneId }, "x")).rejects.toThrow(/not a viewer pane/);
    await expect(w.show({ target: join(home, "nope") , pane: ws.paneId }, "x")).rejects.toThrow(/does not exist/);
    await expect(w.show({ target: f1 }, "x")).rejects.toThrow(/say where/);

    const tab = await w.show({ target: "https://example.com", tabIn: ws.workspaceId }, "user");
    expect(w.model.panes.find((p) => p.id === tab.paneId)!.tabId).not.toBe(ws.tabId);

    await w.close(v.paneId);
    expect(w.view(v.paneId)).toBeUndefined();
  });

  test("viewers whose pane disappeared are dropped, and the registry survives a restart", async () => {
    const { home, backend, w, ws } = await setup();
    writeFileSync(join(home, "x.txt"), "x\n");
    const a = await w.show({ target: join(home, "x.txt"), pane: ws.paneId }, "u");
    const b = await w.show({ target: join(home, "x.txt"), pane: ws.paneId, split: "down" }, "u");
    await backend.closePane(a.paneId); // closed in Herdr directly
    await w.refresh();
    expect(Object.keys(w.views)).toEqual([b.paneId]);
    const w2 = new Workspaces({ home, backend, paneEnv: () => ({}) });
    expect(Object.keys(w2.views)).toEqual([b.paneId]);
  });
});

describe("workspaces: API used by agents", () => {
  test("af read resolves run agents by name; split → agent joins the run when the workspace is a run", async () => {
    const home = tmp("af-api-home-");
    const repo = tmp("af-api-repo-");
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "f.txt"), "f\n");
    commitAll(repo, "init");
    process.env.CODEX_HOME = tmp("af-codex-");
    const backend = new FakeBackend();
    const o = new Orchestrator({ home, backend, sock: "/s", binDir: "/af/bin", protocolDir: join(import.meta.dir, "../../skill"), config: DEFAULT_CONFIG });
    const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await w.start(60_000);
    const h = makeHandler(o, w, backend);
    const call = async (path: string, body: object) => {
      const r = await h(new Request(`http://af${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      return { status: r.status, body: (await r.json()) as any };
    };

    const meta = await o.createRun({ cwd: repo });
    await w.refresh();
    const leadPane = o.getRun(meta.id).agents.lead!.paneId!;

    const read = await call("/pane/read", { run: meta.id, agent: "lead", ref: "lead", lines: 50 });
    expect(read.body).toEqual({ pane: leadPane, text: `screen of ${leadPane}\n` });
    expect((await call("/pane/read", { run: meta.id, ref: "ghost" })).status).toBe(404);

    const split = await call("/pane/split", { pane: leadPane, direction: "down", kind: "agent", agentKind: "omp" });
    expect(split.body).toMatchObject({ agent: "omp", run: meta.id });
    const helper = o.getRun(meta.id).agents.omp!;
    expect(helper.paneId).toBe(split.body.paneId);
    expect(w.model.panes.find((p) => p.id === helper.paneId)!.tabId).toBe(w.model.panes.find((p) => p.id === leadPane)!.tabId); // same tab: a split, not a new tab

    const ls = await call("/ls", {}).catch(() => undefined);
    const lsGet = await h(new Request("http://af/ls"));
    const body = (await lsGet.json()) as any;
    expect(body.runs[meta.herdrWorkspace!]).toBe(meta.id);
    expect(ls?.status).toBe(404); // ls is GET only

    writeFileSync(join(repo, "notes.md"), "# notes\n");
    const shown = await call("/show", { run: meta.id, agent: "lead", target: join(repo, "notes.md"), pane: leadPane });
    expect(shown.status).toBe(200);
    expect(o.getRun(meta.id).opens.at(-1)).toMatchObject({ by: "lead", target: join(repo, "notes.md") });
  });
});
