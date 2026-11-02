import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSkills, codexSkills, commandsFor, ompSkills, skillFromFrontmatter } from "../src/commands.ts";
import { prepareFork, sessionIdOf } from "../src/fork.ts";
import { Notices } from "../src/notices.ts";
import { LocalFS, SshFS, TranscriptTail } from "../src/transcripts/index.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "af-cf-")));
  dirs.push(d);
  return d;
};

describe("slash commands and skills", () => {
  test("claude: skills from skill_listing attachments; later deltas add, a new initial listing replaces", () => {
    const listing = (content: string, isInitial = true) => JSON.stringify({ type: "attachment", attachment: { type: "skill_listing", content, isInitial } });
    const head = [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      listing("- grill-me: Interview the user about a plan.\n- academic-research-skills:deep-research: Universal deep research agent team."),
      listing("- overleaf: Sync Overleaf projects.", false),
    ].join("\n");
    expect(claudeSkills(head).map((s) => [s.insert, s.description])).toEqual([
      ["/grill-me", "Interview the user about a plan."],
      ["/academic-research-skills:deep-research", "Universal deep research agent team."],
      ["/overleaf", "Sync Overleaf projects."],
    ]);
    expect(claudeSkills(head + "\n" + listing("- only: one")).map((s) => s.name)).toEqual(["only"]);
  });

  test("codex: the available-skills catalog, invoked with $name, file locations stripped", () => {
    const text = "## Skills\n### Available skills\n- imagegen: Generate or edit raster images. (file: r2/imagegen/SKILL.md)\n- delivery-audit: Audit a delivery. (file: /x/SKILL.md)\n### How to use skills\n- not-a-skill: no";
    const head = JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text }] } });
    expect(codexSkills(head).map((s) => [s.insert, s.description])).toEqual([
      ["$imagegen", "Generate or edit raster images."],
      ["$delivery-audit", "Audit a delivery."],
    ]);
  });

  test("omp: SKILL.md frontmatter in its skill folders, invoked with /skill:name; built-ins come first", async () => {
    const home = tmp();
    mkdirSync(join(home, ".claude/skills/talk"), { recursive: true });
    writeFileSync(join(home, ".claude/skills/talk/SKILL.md"), '---\nname: talk-like-a-human\ndescription: "Write replies a human can read fast."\n---\nbody');
    mkdirSync(join(home, "proj/.omp/skills/local-one"), { recursive: true });
    writeFileSync(join(home, "proj/.omp/skills/local-one/SKILL.md"), "no frontmatter");
    const fs = new SshFS(async (cmd) => {
      const p = Bun.spawnSync(["sh", "-c", cmd], { env: { ...process.env, HOME: home }, stdout: "pipe" });
      return { code: 0, out: Buffer.from(p.stdout), err: "" };
    });
    const skills = await ompSkills(fs, join(home, "proj"));
    expect(skills.map((s) => [s.insert, s.description])).toEqual([
      ["/skill:talk-like-a-human", "Write replies a human can read fast."],
      ["/skill:local-one", ""],
    ]);
    const all = await commandsFor("omp", fs, undefined, join(home, "proj"));
    expect(all[0]).toMatchObject({ insert: "/model", kind: "command" });
    expect(all.at(-1)).toMatchObject({ insert: "/skill:local-one", kind: "skill" });
    expect(skillFromFrontmatter("---\nname: x\n---")).toEqual({ name: "x", description: undefined });
  });
});

describe("fork", () => {
  const line = (o: object) => JSON.stringify(o);

  test("claude: copy up to a user message (an entry's ref), new session id everywhere; the original is untouched", async () => {
    const dir = tmp();
    const oldId = "2073f510-3a98-4a65-a1cd-00f70560d61e";
    const src = join(dir, `${oldId}.jsonl`);
    const content =
      [
        line({ type: "user", sessionId: oldId, message: { role: "user", content: "first question" } }),
        line({ type: "assistant", sessionId: oldId, message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } }),
        line({ type: "user", sessionId: oldId, message: { role: "user", content: "second question" } }),
        line({ type: "assistant", sessionId: oldId, message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } }),
      ].join("\n") + "\n";
    writeFileSync(src, content);
    const source = { agent: "claude" as const, path: src, how: "session" as const };
    expect(sessionIdOf(source)).toBe(oldId);
    // the fork point is where the second user message's line starts, as the tail reports it
    const { ops } = await new TranscriptTail(source, new LocalFS()).read();
    const second = ops.find((o) => o.op === "add" && o.entry.block.kind === "user" && (o.entry.block as any).text === "second question") as any;
    expect(second.entry.ref).toBe(content.indexOf(line({ type: "user", sessionId: oldId, message: { role: "user", content: "second question" } })));

    const plan = await prepareFork(new LocalFS(), source, second.entry.ref, "11111111-2222-3333-4444-555555555555");
    expect(plan.args).toEqual(["--resume", "11111111-2222-3333-4444-555555555555"]);
    const copy = readFileSync(plan.session!.path, "utf8");
    expect(copy).toContain("first answer");
    expect(copy).not.toContain("second question");
    expect(copy).not.toContain(oldId);
    expect(readFileSync(src, "utf8")).toBe(content);
  });

  test("omp: whole conversation, new file named <time>_<id>; codex: codex fork <id>, whole only", async () => {
    const dir = tmp();
    const oldId = "01a19adc-3cae-7000-9310-8329217a306d";
    const src = join(dir, `2026-11-02T06-04-47-150Z_${oldId}.jsonl`);
    writeFileSync(src, line({ type: "session", id: oldId }) + "\n" + line({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }) + "\n");
    const plan = await prepareFork(new LocalFS(), { agent: "omp", path: src, how: "session" }, undefined, "22222222-2222-3333-4444-555555555555");
    expect(plan.session!.path).toMatch(/\/\d{4}-\d\d-\d\dT[\d-]+Z_22222222-2222-3333-4444-555555555555\.jsonl$/);
    expect(plan.args).toEqual([`--resume=${plan.session!.path}`]);
    expect(readFileSync(plan.session!.path, "utf8")).toContain('"id":"22222222-2222-3333-4444-555555555555"');

    const codex = { agent: "codex" as const, path: "/x/rollout-2026-11-02T14-16-30-01a19ae6-f5c1-7b70-bf1d-6b1cd834650a.jsonl", how: "session" as const };
    expect((await prepareFork(new LocalFS(), codex, undefined)).args).toEqual(["fork", "-c", "check_for_update_on_startup=false", "--no-alt-screen", "01a19ae6-f5c1-7b70-bf1d-6b1cd834650a"]);
    await expect(prepareFork(new LocalFS(), codex, 100)).rejects.toThrow(/whole conversation/);
  });

  test("the SSH copy command does the same cut and replacement", async () => {
    const dir = tmp();
    const oldId = "aaaaaaaa-0000-0000-0000-000000000001";
    const src = join(dir, `${oldId}.jsonl`);
    const content = `{"sessionId":"${oldId}","n":1}\n{"sessionId":"${oldId}","n":2}\n`;
    writeFileSync(src, content);
    const fs = new SshFS(async (cmd) => {
      const p = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode ?? -1, out: Buffer.from(p.stdout), err: p.stderr.toString() };
    });
    const plan = await prepareFork(fs, { agent: "claude", path: src, how: "session" }, content.indexOf("\n") + 1, "bbbbbbbb-0000-0000-0000-000000000002");
    expect(readFileSync(plan.session!.path, "utf8")).toBe('{"sessionId":"bbbbbbbb-0000-0000-0000-000000000002","n":1}\n');
  });
});

describe("notices", () => {
  test("a repeated notice from the same source is counted, not repeated", () => {
    const n = new Notices();
    const seen: string[] = [];
    n.subscribe((x) => seen.push(`${x.text}×${x.count}`));
    n.add("error", "machine:ds03", "ds03: cannot reach ds03");
    n.add("warn", "terminal:w1:p2", "stream stopped");
    n.add("error", "machine:ds03", "ds03: cannot reach ds03");
    expect(n.list.map((x) => `${x.source}×${x.count}`)).toEqual(["terminal:w1:p2×1", "machine:ds03×2"]);
    n.add("info", "machine:ds03", "Connected to ds03 again");
    expect(n.list.length).toBe(3);
    expect(seen.at(-2)).toBe("ds03: cannot reach ds03×2");
  });
});
