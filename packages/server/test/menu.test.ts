import { describe, expect, test } from "bun:test";
import { enrichFromTranscript, keysToChoose, parseMenu, screenOverlay } from "../src/menu.ts";

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

  test("codex folder trust: the shell line above the dialog is not part of the question", () => {
    const m = parseMenu(
      [
        "zhengqiaoyi@Mac mul2 % codex fork --no-alt-screen 01a19ae6",
        "  Folder access",
        "  /Users/zhengqiaoyi/agent-flow/.sandbox/demo/.agent-flow/worktrees/rhv93/mul2",
        "  Trust this folder? Codex can read, edit, and run files here.",
        "› 1. Trust and continue",
        "  2. Quit",
        "  enter continue · esc quit",
      ].join("\n"),
    )!;
    expect(m.question).toEqual(["Folder access", "/Users/zhengqiaoyi/agent-flow/.sandbox/demo/.agent-flow/worktrees/rhv93/mul2", "Trust this folder? Codex can read, edit, and run files here."]);
    expect(m.options.map((o) => o.label)).toEqual(["Trust and continue", "Quit"]);
  });

  test("claude's real permission prompt (2.1.316), with the switch-to-auto-mode option", () => {
    const screen = [
      "⏺ Bash(echo agent-flow-probe > /tmp/af-perm-probe.txt)",
      "  ⎿ \u00a0Waiting…",
      "",
      "─".repeat(120),
      " Bash command",
      ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
      " Write probe text to a temp file",
      "╌".repeat(120),
      " echo agent-flow-probe > /tmp/af-perm-probe.txt",
      "╌".repeat(120),
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and always allow access to /tmp from this project",
      "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
      "   4. No",
      "",
      " Esc to cancel · Tab to amend",
    ].join("\n");
    const m = parseMenu(screen)!;
    expect(m.question).toEqual([
      "Bash command",
      'Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
      "Write probe text to a temp file",
      "echo agent-flow-probe > /tmp/af-perm-probe.txt",
      "Do you want to proceed?",
    ]);
    expect(m.options.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, and always allow access to /tmp from this project",
      "Yes, and switch to auto mode · auto mode handles these prompts for you",
      "No",
    ]);
    expect(m.hint).toBe("Esc to cancel · Tab to amend");
    expect(m.code).toEqual(["echo agent-flow-probe > /tmp/af-perm-probe.txt"]);
  });

  test("claude question with previews: the preview box on the right is not part of the options", () => {
    const screen = [
      "─".repeat(60),
      " ☐ Layout",
      "",
      "Which layout?",
      "",
      "❯ 1. Sidebar                     ┌────────────────────────┐",
      "  2. Top bar                     │ +------+--------+      │",
      "                                 │ | nav  | main   |      │",
      "                                 │ |      |        |      │",
      "                                 │ +------+--------+      │",
      "                                 └────────────────────────┘",
      "",
      "                                 Notes: press n to add notes",
      "",
      "─".repeat(60),
      "  Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · n to add notes · Esc to",
      "cancel",
    ].join("\n");
    const m = parseMenu(screen)!;
    expect(m.question).toEqual(["☐ Layout", "Which layout?"]);
    expect(m.options.map((o) => [o.label, o.description ?? ""])).toEqual([
      ["Sidebar", ""],
      ["Top bar", ""],
      ["Chat about this", ""],
    ]);
  });

  test("a narrow pane: the preview box is 4 columns wide and cut short (captured)", () => {
    const box = ["                    │  │", "                    │  │", "                    ├─── ✂ ─── 56", "                    lines hidden ┤", "                    └──┘"];
    const screen = [
      "─".repeat(34),
      " ☐ Layout",
      "",
      "Which layout?",
      "",
      "❯ 1. Sidebar        ┌──┐",
      "  2. Top bar        │  │",
      ...box,
      "",
      "                    Notes: press n",
      "                           to add",
      "                           notes",
      "",
      "─".repeat(34),
      "  Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate",
      "· n to add notes · Esc to cancel",
    ].join("\n");
    expect(parseMenu(screen)!.options.map((o) => [o.label, o.description ?? ""])).toEqual([
      ["Sidebar", ""],
      ["Top bar", ""],
      ["Chat about this", ""],
    ]);
  });

  test("previews and descriptions come from claude's own record of the question, until it is answered", () => {
    const menu = parseMenu(["Which layout?", "", "❯ 1. Sidebar", "  2. Top bar", "", "Enter to select · ↑/↓ to navigate · Esc to cancel"].join("\n"))!;
    const ask = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "AskUserQuestion", input: { questions: [{ question: "Which layout?", options: [{ label: "Sidebar", description: "Nav on the left", preview: "| nav | main |" }, { label: "Top bar", preview: "| nav |\n| main |" }] }] } }] },
    });
    const m = enrichFromTranscript(menu, ask);
    expect(m.options.map((o) => [o.label, o.description ?? "", o.preview ?? ""])).toEqual([
      ["Sidebar", "Nav on the left", "| nav | main |"],
      ["Top bar", "", "| nav |\n| main |"],
    ]);
    const answered = ask + "\n" + JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
    expect(enrichFromTranscript(menu, answered).options[0]!.preview).toBeUndefined();
  });

  test("not a menu: the agent's own input line, a lone pointer, plain output", () => {
    expect(parseMenu(["─".repeat(80), "❯ please fix the tests", "─".repeat(80), "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n"))).toBeUndefined();
    expect(parseMenu("❯ 1. only one option\n\nEnter to select")).toBeUndefined();
    expect(parseMenu("all tests passed\n$ ")).toBeUndefined();
  });
});

describe("panels and notices instead of the input box", () => {
  const rule = "─".repeat(34);
  test("claude idle, working, or showing a panel (captured /status)", () => {
    const idle = ["⏺ You picked Sidebar.", "", "✻ Churned for 7s · done 19:08", "", rule, "❯", rule, "  ⏵⏵ auto mode on (shift+tab to", "                  Auto-updating…"].join("\n");
    expect(screenOverlay(idle, "claude")).toBeUndefined();
    const working = ["⏺ Bash(sleep 8)", "  ⎿  Running…", "", "✢ Churning… (12s)", "", rule, "❯ 第二条消息", rule, "  ⏵⏵ auto mode on"].join("\n");
    expect(screenOverlay(working, "claude")).toBeUndefined();
    const status = [rule, "  Anthropic base URL:", "  https://ai.soruxgpt.com", "", "  Model:", "  opus (claude-opus-5-5)", "  Auto mode server:", "  Disabled", "", "  Esc to cancel"].join("\n");
    expect(screenOverlay(status, "claude")).toEqual({
      lines: ["Anthropic base URL:", "https://ai.soruxgpt.com", "", "Model:", "opus (claude-opus-5-5)", "Auto mode server:", "Disabled", ""],
      hint: "Esc to cancel",
      enter: false,
      esc: true,
    });
  });

  test("a notice that waits for Enter (like claude's auto-mode billing notice)", () => {
    const notice = [
      "⏺ Bash(ls)",
      rule,
      " We're changing auto mode to no longer charge for classifier requests in Claude Code.",
      "",
      " However, this session isn't eligible because your requests go through ai.soruxgpt.com, which isn't compatible with this update.",
      " Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.",
      "",
      " Enter to continue · Esc to interrupt",
    ].join("\n");
    const o = screenOverlay(notice, "claude")!;
    expect(o.lines[0]).toBe("We're changing auto mode to no longer charge for classifier requests in Claude Code.");
    expect(o.hint).toBe("Enter to continue · Esc to interrupt");
    expect([o.enter, o.esc]).toEqual([true, true]);
  });

  test("codex and omp input boxes; unknown agents and half-drawn screens are left alone", () => {
    expect(screenOverlay(["• done", "", "› Ask Codex to do anything", "", "  GPT-6-Astra xhigh · ~/proj", "  ? for shortcuts"].join("\n"), "codex")).toBeUndefined();
    expect(screenOverlay(["  Sign in with ChatGPT", "", "  1) open the link", "  Press Enter to continue"].join("\n"), "codex")!.enter).toBe(true);
    expect(screenOverlay(["Submitted pass.", "╭─ π > demo", "╰─ "].join("\n"), "omp")).toBeUndefined();
    expect(screenOverlay("anything\nat all\nhere", "gemini")).toBeUndefined();
    expect(screenOverlay("\n\n", "claude")).toBeUndefined();
  });
});
