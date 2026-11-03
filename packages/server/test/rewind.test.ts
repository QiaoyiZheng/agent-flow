import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inputText } from "../src/controls.ts";
import { claudeHighlight, codexHighlight, firstLine, ompHighlight, sameMessage } from "../src/rewind.ts";
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
