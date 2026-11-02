import { describe, expect, test } from "bun:test";
import { keysToChoose, parseMenu } from "../src/menu.ts";

// captured from a real claude AskUserQuestion prompt (Claude Code 2.1.316)
const ASK = [
  "⏺ 第三条收到",
  "",
  "❯ Use the AskUserQuestion tool now to ask me one question: which output format I prefer for the report. Options: Markdown",
  "  (plain text with headings), LaTeX (for the paper), HTML (for the browser). Do not do anything else.",
  "  ⎿  1 skill available",
  "─".repeat(120),
  " ☐ Format",
  "",
  "Which output format do you prefer for the report?",
  "",
  "❯ 1. Markdown",
  "     Plain text with headings",
  "  2. LaTeX",
  "     For the paper",
  "  3. HTML",
  "     For the browser",
  "  4. Type something.",
  "─".repeat(120),
  "  5. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
].join("\n");

describe("parsing agent menus", () => {
  test("claude question: title, question, options with descriptions, an option past the separator, key hint", () => {
    const m = parseMenu(ASK)!;
    expect(m.question).toEqual(["☐ Format", "Which output format do you prefer for the report?"]);
    expect(m.options.map((o) => [o.number, o.label, o.description ?? "", o.selected, o.freeText])).toEqual([
      [1, "Markdown", "Plain text with headings", true, false],
      [2, "LaTeX", "For the paper", false, false],
      [3, "HTML", "For the browser", false, false],
      [4, "Type something.", "", false, true],
      [5, "Chat about this", "", false, false],
    ]);
    expect(m.hint).toBe("Enter to select · ↑/↓ to navigate · Esc to cancel");
    expect(keysToChoose(m, 2)).toEqual(["down", "down", "enter"]);
    expect(keysToChoose(m, 0)).toEqual(["enter"]);
  });

  test("the highlight in the middle: options above it are found too", () => {
    const moved = ASK.replace("❯ 1. Markdown", "  1. Markdown").replace("  3. HTML", "❯ 3. HTML");
    const m = parseMenu(moved)!;
    expect(m.options.map((o) => o.selected)).toEqual([false, false, true, false, false]);
    expect(keysToChoose(m, 0)).toEqual(["up", "up", "enter"]);
    expect(keysToChoose(m, 4)).toEqual(["down", "down", "enter"]);
  });

  test("claude permission prompt", () => {
    const m = parseMenu(
      [
        "╭────────────────────────────────────────╮",
        "│ Bash command                           │",
        "│                                        │",
        "│   rm -rf build                         │",
        "│   Remove the build directory           │",
        "│                                        │",
        "│ Do you want to proceed?                │",
        "│ ❯ 1. Yes                               │",
        "│   2. Yes, and don't ask again for rm commands in /proj │",
        "│   3. No, and tell Claude what to do differently (esc) │",
        "╰────────────────────────────────────────╯",
      ].join("\n"),
    )!;
    expect(m.question).toEqual(["Bash command", "rm -rf build", "Remove the build directory", "Do you want to proceed?"]);
    expect(m.options.map((o) => o.label)).toEqual(["Yes", "Yes, and don't ask again for rm commands in /proj", "No, and tell Claude what to do differently (esc)"]);
    expect(m.options[2]!.freeText).toBe(true);
  });

  test("unnumbered list with a hint: the folder-trust dialog", () => {
    const m = parseMenu([" Quick safety check: Is this a project you created or one you trust?", "", " ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel"].join("\n"))!;
    expect(m.options.map((o) => [o.label, o.selected])).toEqual([
      ["No, exit", true],
      ["Yes, I trust this folder", false],
    ]);
    expect(keysToChoose(m, 1)).toEqual(["down", "enter"]);
  });

  test("codex approval", () => {
    const m = parseMenu(["  Would you like to run the following command?", "", "  $ npm test", "", "› 1. Yes, proceed (y)", "  2. Yes, and don't ask again for this command (p)", "  3. No, and tell Codex what to do differently (esc)", "", "  Press enter to confirm or esc to cancel"].join("\n"))!;
    expect(m.question).toEqual(["Would you like to run the following command?", "$ npm test"]);
    expect(m.options.length).toBe(3);
    expect(m.options[2]!.freeText).toBe(true);
    expect(m.hint).toBe("Press enter to confirm or esc to cancel");
  });

  test("not a menu: the agent's own input line, a lone pointer, plain output", () => {
    expect(parseMenu(["─".repeat(80), "❯ please fix the tests", "─".repeat(80), "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n"))).toBeUndefined();
    expect(parseMenu("❯ 1. only one option\n\nEnter to select")).toBeUndefined();
    expect(parseMenu("all tests passed\n$ ")).toBeUndefined();
  });
});
