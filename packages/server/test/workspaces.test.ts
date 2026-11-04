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

  test("an agent's status carries the time it changed, unless it had it when agent-flow first looked", async () => {
    const home = tmp("af-ws-home-");
    const backend = new FakeBackend();
    const ws = await backend.createWorkspace("proj", home);
    await backend.startAgent("old", "claude", ws.paneId, []);
    backend.set("old", "done");
    const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await w.start(60_000);
    const pane = () => w.model.panes.find((p) => p.id === ws.paneId)!;
    expect(pane()).toMatchObject({ agentStatus: "done", statusAt: undefined }); // finished before we looked: not news
    backend.set("old", "working");
    await w.refresh();
    const t1 = pane().statusAt!;
    expect(pane().agentStatus).toBe("working");
    expect(Date.parse(t1)).toBeGreaterThan(Date.now() - 5000);
    await w.refresh();
    expect(pane().statusAt).toBe(t1); // unchanged status keeps its time
    await Bun.sleep(5);
    backend.set("old", "done");
    await w.refresh();
    expect(pane().statusAt! > t1).toBe(true);

    // a restart keeps the times; a status that changed while the server was down changed "now"
    const t2 = pane().statusAt!;
    await Bun.sleep(1100); // the save is debounced
    w.stop?.();
    const again = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await again.start(60_000);
    expect(again.model.panes.find((p) => p.id === ws.paneId)!.statusAt).toBe(t2);
    again.stop?.();
    backend.set("old", "working");
    const third = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await third.start(60_000);
    expect(third.model.panes.find((p) => p.id === ws.paneId)!.statusAt! > t2).toBe(true);
    third.stop?.();
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

describe("workspaces: remote machines", () => {
  test("remote ids are prefixed, operations route to the right machine, offline machines refuse clearly", async () => {
    const home = tmp("af-ws-remote-");
    const local = new FakeBackend();
    local.saved = [{ id: "p1", label: "ds03", target: "ds03", session: "default" }, { id: "p2", label: "Build box", target: "me@build", session: "default" }];
    const remoteBackend = new FakeBackend();
    const execs: string[] = [];
    const hangups: string[] = [];
    const remotes = new Map<string, { state: any; error?: string; home?: string; onChange: () => void }>();
    const w = new Workspaces({
      home,
      backend: local,
      paneEnv: () => ({ PATH: "/af/bin" }),
      remotePollMs: 0,
      remote: (spec, onChange) => {
        const r = {
          state: "offline" as any,
          error: undefined as string | undefined,
          home: "/home/u",
          onChange,
          close(hangUp?: boolean) {
            r.state = "offline";
            if (hangUp) hangups.push(spec.key);
            onChange();
          },
          async connect() {
            if (spec.key !== "ds03") {
              r.state = "error";
              r.error = "cannot reach me@build";
              onChange();
              throw new Error(r.error);
            }
            r.state = "online";
            onChange();
          },
          async exec(cmd: string) {
            execs.push(cmd);
            return { code: 0, out: Buffer.from("/home/u/.agent-flow/attachments/x-shot.png\n"), err: "" };
          },
        };
        remotes.set(spec.key, r);
        return { remote: r, backend: () => remoteBackend };
      },
    });
    await w.start(60_000);
    expect(w.model.machines.map((m) => `${m.id}:${m.state}`)).toEqual(["local:online", "ds03:offline", "build-box:offline"]);

    const rws = await remoteBackend.createWorkspace("paper", "/home/u/paper");
    await remoteBackend.startAgent("writer", "claude", rws.paneId, []);
    expect(w.model.workspaces.filter((x) => x.machine === "ds03")).toEqual([]); // not connected yet

    expect((await w.connect("ds03")).state).toBe("online");
    const ws = w.model.workspaces.find((x) => x.machine === "ds03")!;
    expect(ws.id).toBe(`ds03~${rws.workspaceId}`);
    const pane = w.model.panes.find((p) => p.machine === "ds03")!;
    expect(pane).toMatchObject({ id: `ds03~${rws.paneId}`, tabId: `ds03~${rws.tabId}`, agent: "claude" });
    expect(w.model.layouts[`ds03~${rws.tabId}`]!.root).toEqual({ type: "pane", paneId: `ds03~${rws.paneId}` });

    // operations reach the remote backend with the raw id; results come back prefixed
    const split = await w.split(pane.id, "down");
    expect(split.paneId).toStartWith("ds03~");
    expect(remoteBackend.panes.has(split.paneId.slice(5))).toBe(true);
    expect(local.panes.size).toBe(0);
    await w.prompt(pane.id, "hello");
    expect(remoteBackend.prompts.at(-1)).toEqual({ name: rws.paneId, text: "hello" });
    expect(await w.read(pane.id)).toBe(`screen of ${rws.paneId}\n`);

    // attachments for remote panes are written on the remote machine
    const att = await w.saveAttachment(pane.id, new Uint8Array([1, 2, 3]), "shot.png");
    expect(att).toMatchObject({ path: "/home/u/.agent-flow/attachments/x-shot.png", remote: true });
    expect(execs.at(-1)).toContain("cat > ");
    await expect(w.show({ target: "/etc/hosts", of: pane.id }, "u")).rejects.toThrow(/not supported yet/);

    // a machine that cannot connect reports why, and its ids are refused with that reason
    expect(await w.connect("build-box")).toMatchObject({ state: "error", error: "cannot reach me@build" });
    expect(() => w.route("build-box~w1:p1")).toThrow(/Build box is not connected: cannot reach me@build/);
    expect(() => w.route("nowhere~w1:p1")).toThrow(/no machine nowhere/);

    // losing the connection keeps the last known panes (shown dimmed) while it reconnects ...
    const r = remotes.get("ds03")!;
    const panesBefore = w.model.panes.filter((p) => p.machine === "ds03").length;
    r.state = "connecting";
    r.error = "connection lost; reconnecting";
    r.onChange();
    await w.refresh();
    expect(w.model.panes.filter((p) => p.machine === "ds03").length).toBe(panesBefore);
    expect(w.model.machines.find((m) => m.id === "ds03")).toMatchObject({ state: "connecting" });
    expect(() => w.route(pane.id)).toThrow(/not connected/);
    // ... and forgets them once the user disconnects
    await w.disconnect("ds03");
    expect(w.model.panes.filter((p) => p.machine === "ds03")).toEqual([]);
    w.stop();
  });
});

describe("workspaces: adding and removing machines and workspaces", () => {
  function make() {
    const home = tmp("af-ws-add-");
    const local = new FakeBackend();
    const remoteBackend = new FakeBackend();
    const execs: string[] = [];
    const w = new Workspaces({
      home,
      backend: local,
      paneEnv: () => ({}),
      remotePollMs: 0,
      remote: (spec, onChange) => {
        const r = {
          state: "offline" as any,
          error: undefined as string | undefined,
          home: "/home/u",
          async connect() {
            r.state = "online";
            onChange();
          },
          close() {},
          async exec(cmd: string) {
            execs.push(cmd);
            return { code: 0, out: Buffer.from(cmd.includes("/nope") ? "" : "ok\n"), err: "" };
          },
        };
        return { remote: r, backend: () => remoteBackend };
      },
    });
    return { home, local, remoteBackend, w, execs };
  }

  test("add a machine: saved in Herdr, appears, connects; remove: gone; bad input is refused", async () => {
    const { local, w } = make();
    await w.start(60_000);
    const m = await w.addMachine("me@gpu-box", "GPU box");
    expect(m).toMatchObject({ id: "gpu-box", label: "GPU box", target: "me@gpu-box", state: "online" });
    expect(local.saved.map((x) => x.target)).toEqual(["me@gpu-box"]);
    expect(w.model.machines.map((x) => x.id)).toEqual(["local", "gpu-box"]);
    await expect(w.addMachine("has space")).rejects.toThrow(/SSH target/);
    await expect(w.addMachine("-oProxyCommand=x")).rejects.toThrow(/SSH target/);
    local.addFails = "remote Herdr needs approval to install; run herdr machine add in a terminal";
    await expect(w.addMachine("other")).rejects.toThrow(/approval to install/);

    await w.removeMachine("gpu-box");
    expect(local.saved).toEqual([]);
    expect(w.model.machines.map((x) => x.id)).toEqual(["local"]);
    await expect(w.removeMachine("local")).rejects.toThrow(/cannot be removed/);
  });

  test("machines added or removed in the Herdr TUI show up after a reload, with stable keys", async () => {
    const { local, w } = make();
    local.saved = [{ id: "a", label: "ds03", target: "ds03", session: "default" }];
    await w.start(60_000);
    local.saved.push({ id: "b", label: "tea0", target: "tea0", session: "default" });
    await w.reloadMachines();
    expect(w.model.machines.map((x) => x.id)).toEqual(["local", "ds03", "tea0"]);
    local.saved = local.saved.filter((x) => x.id !== "a");
    await w.reloadMachines();
    expect(w.model.machines.map((x) => x.id)).toEqual(["local", "tea0"]);
  });

  test("a connected machine reconnects on the next start until it is disconnected", async () => {
    const { home, local } = make();
    local.saved = [{ id: "a", label: "ds03", target: "ds03", session: "default" }];
    const connects: string[] = [];
    const build = () =>
      new Workspaces({
        home,
        backend: local,
        paneEnv: () => ({}),
        remote: (spec, onChange) => {
          const r = {
            state: "offline" as any,
            error: undefined,
            home: "/h",
            async connect() {
              connects.push(spec.key);
              r.state = "online";
              onChange();
            },
            close() {
              r.state = "offline";
              onChange();
            },
            async exec() {
              return { code: 0, out: Buffer.from(""), err: "" };
            },
          };
          return { remote: r, backend: () => new FakeBackend() };
        },
      });
    const w1 = build();
    await w1.start(60_000);
    expect(connects).toEqual([]); // nothing connects until asked
    await w1.connect("ds03");
    w1.stop();
    const w2 = build();
    await w2.start(60_000);
    expect(connects).toEqual(["ds03", "ds03"]); // reconnected by itself
    expect(w2.model.machines.find((m) => m.id === "ds03")!.state).toBe("online");
    await w2.disconnect("ds03");
    w2.stop();
    const w3 = build();
    await w3.start(60_000);
    expect(connects.length).toBe(2); // disconnected: stays off
    w3.stop();
  });

  test("create and close workspaces, locally and on a remote machine", async () => {
    const { home, local, remoteBackend, w, execs } = make();
    local.saved = [{ id: "a", label: "ds03", target: "ds03", session: "default" }];
    await w.start(60_000);
    const lw = await w.newWorkspace("", home);
    expect(w.model.workspaces.find((x) => x.id === lw.workspaceId)!.label).toBe(home.split("/").at(-1)!);
    await expect(w.newWorkspace("x", join(home, "missing"))).rejects.toThrow(/does not exist/);

    await w.connect("ds03");
    const rw = await w.newWorkspace("paper", "~/paper", "ds03");
    expect(rw.workspaceId).toStartWith("ds03~");
    expect(execs.at(-1)).toContain("'/home/u/paper'"); // ~ expanded to the remote home, checked there
    await expect(w.newWorkspace("x", "/nope", "ds03")).rejects.toThrow(/does not exist on ds03/);

    // rename, locally and on the remote machine (Herdr's own name, so its TUI shows it too)
    expect(await w.renameWorkspace(lw.workspaceId, "  my   project ")).toEqual({ workspace: lw.workspaceId, label: "my project" });
    expect(w.model.workspaces.find((x) => x.id === lw.workspaceId)!.label).toBe("my project");
    await w.renameWorkspace(rw.workspaceId, "论文");
    expect(remoteBackend.workspaces.get(rw.workspaceId.slice("ds03~".length))!.label).toBe("论文");
    expect(w.model.workspaces.find((x) => x.id === rw.workspaceId)!.label).toBe("论文");
    await expect(w.renameWorkspace(lw.workspaceId, "   ")).rejects.toThrow(/needs a name/);
    await expect(w.renameWorkspace("w999", "x")).rejects.toThrow(/no Herdr workspace/);

    await w.closeWorkspace(rw.workspaceId);
    expect(w.model.workspaces.some((x) => x.id === rw.workspaceId)).toBe(false);
    expect(remoteBackend.workspaces.size).toBe(0);
    await w.closeWorkspace(lw.workspaceId);
    expect(w.model.workspaces).toEqual([]);
    await expect(w.closeWorkspace("w999")).rejects.toThrow(/no Herdr workspace/);
    w.stop();
  });
});

describe("menus: an agent's question answered from the UI", () => {
  test("choose sends arrows and Enter; free text is typed in place; a changed menu is refused", async () => {
    const { backend, w, ws } = await setup();
    await backend.startAgent("a1", "claude", ws.paneId, []);
    await w.refresh();
    const screen = ["Which format?", "", "❯ 1. Markdown", "  2. LaTeX", "  3. Type something.", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n");
    backend.screens.set(ws.paneId, screen);
    const m = (await w.menu(ws.paneId))!;
    expect(m.options.map((o) => o.label)).toEqual(["Markdown", "LaTeX", "Type something."]);

    await w.choose(ws.paneId, 1, "LaTeX");
    expect(backend.keys.at(-1)).toEqual({ target: ws.paneId, keys: ["down", "enter"] });

    backend.keys = [];
    await w.choose(ws.paneId, 2, "Type something.", "PDF\nplease");
    expect(backend.keys).toEqual([
      { target: ws.paneId, keys: ["down", "down"] },
      { target: ws.paneId, keys: ["enter"] },
    ]);
    expect(backend.texts.at(-1)).toEqual({ pane: ws.paneId, text: "PDF please" });

    await expect(w.choose(ws.paneId, 1, "HTML")).rejects.toThrow(/menu changed/);
    backend.screens.set(ws.paneId, "all done\n❯ ");
    expect(await w.menu(ws.paneId)).toBeUndefined();
    await expect(w.choose(ws.paneId, 0, "Markdown")).rejects.toThrow(/not showing a menu/);
  });
});

describe("composer: prompt with attachments, keys", () => {
  test("attachments are saved under home and listed before the message; keys are validated", async () => {
    const { home, backend, w, ws } = await setup();
    await backend.startAgent("a1", "claude", ws.paneId, []);
    await w.refresh();
    const h = makeHandler(new Orchestrator({ home, backend, sock: "/s", binDir: "/b", protocolDir: join(import.meta.dir, "../../skill"), config: DEFAULT_CONFIG }), w, backend);
    const post = async (path: string, body: object) => {
      const r = await h(new Request(`http://af${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      return { status: r.status, body: (await r.json()) as any };
    };
    const att = await w.saveAttachment(ws.paneId, new TextEncoder().encode("png-bytes"), "shot.png");
    expect(att.path).toStartWith(join(home, "attachments"));
    expect(att.path).toEndWith("-shot.png");
    const r = await post("/prompt", { pane: ws.paneId, text: "  what is this?  ", attachments: [att.path, "/x/notes.md"] });
    expect(r.status).toBe(200);
    expect(backend.prompts.at(-1)).toEqual({ name: ws.paneId, text: `Read these attached files first:\n- ${att.path}\n- /x/notes.md\n\nwhat is this?` });
    expect((await post("/prompt", { pane: ws.paneId, text: "   " })).status).toBe(400);
    const plain = await backend.splitPane(ws.paneId, "right", undefined, {});
    await w.refresh();
    expect((await post("/prompt", { pane: plain.paneId, text: "hi" })).body.error.code).toBe("no_agent");
    expect((await post("/keys", { pane: ws.paneId, keys: ["esc"] })).status).toBe(200);
    expect(backend.keys.at(-1)).toEqual({ target: ws.paneId, keys: ["esc"] });
    expect((await post("/keys", { pane: ws.paneId, keys: ["rm -rf /"] })).status).toBe(400);
  });
});

describe("af deliver: a finished document handed to the user", () => {
  test("shown next to the agent, then in the same viewer; listed until done; bad paths refused", async () => {
    const { home, backend, w, ws } = await setup();
    await backend.startAgent("a1", "claude", ws.paneId, []);
    await w.refresh();
    const h = makeHandler(new Orchestrator({ home, backend, sock: "/s", binDir: "/b", protocolDir: join(import.meta.dir, "../../skill"), config: DEFAULT_CONFIG }), w, backend);
    const post = async (path: string, body: object) => {
      const r = await h(new Request(`http://af${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      return { status: r.status, body: (await r.json()) as any };
    };
    const report = join(home, "report.md");
    const deck = join(home, "deck.pptx");
    writeFileSync(report, "# Report\n");
    writeFileSync(deck, "PK");
    const first = await post("/deliver", { path: report, title: "Weekly report", pane: ws.paneId });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ kind: "markdown", app: "obsidian", delivery: { path: report, title: "Weekly report", pane: ws.paneId, machine: "local", done: false } });
    const viewer = first.body.delivery.viewer;
    expect(w.views[viewer]?.target).toBe(report); // a viewer pane split off the agent's pane
    const second = await post("/deliver", { path: deck, pane: ws.paneId });
    expect(second.body.delivery.viewer).toBe(viewer); // the same viewer, not a pile of panes
    expect(second.body).toMatchObject({ kind: "document", app: "default" });
    expect(w.views[viewer]?.target).toBe(deck);
    expect((await post("/deliver/done", { id: first.body.delivery.id })).body.ok).toBe(true);
    expect((await post("/deliver", { path: "relative.md", pane: ws.paneId })).status).toBe(400);
    expect((await post("/deliver", { path: join(home, "nope.md"), pane: ws.paneId })).status).toBe(404);
    // outside Herdr (no pane): listed, not shown
    const loose = await post("/deliver", { path: report });
    expect(loose.body.delivery.viewer).toBeUndefined();
    // a file that is not there is refused before any app starts
    expect((await post("/open-with", { path: "/x/a.md", app: "obsidian" })).status).toBe(404);
  });
});

describe("controls: stop, rewind, clear, exit with each agent's own keys", () => {
  test("claude and codex rewind with Esc Esc from an empty box, omp with /rewind; exit clears the box first", async () => {
    const { backend, w, ws } = await setup();
    const pane = ws.paneId;
    const run = async (kind: "claude" | "codex" | "omp", action: string) => {
      backend.panes.get(pane)!.agent = { name: kind, kind, args: [], status: "idle" };
      await w.refresh();
      backend.keys = [];
      backend.texts = [];
      const r = await w.control(pane, action);
      return { keys: backend.keys.map((k) => k.keys.join("+")), texts: backend.texts.map((t) => t.text), hint: r.hint };
    };
    expect(await run("claude", "interrupt")).toMatchObject({ keys: ["esc"], texts: [] });
    // an empty box is not Ctrl+C'd (that arms "press again to quit"); a box with text is cleared first
    backend.screens.set(pane, "────\n❯\u00a0 \n────\n");
    expect(await run("claude", "rewind")).toMatchObject({ keys: ["esc", "esc"], hint: expect.stringContaining("Restore conversation") });
    expect(await run("claude", "clear")).toMatchObject({ keys: [] });
    backend.screens.set(pane, "────\n❯\u00a0half typed\n────\n");
    expect(await run("claude", "rewind")).toMatchObject({ keys: ["ctrl+c", "esc", "esc"] });
    backend.screens.set(pane, "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n");
    expect(await run("codex", "rewind")).toMatchObject({ keys: ["esc", "esc"] });
    backend.screens.set(pane, "╰─ draft\n");
    expect(await run("omp", "rewind")).toMatchObject({ keys: ["ctrl+c", "enter"], texts: ["/rewind"] });
    expect(await run("claude", "exit")).toMatchObject({ keys: ["ctrl+c", "ctrl+c"] });
    for (const k of ["codex", "omp"] as const) expect(await run(k, "exit")).toMatchObject({ keys: ["ctrl+c", "ctrl+d"] });
    expect(await run("omp", "clear")).toMatchObject({ keys: ["ctrl+c"] });
    await expect(w.control(pane, "explode")).rejects.toThrow(/unknown action/);
    delete backend.panes.get(pane)!.agent;
    await w.refresh();
    await expect(w.control(pane, "interrupt")).rejects.toThrow(/no agent/);
  });
});

describe("the message queue and steering", () => {
  test("while the agent works a message waits for the end of its turn; steer sends it now; the queue survives a restart", async () => {
    const { home, backend, w, ws } = await setup();
    await backend.startAgent("a1", "claude", ws.paneId, []);
    backend.set("a1", "working");
    await w.refresh();
    const pane = ws.paneId;
    backend.prompts = [];

    // working: queued, not typed into the agent
    const q1 = await w.send(pane, " first ", []);
    const q2 = await w.send(pane, "second", ["/x/a.png"]);
    expect("queued" in q1 && "queued" in q2).toBe(true);
    expect(w.queue[pane]!.map((q) => q.body)).toEqual(["first", "second"]);
    expect(backend.prompts).toEqual([]);

    // steer: the second goes into the running turn at once, the first keeps waiting. claude shows a typed message
    // as waiting ("ctrl+enter to send now"); Ctrl+Enter sends it now
    (w as any).opts.steerPolls = 3;
    backend.screens.set(pane, "❯ Press up to edit queued messages\n  ctrl+enter to send now\n");
    const id2 = w.queue[pane]![1]!.id;
    expect(await w.steer(pane, id2)).toEqual({ sent: "Read these attached files first:\n- /x/a.png\n\nsecond", sentNow: true });
    expect(backend.keys.at(-1)).toEqual({ target: pane, keys: ["ctrl+enter"] });
    expect(backend.prompts.map((p) => p.text)).toEqual(["Read these attached files first:\n- /x/a.png\n\nsecond"]);
    expect(w.queue[pane]!.map((q) => q.body)).toEqual(["first"]);
    await expect(w.steer(pane, id2)).rejects.toThrow(/not in the queue/);
    // steer mode sends at once even while working; queue mode holds even when idle
    expect(await w.send(pane, "now", [], "steer")).toEqual({ sent: "now", sentNow: true });
    await w.send(pane, "third", []);
    expect(w.queue[pane]!.map((q) => q.body)).toEqual(["first", "third"]);

    // a restart keeps the queue
    const w2 = new Workspaces({ home, backend, paneEnv: () => ({}) });
    expect(w2.queue[pane]!.map((q) => q.body)).toEqual(["first", "third"]);

    // remove (also used to edit: it goes back to the message box)
    expect(w.unqueue(pane, w.queue[pane]![1]!.id).body).toBe("third");
    expect(w.queue[pane]!.map((q) => q.body)).toEqual(["first"]);

    // the turn ends: the next queued message goes out by itself
    backend.prompts = [];
    backend.set("a1", "done");
    await w.refresh();
    await Bun.sleep(10);
    expect(backend.prompts.map((p) => p.text)).toEqual(["first"]);
    expect(w.queue[pane]).toBeUndefined();
  });

  test("steer uses each agent's own send-now: claude Ctrl+Enter, codex Esc only while it holds the message, omp nothing", async () => {
    const { backend, w, ws } = await setup();
    (w as any).opts.steerPolls = 3;
    const pane = ws.paneId;
    const steer = async (kind: "claude" | "codex" | "omp", screen: string) => {
      backend.panes.get(pane)!.agent = { name: kind, kind, args: [], status: "working" };
      backend.screens.set(pane, screen);
      await w.refresh();
      backend.keys = [];
      backend.prompts = [];
      const r = await w.send(pane, "look at b.ts too", [], "steer");
      return { prompts: backend.prompts.map((p) => p.text), keys: backend.keys.map((k) => k.keys.join(" ")), sentNow: (r as any).sentNow };
    };
    // screens as the agents draw them (their input box at the bottom)
    const claudeBox = "\n────────────────────────────────────────\n❯ Press up to edit queued messages\n────────────────────────────────────────\n  ⏵⏵ auto mode on · esc to interrupt";
    const codexBox = "\n› Ask Codex to do anything\n  GPT-6-Astra xhigh · ~";
    expect(await steer("claude", `  ctrl+enter to send now\n✳ Tinkering… (31s)${claudeBox}`)).toEqual({ prompts: ["look at b.ts too"], keys: ["ctrl+enter"], sentNow: true });
    expect(await steer("codex", `• Working (47s • esc to interrupt)\n• Messages to be submitted after next tool call (press esc to interrupt and send immediately)\n  ↳ look at b.ts too${codexBox}`)).toEqual({ prompts: ["look at b.ts too"], keys: ["esc"], sentNow: true });
    // codex took it straight into the turn (no held line): Esc would stop the turn, so it is not pressed
    expect(await steer("codex", `› look at b.ts too\n• Working (6s • esc to interrupt)${codexBox}`)).toEqual({ prompts: ["look at b.ts too"], keys: [], sentNow: false });
    expect(await steer("omp", " π > working\n╰─ ")).toEqual({ prompts: ["look at b.ts too"], keys: [], sentNow: true });
  });

  test("right after a prompt, before Herdr sees the agent start, the next message still waits", async () => {
    const { backend, w, ws } = await setup();
    await backend.startAgent("a1", "claude", ws.paneId, []);
    backend.set("a1", "idle");
    await w.refresh();
    await Bun.sleep(5);
    expect(await w.send(ws.paneId, "go", [])).toEqual({ sent: "go" });
    expect("queued" in (await w.send(ws.paneId, "and then this", []))).toBe(true); // Herdr still says idle
    await Bun.sleep(5);
    backend.set("a1", "working");
    await w.refresh();
    backend.set("a1", "done");
    await w.refresh();
    await Bun.sleep(10);
    expect(backend.promptsTo(ws.paneId).slice(-2)).toEqual(["go", "and then this"]);
  });

  test("one queued message per turn; nothing is typed while the agent asks a question", async () => {
    const { backend, w, ws } = await setup();
    await backend.startAgent("a1", "claude", ws.paneId, []);
    backend.set("a1", "working");
    await w.refresh();
    const pane = ws.paneId;
    await w.send(pane, "one", []);
    await w.send(pane, "two", []);
    backend.prompts = [];

    // the turn ends with a question on screen: hold
    backend.set("a1", "idle");
    backend.screens.set(pane, ["Which format?", "", "❯ 1. Markdown", "  2. LaTeX", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n"));
    await w.refresh();
    await Bun.sleep(10);
    expect(backend.prompts).toEqual([]);
    await expect(w.steer(pane, w.queue[pane]![0]!.id)).rejects.toThrow(/answer it first/);
    expect(w.queue[pane]!.length).toBe(2);

    // answered; the agent is free: "one" goes, "two" waits for the turn "one" starts
    backend.screens.set(pane, "done\n❯ ");
    (w as any).queueSentAt.clear();
    (w as any).promptedAt.clear();
    await w.refresh();
    await Bun.sleep(10);
    await w.refresh();
    await Bun.sleep(10);
    expect(backend.prompts.map((p) => p.text)).toEqual(["one"]);
    backend.set("a1", "working");
    await w.refresh();
    backend.set("a1", "done");
    await w.refresh();
    await Bun.sleep(10);
    expect(backend.prompts.map((p) => p.text)).toEqual(["one", "two"]);
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
