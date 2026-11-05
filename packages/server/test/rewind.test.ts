import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputText } from "../src/controls.ts";
import { claudeHighlight, codexHighlight, firstLine, geminiHighlight, ompHighlight, sameMessage } from "../src/rewind.ts";
import { LocalFS, TranscriptTail, codexBases } from "../src/transcripts/index.ts";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "af-rewind-")));
  dirs.push(d);
  return d;
};

// screens as each agent draws them (captured from claude 2.1.317, codex 0.162.1, omp 18.2.3)
const RULE = "─".repeat(60);
const claudeList = (at: number) =>
  ["❯ Reply with just the word four.", "⏺ four", RULE, "  Rewind", "  Restore the code and/or conversation to the point before…"]
    .concat(["one", "two", "three", "four"].flatMap((w, i) => [`  ${at === i ? "❯" : " "} Reply with just the word ${w}.`, "    No code changes"]))
    .concat([`  ${at === 4 ? "❯" : " "} (current)`, "  Enter to continue · Esc to cancel"])
    .join("\n");
const codexBrowse = (at: number) =>
  ["one", "two", "three", "four"].map((w, i) => `\x1b[1m\x1b[2m\x1b[48;2;68;73;84m› \x1b[0m${at === i ? "\x1b[7m" : ""}\x1b[48;2;68;73;84mReply with just the word ${w}.\x1b[0m`).join("\n") +
  "\nBrowsing transcript · ↑↓/jk scroll · ←→/hl prompts · ⌃t details · ↵ rewind · esc back";
const ompPick = (text: string) => ["   one", "╭┄┄┄┄┄┄┄┄┄┄╮", "┆           ┆", `┆  ${text}  ┆`, "┆           ┆", "╰┄┄┄┄┄┄┄┄┄┄╯", " 8/9  ↑/↓ step  ←/→ user turns  enter rewind  esc cancel"].join("\n");

describe("reading the agents' rewind pickers", () => {
  test("claude: the ❯ row of the Rewind list, not the conversation's ❯ lines", () => {
    expect(claudeHighlight(claudeList(4))).toBe("(current)");
    expect(claudeHighlight(claudeList(2))).toBe("Reply with just the word three.");
    expect(claudeHighlight("❯ Reply with just the word four.\n⏺ four")).toBeUndefined(); // no list open
  });
  test("codex: the prompt in reverse video while browsing", () => {
    expect(codexHighlight(codexBrowse(3))).toBe("Reply with just the word four.");
    expect(codexHighlight(codexBrowse(1))).toBe("Reply with just the word two.");
    expect(codexHighlight("› Reply with just the word one.\n• one")).toBeUndefined();
  });
  test("omp: the dashed box", () => {
    expect(ompHighlight(ompPick("Reply with just the word four."))).toBe("Reply with just the word four.");
    expect(ompHighlight("╰─ ")).toBeUndefined();
  });
  test("gemini: the ● item under \"> Rewind\", its rows joined, without the row saying what it changed", () => {
    const W = 60;
    const row = (r: string) => `│ ${r.padEnd(W - 4)} │`;
    const geminiList = (at: number) =>
      [
        "▄".repeat(W),
        " > /rewind",
        "▀".repeat(W),
        "",
        `╭${"─".repeat(W - 2)}╮`,
        ...["", "> Rewind", ""].map(row),
        ...[
          ["Reply with just the word one.", "No files have been changed"],
          ["Write a long note about the build and then run every test in the", "repository, one by one ...", "2 files changed +12 -3"],
          ["Stay at current position", "Cancel rewind and stay here"],
        ].flatMap((item, i) => [...item.map((l, k) => row(`${k === 0 && i === at ? "●" : " "} ${l}`)), row("")]),
        ...["", "(Use Enter to select a message, Esc to close, Right/Left to expand/collapse)", ""].map(row),
        `╰${"─".repeat(W - 2)}╯`,
      ].join("\n");
    expect(geminiHighlight(geminiList(2))).toBe("Stay at current position");
    expect(geminiHighlight(geminiList(0))).toBe("Reply with just the word one.");
    const long = geminiHighlight(geminiList(1));
    expect(long).toBe("Write a long note about the build and then run every test in the repository, one by one ...");
    expect(sameMessage(long, "Write a long note about the build and then run every test in the repository, one by one, and fix them.")).toBe(true);
    expect(geminiHighlight(["▄".repeat(W), " > Reply with just the word one.", "▀".repeat(W)].join("\n"))).toBeUndefined();
  });
  test("matching a message to what a picker shows (cut with …)", () => {
    expect(sameMessage("Reply with just the word three.", "Reply with just the word three.")).toBe(true);
    expect(sameMessage("Reply with just the…", "Reply with just the word three.")).toBe(true);
    expect(sameMessage("Reply with just the word four.", "Reply with just the word three.")).toBe(false);
    expect(sameMessage("(current)", "Reply with just the word three.")).toBe(false);
    expect(firstLine("\n  first   line\nsecond")).toBe("first line");
  });
});

describe("reading the agents' input boxes", () => {
  test("text, empty, placeholder, completion hint", () => {
    expect(inputText("claude", `${RULE}\n❯ typed draft\x1b[7m \x1b[0m\r\n${RULE}`)).toBe("typed draft");
    expect(inputText("claude", `${RULE}\n❯ \x1b[0m\x1b[7m \x1b[0m\r\n${RULE}`)).toBe("");
    expect(inputText("claude", claudeList(4))).toBeUndefined(); // the box is not on screen while the list is
    expect(inputText("codex", "\x1b[1m\x1b[48;2;59;64;76m›\x1b[0m\x1b[48;2;59;64;76m \x1b[0m\x1b[2m\x1b[48;2;59;64;76mAsk Codex to do anything\x1b[0m")).toBe("");
    expect(inputText("codex", "\x1b[1m\x1b[48;2;59;64;76m›\x1b[0m\x1b[48;2;59;64;76m typed draft      ")).toBe("typed draft");
    expect(inputText("omp", "\x1b[38;2;101;199;254m╰─ \x1b[0m      ")).toBe("");
    expect(inputText("omp", "\x1b[38;2;101;199;254m╰─ \x1b[0m\x1b[38;2;229;229;231mtyped draft\x1b[0m\x1b[38;2;110;118;129ms\x1b[0m   ")).toBe("typed draft");
  });

  test("gemini: the band at the bottom (placeholder, text, two lines), not a user message above a dialog", () => {
    // captured colour codes (Gemini CLI 0.66, default theme): band rows, the "> " prompt, the cursor, the gray placeholder
    const top = "\x1b[0m\x1b[38;2;67;72;82m" + "▄".repeat(40) + "\x1b[0m\r";
    const bottom = "\x1b[0m\x1b[38;2;67;72;82m" + "▀".repeat(40) + "\x1b[0m\r";
    const prompt = (rest: string) => `\x1b[0m\x1b[48;2;67;72;82m \x1b[0m\x1b[38;2;215;175;255m\x1b[48;2;67;72;82m> \x1b[0m${rest}\x1b[48;2;67;72;82m        \x1b[0m\r`;
    const footer = " \x1b[0m\x1b[38;2;175;175;175mworkspace (/directory)\x1b[0m        \x1b[0m\x1b[38;2;175;175;175m/model\x1b[0m\r\n \x1b[0m\x1b[38;2;255;255;255m/tmp/proj\x1b[0m\r";
    const screen = (...rows: string[]) => ["✦ Done.", top, ...rows, bottom, footer].join("\n");
    expect(inputText("gemini", screen(prompt("\x1b[7m\x1b[48;2;67;72;82m \x1b[0m\x1b[38;2;175;175;175m\x1b[48;2;67;72;82m Type your message or @path/to/file\x1b[0m")))).toBe("");
    expect(inputText("gemini", screen(prompt("\x1b[38;2;255;255;255m\x1b[48;2;67;72;82mhalf typed draft\x1b[0m\x1b[7m\x1b[48;2;67;72;82m \x1b[0m")))).toBe("half typed draft");
    expect(inputText("gemini", screen(prompt("\x1b[38;2;255;255;255mline one\x1b[0m"), "\x1b[48;2;67;72;82m   line two\x1b[0m\r"))).toBe("line one\nline two");
    // a dialog at the bottom: the user's message band above it is not the box
    expect(inputText("gemini", [top, prompt("\x1b[38;2;255;255;255mRun the tests\x1b[0m"), bottom, "", "╭────╮", "│ ● 1. Allow once │", "╰────╯"].join("\n"))).toBeUndefined();
  });
});

describe("transcripts after a rewind", () => {
  test("codex: a new file continues the old one up to the rewind point; the view shows both, marked", async () => {
    const root = tmp();
    const day = join(root, "2026/11/03");
    mkdirSync(day, { recursive: true });
    const thread = "01a1a0f4-b1cc-7112-a9d4-82d24e17a269";
    const msg = (role: string, text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
    const first = join(day, `rollout-2026-11-03T18-29-13-${thread}.jsonl`);
    const head = JSON.stringify({ type: "session_meta", payload: { id: thread, cwd: "/p" } }) + "\n" + msg("user", "one") + "\n" + msg("assistant", "1") + "\n";
    writeFileSync(first, head + msg("user", "two") + "\n" + msg("assistant", "2") + "\n"); // "two" is rewound away
    const second = join(day, `rollout-2026-11-03T18-32-40-${thread}_01a1a0f7-db09-72c0-812e-a472fdf4e6c6.jsonl`);
    writeFileSync(second, JSON.stringify({ type: "session_meta", payload: { id: thread, history_mode: "paginated", history_base: { thread_id: thread, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(head) } } }) + "\n" + msg("user", "three") + "\n" + msg("assistant", "3") + "\n");
    const fs = new LocalFS({ claude: join(root, "none"), codex: root });
    expect(await codexBases(fs, second)).toEqual([{ path: first, end: Buffer.byteLength(head) }]);
    expect(await codexBases(fs, first)).toEqual([]);
    const t = new TranscriptTail({ agent: "codex", path: second, how: "session" }, fs);
    const shown = ((await t.read()).ops as any[]).filter((o) => o.op === "add").map((o) => (o.entry.block.kind === "notice" ? `[${o.entry.block.text.slice(0, 9)}]` : o.entry.block.text));
    expect(shown).toEqual(["one", "1", "[↶ Rewound]", "three", "3"]);
    expect(t.more).toBe(false);

    // rewound again: the next file names the page before it (by its page id), not the thread
    const page = "01a1a0f7-db09-72c0-812e-a472fdf4e6c6";
    const keep = Buffer.byteLength(JSON.stringify({ type: "session_meta", payload: { id: thread, history_mode: "paginated", history_base: { thread_id: thread, end_ordinal_exclusive: 3, end_byte_offset: Buffer.byteLength(head) } } }) + "\n" + msg("user", "three") + "\n" + msg("assistant", "3") + "\n");
    appendFileSync(second, msg("user", "four") + "\n" + msg("assistant", "4") + "\n"); // "four" is rewound away next
    const third = join(day, `rollout-2026-11-03T18-50-59-${thread}_01a1a108-a112-73c1-8787-180187e7a249.jsonl`);
    writeFileSync(third, JSON.stringify({ type: "session_meta", payload: { id: thread, history_base: { thread_id: page, end_ordinal_exclusive: 30, end_byte_offset: keep } } }) + "\n" + msg("user", "five") + "\n");
    expect((await codexBases(fs, third)).map((b) => b.path)).toEqual([second, first]);
    const t3 = new TranscriptTail({ agent: "codex", path: third, how: "session" }, fs);
    const shown3 = ((await t3.read()).ops as any[]).filter((o) => o.op === "add").map((o) => (o.entry.block.kind === "notice" ? `[${o.entry.block.text.slice(0, 9)}]` : o.entry.block.text));
    expect(shown3).toEqual(["one", "1", "[↶ Rewound]", "three", "3", "[↶ Rewound]", "five"]);
  });

  test("claude, omp: the turns from the rewound message on are hidden until the agent writes; later lines show", async () => {
    const root = tmp();
    const path = join(root, "s.jsonl");
    const line = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }] } }) + "\n";
    writeFileSync(path, line("user", "one") + line("assistant", "1"));
    const from = Buffer.byteLength(line("user", "one") + line("assistant", "1"));
    appendFileSync(path, line("user", "two") + line("assistant", "2"));
    const to = from + Buffer.byteLength(line("user", "two") + line("assistant", "2"));
    const cuts = [{ from, to }];
    const t = new TranscriptTail({ agent: "omp", path, how: "session" }, new LocalFS(), undefined, undefined, () => cuts);
    const texts = (ops: any[]) => ops.filter((o) => o.op === "add").map((o) => o.entry.block.text);
    expect(texts((await t.read()).ops)).toEqual(["one", "1"]);
    appendFileSync(path, line("user", "three"));
    expect(texts((await t.read()).ops)).toEqual(["three"]);
  });
});

import { Cuts, takeBack, unansweredPrompt } from "../src/rewind.ts";

describe("a message claude took back (Esc before it replied)", () => {
  // the lines claude 2.1.318 wrote when Esc stopped it 2.5 s after the message: the prompt, attachments, then
  // bookkeeping; nothing answers it. The next message's parent is the line before it.
  const prompt = (uuid: string, parent: string, text: string) => JSON.stringify({ type: "user", uuid, parentUuid: parent, message: { role: "user", content: text } });
  const att = (uuid: string, parent: string) => JSON.stringify({ type: "attachment", uuid, parentUuid: parent, attachment: { type: "skill_listing" } });
  const reply = (uuid: string, parent: string, text: string) => JSON.stringify({ type: "assistant", uuid, parentUuid: parent, message: { role: "assistant", content: [{ type: "text", text }] } });
  const before = [att("a1", ""), prompt("u1", "a1", "Reply with just the word pong."), reply("r1", "u1", "pong")].join("\n") + "\n";
  const taken = [prompt("u2", "r1", "List the files in this folder, then write a 300-word story about them."), att("a2", "u2"), att("a3", "a2"), JSON.stringify({ type: "last-prompt", lastPrompt: "List the files" }), JSON.stringify({ type: "ai-title", aiTitle: "Files" })].join("\n") + "\n";

  test("the newest message with nothing answering it, and where its line starts", () => {
    const buf = Buffer.from(before + taken);
    expect(unansweredPrompt(buf, 0)).toEqual({ at: Buffer.byteLength(before), text: "List the files in this folder, then write a 300-word story about them." });
    expect(unansweredPrompt(Buffer.from(before), 0)).toBeUndefined(); // answered
    const toolResult = JSON.stringify({ type: "user", uuid: "t1", parentUuid: "u2", toolUseResult: {}, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } });
    expect(unansweredPrompt(Buffer.from(before + taken + toolResult + "\n"), 0)).toBeUndefined(); // claude was at work on it
    // read from the middle of a line: that line is not taken for a whole one
    expect(unansweredPrompt(Buffer.from(taken).subarray(10), 100)).toBeUndefined();
  });

  test("taken back: hidden in the view, cleared from claude's box (or left there); not when claude's box holds something else", async () => {
    const dir = tmp();
    const path = join(dir, "s.jsonl");
    writeFileSync(path, before + taken);
    const box = (text: string) => `${RULE}\n❯ ${text}\n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)`;
    let screen = box("List the files in this folder, then write a 300-word story about them.");
    let cleared = 0;
    const w = { model: { panes: [{ id: "w1:p1", agent: "claude" }] }, visible: async () => screen, clearBox: async () => ((cleared++, (screen = box(""))), true) } as any;
    const changed: string[] = [];
    const cuts = new Cuts();
    cuts.onChange((p) => changed.push(p));
    const access = { resolve: async () => ({ source: { agent: "claude", path } }), fsFor: () => ({ fs: new LocalFS() }), cuts } as any;

    expect(await takeBack(w, access, "w1:p1", { clear: true, expect: "Reply with just the word pong.", waitMs: 0 })).toBeUndefined(); // not that one
    expect(await takeBack(w, access, "w1:p1", { clear: true, waitMs: 0 })).toBe("List the files in this folder, then write a 300-word story about them.");
    expect(cleared).toBe(1);
    expect(cuts.for(path)).toEqual([{ from: Buffer.byteLength(before), to: Buffer.byteLength(before + taken) }]);
    expect(changed).toEqual(["w1:p1"]);
    // the view reads the file again without it
    const tail = new TranscriptTail({ agent: "claude", path, how: "session" }, new LocalFS(), undefined, undefined, () => cuts.for(path));
    const users = (await tail.read()).ops.flatMap((o: any) => (o.op === "add" && o.entry.block.kind === "user" ? [o.entry.block.text] : []));
    expect(users).toEqual(["Reply with just the word pong."]);
    // again: claude's box is empty now, nothing happens
    expect(await takeBack(w, access, "w1:p1", { clear: true, waitMs: 0 })).toBeUndefined();

    // Esc in claude's own terminal: the text stays in its box
    const path2 = join(dir, "s2.jsonl");
    writeFileSync(path2, before + taken);
    access.resolve = async () => ({ source: { agent: "claude", path: path2 } });
    screen = box("List the files in this folder, then write a 300-word story about them.");
    expect(await takeBack(w, access, "w1:p1", { clear: false, waitMs: 0 })).toBeDefined();
    expect(cleared).toBe(1);
    expect(cuts.for(path2).length).toBe(1);

    // claude's box holds something else (typed while it worked), or the agent is not claude: nothing
    const path3 = join(dir, "s3.jsonl");
    writeFileSync(path3, before + taken);
    access.resolve = async () => ({ source: { agent: "claude", path: path3 } });
    screen = box("something else");
    expect(await takeBack(w, access, "w1:p1", { clear: true, waitMs: 0 })).toBeUndefined();
    w.model.panes[0].agent = "codex";
    screen = box("List the files in this folder, then write a 300-word story about them.");
    expect(await takeBack(w, access, "w1:p1", { clear: true, waitMs: 0 })).toBeUndefined();
    expect(cuts.for(path3)).toEqual([]);
  });
});
