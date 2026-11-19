import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrMemberName } from "@af/core";
import { DEFAULT_CONFIG } from "../src/agents.ts";
import { makeHandler } from "../src/api.ts";
import { PlaybookLibrary } from "../src/playbooks.ts";
import { Teams } from "../src/teams.ts";
import type { Peek } from "../src/transcripts/peek.ts";
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

async function setup() {
  const home = tmp("af-ch-home-");
  const backend = new FakeBackend();
  const w = new Workspaces({ home, backend, paneEnv: () => ({}) });
  await w.start(60_000);
  const peeks = new Map<string, Peek>();
  const o = new Teams({ home, backend, w, sock: "/s", binDir: "/af/bin", protocolDir: SKILL, config: DEFAULT_CONFIG, playbooks: new PlaybookLibrary(join(SKILL, "playbooks"), join(home, "playbooks")), peek: async (p) => peeks.get(p), settleMs: 0, noSubmitMs: 0 });
  o.load();
  const ws = await backend.createWorkspace("paper", home);
  await backend.startAgent("lead", "claude", ws.paneId, []);
  await w.refresh();
  const h = makeHandler(o, w, backend);
  const call = async (path: string, body: object, method: "POST" | "GET" = "POST") => {
    const url = method === "GET" ? `http://af${path}?${new URLSearchParams(body as Record<string, string>)}` : `http://af${path}`;
    const r = await h(new Request(url, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : undefined }));
    return { status: r.status, body: (await r.json()) as any };
  };
  const step = async () => {
    for (let i = 0; i < 2; i++) {
      await w.refresh();
      await o.flush();
    }
  };
  const turn = async (name: string) => {
    backend.set(name, "working");
    await step();
    await Bun.sleep(5);
    backend.set(name, "idle");
    await step();
  };
  const typed = (pane: string) => backend.prompts.filter((p) => p.name === pane).map((p) => p.text);
  return { home, backend, w, o, ws, lead: ws.paneId, call, step, turn, typed, peeks };
}

describe("channels: the ways agents send each other messages", () => {
  test("a session and the one it handed work to: listed with what waits; a message from the user; one deleted; disconnected", async () => {
    const { o, backend, lead, call, step, turn, typed, peeks } = await setup();
    const r = await call("/task", { callerPane: lead, kind: "claude", task: "write section 3", name: "writer" });
    const team = r.body.team;
    await step();
    const m = () => o.get(team).members.writer!;
    const ch = async () => (await call("/channels", {}, "GET")).body.channels.find((c: any) => c.id === `parent:${team}:writer`);
    expect(await ch()).toMatchObject({ kind: "parent", a: { pane: lead }, b: { pane: m().paneId, name: "writer" }, toA: [], toB: [], ticket: { id: "T1" } });

    // its result waits in the main session's queue: shown on the channel
    peeks.set(m().paneId!, { reply: "Section 3 written." });
    await turn(herdrMemberName(team, "writer"));
    expect((await ch()).toA.map((x: any) => x.text)).toEqual(["Section 3 written."]);
    // the user deletes it: it is not given to the main session
    const ref = (await ch()).toA[0].ref;
    expect((await call("/channels/drop", { id: `parent:${team}:writer`, ref })).status).toBe(200);
    expect((await ch()).toA).toEqual([]);
    expect((await call("/team/take", { callerPane: lead })).body.text).toBe("(your queue is empty)");

    // the user sends the writer one message on the channel: typed in when it is free
    backend.set(herdrMemberName(team, "writer"), "working");
    await step();
    await call("/channels/send", { id: `parent:${team}:writer`, text: "use the two-year totals", toChild: true });
    expect((await ch()).toB.map((x: any) => x.text)).toEqual(["[agent-flow] From the user: use the two-year totals"]);
    backend.set(herdrMemberName(team, "writer"), "idle");
    await step();
    await step();
    expect(typed(m().paneId!).at(-1)).toBe("[agent-flow] From the user: use the two-year totals");
    // and one into the main session's queue, as if from the writer
    await call("/channels/send", { id: `parent:${team}:writer`, text: "the figures are in out/", toChild: false });
    expect((await ch()).toA[0].text).toContain("the figures are in out/");

    // disconnect: an independent session; its tickets close; what waited is dropped; nothing reports it exited
    const before = typed(m().paneId!).length;
    await call("/channels/send", { id: `parent:${team}:writer`, text: "one more", toChild: true });
    backend.set(herdrMemberName(team, "writer"), "working");
    await step();
    const d = await call("/channels/disconnect", { id: `parent:${team}:writer` });
    expect(d.status).toBe(200);
    expect(m()).toMatchObject({ detached: expect.any(String), status: "exited" });
    expect(o.get(team).tickets.T1).toMatchObject({ status: "closed", outcome: "cancelled", closeNote: "the user disconnected it" });
    expect(await ch()).toBeUndefined();
    expect(backend.panes.has(m().paneId!)).toBe(true); // its pane and agent are not touched
    // it finishes a turn later: nothing comes to the main session, nothing is typed into it
    peeks.set(m().paneId!, { reply: "done anyway", lastUser: "x" });
    backend.set(herdrMemberName(team, "writer"), "idle");
    await step();
    await turn(herdrMemberName(team, "writer"));
    expect(typed(m().paneId!).length).toBe(before);
    expect(o.get(team).queue.filter((q) => q.state !== "handled")).toEqual([]);
    expect(o.isMemberPane(m().paneId!)).toBe(false); // it may hand off by itself now (Refresh)
  });

  test("two agents the user connects: each told the other's name; af send both ways; a waiting message deleted; the channel deleted", async () => {
    const { backend, w, call, step, typed, ws } = await setup();
    const reviewer = await backend.splitPane(ws.paneId, "right", undefined, {});
    await backend.startAgent("rev", "codex", reviewer.paneId, []);
    const writer = await backend.createWorkspace("draft", "/tmp");
    await backend.startAgent("wri", "claude", writer.paneId, []);
    await w.refresh();
    const c = await call("/channels/connect", { a: reviewer.paneId, b: writer.paneId });
    expect(c.status).toBe(200);
    const id = c.body.id;
    expect((await call("/channels/connect", { a: writer.paneId, b: reviewer.paneId })).status).toBe(409);
    // both told, once they are free (agent-flow's queue: nothing typed into a busy agent)
    await step();
    const intro = (pane: string) => typed(pane).find((t) => t.includes("The user connected you"));
    expect(intro(reviewer.paneId)).toContain(`send ${c.body.bName} "<text>"`);
    expect(intro(writer.paneId)).toContain(`send ${c.body.aName} "<text>"`);
    // listed in both workspaces
    expect((await call("/channels", { workspace: ws.workspaceId }, "GET")).body.channels.map((x: any) => x.id)).toContain(id);
    expect((await call("/channels", { workspace: writer.workspaceId }, "GET")).body.channels.map((x: any) => x.id)).toContain(id);

    // the reviewer sends to the writer by name (af send); the writer works, so it waits on the channel
    backend.set("wri", "working");
    await w.refresh();
    const s = await call("/send", { callerPane: reviewer.paneId, to: c.body.bName, text: "section 2 needs the numbers" });
    expect(s.body).toMatchObject({ to: c.body.bName, queued: true });
    let ch = (await call("/channels", {}, "GET")).body.channels.find((x: any) => x.id === id);
    expect(ch.toB.map((m: any) => m.text)[0]).toStartWith(`[agent-flow] Message from ${c.body.aName} (reply: af send ${c.body.aName} "<text>"):\nsection 2 needs the numbers`);
    // a second one, deleted by the user before it is delivered
    await call("/send", { callerPane: reviewer.paneId, to: c.body.bName, text: "never mind the second point" });
    ch = (await call("/channels", {}, "GET")).body.channels.find((x: any) => x.id === id);
    expect(ch.toB.length).toBe(2);
    await call("/channels/drop", { id, ref: ch.toB[1].ref });
    // the writer is free: it gets the first, not the deleted one
    backend.set("wri", "idle");
    await w.refresh();
    await Bun.sleep(20);
    await w.refresh();
    expect(typed(writer.paneId).filter((t) => t.includes("Message from")).map((t) => t.split("\n")[1])).toEqual(["section 2 needs the numbers"]);
    // the writer answers; an unknown name is refused with the names it has
    expect((await call("/send", { callerPane: writer.paneId, to: "nobody", text: "x" })).body.error.message).toContain(c.body.aName);
    expect((await call("/send", { callerPane: writer.paneId, to: c.body.aName, text: "done" })).status).toBe(200);

    // deleted: what waits is dropped, both told, af send refused
    backend.set("rev", "working");
    await w.refresh();
    await call("/send", { callerPane: writer.paneId, to: c.body.aName, text: "and one more" });
    const del = await call("/channels/disconnect", { id });
    expect(del.body.dropped).toBeGreaterThanOrEqual(1);
    expect((await call("/channels", {}, "GET")).body.channels.some((x: any) => x.id === id)).toBe(false);
    expect((await call("/send", { callerPane: writer.paneId, to: c.body.aName, text: "?" })).status).toBe(404);
    backend.set("rev", "idle");
    await w.refresh();
    await Bun.sleep(20);
    await w.refresh();
    expect(typed(reviewer.paneId).some((t) => t.includes("and one more"))).toBe(false);
    w.stop();
  });
});
