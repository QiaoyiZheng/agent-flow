// Rewind an agent to before one of its messages, from the rendered view. Each agent has its own picker; this drives
// it the way a user would and checks on screen that the right message is highlighted before confirming:
//
//            open                     step back      highlighted message                    confirm
//   claude   Esc Esc (empty box)      Up             "  ❯ <first line>" in the Rewind list  Enter, then "Restore
//                                                                                           conversation" (or "…code…")
//   codex    Esc Esc (empty box)      Left           the prompt drawn in reverse video      Enter
//   omp      /rewind                  Left           the dashed box (┆ … ┆)                 Enter
//   gemini   /rewind                  Up             "● <text>" under "> Rewind" (the       Enter, then "Rewind
//                                                    list opens on "Stay at current         conversation" (or "… and
//                                                    position")                             revert code changes")
//
// All four put the message back into their own input box; it is cleared there (the UI puts it in its own box).
// (gemini's list also shows the messages Gemini CLI sends itself: its <session_context>, "[System: …]".)
//
// What the transcript shows afterwards: codex starts a new file that continues the old one up to the rewind point
// (TranscriptTail reads both). gemini appends {"$rewindTo": "<message id>"} to its file at once (and a $patch). claude
// and omp write nothing until the next message, whose parent is the earlier point; until then the rewound turns are
// hidden with a cut: the byte range of the file from the message's line to the end at the time of the rewind.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { TranscriptAccess } from "./access.ts";
import { AfError } from "./orchestrator.ts";
import type { Workspaces } from "./workspaces.ts";

export interface Cut {
  from: number;
  to: number;
}

/** Byte ranges of transcripts whose turns were rewound away, saved so a reload keeps them hidden. */
export class Cuts {
  private data: Record<string, Cut[]> = {};
  private listeners = new Set<(pane: string) => void>();
  constructor(private file?: string) {
    try {
      if (file && existsSync(file)) this.data = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
  }
  for(path: string): Cut[] {
    return this.data[path] ?? [];
  }
  add(path: string, cut: Cut) {
    (this.data[path] ??= []).push(cut);
    if (this.file) writeFileSync(this.file, JSON.stringify(this.data));
  }
  /** Something about a pane's conversation changed: chat views of it start over. */
  changed(pane: string) {
    for (const l of this.listeners) l(pane);
  }
  onChange(fn: (pane: string) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const plain = (s: string) => s.replace(ANSI, "");

/** The message the claude Rewind list highlights ("(current)" at first), or undefined when the list is not shown. */
export function claudeHighlight(screen: string): string | undefined {
  const lines = plain(screen).split("\n");
  if (!lines.some((l) => /^\s*Rewind\s*$/.test(l)) || !lines.some((l) => /Enter to continue/.test(l))) return undefined;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^ {2,}❯ (.+)$/);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

/** The prompt codex's transcript browser highlights (reverse video), or undefined when it is not browsing. */
export function codexHighlight(ansiScreen: string): string | undefined {
  if (!plain(ansiScreen).includes("Browsing transcript")) return undefined;
  for (const l of ansiScreen.split("\n")) if (l.includes("\x1b[7m")) return plain(l).trim().replace(/^›\s*/, "");
  return "";
}

/** The step omp's rewind picker shows in its dashed box, or undefined when the picker is not shown. */
export function ompHighlight(screen: string): string | undefined {
  const lines = plain(screen).split("\n");
  if (!lines.some((l) => /\d+\/\d+\s+↑\/↓ step/.test(l))) return undefined;
  const top = lines.findIndex((l) => /^\s*╭┄/.test(l));
  if (top < 0) return "";
  for (let i = top + 1; i < lines.length && !/^\s*╰┄/.test(lines[i]!); i++) {
    const t = lines[i]!.replace(/^\s*┆\s?/, "").replace(/\s?┆\s*$/, "").trim();
    if (t) return t;
  }
  return "";
}

/**
 * The message gemini's rewind list highlights, or undefined when the list is not shown. Each item in its box is the
 * message (up to two rows, cut with "...") and a row saying what it changed ("No files have been changed",
 * "1 file changed +1"); the last item is "Stay at current position" / "Cancel rewind and stay here".
 */
export function geminiHighlight(screen: string): string | undefined {
  const lines = plain(screen).split("\n").map((l) => l.replace(/\s+$/, ""));
  const title = lines.findLastIndex((l) => /^\s*│ > Rewind\s*│$/.test(l));
  if (title < 0) return undefined;
  const rows: string[] = [];
  for (const l of lines.slice(title + 1)) {
    if (!/^\s*│/.test(l)) break;
    rows.push(l.replace(/^\s*│ ?/, "").replace(/\s*│$/, ""));
  }
  const at = rows.findIndex((r) => /^● /.test(r));
  if (at < 0) return "";
  const item = [rows[at]!.slice(2).trim()];
  for (let i = at + 1; i < rows.length && rows[i]!.trim(); i++) item.push(rows[i]!.trim());
  if (item.length > 1) item.pop();
  return item.join(" ");
}

const norm = (s: string) => s.replace(/\s+/g, " ").replace(/(…|\.\.\.)$/, "").trim();
/** The line a picker shows for a message: its first line that is not empty. */
export const firstLine = (text: string) => norm(text.split("\n").find((l) => l.trim()) ?? "");

/** A picker shows `shown` for the message whose first line is `target` (pickers cut long lines with "…"). */
export function sameMessage(shown: string | undefined, target: string) {
  const h = norm(shown ?? "");
  const t = firstLine(target);
  if (!h || !t) return false;
  if (h === t) return true;
  return (t.startsWith(h) && h.length >= Math.min(t.length, 12)) || h.startsWith(t);
}

interface Driver {
  open: (w: Workspaces, pane: string) => Promise<void>;
  highlight: (w: Workspaces, pane: string) => Promise<string | undefined>;
  /** Steps to the newest message from where the picker opens. */
  pre: number;
  back: string;
  forward: string;
  confirm: (w: Workspaces, pane: string, code: boolean) => Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const escEsc = async (w: Workspaces, pane: string) => {
  await w.clearBox(pane); // from an empty box: Esc Esc on typed text only clears it
  await w.press(pane, ["esc"]);
  await sleep(120);
  await w.press(pane, ["esc"]);
};

const DRIVERS: Record<string, Driver> = {
  claude: {
    open: escEsc,
    highlight: async (w, pane) => claudeHighlight(await w.visible(pane)),
    pre: 1,
    back: "up",
    forward: "down",
    confirm: async (w, pane, code) => {
      await w.press(pane, ["enter"]);
      // its question: Restore conversation / Restore code and conversation / Summarize … / Never mind
      for (let i = 0; i < 25; i++) {
        await sleep(80);
        const { menu } = await w.screenState(pane);
        const pick = menu?.options.find((o) => o.label === (code ? "Restore code and conversation" : "Restore conversation")) ?? menu?.options.find((o) => o.label === "Restore conversation");
        if (pick) return void (await w.choose(pane, pick.index, pick.label));
      }
      throw new AfError("rewind_failed", "claude did not ask how to restore; look at its terminal");
    },
  },
  codex: {
    open: escEsc,
    highlight: async (w, pane) => codexHighlight(await w.visible(pane, true)),
    pre: 0,
    back: "left",
    forward: "right",
    confirm: (w, pane) => w.press(pane, ["enter"]),
  },
  omp: {
    open: async (w, pane) => {
      await w.clearBox(pane);
      await w.typeText(pane, "/rewind");
      await sleep(120);
      await w.press(pane, ["enter"]);
    },
    highlight: async (w, pane) => ompHighlight(await w.visible(pane)),
    pre: 1,
    back: "left",
    forward: "right",
    confirm: (w, pane) => w.press(pane, ["enter"]),
  },
  gemini: {
    // (Esc Esc opens it too, but only from an empty box of an agent that is not working)
    open: async (w, pane) => {
      await w.clearBox(pane);
      await w.typeText(pane, "/rewind");
      await sleep(120);
      await w.press(pane, ["enter"]);
    },
    highlight: async (w, pane) => geminiHighlight(await w.visible(pane)),
    pre: 1,
    back: "up",
    forward: "down",
    confirm: async (w, pane, code) => {
      await w.press(pane, ["enter"]);
      // its question: Rewind conversation and revert code changes / Rewind conversation / Revert code changes / Do nothing
      for (let i = 0; i < 25; i++) {
        await sleep(80);
        const { menu } = await w.screenState(pane);
        const pick = menu?.options.find((o) => o.label === (code ? "Rewind conversation and revert code changes" : "Rewind conversation")) ?? menu?.options.find((o) => o.label === "Rewind conversation");
        if (pick) return void (await w.choose(pane, pick.index, pick.label));
      }
      throw new AfError("rewind_failed", "gemini did not ask how to rewind; look at its terminal");
    },
  },
};

export interface RewindRequest {
  pane: string;
  /** The message's text as the transcript has it. */
  text: string;
  /** User messages after it in the view (an estimate of where it is in the agent's list). */
  back: number;
  /** Which one of the messages with this same first line, counting from the newest (1: the newest). */
  occurrence: number;
  /** Byte offset of the message's line in the transcript (claude, omp): from there on is hidden until the agent writes. */
  ref?: number;
  /** claude: restore the files it edited too. */
  code?: boolean;
}

const locks = new Set<string>();

export async function rewindTo(w: Workspaces, access: TranscriptAccess, req: RewindRequest): Promise<{ agent: string; restored: string }> {
  const p = w.model.panes.find((x) => x.id === req.pane);
  if (!p?.agent) throw new AfError("no_agent", "this pane has no agent");
  const d = DRIVERS[p.agent];
  if (!d) throw new AfError("unsupported", `rewinding ${p.agent} is not supported`);
  if (!firstLine(req.text)) throw new AfError("bad_request", "which message?");
  if (locks.has(req.pane)) throw new AfError("busy", "a rewind is already going on in this pane", 409);
  locks.add(req.pane);
  try {
    const st = await w.screenState(req.pane);
    if (st.menu || st.overlay) throw new AfError("agent_asking", `${p.agent} is showing a question or a notice; answer it first`, 409);
    // a working agent stops first (Esc), as in its own terminal
    if (p.agentStatus === "working") {
      await w.press(req.pane, ["esc"]);
      for (let i = 0; i < 40; i++) {
        await sleep(200);
        await w.refresh();
        if (w.model.panes.find((x) => x.id === req.pane)?.agentStatus !== "working") break;
      }
    }
    // where the transcript ends now: the hidden part ends here (codex and gemini record the rewind themselves)
    const src = p.agent !== "codex" && p.agent !== "gemini" && req.ref !== undefined ? await access.resolve(req.pane).catch(() => undefined) : undefined;
    const path = src && "source" in src && !src.source.pending ? src.source.path : undefined;
    const size = path ? (await access.fsFor(req.pane).fs.readFrom(path, 0, 0))?.size : undefined;

    await d.open(w, req.pane);
    let h: string | undefined;
    for (let i = 0; i < 25 && h === undefined; i++) {
      await sleep(80);
      h = await d.highlight(w, req.pane);
    }
    if (h === undefined) throw new AfError("rewind_failed", `${p.agent}'s rewind list did not open; look at its terminal`);

    // press a key and wait for the highlight to move (the agent redraws); the same text after 500 ms: the list's end
    const step = async (key: string, n = 1) => {
      const before = h;
      await w.press(req.pane, Array(n).fill(key));
      for (let i = 0; i < 10; i++) {
        await sleep(50);
        h = await d.highlight(w, req.pane);
        if (h !== before) return true;
      }
      return false;
    };
    let found = false;
    if (req.occurrence <= 1) {
      // most likely right there: jump close, then step to it; failing that, search the whole list from the top down
      const jump = d.pre + Math.max(0, req.back - 2);
      if (jump) await step(d.back, jump);
      for (let i = 0; i < 80 && !found; i++) {
        if (sameMessage(h, req.text)) found = true;
        else if (!(await step(d.back))) break;
      }
      for (let i = 0; i < 160 && !found; i++) {
        if (sameMessage(h, req.text)) found = true;
        else if (!(await step(d.forward))) break;
      }
    } else {
      if (d.pre) await step(d.back, d.pre);
      let seen = 0;
      for (let i = 0; i < 400; i++) {
        if (sameMessage(h, req.text) && ++seen === req.occurrence) {
          found = true;
          break;
        }
        if (!(await step(d.back))) break;
      }
    }
    if (!found) {
      await w.press(req.pane, ["esc"]);
      throw new AfError("rewind_failed", `could not find that message in ${p.agent}'s rewind list`);
    }

    await d.confirm(w, req.pane, !!req.code);
    // the picker closes and the message lands in the agent's own box: clear it there (never Ctrl+C an empty box:
    // that arms "press again to quit")
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      if ((await d.highlight(w, req.pane)) !== undefined || (await w.screenState(req.pane)).menu) continue;
      if (await w.clearBox(req.pane)) break;
    }

    if (path && size !== undefined && req.ref !== undefined && req.ref < size) access.cuts.add(path, { from: req.ref, to: size });
    access.cuts.changed(req.pane);
    return { agent: p.agent, restored: req.text };
  } finally {
    locks.delete(req.pane);
  }
}
