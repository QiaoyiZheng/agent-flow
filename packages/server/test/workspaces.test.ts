import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LayoutNode } from "@af/core";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { handOver, makeHandler, watchDocuments } from "../src/api.ts";
import { makeTranscriptAccess } from "../src/access.ts";
import { commitAll, git } from "../src/git.ts";
import { Teams } from "../src/teams.ts";
import { Workspaces, workspaceStatus } from "../src/workspaces.ts";
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

  test("a workspace is working while any agent in it works, also when another finished (Herdr's own status says done)", async () => {
    const { backend, w, ws } = await setup();
    const right = await backend.splitPane(ws.paneId, "right", undefined, {});
    const other = await backend.createTab(ws.workspaceId, "/tmp", "shell", {});
    await backend.startAgent("left", "claude", ws.paneId, []);
    await backend.startAgent("right", "claude", right.paneId, []);
    await backend.startAgent("omp", "omp", other.paneId, []);
    const status = async () => (await w.refresh(), w.model.workspaces.find((x) => x.id === ws.workspaceId)!.agentStatus);
    backend.set("left", "idle");
    backend.set("right", "idle");
    backend.set("omp", "done");
    expect(await status()).toBe("done");
    backend.set("right", "working"); // lxc: the right-hand claude works, the omp in another tab finished earlier
    expect(await status()).toBe("working");
    backend.set("left", "blocked");
    expect(await status()).toBe("blocked");
    backend.set("left", "idle");
    backend.set("right", "done");
    expect(await status()).toBe("done");
    expect(workspaceStatus([], "unknown")).toBe("unknown"); // no agents: Herdr's value
  });

  test("waiting on background work is not finished: turn ends, status times and settled() wait for it", async () => {
    const home = tmp("af-ws-home-");
    const backend = new FakeBackend();
    const ws = await backend.createWorkspace("proj", home);
    await backend.startAgent("t1", "claude", ws.paneId, []);
    backend.procs.set(ws.paneId, [{ pid: 4242, argv: ["claude", "--session-id", "s"] }]);
    let running = 0; // background tasks holding their output files open
    const checks: string[][] = [];
    const w = new Workspaces({
      home,
      backend,
      paneEnv: () => ({}),
      background: { session: (pid) => (pid === 4242 ? "sid-1" : undefined), dir: (sid) => `/tmp/claude-1/x/${sid}/tasks`, count: async (dirs) => (checks.push(dirs), new Map(dirs.map((d) => [d, running]))) },
    });
    await w.start(60_000);
    const ends: { started?: number; ended: number }[] = [];
    w.onTurnEnd((t) => ends.push(t));
    const pane = () => w.model.panes.find((p) => p.id === ws.paneId)!;
    const step = async (status: "working" | "done", bg?: number) => {
      if (bg !== undefined) running = bg;
      backend.set("t1", status);
      (w as any).machines.get("local").background?.forEach((v: any) => (v.at = 0)); // the 3 s recheck is due
      await w.refresh();
    };
    await step("working");
    const t0 = Date.now();
    await step("done", 1); // T1 starts its experiment under a Monitor and ends its turn
    expect(pane()).toMatchObject({ agentStatus: "done", background: 1 });
    expect(ends).toEqual([]); // not finished
    expect(w.settled(ws.paneId)).toBe(false);
    expect(w.model.workspaces.find((x) => x.id === ws.workspaceId)!.agentStatus).toBe("working");
    const waitingSince = pane().statusAt;
    await step("working"); // a monitor event wakes it for a short turn
    await step("done", 1); // and it waits again
    expect(ends).toEqual([]);
    await Bun.sleep(5);
    await step("done", 0); // the experiment ends: the monitor's file is closed
    expect(pane().background).toBeUndefined();
    expect(ends.length).toBe(1); // one end, at the real end, spanning the whole job
    expect(ends[0]!.started! <= t0).toBe(true);
    expect(pane().statusAt! > waitingSince!).toBe(true); // a fresh time: "finished" in Needs you comes now
    expect(w.settled(ws.paneId)).toBe(true);
    // a plain turn without background work ends at once; a finished pane is not checked again and again
    await step("working");
    const n = checks.length;
    await step("done", 0);
    expect(ends.length).toBe(2);
    await w.refresh();
    await w.refresh();
    expect(checks.length).toBe(n + 1);
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

describe("background work on a remote machine", () => {
  test("checked over SSH with one script; the turn end waits for its answer; a job ending later ends the turn then", async () => {
    const home = tmp("af-ws-bgremote-");
    const local = new FakeBackend();
    local.saved = [{ id: "p1", label: "tea2", target: "tea2", session: "default" }];
    const remoteBackend = new FakeBackend();
    // the remote machine: its "SSH" runs the real script in a local shell, with HOME pointing at a fake remote home
    const rhome = tmp("af-rhome-");
    const uid = process.getuid!();
    const tasks = join(rhome, `.claude-${uid}`, "-home-u-exp", "aaaaaaaa-0000-0000-0000-00000000000a", "tasks");
    mkdirSync(tasks, { recursive: true });
    mkdirSync(join(rhome, ".claude/sessions"), { recursive: true });
    writeFileSync(join(rhome, ".claude/sessions/7001.json"), JSON.stringify({ pid: 7001, sessionId: "aaaaaaaa-0000-0000-0000-00000000000a" }));
    const scripts: string[] = [];
    let gate: Promise<void> = Promise.resolve();
    const w = new Workspaces({
      home,
      backend: local,
      paneEnv: () => ({}),
      remotePollMs: 0,
      remote: (_spec, onChange) => {
        const r = {
          state: "offline" as any,
          home: rhome,
          async connect() {
            r.state = "online";
            onChange();
          },
          close() {},
          async exec(cmd: string) {
            scripts.push(cmd);
            await gate; // an SSH round trip that takes its time
            const p = Bun.spawnSync(["sh", "-c", cmd], { env: { ...process.env, HOME: rhome, TMPDIR: join(rhome, "tmp") }, stdout: "pipe" });
            return { code: 0, out: Buffer.from(p.stdout), err: "" };
          },
        };
        return { remote: r, backend: () => remoteBackend };
      },
    });
    await w.start(60_000);
    await w.connect("tea2");
    const rws = await remoteBackend.createWorkspace("exp", "/home/u/exp");
    await remoteBackend.startAgent("t1", "claude", rws.paneId, []);
    remoteBackend.procs.set(rws.paneId, [{ pid: 7001, argv: ["claude"] }]);
    const id = `tea2~${rws.paneId}`;
    const ends: string[] = [];
    w.onTurnEnd((t) => ends.push(t.pane));
    const pane = () => w.model.panes.find((p) => p.id === id)!;
    const settle = async () => {
      for (let i = 0; i < 20 && (w as any).machines.get("tea2").bgRunning; i++) await Bun.sleep(25);
      await w.refresh();
    };
    remoteBackend.set("t1", "working");
    await w.refresh();
    // T1 starts its experiment in the background and ends its turn; the check is slow to answer
    const job = Bun.spawn(["sh", "-c", `exec >>'${join(tasks, "bexp.output")}' 2>&1; exec sleep 30`]);
    await Bun.sleep(300);
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    remoteBackend.set("t1", "done");
    await w.refresh();
    expect(ends).toEqual([]); // not ended while the answer is on its way
    open();
    await settle();
    expect(pane()).toMatchObject({ agentStatus: "done", background: 1 });
    expect(ends).toEqual([]);
    expect(w.settled(id)).toBe(false);
    expect(scripts.at(-1)).toContain(`chk '${rws.paneId}' 7001`);
    // the job ends; the 6 s recheck finds nothing open: the turn ends then
    job.kill();
    await job.exited;
    (w as any).machines.get("tea2").background.forEach((v: any) => (v.at = 0));
    await w.refresh();
    await settle();
    expect(pane().background).toBeUndefined();
    expect(ends).toEqual([id]);
    expect(w.settled(id)).toBe(true);
  });
});

describe("background work on a remote machine: a plain turn end", () => {
  test("working → idle with no background work: one check, the turn ends, no loop of checks", async () => {
    const home = tmp("af-ws-bgloop-");
    const local = new FakeBackend();
    local.saved = [{ id: "p1", label: "tea2", target: "tea2", session: "default" }];
    const remoteBackend = new FakeBackend();
    let execs = 0;
    const w = new Workspaces({
      home,
      backend: local,
      paneEnv: () => ({}),
      remotePollMs: 0,
      remote: (_spec, onChange) => {
        const r = {
          state: "offline" as any,
          home: "/home/u",
          async connect() {
            r.state = "online";
            onChange();
          },
          close() {},
          async exec() {
            execs++;
            return { code: 0, out: Buffer.from(""), err: "" }; // answers at once: no background work
          },
        };
        return { remote: r, backend: () => remoteBackend };
      },
    });
    await w.start(60_000);
    await w.connect("tea2");
    const rws = await remoteBackend.createWorkspace("exp", "/home/u/exp");
    await remoteBackend.startAgent("t1", "claude", rws.paneId, []);
    const id = `tea2~${rws.paneId}`;
    const ends: string[] = [];
    w.onTurnEnd((t) => ends.push(t.pane));
    remoteBackend.set("t1", "working");
    await w.refresh();
    const before = execs;
    remoteBackend.set("t1", "idle");
    // the bug: each answer started a refresh that found the check due again, so refresh() never resolved
    const done = await Promise.race([w.refresh().then(() => "resolved"), Bun.sleep(3000).then(() => "hung")]);
    expect(done).toBe("resolved");
    for (let i = 0; i < 20 && (w as any).machines.get("tea2").bgRunning; i++) await Bun.sleep(25);
    await Promise.race([w.refresh(), Bun.sleep(3000)]);
    await Bun.sleep(100);
    expect(execs - before).toBe(1);
    expect(ends).toEqual([id]);
    expect(w.model.panes.find((p) => p.id === id)!.agentStatus).toBe("idle");
    expect(w.settled(id)).toBe(true);
    w.stop();
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
    // it opens on its folder: a viewer pane of the directory next to the shell, in the same tab
    expect(lw.folderPane).toBeDefined();
    expect(w.views[lw.folderPane!]?.target).toBe(home);
    expect(w.model.panes.find((p) => p.id === lw.folderPane)!.tabId).toBe(lw.tabId);
    await expect(w.newWorkspace("x", join(home, "missing"))).rejects.toThrow(/does not exist/);

    await w.connect("ds03");
    const rw = await w.newWorkspace("paper", "~/paper", "ds03");
    expect(rw.workspaceId).toStartWith("ds03~");
    expect(rw.folderPane).toBeUndefined(); // viewer panes are local only
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

describe("choosing in claude's /model picker", () => {
  test("arrows to the model, ←/→ to the effort, then Enter or the dialog's own key; unknown keys and levels refused", async () => {
    const { backend, w, ws } = await setup();
    await backend.startAgent("a1", "claude", ws.paneId, []);
    await w.refresh();
    const rows = ["Default (recommended)  Use the default model", "Opus ✔                 Opus 5.5 · Best", "Fable                  Fable 5.1 · Most", "Sonnet                 Sonnet 5.5 · Efficient"];
    backend.screens.set(ws.paneId, ["  Select model", "", ...rows.map((r, i) => `  ${i === 1 ? "❯" : " "} ${i + 1}. ${r}`), "", "  ◉ xHigh effort ←/→ to adjust", "", "  Enter to set as default · s to use this session only · Esc to cancel"].join("\n"));
    backend.keys = [];
    await w.choose(ws.paneId, 3, "Sonnet", undefined, { key: "s", setting: "High" });
    expect(backend.keys.map((k) => k.keys.join(" "))).toEqual(["left", "down down s"]);
    backend.keys = [];
    await w.choose(ws.paneId, 0, "Default (recommended)");
    expect(backend.keys.map((k) => k.keys.join(" "))).toEqual(["up enter"]);
    await expect(w.choose(ws.paneId, 3, "Sonnet", undefined, { key: "q" })).rejects.toThrow(/does not offer/);
    await expect(w.choose(ws.paneId, 3, "Sonnet", undefined, { setting: "Ultra" })).rejects.toThrow(/not one of/);
  });
});

describe("composer: prompt with attachments, keys", () => {
  test("attachments are saved under home and listed before the message; keys are validated", async () => {
    const { home, backend, w, ws } = await setup();
    await backend.startAgent("a1", "claude", ws.paneId, []);
    await w.refresh();
    const h = makeHandler(new Teams({ home, backend, w, sock: "/s", binDir: "/b", protocolDir: join(import.meta.dir, "../../skill"), config: DEFAULT_CONFIG }), w, backend);
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

describe("gemini: a prompt left unsent in its box", () => {
  test("when the box still holds the text after typing it, Enter is pressed once more", async () => {
    const { backend, w, ws } = await setup();
    await backend.startAgent("g1", "gemini", ws.paneId, []);
    backend.set("g1", "idle");
    await w.refresh();
    const band = (t: string) => [`${"▄".repeat(60)}`, ` > ${t}`, `${"▀".repeat(60)}`, " workspace (/directory)        sandbox", " /tmp/x                        no sandbox"].join("\n");
    // gemini kept the pasted text in its box
    backend.screens.set(ws.paneId, band("Reply with just the word pong."));
    backend.keys = [];
    await w.prompt(ws.paneId, "Reply with just the word pong.");
    expect(backend.keys.map((k) => k.keys.join(" "))).toEqual(["enter"]);
    // sent normally: the box is empty, nothing more is pressed
    backend.screens.set(ws.paneId, band("  Type your message or @path/to/file"));
    backend.keys = [];
    await w.prompt(ws.paneId, "Reply with just the word pong.");
    expect(backend.keys).toEqual([]);
  });
});

describe("questions Herdr does not report", () => {
  test("an agent Herdr calls idle but showing a dialog is marked asking, until the dialog is gone", async () => {
    const { backend, w, ws } = await setup();
    await backend.startAgent("g1", "claude", ws.paneId, []);
    backend.set("g1", "idle");
    const rule = "─".repeat(40);
    backend.screens.set(ws.paneId, ["Do you trust the files in this folder?", "", "❯ 1. Trust folder", "  2. Don't trust", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n"));
    (w as any).machines.get("local").askingAt = 0;
    await w.refresh();
    for (let i = 0; i < 20 && !w.model.panes.find((p) => p.id === ws.paneId)?.asking; i++) await Bun.sleep(10);
    expect(w.model.panes.find((p) => p.id === ws.paneId)?.asking).toBe("Do you trust the files in this folder?");
    // another question right after: its own text
    backend.screens.set(ws.paneId, ["Allow execution of: ls?", "", "❯ 1. Allow once", "  2. No", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n"));
    (w as any).machines.get("local").askingAt = 0;
    await w.refresh();
    for (let i = 0; i < 20 && !/Allow execution/.test(w.model.panes.find((p) => p.id === ws.paneId)?.asking ?? ""); i++) await Bun.sleep(10);
    expect(w.model.panes.find((p) => p.id === ws.paneId)?.asking).toBe("Allow execution of: ls?");
    // answered: the input box is back
    backend.screens.set(ws.paneId, `done\n${rule}\n❯ \n${rule}\n`);
    (w as any).machines.get("local").askingAt = 0;
    await w.refresh();
    for (let i = 0; i < 20 && w.model.panes.find((p) => p.id === ws.paneId)?.asking; i++) await Bun.sleep(10);
    expect(w.model.panes.find((p) => p.id === ws.paneId)?.asking).toBeUndefined();
  });
});

describe("notices that wait for a key", () => {
  test("a notice still on screen at the next check counts as asking (not finished); the input box back clears it", async () => {
    const { backend, w, ws } = await setup();
    await backend.startAgent("n1", "claude", ws.paneId, []);
    backend.set("n1", "done");
    await w.refresh(); // the model knows the pane's agent
    const rule = "─".repeat(40);
    backend.screens.set(ws.paneId, ["⏺ Running the first command", "", rule, " Auto mode now uses your extra usage when your plan's limit is reached.", " You can change this in /config.", "", " Enter to continue"].join("\n"));
    const check = async () => {
      (w as any).machines.get("local").askingAt = 0;
      await w.refresh();
      for (let i = 0; i < 10 && (w as any).machines.get("local").askingBusy; i++) await Bun.sleep(10);
      await Bun.sleep(20);
    };
    await check();
    expect(w.model.panes.find((p) => p.id === ws.paneId)?.asking).toBeUndefined(); // seen once: maybe a redraw
    await check();
    expect(w.model.panes.find((p) => p.id === ws.paneId)?.asking).toContain("Auto mode now uses your extra usage");
    expect(w.settled(ws.paneId)).toBe(false);
    backend.screens.set(ws.paneId, `done\n${rule}\n❯ \n${rule}\n`);
    await check();
    expect(w.model.panes.find((p) => p.id === ws.paneId)?.asking).toBeUndefined();
    expect(w.settled(ws.paneId)).toBe(true);
  });
});

describe("af deliver: a finished document handed to the user", () => {
  test("recorded for the agent's reply, no pane opened; marked done when opened; bad paths refused", async () => {
    const { home, backend, w, ws } = await setup();
    await backend.startAgent("a1", "claude", ws.paneId, []);
    await w.refresh();
    const h = makeHandler(new Teams({ home, backend, w, sock: "/s", binDir: "/b", protocolDir: join(import.meta.dir, "../../skill"), config: DEFAULT_CONFIG }), w, backend);
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
    // nothing opens by itself: no viewer pane (with many agents a pane per document made everything slow)
    expect(first.body.delivery.viewer).toBeUndefined();
    expect(Object.keys(w.views)).toEqual([]);
    expect(w.model.panes.filter((p) => p.workspaceId === ws.workspaceId).length).toBe(1);
    const second = await post("/deliver", { path: deck, pane: ws.paneId });
    expect(second.body).toMatchObject({ kind: "document", app: "default" });
    expect(Object.keys(w.views)).toEqual([]);
    expect((await post("/deliver/done", { id: first.body.delivery.id })).body.ok).toBe(true);
    expect((await post("/deliver", { path: "relative.md", pane: ws.paneId })).status).toBe(400);
    expect((await post("/deliver", { path: join(home, "nope.md"), pane: ws.paneId })).status).toBe(404);
    // outside Herdr (no pane): recorded too
    const loose = await post("/deliver", { path: report });
    expect(loose.body.delivery.path).toBe(report);
    expect(loose.body.delivery.pane).toBeUndefined();
    // a file that is not there is refused before any app starts
    expect((await post("/open-with", { path: "/x/a.md", app: "obsidian" })).status).toBe(404);
  });
});

describe("documents found at the end of a turn", () => {
  test("a document the agent changed but did not hand over is handed over when its turn ends; one it handed over is not doubled", async () => {
    const { home, backend, w, ws } = await setup();
    const proj = tmp("af-proj-");
    backend.panes.get(ws.paneId)!.cwd = proj;
    await backend.startAgent("a1", "claude", ws.paneId, []);
    await w.refresh();
    const o = new Teams({ home, backend, w, sock: "/s", binDir: "/b", protocolDir: join(import.meta.dir, "../../skill"), config: DEFAULT_CONFIG });
    const access = makeTranscriptAccess(o, w);
    watchDocuments(w, access);
    backend.set("a1", "working");
    await w.refresh();
    await Bun.sleep(20);
    writeFileSync(join(proj, "report.md"), "# R\n");
    writeFileSync(join(proj, "handed.md"), "# H\n");
    writeFileSync(join(proj, "code.ts"), "x");
    await handOver(w, access, { path: join(proj, "handed.md"), pane: ws.paneId }); // the agent ran af deliver for this one
    backend.set("a1", "done");
    await w.refresh();
    await Bun.sleep(1700);
    const open = access.deliveries.list.filter((d) => !d.done);
    expect(open.map((d) => d.path.split("/").at(-1)).sort()).toEqual(["handed.md", "report.md"]);
    expect(open.find((d) => d.path.endsWith("report.md"))).toMatchObject({ found: true, pane: ws.paneId, title: "claude changed report.md" });
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

  test("gemini: its box is cleared line by line without Ctrl+C (that would stop a turn); /rewind; exit is two Ctrl+C on an empty box", async () => {
    const { backend, w, ws } = await setup();
    const pane = ws.paneId;
    backend.panes.get(pane)!.agent = { name: "g1", kind: "gemini", args: [], status: "working" };
    await w.refresh();
    // gemini's input band (captured layout): each Ctrl+E Ctrl+U Backspace removes the last line of the draft
    const band = (lines: string[]) => ["✦ Working on it.", "▄".repeat(40), ` > ${lines[0] ?? "  Type your message or @path/to/file"}`, ...lines.slice(1).map((l) => `   ${l}`), "▀".repeat(40), " workspace (/directory)   /model"].join("\n");
    let draft: string[] = [];
    backend.onKeys = (_t, keys) => {
      if (keys.join(" ") === "ctrl+e ctrl+u backspace") draft = draft.slice(0, -1);
      backend.screens.set(pane, band(draft));
    };
    const run = async (action: string, typed: string[]) => {
      draft = typed;
      backend.screens.set(pane, band(draft));
      backend.keys = [];
      backend.texts = [];
      const r = await w.control(pane, action);
      return { keys: backend.keys.map((k) => k.keys.join(" ")), texts: backend.texts.map((t) => t.text), hint: r.hint, left: draft };
    };
    expect(await run("interrupt", [])).toMatchObject({ keys: ["esc"] });
    expect(await run("clear", [])).toMatchObject({ keys: [] });
    expect(await run("clear", ["first line", "second line"])).toEqual({ keys: ["ctrl+e ctrl+u backspace", "ctrl+e ctrl+u backspace"], texts: [], hint: undefined, left: [] });
    expect(await run("rewind", ["draft"])).toMatchObject({ keys: ["ctrl+e ctrl+u backspace", "enter"], texts: ["/rewind"], hint: expect.stringContaining("Rewind conversation") });
    expect(await run("exit", ["draft"])).toMatchObject({ keys: ["ctrl+e ctrl+u backspace", "ctrl+c", "ctrl+c"] });
    expect(await run("exit", [])).toMatchObject({ keys: ["ctrl+c", "ctrl+c"] });
    backend.onKeys = undefined;
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

  test("steer uses each agent's own send-now: claude Ctrl+Enter, codex Esc only while it holds the message, omp nothing, gemini holds it", async () => {
    const { backend, w, ws } = await setup();
    (w as any).opts.steerPolls = 3;
    const pane = ws.paneId;
    const steer = async (kind: "claude" | "codex" | "omp" | "gemini", screen: string) => {
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
    // gemini queues it until the turn ends; no key sends it sooner (Esc would stop the turn)
    const geminiBox = `\n${"▄".repeat(40)}\n >   Type your message or @path/to/file\n${"▀".repeat(40)}\n workspace (/directory)   /model`;
    expect(await steer("gemini", `  Queued (press ↑ to edit):\n    look at b.ts too\n\n ⠦ Thinking... (esc to cancel, 4s)${geminiBox}`)).toEqual({ prompts: ["look at b.ts too"], keys: [], sentNow: false });
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
  test("af read resolves team members by name; a split gets a plain agent; af ls lists workspaces with teams", async () => {
    const home = tmp("af-api-home-");
    const repo = tmp("af-api-repo-");
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "f.txt"), "f\n");
    commitAll(repo, "init");
    const backend = new FakeBackend();
    const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
    await w.start(60_000);
    const o = new Teams({ home, backend, w, sock: "/s", binDir: "/af/bin", protocolDir: join(import.meta.dir, "../../skill"), config: DEFAULT_CONFIG, settleMs: 0 });
    const h = makeHandler(o, w, backend);
    const call = async (path: string, body: object) => {
      const r = await h(new Request(`http://af${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      return { status: r.status, body: (await r.json()) as any };
    };
    const ws = await backend.createWorkspace("proj", repo);
    await backend.startAgent("lead", "claude", ws.paneId, []);
    await w.refresh();
    const task = await call("/task", { callerPane: ws.paneId, kind: "codex", task: "count the files", name: "counter", worktree: false });
    expect(task.status).toBe(200);
    await o.flush();
    await w.refresh();
    const counter = o.get(task.body.team).members.counter!;

    const read = await call("/pane/read", { callerPane: ws.paneId, ref: "counter", lines: 50 });
    expect(read.body).toEqual({ pane: counter.paneId, text: `screen of ${counter.paneId}\n` });
    expect((await call("/pane/read", { callerPane: ws.paneId, ref: "ghost" })).status).toBe(404);

    const split = await call("/pane/split", { pane: ws.paneId, direction: "down", kind: "agent", agentKind: "omp" });
    expect(split.body).toMatchObject({ started: true });
    expect(w.model.panes.find((p) => p.id === split.body.paneId)!.tabId).toBe(ws.tabId); // same tab: a split, not a new tab

    const lsGet = await h(new Request("http://af/ls"));
    const body = (await lsGet.json()) as any;
    expect(body.teams[ws.workspaceId]).toBe(task.body.team);
    expect((await call("/ls", {})).status).toBe(404); // ls is GET only

    writeFileSync(join(repo, "notes.md"), "# notes\n");
    const shown = await call("/show", { target: join(repo, "notes.md"), pane: ws.paneId });
    expect(shown.status).toBe(200);
  });
});
