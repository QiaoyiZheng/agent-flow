// Option menus that agents draw in the terminal: claude's questions (AskUserQuestion), approval prompts,
// the folder-trust dialog, codex approvals. They share one shape:
//
//    Which output format do you prefer?        <- question (above the list, below the last separator)
//
//  ❯ 1. Markdown                               <- the pointer marks the highlighted option
//       Plain text with headings               <- deeper indent: description of the option above
//    2. LaTeX
//  Enter to select · ↑/↓ to navigate · Esc     <- key hint (less indented than the options)
//
// The parser finds the pointer nearest the bottom of the screen and reads the options around it.
// Choosing an option sends arrow keys and Enter, exactly what a user would press.

export interface MenuOption {
  index: number;
  number?: number;
  label: string;
  description?: string;
  selected: boolean;
  /** Options that turn into a text field (claude "Type something.", codex "No, and tell Codex …"). */
  freeText: boolean;
}

export interface Menu {
  question: string[];
  /** Question lines that are a command or file the agent asks about (claude frames them with ╌ rules). */
  code?: string[];
  options: MenuOption[];
  hint?: string;
  multiSelect: boolean;
}

const POINTER = /^(\s*)([❯›▶➤])\s+(\S.*)$/;
/** A dialog's outer edge (solid rule or box corner). */
const SEPARATOR = /^\s*[╭╰┌└├]?[─━═-]{8,}[╮╯┐┘┤]?\s*$/;
/** A rule inside a dialog (claude draws ╌╌╌ around the command it asks about): skipped, not an edge. */
const INNER_RULE = /^\s*[╌┄┈]{8,}\s*$/;
const HINT = /\b(enter|esc|escape|navigate|confirm|select|cancel)\b|↑|↓/i;
const indentOf = (l: string) => l.length - l.replace(/^\s+/, "").length;
const blank = (l: string) => !l.trim();

export function parseMenu(screen: string): Menu | undefined {
  // non-breaking spaces become spaces; box sides (│ … │) become spaces so indentation is kept
  const lines = screen
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/\u00a0/g, " ").replace(/^(\s*)[│┃]/, "$1 ").replace(/[│┃]\s*$/, "").replace(/\s+$/, ""));
  for (let p = lines.length - 1; p >= 0 && p >= lines.length - 60; p--) {
    const m = lines[p]!.match(POINTER);
    if (!m) continue;
    const t = lines[p]!.length - m[3]!.length; // column where the option text starts
    const menu = readAround(lines, p, t, m[3]!);
    if (menu) return menu;
  }
  return undefined;
}

function readAround(lines: string[], p: number, t: number, pointerText: string): Menu | undefined {
  type Row = { kind: "opt" | "desc"; text: string; selected: boolean };
  const above: Row[] = [];
  let i = p - 1;
  for (; i >= 0; i--) {
    const l = lines[i]!;
    if (blank(l)) continue;
    if (SEPARATOR.test(l) || indentOf(l) < t) break;
    above.unshift({ kind: indentOf(l) === t ? "opt" : "desc", text: l.trim(), selected: false });
  }
  const questionEnd = i;
  const below: Row[] = [];
  let hint: string | undefined;
  for (let j = p + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (blank(l) || SEPARATOR.test(l)) continue;
    const ind = indentOf(l);
    if (ind < t) {
      if (HINT.test(l)) hint = l.trim();
      break;
    }
    below.push({ kind: ind === t ? "opt" : "desc", text: l.trim(), selected: false });
  }
  // descriptions above the first option belong to nothing: the region started mid-description
  while (above[0]?.kind === "desc") above.shift();
  const rows = [...above, { kind: "opt" as const, text: pointerText.trim(), selected: true }, ...below];

  const options: MenuOption[] = [];
  for (const r of rows) {
    if (r.kind === "desc") {
      const last = options.at(-1);
      if (last) last.description = last.description ? `${last.description}\n${r.text}` : r.text;
      continue;
    }
    const num = r.text.match(/^(\d{1,2})[.)]\s+(.*)$/);
    const label = (num ? num[2]! : r.text).trim();
    options.push({
      index: options.length,
      number: num ? Number(num[1]) : undefined,
      label,
      selected: r.selected,
      freeText: /^(type something|other|something else)\b|tell (claude|codex|me|it) what to do/i.test(label),
    });
  }
  // in a numbered list, unnumbered lines before option 1 are part of the question (codex indents its question like its options)
  const extra: string[] = [];
  const firstNumbered = options.findIndex((o) => o.number !== undefined);
  if (firstNumbered > 0 && options.filter((o) => o.number !== undefined).length >= 2) {
    if (options.slice(0, firstNumbered).some((o) => o.selected)) return undefined;
    for (const o of options.splice(0, firstNumbered)) extra.push(o.label, ...(o.description ? o.description.split("\n") : []));
    options.forEach((o, k) => (o.index = k));
  }
  // ... and an unnumbered key hint after the last option is the hint (codex indents it like its options too)
  while (options.length && options.at(-1)!.number === undefined && options.some((o) => o.number !== undefined) && HINT.test(options.at(-1)!.label) && !options.at(-1)!.selected)
    hint ??= options.pop()!.label;
  if (options.length < 2) return undefined;
  const numbered = options.filter((o) => o.number !== undefined).length;
  // the agent's own input line also starts with ❯: only accept real lists
  if (!hint && numbered < 2) return undefined;
  if (numbered >= 2 && numbered < options.length - 1) return undefined;

  const question: string[] = [];
  const code: string[] = [];
  let inRule = false;
  for (let k = questionEnd; k >= 0 && question.length < 12; k--) {
    const l = lines[k]!;
    if (INNER_RULE.test(l)) {
      inRule = !inRule;
      continue;
    }
    if (inRule && !blank(l)) code.push(l.trim());
    if (SEPARATOR.test(l)) break;
    if (POINTER.test(l)) break;
    if (blank(l)) {
      if (question.length && blank(lines[k - 1] ?? "")) break;
      continue;
    }
    question.unshift(l.trim());
  }
  // codex draws its whole dialog at the options' indent: those lines are the question; what is above them is
  // the terminal (the shell prompt, earlier output), not part of the dialog
  if (extra.length) question.splice(0, question.length, ...extra);
  const multiSelect = options.some((o) => /^\[[ x✓✔]\]|^[☐☑☒◻◼]/.test(o.label));
  return { question, code: code.length ? code : undefined, options, hint, multiSelect };
}

/** Keys that move the highlight from the selected option to `target` and press Enter. */
export function keysToChoose(menu: Menu, target: number): string[] {
  const from = menu.options.find((o) => o.selected)?.index ?? 0;
  if (target < 0 || target >= menu.options.length) throw new Error(`no option ${target + 1}`);
  const moves = target - from;
  return [...Array(Math.abs(moves)).fill(moves > 0 ? "down" : "up"), "enter"];
}
