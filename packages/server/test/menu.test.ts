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
    expect(m.question).toEqual(["Which output format do you prefer for the report?"]);
    expect(m.tabs).toEqual([{ label: "Format", done: false }]);
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
    expect(m.question).toEqual(["Which layout?"]);
    expect(m.tabs).toEqual([{ label: "Layout", done: false }]);
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

describe("menu-like text in the conversation is not a menu while the input box is on screen", () => {
  const rule = "─".repeat(120);
  // captured: the lead claude quoted codex's folder-trust prompt in its reply; the card showed it as the lead's question
  const QUOTED = [
    "  ⎿  Allowed by auto mode",
    "",
    "⏺ codex 已经重开，又停在了同一个提示上，等你按键。",
    "",
    "  提示内容是：",
    "",
    "  Trust this folder?   /Users/zhengqiaoyi/agent-flow/.sandbox/demo",
    "  › 1. Trust and continue",
    "    2. Quit",
    "",
    "  你在 codex 的标签页（count-exports-3）里按 1 回车，它就会开始数导出函数。",
    "",
    "  codex 提交结果后，我会核对，再给你最终汇总。",
    "",
    "✻ Brewed for 14s · done 10:15",
    "",
    rule,
    "❯",
    rule,
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← 2 agents",
  ].join("\n");

  test("claude: a reply that quotes a prompt, idle or working", () => {
    expect(parseMenu(QUOTED, "claude")).toBeUndefined();
    const working = QUOTED.replace("✻ Brewed for 14s · done 10:15", "✢ Churning… (12s · esc to interrupt)").replace("\n❯\n", "\n❯ 下一条消息\n");
    expect(parseMenu(working, "claude")).toBeUndefined();
  });

  test("claude: the user's own message with a numbered list", () => {
    const screen = ["❯ 1. fix the tests", "  2. update the docs", "", "⏺ Both done.", "", rule, "❯", rule, "  ⏵⏵ auto mode on (shift+tab to cycle)"].join("\n");
    expect(parseMenu(screen, "claude")).toBeUndefined();
  });

  test("codex and omp: a quoted prompt above their input boxes", () => {
    const quote = ["• The dialog said:", "", "  › 1. Yes, proceed (y)", "    2. No, and tell Codex what to do differently (esc)", "", "  Press enter to confirm or esc to cancel", ""];
    expect(parseMenu([...quote, "› Ask Codex to do anything", "", "  GPT-6-Astra xhigh · ~/proj", "  ? for shortcuts"].join("\n"), "codex")).toBeUndefined();
    expect(parseMenu([...quote, " π > demo ▶────────", "╰─"].join("\n"), "omp")).toBeUndefined();
  });

  test("real dialogs replace the input box: still menus when the agent is known", () => {
    expect(parseMenu(ASK, "claude")!.options.length).toBe(5);
    const permission = [rule, " Bash command", " Write probe text to a temp file", " Do you want to proceed?", " ❯ 1. Yes", "   2. No", "", " Esc to cancel · Tab to amend"].join("\n");
    expect(parseMenu(permission, "claude")!.options.map((o) => o.label)).toEqual(["Yes", "No"]);
    const trust = ["zhengqiaoyi@Mac _main % codex -p agent-flow-worker", "  Trust this folder? Codex can read, edit, and run files here.", "› 1. Trust and continue", "  2. Quit", "  enter continue · esc quit"].join("\n");
    expect(parseMenu(trust, "codex")!.options.map((o) => o.label)).toEqual(["Trust and continue", "Quit"]);
    // a shell, or an agent not detected yet: the whole screen is searched, as before
    expect(parseMenu(trust, "shell")!.options.length).toBe(2);
    expect(parseMenu(trust)!.options.length).toBe(2);
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

describe("claude multi-select questions: Next/Submit is a button, not an option", () => {
  const RULE = "─".repeat(100);
  const page = (pointer: number | "action", ticked: number[], button = "Next") => {
    const opt = (i: number, label: string, desc?: string) => [`${pointer === i ? "❯" : " "} ${i}. [${ticked.includes(i) ? "✔" : " "}] ${label}`, ...(desc ? [`         ${desc}`] : [])];
    return [
      "←  ☒ Parts  ☐ Length  ✔ Submit  →",
      "",
      "Which parts should the slides cover?",
      "",
      ...opt(1, "Background", "Context and background information"),
      ...opt(2, "Causes", "Underlying causes"),
      ...opt(3, "Type something"),
      `${pointer === "action" ? "❯" : " "}    ${button}`,
      RULE,
      "  4. Chat about this",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ].join("\n");
  };

  test("options carry their tick, the button is its own arrow stop, steps are read from the tab bar", () => {
    const m = parseMenu(page(1, [1]), "claude")!;
    expect(m.multiSelect).toBe(true);
    expect(m.question).toEqual(["Which parts should the slides cover?"]);
    expect(m.tabs).toEqual([{ label: "Parts", done: true }, { label: "Length", done: false }, { label: "Submit", done: false, submit: true }]);
    expect(m.options.map((o) => [o.index, o.label, o.checked, o.action, o.freeText])).toEqual([
      [0, "Background", true, undefined, false],
      [1, "Causes", false, undefined, false],
      [2, "Type something", false, undefined, true],
      [3, "Next", undefined, "primary", false],
      [4, "Chat about this", undefined, undefined, false],
    ]);
    expect(m.options[2]!.description).toBeUndefined(); // "Next" is not the description of the option above it
    expect(keysToChoose(m, 3)).toEqual(["down", "down", "down", "enter"]);
  });

  test("with the button highlighted (drawn deeper than the options) the menu is still read", () => {
    const m = parseMenu(page("action", [1, 2], "Submit"), "claude")!;
    expect(m.options.map((o) => o.label)).toEqual(["Background", "Causes", "Type something", "Submit", "Chat about this"]);
    expect(m.options.find((o) => o.selected)).toMatchObject({ index: 3, action: "primary" });
    expect(m.options.filter((o) => o.checked).map((o) => o.label)).toEqual(["Background", "Causes"]);
    expect(keysToChoose(m, 0)).toEqual(["up", "up", "up", "enter"]);
  });

  test("the review page: answers are the question, Submit answers and Cancel are buttons", () => {
    const screen = [
      "←  ☒ Parts  ☒ Length  ✔ Submit  →",
      "",
      "Review your answers",
      "",
      " ● Which parts should the slides cover?",
      "   → Background",
      " ● How long should the talk be?",
      "   → 10 minutes",
      "",
      "Ready to submit your answers?",
      "",
      "❯ 1. Submit answers",
      "  2. Cancel",
    ].join("\n");
    const m = parseMenu(screen, "claude")!;
    expect(m.review).toBe(true);
    expect(m.multiSelect).toBe(false);
    expect(m.tabs!.map((x) => [x.label, x.current])).toEqual([["Parts", false], ["Length", false], ["Submit", true]]);
    expect(m.options.map((o) => [o.label, o.action])).toEqual([["Submit answers", "primary"], ["Cancel", "secondary"]]);
    // the transcript's pending question does not turn the review page into a multi-select
    const call = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which parts should the slides cover?", header: "Parts", multiSelect: true, options: [] }] } }] } });
    expect(enrichFromTranscript(m, call)).toBe(m);
  });

  test("the transcript tells which step is on screen", () => {
    const call = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Which parts should the slides cover?", header: "Parts", multiSelect: true, options: [{ label: "Background" }] }, { question: "How long?", header: "Length", options: [] }] } }] } });
    const m = enrichFromTranscript(parseMenu(page(1, []), "claude")!, call);
    expect(m.tabs!.map((x) => [x.label, x.current])).toEqual([["Parts", true], ["Length", false], ["Submit", false]]);
  });
});
