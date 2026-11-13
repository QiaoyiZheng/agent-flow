import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { PlaybookLibrary } from "../src/playbooks.ts";
import { Teams } from "../src/teams.ts";
import { Workspaces } from "../src/workspaces.ts";
import { FakeBackend } from "./fake.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (p: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), p)));
  dirs.push(d);
  return d;
};
const SKILL = join(import.meta.dir, "../../skill");

describe("two saved machines that reach the same Herdr (two SSH routes to one machine)", () => {
  test("its panes once, under the first; what was kept under the other moves; the other route serves when the first is down", async () => {
    const home = tmp("af-routes-");
    const local = new FakeBackend();
    // the order of Herdr's list: "gpu" first, then "gpu-campus" (the same machine, another SSH target)
    local.saved = [
      { id: "p1", label: "gpu", target: "gpu", session: "default" },
      { id: "p2", label: "gpu-campus", target: "gpu-campus", session: "default" },
    ];
    const herdr = new FakeBackend(); // the one Herdr both routes reach
    const remotes = new Map<string, any>();
    const w = new Workspaces({
      home,
      backend: local,
      paneEnv: () => ({}),
      remotePollMs: 0,
      remote: (spec, onChange) => {
        const r: any = {
          state: "offline",
          home: "/home/u",
          async connect() {
            r.state = "online";
            onChange();
          },
          close() {
            r.state = "offline";
            onChange();
          },
          async exec(cmd: string) {
            if (cmd.includes("machine-id")) return { code: 0, out: Buffer.from("3036b21e|/home/u"), err: "" };
            return { code: 0, out: Buffer.from(""), err: "" };
          },
        };
        remotes.set(spec.key, r);
        return { remote: r, backend: () => herdr };
      },
    });
    await w.start(60_000);
    const ws = await herdr.createWorkspace("iad", "/home/u/iad");
    await herdr.startAgent("rev", "codex", ws.paneId, []);
    const settle = async () => {
      for (let i = 0; i < 3; i++) {
        await Bun.sleep(10);
        await w.refresh();
      }
    };

    // only the second route is connected (the first was down): its panes are shown under it, and kept under it
    await w.connect("gpu-campus");
    await settle();
    const onCampus = `gpu-campus~${ws.paneId}`;
    expect(w.model.panes.map((p) => p.id)).toContain(onCampus);
    w.rememberSession(onCampus, "s-1");
    const o = new Teams({ home, backend: local, w, sock: "/s", binDir: "/af/bin", protocolDir: SKILL, config: DEFAULT_CONFIG, playbooks: new PlaybookLibrary(join(SKILL, "playbooks"), join(home, "playbooks")) });
    o.load();
    // a team whose member was started through the second route
    const lead = await local.createWorkspace("proj", home);
    await local.startAgent("lead", "claude", lead.paneId, []);
    await w.refresh();
    const team = (o as any).directTeam(lead.paneId);
    (o as any).emit(team, { type: "member.added", at: new Date().toISOString(), member: { name: "rev", kind: "codex", protocol: "none", cwd: "/home/u/iad", status: "idle", addedAt: new Date().toISOString(), machine: "gpu-campus" } });
    (o as any).emit(team, { type: "member.placed", at: new Date().toISOString(), name: "rev", paneId: onCampus, tabId: `gpu-campus~${ws.tabId}` });

    // the first route connects: both turn out to reach one Herdr. Its panes once, under the first; the second is a route
    await w.connect("gpu");
    await settle();
    const onGpu = `gpu~${ws.paneId}`;
    expect(w.model.panes.filter((p) => p.id.includes("~") && p.id.endsWith(ws.paneId)).map((p) => p.id)).toEqual([onGpu]);
    expect(w.model.machines.find((m) => m.id === "gpu-campus")).toMatchObject({ aliasOf: "gpu" });
    expect(w.primaryOf("gpu-campus")).toBe("gpu");
    expect(w.canonId(onCampus)).toBe(onGpu);
    expect(JSON.parse(readFileSync(join(home, "machine-ids.json"), "utf8"))).toEqual({ gpu: "3036b21e|/home/u", "gpu-campus": "3036b21e|/home/u" });
    // what was kept under the second route moved: the session, and the team's member
    expect(w.sessions[onGpu]?.id).toBe("s-1");
    expect(w.sessions[onCampus]).toBeUndefined();
    expect(o.get(team.id).members.rev).toMatchObject({ paneId: onGpu, tabId: `gpu~${ws.tabId}`, machine: "gpu" });
    // an id on the second route still reaches the pane
    await w.prompt(onCampus, "hello");
    expect(herdr.prompts.at(-1)).toEqual({ name: ws.paneId, text: "hello" });

    // the first route goes down: the second serves it; the panes stay under the first, and work
    remotes.get("gpu").close();
    await settle();
    expect(w.model.machines.find((m) => m.id === "gpu")).toMatchObject({ state: "online", via: "gpu-campus" });
    expect(w.model.panes.filter((p) => p.id.includes("~") && p.id.endsWith(ws.paneId)).map((p) => p.id)).toEqual([onGpu]);
    await w.prompt(onGpu, "still there");
    expect(herdr.prompts.at(-1)).toEqual({ name: ws.paneId, text: "still there" });
    expect(w.remoteOf(onGpu)).toBe(remotes.get("gpu-campus"));
    w.stop();
  });

  test("an agent stopped for being idle through the second route stays a stopped agent for its team, not one that exited", async () => {
    const home = tmp("af-routes-sleep-");
    const local = new FakeBackend();
    local.saved = [
      { id: "p1", label: "gpu", target: "gpu", session: "default" },
      { id: "p2", label: "gpu-campus", target: "gpu-campus", session: "default" },
    ];
    const herdr = new FakeBackend();
    const w = new Workspaces({
      home,
      backend: local,
      paneEnv: () => ({}),
      remotePollMs: 0,
      remote: (_spec, onChange) => {
        const r: any = {
          state: "offline",
          home: "/home/u",
          async connect() {
            r.state = "online";
            onChange();
          },
          close() {},
          async exec(cmd: string) {
            return { code: 0, out: Buffer.from(cmd.includes("machine-id") ? "3036b21e|/home/u" : ""), err: "" };
          },
        };
        return { remote: r, backend: () => herdr };
      },
    });
    await w.start(60_000);
    const ws = await herdr.createWorkspace("iad", "/home/u/iad");
    await herdr.startAgent("tvhqb-rev", "codex", ws.paneId, []);
    // what the bug left: the stop recorded under the second route (both routes were shown, each pane twice)
    const asleep = { [`gpu-campus~${ws.paneId}`]: { pane: `gpu-campus~${ws.paneId}`, agent: "codex", name: "tvhqb-rev", bin: "codex", args: ["--no-alt-screen"], cwd: "/home/u/iad", status: "done", session: { id: "01a1" }, since: new Date().toISOString(), reason: "finished worker, idle 12 min" } };
    await Bun.write(join(home, "asleep.json"), JSON.stringify(asleep));
    const w2 = new Workspaces({ home, backend: local, paneEnv: () => ({}), remotePollMs: 0, remote: (w as any).opts.remote });
    w.stop();
    await w2.start(60_000);
    // its process is gone: the pane is a shell now
    herdr.panes.get(ws.paneId)!.agent = undefined;
    await w2.connect("gpu");
    await w2.connect("gpu-campus");
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(10);
      await w2.refresh();
    }
    // the stop is the first route's now, and its pane shows the stopped codex (so a team does not see it exit)
    const p = w2.model.panes.find((x) => x.id === `gpu~${ws.paneId}`)!;
    expect(p).toMatchObject({ agent: "codex", agentName: "tvhqb-rev", agentStatus: "done" });
    expect(p.asleep).toBeDefined();
    expect(Object.keys(JSON.parse(readFileSync(join(home, "asleep.json"), "utf8")))).toEqual([`gpu~${ws.paneId}`]);
    w2.stop();
  });
});
