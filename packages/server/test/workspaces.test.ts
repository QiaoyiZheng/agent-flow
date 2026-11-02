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

describe("workspaces: remote machines", () => {
  test("remote ids are prefixed, operations route to the right machine, offline machines refuse clearly", async () => {
    const home = tmp("af-ws-remote-");
    const local = new FakeBackend();
    local.saved = [{ id: "p1", label: "ds03", target: "ds03", session: "default" }, { id: "p2", label: "Build box", target: "me@build", session: "default" }];
    const remoteBackend = new FakeBackend();
    const execs: string[] = [];
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
          close() {},
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

    // losing the connection drops the remote panes from the model
    const r = remotes.get("ds03")!;
    r.state = "error";
    r.error = "connection lost";
    r.onChange();
    await w.refresh();
    expect(w.model.panes.filter((p) => p.machine === "ds03")).toEqual([]);
    expect(w.model.machines.find((m) => m.id === "ds03")).toMatchObject({ state: "error", error: "connection lost" });
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

    await w.closeWorkspace(rw.workspaceId);
    expect(w.model.workspaces.some((x) => x.id === rw.workspaceId)).toBe(false);
    expect(remoteBackend.workspaces.size).toBe(0);
    await w.closeWorkspace(lw.workspaceId);
    expect(w.model.workspaces).toEqual([]);
    await expect(w.closeWorkspace("w999")).rejects.toThrow(/no Herdr workspace/);
    w.stop();
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
