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
//
// A dialog takes the place of the agent's input box. While the input box is on screen, menu-like text above it is
// part of the conversation (a reply that quotes a prompt, a user message with a numbered list), not a menu.
//
// omp (oh-my-pi) draws its dialogs as a rounded box in place of its input box. Its ask tool:
//
//  ╭─ Ask ──────────────────────────────────────────╮
//  │  Format    Length    Submit                      │  <- steps, only with several questions or a multi-select
//  │ Which output format do you prefer?               │  <- question
//  ├──────────────────────────────────────────────────┤
//  │ ❯ ○ Markdown                                     │  <- ❯ highlighted row; ○/◉ pick one, ☐/☑ pick many
//  │       Plain text with headings                   │  <- description
//  │   ○ Other (type your own)                        │  <- always last: Enter opens a text box
//  ├──────────────────────────────────────────────────┤
//  │ Enter select · n note · ↑/↓ move · Esc cancel    │  <- key hint
//  ╰──────────────────────────────────────────────────╯
//
// Its selectors (confirmations, extension and command menus) put the title in the top edge, then message lines,
// the options (" ❯ Yes" / "   No", descriptions deeper) and a key hint, with no ├──┤ rules. Its idle input box
// (default "band" shape) is a status line over "╰─ " and the text typed; the "box" shape ends in "╰─ text ─╯".
// A dialog's bottom edge is a bare rule (╰────╯), so it is not taken for the input box.
//
// gemini (Gemini CLI 0.66) draws its input box as a band of background colour between half-block rows; below it
// are only the footer and the "/" list. The user's messages in the conversation are drawn the same way, so only a
// band with nothing but footer lines under it is the box. (Without background colours a ─── rule is above it.)
//
//  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
//   > typed text                          <- ">" ("!" shell mode, "*" YOLO mode, "(r:)" history search)
//  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
//   workspace (/directory)   /model       <- footer
//
// Its dialogs (tool approvals, the ask_user tool, folder trust, /model, the rewind steps) replace the box with a
// rounded box at the bottom; lists mark the highlighted row with ● (numbered or not):
//
//  ╭──────────────────────────────────╮
//  │ ? Shell  sleep 25; echo done     │  <- a tool approval: "?", the tool, what it does
//  │ ╭──────────────────────────────╮ │
//  │ │ sleep 25; echo done          │ │  <- the command (or the file's diff)
//  │ ╰──────────────────────────────╯ │
//  │ Allow execution of [Shell]?      │  <- question
//  │                                  │
//  │ ● 1. Allow once                  │
//  │   2. Allow for this session      │
//  │   3. No, suggest changes (esc)   │
//  ╰──────────────────────────────────╯
//
// The ask_user dialog is titled "Answer Questions", with steps ("← □ Format │ ✓ Length │ ≡ Review →") when it asks
// several; its last numbered option is a text field ("Enter a custom value" until something is typed: the answer
// is typed while it is highlighted, then Enter), a multi-select ticks with Enter ("[x]") and ends with "Done".

export interface MenuOption {
  index: number;
  number?: number;
  label: string;
  description?: string;
  /** Text the agent shows next to the option (claude question previews: mockups, code). */
  preview?: string;
  selected: boolean;
  /** Options that turn into a text field (claude "Type something.", codex "No, and tell Codex …"). */
  freeText: boolean;
  /** Marked as the current choice (claude's /model: "Opus ✔"). */
  current?: boolean;
  /** Multi-select options: whether the box is ticked (omp also ticks a single-select answer chosen earlier, ◉). Undefined for plain options. */
  checked?: boolean;
  /** Not an answer but a button: claude's multi-select "Next"/"Submit", and "Submit answers"/"Cancel" on its review page. */
  action?: "primary" | "secondary";
}

/** One step of claude's multi-question dialog ("←  ☒ Parts  ☐ Length  ✔ Submit  →"). */
export interface MenuTab {
  label: string;
  done: boolean;
  /** The last step, where the answers are reviewed and sent. */
  submit?: boolean;
  /** The step on screen (known from the transcript, or the review page). */
  current?: boolean;
}

export interface Menu {
  question: string[];
  /** Question lines that are a command or file the agent asks about (claude frames them with ╌ rules). */
  code?: string[];
  options: MenuOption[];
  hint?: string;
  multiSelect: boolean;
  tabs?: MenuTab[];
  /** claude's last step: the answers so far, and Submit answers / Cancel. */
  review?: boolean;
  /**
   * Keys that differ from claude's and codex's (Enter picks or ticks the highlighted option). omp's ask dialog
   * ticks a multi-select option with Space (Enter sends the answers), and its "Other (type your own)" opens a text
   * box on Enter: the answer is typed after that Enter and sent with another one.
   */
  keys?: { tick?: "space"; textAfterEnter?: boolean };
  /**
   * A setting under the options, changed with ←/→ (claude's /model: "◉ xHigh effort ←/→ to adjust"). `levels` are
   * its values in order, when known, with the current one.
   */
  setting?: { label: string; value: string; levels?: string[]; note?: string };
  /** More keys the dialog offers besides Enter (claude's /model: "s to use this session only"). */
  extraKeys?: { key: string; label: string }[];
}

/** A setting row changed with ←/→: "◉ xHigh effort ←/→ to adjust" (claude's effort: ○ ◐ ● ◉ ◈). */
const SETTING_ROW = /^([○◐●◉◈◯◎])\s+(.+?)\s+effort\s+←\/→/i;
/** claude's effort levels, low to high. */
const EFFORT_LEVELS = ["Low", "Medium", "High", "xHigh", "Max"];

/** The multi-select button under the options: claude's Next/Submit, gemini's Done. */
const ACTION = /^(Next|Submit|Done)$/;
const NUMBERED = /^\s*\d{1,2}[.)]\s/;

const POINTER = /^(\s*)([❯›▶➤])\s+(\S.*)$/;
/** gemini marks the highlighted row of a list with ● (claude and omp use ● as a bullet in the conversation). */
const GEMINI_POINTER = /^(\s*)(●)\s+(\S.*)$/;
/** A dialog's outer edge (solid rule or box corner). */
const SEPARATOR = /^\s*[╭╰┌└├]?[─━═-]{8,}[╮╯┐┘┤]?\s*$/;
/** A rule inside a dialog (claude draws ╌╌╌ around the command it asks about): skipped, not an edge. */
const INNER_RULE = /^\s*[╌┄┈]{8,}\s*$/;
const HINT = /\b(enter|esc|escape|navigate|confirm|select|cancel)\b|↑|↓/i;
const indentOf = (l: string) => l.length - l.replace(/^\s+/, "").length;
const blank = (l: string) => !l.trim();
const rule = (l?: string) => !!l && SEPARATOR.test(l);
const AGENTS = new Set(["claude", "codex", "omp", "gemini"]);

/** The screen's lines, without trailing spaces and without the blank rows below the last text. */
function screenLines(screen: string) {
  const lines = screen.replace(/\r/g, "").split("\n").map((l) => l.replace(/\u00a0/g, " ").replace(/\s+$/, ""));
  while (lines.length && !lines.at(-1)!.trim()) lines.pop();
  return lines;
}

/**
 * Whether the agent's own input box is at the bottom of the screen. A dialog (a question, an approval, a notice)
 * takes its place: claude and codex draw it in the input box's area, omp swaps its editor for a selector.
 *   claude:  ──── / ❯ … / ──── / status lines        codex:  › … / model line / "? for shortcuts"
 *   omp:     status line / ╰─ …   or   ╭─ status ─╮ / ╰─ … ─╯   (a dialog ends in a bare ╰────╯ instead);
 *            its other input shapes: a ❯ prompt, a filled field ▐ … ▌ or rail ▎ …, " text" between two bare rules
 *   gemini:  ▄▄▄▄ / " > …" / ▀▀▀▀ / footer   (see the header comment)
 */
function inputBoxShown(lines: string[], agent: string | undefined) {
  if (!agent || !AGENTS.has(agent)) return false;
  if (agent === "gemini") return geminiInputRows(lines) !== undefined;
  const tail = lines.slice(-14);
  if (agent === "claude") return tail.some((l, i) => /^\s*❯(\s|$)/.test(l) && (rule(tail[i - 1]) || rule(tail[i - 2])) && tail.slice(i + 1, i + 4).some((x) => rule(x)));
  if (agent === "codex") return tail.slice(-8).some((l) => /^\s*›(\s|$)/.test(l) && !/^\s*›\s+\d+[.)]/.test(l));
  // (omp's dialog rows all start with a box edge, so a bare ❯ is the prompt.) The "box" shape with omp's IME-safe
  // cursor also ends in a bare ╰────╯, under a text row without its right edge.
  const last = tail.slice(-6);
  if (last.filter((l) => /^─{8,}$/.test(l)).length >= 2) return true;
  return last.some((l, i) => /^\s*[❯▐▎]/.test(l) || (/^\s*╰─/.test(l) && (!OMP_BOTTOM.test(l) || (/^\s*│/.test(last[i - 1] ?? "") && !OMP_ROW.test(last[i - 1]!)))));
}

// ---- gemini (see the header comment) ----

/** The prompt row of gemini's input box: ">", "!" (shell mode), "*" (YOLO mode), "(r:)" (history search). */
const GEMINI_PROMPT = /^ ?(?:[>!*]|\(r:\)) /;
const HALF_TOP = /^▄{8,}$/;
const HALF_BOTTOM = /^▀{8,}$/;
/** A row of a box (a dialog, a tool's output): nothing like it is below gemini's input box. */
const BOX_ROW = /^\s*[╭╰│]/;

/**
 * The rows of gemini's input box (the prompt row first, then the typed text's other lines) when the box is at the
 * bottom of the screen; undefined when something else is (a dialog). `lines` without trailing spaces.
 */
export function geminiInputRows(lines: string[]): string[] | undefined {
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 24); i--) {
    const l = lines[i]!;
    if (BOX_ROW.test(l)) return undefined;
    if (HALF_BOTTOM.test(l.trim())) {
      let j = i - 1;
      while (j > 0 && i - j < 16 && !HALF_TOP.test(lines[j - 1]!.trim())) j--;
      return j > 0 && j < i && HALF_TOP.test(lines[j - 1]!.trim()) && GEMINI_PROMPT.test(lines[j]!) ? lines.slice(j, i) : undefined;
    }
    // without background colours: a rule above the prompt row, no band under it
    if (GEMINI_PROMPT.test(l) && i > 0 && rule(lines[i - 1])) return [l];
  }
  return undefined;
}

/** The rows of the rounded box at the bottom of gemini's screen, without its outer edges (inner boxes kept). */
function geminiDialog(lines: string[]): string[] | undefined {
  for (let b = lines.length - 1; b >= Math.max(0, lines.length - 6); b--) {
    const m = /^(\s*)╰─+╯$/.exec(lines[b]!);
    if (!m) continue;
    const left = m[1]!.length;
    const rows: string[] = [];
    for (let j = b - 1; j >= 0 && j >= b - 150; j--) {
      const l = lines[j]!;
      if (indentOf(l) !== left) return undefined;
      if (/^\s*╭─+╮$/.test(l)) return rows.reverse();
      if (l[left] !== "│") return undefined;
      rows.push(l.slice(left + 1).replace(/│$/, "").replace(/^ /, "").trimEnd());
    }
    return undefined;
  }
  return undefined;
}

/** An inner box's edge (╭──╮ ╰──╯, ┌──┐ └──┘) or a row in it ("│ text │"). */
const INNER_EDGE = /^[╭╰┌└]─+[╮╯┐┘]$/;
const INNER_ROW = /^│ ?(.*?) ?│$/;

/**
 * The menu in a gemini dialog box: options as in other agents' lists (● for the highlight); the question is the box's
 * text above them, from the tool waiting for approval ("? Shell …") if there is one. A tool's command or diff (the
 * inner box) is also `code`.
 */
function geminiMenu(all: string[]): Menu | undefined {
  // the rewind list is not a menu (its rows are messages; rewind.ts reads it)
  if (all.some((r) => /^> Rewind$/.test(r.trim()))) return undefined;
  // a list longer than the dialog shows ▲ above and ▼ below it (the rest is reached with the arrow keys)
  const rows = all.filter((r) => !/^[▲▼]$/.test(r.trim()));
  const scrolled = rows.length < all.length;
  const menu = menuIn(rows, GEMINI_POINTER);
  if (!menu) return undefined;
  // where the list starts: the rows above the first option are the question
  const first = menu.options[0]!;
  const p = rows.findIndex((r) => {
    const m = GEMINI_POINTER.exec(r);
    const text = (m ? m[3]! : r).trim();
    return text === first.label || text.replace(/^\d{1,2}[.)]\s+/, "").replace(/^\[[ x]\]\s*/, "") === first.label;
  });
  if (p < 0) return menu;
  const end = p - 1;
  const tool = rows.slice(0, end + 1).findLastIndex((r) => /^\? \S/.test(r));
  const question: string[] = [];
  const code: string[] = [];
  let tabs: MenuTab[] | undefined;
  let ask = false;
  for (const r of rows.slice(Math.max(0, tool), end + 1)) {
    const x = r.trim();
    if (!x || INNER_EDGE.test(x)) continue;
    const inner = INNER_ROW.exec(x);
    if (inner) {
      if (!inner[1]!.trim()) continue;
      question.push(inner[1]!.trim());
      if (tool >= 0) code.push(inner[1]!.trim());
    } else if (x === "Answer Questions") ask = true;
    else if (/^← .* →$/.test(x))
      tabs = x
        .slice(2, -2)
        .split(" │ ")
        .map((s) => s.match(/^([□✓≡]) (.+)$/))
        .filter((s): s is RegExpMatchArray => !!s)
        .map((s) => (s[1] === "≡" ? { label: s[2]!, done: false, submit: true } : { label: s[2]!, done: s[1] === "✓" }));
    else question.push(tool >= 0 && question.length === 0 ? x.replace(/^\? /, "").replace(/\s{2,}/g, " ") : x);
  }
  // the shell tool's header repeats its command ("Shell sleep 25"): keep the tool's name
  if (tool >= 0 && code[0] && question[0]?.endsWith(` ${code[0]}`)) question[0] = question[0].slice(0, -code[0].length - 1);
  // ask_user: the last numbered option is its text field (in a scrolled list, if it is in sight: its placeholder, or
  // highlighted, when the hint says "Enter to submit"); " ✓" marks the answer chosen earlier (single-select)
  const last = ask ? menu.options.findLast((o) => o.number !== undefined && !o.action) : undefined;
  const field = last && (!scrolled || last.label === "Enter a custom value" || (last.selected && /^Enter to submit\b/.test(menu.hint ?? ""))) ? last : undefined;
  const options = menu.options.map((o) => {
    const earlier = !menu.multiSelect && / ✓$/.test(o.label);
    return { ...o, label: earlier ? o.label.slice(0, -2) : o.label, freeText: o === field ? true : ask ? false : o.freeText, ...(earlier ? { checked: true } : {}) };
  });
  return { ...menu, question, code: code.length ? code : undefined, options, ...(tabs?.length ? { tabs } : {}) };
}

// ---- omp dialogs (see the header comment) ----

const OMP_BOTTOM = /^(\s*)╰─+╯$/;
const OMP_ROW = /^\s*│.*│$/;
/** omp's highlight (theme nav.cursor): unicode ❯, Nerd Font chevron. omp's ASCII symbol preset is not read. */
const OMP_CURSOR = /^(\s*)(?:❯|\uf054) (.*)$/;
/** Option markers (theme radio.* and checkbox.*), unicode and Nerd Font. */
const OMP_MARK = /^([◉○☑☐\uf192\uf10c\uf14a\uf096]) (.*)$/;
const OMP_MARK_ON = /[◉☑\uf192\uf14a]/;
const OMP_MARK_BOX = /[☑☐\uf14a\uf096]/;
const OMP_OTHER = "Other (type your own)";
const OMP_ASK_TITLE = /^Ask( \(\d+s\))?$/;

interface OmpBox {
  /** The text in the top edge ("Ask", a selector's title). */
  title: string;
  /** The rows inside, without the │ edges, split at ├──┤ rules. */
  parts: string[][];
}

/** omp's dialog box at the bottom of the screen (a few status lines may follow it). Call when its input box is not shown. */
function ompDialog(lines: string[]): OmpBox | undefined {
  for (let b = lines.length - 1; b >= 0 && b >= lines.length - 8; b--) {
    const m = OMP_BOTTOM.exec(lines[b]!);
    if (!m) continue;
    const left = m[1]!.length;
    const parts: string[][] = [[]];
    for (let j = b - 1; j >= 0 && j >= b - 80; j--) {
      const l = lines[j]!;
      if (indentOf(l) !== left) return undefined;
      if (/^\s*╭─.*╮$/.test(l)) {
        const title = l.trim().replace(/^╭─/, "").replace(/─*╮$/, "").trim();
        parts.forEach((p) => p.reverse());
        parts.reverse();
        // a scrolling list draws its scrollbar (│ track, █ thumb) in the last column of every row
        const body = parts.length === 3 ? parts[1]! : [];
        if (body.length && body.every((r) => /[│█]$/.test(r))) parts[1] = body.map((r) => r.slice(0, -1).trimEnd());
        return { title, parts };
      }
      if (/^\s*├─+┤$/.test(l)) parts.push([]);
      else if (OMP_ROW.test(l)) parts.at(-1)!.push(l.slice(left + 1, -1).replace(/^ /, "").trimEnd());
      else return undefined;
    }
    return undefined;
  }
  return undefined;
}

/**
 * The menu in an omp dialog box. Rows are read relative to the highlight's column c: options start at c (the ❯,
 * or a selector's marker in its place) or at c+2; description, preview (│ …) and wrapped label rows are deeper.
 */
function ompMenu(box: OmpBox): Menu | undefined {
  const rows = box.parts.flat();
  const section = box.parts.flatMap((p, k) => p.map(() => k));
  let p = rows.findLastIndex((r) => OMP_CURSOR.test(r));
  // a selector with radio markers fills the highlighted row's ◉ instead of drawing ❯
  const radioCursor = p < 0;
  if (radioCursor) {
    const filled = rows.flatMap((r, i) => (/^\s*[◉\uf192] /.test(r) ? [i] : []));
    if (filled.length !== 1 || !rows.some((r) => /^\s*[○\uf10c] /.test(r))) return undefined;
    p = filled[0]!;
  }
  const c = indentOf(rows[p]!);
  /** The option on row i (cursor and marker included), if it is one. */
  const optionAt = (i: number) => {
    const r = rows[i]!;
    const text = i === p ? (radioCursor ? r.trim() : OMP_CURSOR.exec(r)![2]!) : indentOf(r) === c + 2 || (indentOf(r) === c && OMP_MARK.test(r.trim())) ? r.trim() : undefined;
    // a selector's search line and empty result are not options
    return text === undefined || /^\(\d+\/\d+( of \d+)?\)\s|^No matching options$/.test(text) ? undefined : text;
  };
  const inList = (i: number) => section[i] === section[p] && (blank(rows[i]!) || optionAt(i) !== undefined || indentOf(rows[i]!) >= c + 4);
  let start = p;
  while (start > 0 && inList(start - 1)) start--;
  let end = p;
  while (end < rows.length - 1 && inList(end + 1)) end++;

  type Opt = MenuOption & { labelCol: number };
  const options: Opt[] = [];
  let multiSelect = false;
  for (let i = start; i <= end; i++) {
    const r = rows[i]!;
    if (blank(r)) continue;
    const text = optionAt(i);
    if (text === undefined) {
      const last = options.at(-1);
      if (!last) continue; // the list started mid-description
      const t = r.trim();
      if (/^│/.test(t)) last.preview = (last.preview ? `${last.preview}\n` : "") + t.replace(/^│ ?/, "");
      else if (indentOf(r) === last.labelCol) last.label += ` ${t}`;
      else last.description = last.description ? `${last.description}\n${t}` : t;
      continue;
    }
    const mark = OMP_MARK.exec(text);
    const label = (mark ? mark[2]! : text).replace(/\s+✎ note$/, "").trim();
    let checked: boolean | undefined;
    if (mark && OMP_MARK_BOX.test(mark[1]!)) (checked = OMP_MARK_ON.test(mark[1]!)), (multiSelect = true);
    else if (mark && OMP_MARK_ON.test(mark[1]!) && !radioCursor) checked = true; // ◉: the answer chosen earlier
    const textCol = i === p && !radioCursor ? c + 2 : indentOf(r);
    options.push({ index: options.length, label, selected: i === p, freeText: label === OMP_OTHER, ...(checked !== undefined ? { checked } : {}), labelCol: textCol + (mark ? 2 : 0) });
  }
  if (options.length < 2) return undefined;

  const hint = rows.slice(end + 1).findLast((r) => !blank(r) && HINT.test(r))?.trim();
  const question = [...(box.title && !OMP_ASK_TITLE.test(box.title) ? [box.title] : []), ...rows.slice(0, start).filter((r) => !blank(r)).map((r) => r.trim())];
  // the ask dialog's steps ("Format    Length    Submit") head the question when its hint offers Tab/←/→
  let tabs: MenuTab[] | undefined;
  const k = hint && /\bTab\//.test(hint) ? question.findIndex((l) => /(^|\s{3})Submit$/.test(l)) : -1;
  if (k >= 0 && k < 3)
    tabs = question
      .splice(0, k + 1)
      .join("    ")
      .split(/\s{3,}/)
      .map((label, i, all) => (i === all.length - 1 ? { label, done: false, submit: true } : { label, done: false }));
  const result: MenuOption[] = options.map(({ labelCol: _, ...o }) => o);
  // a multi-select ticks with Space; Enter sends the ticked answers (on to the next question, or submits)
  const tick = !!hint && /\bSpace toggle\b/i.test(hint);
  if (tick) result.push({ index: result.length, label: /\bEnter next\b/i.test(hint!) ? "Next" : "Submit", selected: false, freeText: false, action: "primary" });
  return { question, options: result, hint, multiSelect, ...(tabs?.length ? { tabs } : {}), keys: { ...(tick ? { tick: "space" as const } : {}), textAfterEnter: true } };
}

/**
 * claude draws a preview box to the right of a question's options (┌──┐ … └──┘ at a fixed column). Return that
 * column, so the right side can be cut off and the left side read as a normal menu.
 */
function sideBoxColumn(lines: string[]) {
  const cols = new Map<number, number>();
  let hasTop = false;
  for (const l of lines) {
    // the box's left edge: the first box character that follows two spaces (or only spaces)
    const m = /(?:^\s*|\s{2})([┌╭│└╰├])/.exec(l);
    if (!m) continue;
    const col = m.index + m[0].length - 1;
    if (col < 12) continue;
    cols.set(col, (cols.get(col) ?? 0) + 1);
    if (/[┌╭]/.test(m[1]!)) hasTop = true;
  }
  const best = [...cols].sort((a, b) => b[1] - a[1])[0];
  return hasTop && best && best[1] >= 3 ? best[0] : undefined;
}

/**
 * `agent` is the pane's agent (claude, codex, omp): while its input box is on screen there is no menu. Without it
 * (a shell, an agent not detected yet) the whole screen is searched.
 */
export function parseMenu(screen: string, agent?: string): Menu | undefined {
  const shown = screenLines(screen);
  if (inputBoxShown(shown, agent)) return undefined;
  if (agent === "omp") {
    const box = ompDialog(shown);
    if (box) return ompMenu(box); // a box that is not a menu (a text prompt, the answers to review) is an overlay
  }
  if (agent === "gemini") {
    const rows = geminiDialog(shown);
    if (rows) return geminiMenu(rows); // a box that is not a menu (the rewind list, a text question, a panel) is an overlay
  }
  let raw =screen.replace(/\r/g, "").split("\n").map((l) => l.replace(/\u00a0/g, " "));
  const side = sideBoxColumn(raw);
  if (side !== undefined) raw = raw.map((l) => (l.length > side && /\s/.test(l[side - 1] ?? " ") ? l.slice(0, side) : l));
  // box sides (│ … │) become spaces so indentation is kept
  const lines = raw.map((l) => l.replace(/^(\s*)[│┃]/, "$1 ").replace(/[│┃]\s*$/, "").replace(/\s+$/, ""));
  return menuIn(lines, agent === "gemini" ? GEMINI_POINTER : POINTER);
}

/** The menu around the highlight nearest the bottom of `lines`. */
function menuIn(lines: string[], pointer: RegExp): Menu | undefined {
  for (let p = lines.length - 1; p >= 0 && p >= lines.length - 60; p--) {
    const m = lines[p]!.match(pointer);
    if (!m) continue;
    let t = lines[p]!.length - m[3]!.length; // column where the option text starts
    let action = false;
    if (ACTION.test(m[3]!.trim())) {
      // claude's "Next"/"Submit" is highlighted: it is drawn deeper than the options, right below the last one
      let k = p - 1;
      while (k >= 0 && (blank(lines[k]!) || (!NUMBERED.test(lines[k]!) && indentOf(lines[k]!) > 0))) k--;
      if (k >= 0 && NUMBERED.test(lines[k]!) && indentOf(lines[k]!) < t) (t = indentOf(lines[k]!)), (action = true);
    }
    const menu = readAround(lines, p, t, m[3]!, action);
    if (menu) return menu;
  }
  return undefined;
}

function readAround(lines: string[], p: number, t: number, pointerText: string, pointerIsAction = false): Menu | undefined {
  type Row = { kind: "opt" | "desc" | "action"; text: string; selected: boolean };
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
  let setting: Menu["setting"];
  const tail: string[] = [];
  let j = p + 1;
  for (; j < lines.length; j++) {
    const l = lines[j]!;
    if (blank(l) || SEPARATOR.test(l)) continue;
    const ind = indentOf(l);
    if (ind < t) break;
    below.push({ kind: ind === t ? "opt" : "desc", text: l.trim(), selected: false });
  }
  // after the options: a setting row (←/→), a note about it, the key hint
  for (; j < lines.length && j < p + 40; j++) {
    const l = lines[j]!;
    if (blank(l) || SEPARATOR.test(l)) continue;
    const st = l.trim().match(SETTING_ROW);
    if (st) setting = { label: "effort", value: st[2]!.trim(), levels: EFFORT_LEVELS.some((e) => e.toLowerCase() === st[2]!.trim().toLowerCase()) ? EFFORT_LEVELS : undefined };
    else if (HINT.test(l)) {
      hint = l.trim();
      break;
    } else if (setting) setting.note = [setting.note, l.trim()].filter(Boolean).join(" ");
    else tail.push(l.trim());
    if (!setting && !HINT.test(l) && tail.length > 3) break;
  }
  // descriptions above the first option belong to nothing: the region started mid-description
  while (above[0]?.kind === "desc") above.shift();
  const rows: Row[] = [...above, { kind: pointerIsAction ? "action" : "opt", text: pointerText.trim(), selected: true }, ...below];

  const options: MenuOption[] = [];
  for (const r of rows) {
    const last = options.at(-1);
    // "Next"/"Submit" right under a multi-select list is a button (and its own stop for the arrow keys)
    const isAction = r.kind === "action" || (r.kind === "desc" && ACTION.test(r.text) && last?.checked !== undefined && !options.some((o) => o.action));
    if (isAction) {
      options.push({ index: options.length, label: r.text, selected: r.selected, freeText: false, action: "primary" });
      continue;
    }
    if (r.kind === "desc") {
      if (last) last.description = last.description ? `${last.description}\n${r.text}` : r.text;
      continue;
    }
    const num = r.text.match(/^(\d{1,2})[.)]\s+(.*)$/);
    let label = (num ? num[2]! : r.text).trim();
    let checked: boolean | undefined;
    const box = label.match(/^\[([ x✓✔])\]\s*(.*)$/) ?? label.match(/^([☐☑☒◻◼])\s+(.*)$/);
    if (box) (checked = !/[ ☐◻]/.test(box[1]!)), (label = box[2]!.trim());
    options.push({
      index: options.length,
      number: num ? Number(num[1]) : undefined,
      label,
      selected: r.selected,
      freeText: /^(type something|other|something else)\b|tell (claude|codex|me|it) what to do/i.test(label),
      ...(checked !== undefined ? { checked } : {}),
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
  const multiSelect = options.some((o) => o.checked !== undefined);
  // claude's steps ("←  ☒ Parts  ☐ Length  ✔ Submit  →"): shown as steps, not as question text
  let tabs: MenuTab[] | undefined;
  const tabLine = question.findIndex((l) => /^(←\s*)?[☐☑☒✔✓]\s*\S/.test(l) && (/→\s*$/.test(l) || /^←/.test(l) || question.indexOf(l) === 0));
  if (tabLine >= 0) {
    tabs = question[tabLine]!.replace(/^←\s*|\s*→\s*$/g, "")
      .split(/\s{2,}/)
      .map((x) => x.match(/^([☐☑☒✔✓])\s*(.+)$/))
      .filter((x): x is RegExpMatchArray => !!x)
      .map((x) => (x[2] === "Submit" && /[✔✓]/.test(x[1]!) ? { label: "Submit", done: false, submit: true } : { label: x[2]!.trim(), done: /[☑☒✔✓]/.test(x[1]!) }));
    question.splice(tabLine, 1);
  }
  const review = question.some((l) => /^Review your answers$/i.test(l)) && options.some((o) => /^submit answers$/i.test(o.label));
  if (review) {
    for (const o of options) o.action = /^submit answers$/i.test(o.label) ? "primary" : /^cancel$/i.test(o.label) ? "secondary" : o.action;
    tabs?.forEach((x) => (x.current = !!x.submit));
  }
  // rows drawn as two columns ("Opus ✔                 Opus 5.5 · Best for…"): the description column starts at
  // the same place in every row; the longest name may leave only two spaces before it
  const cols = options.map((o) => {
    const m = o.label.match(/^(.+?)\s{2,}(\S.*)$/);
    return m ? m[1]!.length + (o.label.length - m[1]!.length - m[2]!.length) : -1;
  });
  const col = cols.filter((c) => c > 0).sort((a, b) => a - b).at(-1);
  const twoColumns = col !== undefined && options.length > 1 && cols.every((c) => c === col || c < 0) && cols.filter((c) => c === col).length >= Math.max(2, options.length - 1);
  for (const o of options) {
    if (twoColumns && !o.description && o.label.length > col! && /\s{2}$/.test(o.label.slice(0, col))) {
      o.description = o.label.slice(col).trim();
      o.label = o.label.slice(0, col).trim();
    }
    // "✔" after the name: the current choice
    if (/\s✔$/.test(o.label)) (o.label = o.label.replace(/\s✔$/, "")), (o.current = true);
  }
  // keys the hint names besides Enter / Esc / arrows ("s to use this session only")
  const extraKeys = [...(hint ?? "").matchAll(/(?:^|·)\s*([a-z])\s+to\s+([^·]+)/gi)].map((m) => ({ key: m[1]!.toLowerCase(), label: m[2]!.trim() }));
  return {
    question,
    code: code.length ? code : undefined,
    options,
    hint,
    multiSelect,
    ...(tabs?.length ? { tabs } : {}),
    ...(review ? { review } : {}),
    ...(setting ? { setting } : {}),
    ...(extraKeys.length ? { extraKeys } : {}),
  };
}

/** Keys that move the highlight from the selected option to `target` and press Enter. */
export function keysToChoose(menu: Menu, target: number): string[] {
  const from = menu.options.find((o) => o.selected)?.index ?? 0;
  if (target < 0 || target >= menu.options.length) throw new Error(`no option ${target + 1}`);
  const opt = menu.options[target]!;
  // omp's multi-select Submit/Next is not a row: Enter on any option row sends the ticks ("Other" would open its text box)
  if (opt.action && menu.keys?.tick) return [...(menu.options[from]?.freeText ? ["up"] : []), "enter"];
  const moves = target - from;
  const arrows: string[] = Array(Math.abs(moves)).fill(moves > 0 ? "down" : "up");
  if (opt.freeText && menu.keys?.textAfterEnter) return [...arrows, "enter", "enter"]; // the answer is typed before the last Enter
  if (opt.checked !== undefined && menu.keys?.tick) return [...arrows, menu.keys.tick];
  return [...arrows, "enter"];
}

/**
 * claude records each question it asks (AskUserQuestion: questions, options, descriptions, previews) in its
 * transcript before showing it. Fill in what the screen cannot show (previews of options that are not
 * highlighted, full descriptions) from the latest such call that has no answer yet.
 */
export function enrichFromTranscript(menu: Menu, transcriptTail: string): Menu {
  let pending: any;
  const answered = new Set<string>();
  for (const line of transcriptTail.split("\n")) {
    if (!line.includes("AskUserQuestion") && !line.includes("tool_result")) continue;
    try {
      const e = JSON.parse(line);
      for (const p of Array.isArray(e?.message?.content) ? e.message.content : []) {
        if (p?.type === "tool_use" && p.name === "AskUserQuestion") pending = p;
        if (p?.type === "tool_result") answered.add(p.tool_use_id);
      }
    } catch {}
  }
  if (!pending || answered.has(pending.id) || menu.review) return menu;
  const questions: any[] = Array.isArray(pending.input?.questions) ? pending.input.questions : [];
  const shown = menu.question.join("\n");
  const q = questions.find((x) => typeof x?.question === "string" && shown.includes(x.question.trim())) ?? (questions.length === 1 ? questions[0] : undefined);
  if (!q) return menu;
  const byLabel = new Map<string, any>((q.options ?? []).map((o: any) => [String(o.label).trim(), o]));
  const header = typeof q.header === "string" ? q.header.trim() : undefined;
  return {
    ...menu,
    tabs: menu.tabs?.map((x) => ({ ...x, current: !!header && x.label === header })),
    multiSelect: menu.multiSelect || !!q.multiSelect,
    options: menu.options.map((o) => {
      const src = byLabel.get(o.label.trim());
      if (!src) return o;
      return { ...o, description: o.description ?? (src.description ? String(src.description) : undefined), preview: src.preview ? String(src.preview) : undefined };
    }),
  };
}

/**
 * Something the agent shows instead of its input box: a notice that waits for Enter (claude's auto-mode billing
 * notice), a panel (/status, /help), a login prompt. Each agent's idle screen ends in its own input box
 * (inputBoxShown). If that box is missing from the bottom of the screen, whatever is there is something the user
 * must see.
 */
export interface Overlay {
  lines: string[];
  hint?: string;
  enter: boolean;
  esc: boolean;
}

export function screenOverlay(screen: string, agent: string | undefined): Overlay | undefined {
  if (!agent || !AGENTS.has(agent)) return undefined;
  const lines = screenLines(screen);
  if (lines.length < 3) return undefined; // not drawn yet
  if (inputBoxShown(lines, agent)) return undefined;
  const box = agent === "omp" ? ompDialog(lines) : undefined;
  const gemini = agent === "gemini" ? geminiDialog(lines) : undefined;
  let body: string[];
  if (gemini) {
    // gemini's dialog box: its rows, inner boxes without their edges
    body = gemini
      .map((r) => r.trim())
      .filter((r) => !INNER_EDGE.test(r))
      .map((r) => INNER_ROW.exec(r)?.[1]?.trim() ?? r)
      .filter((l, i, all) => l || all[i - 1]);
    while (body.length && !body.at(-1)) body.pop();
  } else if (box) {
    // omp's dialog box: its title and rows (the ask dialog's list is padded with blank rows)
    body = [...(box.title && !OMP_ASK_TITLE.test(box.title) ? [box.title] : []), ...box.parts.flat().map((l) => l.trim())].filter((l, i, all) => l || all[i - 1]);
    while (body.length && !body.at(-1)) body.pop();
  } else {
    // the panel: from the last full-width rule (if close to the bottom) to the end
    let start = Math.max(0, lines.length - 30);
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--)
      if (rule(lines[i])) {
        start = i + 1;
        break;
      }
    body = lines.slice(start).map((l) => l.trim());
  }
  while (body.length && !body[0]) body.shift();
  if (!body.join("").trim()) return undefined;
  const hintIdx = body.findLastIndex((l) => HINT.test(l) && l.length < 160);
  const hint = hintIdx >= 0 ? body[hintIdx] : undefined;
  const text = hintIdx >= 0 ? body.filter((_, i) => i !== hintIdx) : body;
  if (box || gemini) while (text.length && !text.at(-1)) text.pop();
  const k = (hint ?? "").toLowerCase();
  return { lines: text, hint, enter: !hint || /enter|continue|confirm|return/.test(k), esc: !hint || /esc/.test(k) };
}
