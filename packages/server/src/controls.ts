// Controls for an agent from the UI: stop its turn, rewind, clear the input, exit. Each agent binds these to
// different keys; the table says what each one does (checked live on claude 2.1.317, codex 0.162.1, omp 18.2.3,
// gemini 0.66.0).
//
//                 claude                     codex                          omp                          gemini
//   interrupt     Esc                        Esc                            Esc                          Esc
//   rewind        Esc Esc → its picker       Esc Esc → its transcript       /rewind → its picker         /rewind → its picker
//                 (pick a message, then      ("Browsing", Enter reverts     (Enter rewinds to the        (pick a message, then
//                 Restore conversation)      to the highlighted message)    highlighted message)         Rewind conversation)
//   clear input   Ctrl+C                     Ctrl+C                         Ctrl+C                       Ctrl+E Ctrl+U per line
//   exit          Ctrl+C Ctrl+C              Ctrl+D (empty input)           Ctrl+D (empty input)         Ctrl+C Ctrl+C (empty input)
//
// claude's Esc before it replied takes the message back (out of its conversation, into its box): the server then
// moves it into the UI's box and hides it in the view (rewind.ts takeBack).
//
// Esc on an empty input is how claude and codex start their rewind pickers, so a second Esc right after an
// interrupt can open one: "interrupt" sends one Esc only. "exit" first clears the input (Ctrl+C): codex and omp
// exit on Ctrl+D only from an empty input, and claude exits on a second Ctrl+C.
//
// gemini: Ctrl+C clears typed text only while it is idle; during a turn it stops the turn (and on an empty box it
// arms "Press Ctrl+C again to exit."), so its box is cleared with Ctrl+E (end of line) Ctrl+U (delete to the start)
// and Backspace (onto the line above), once per line. Esc Esc also opens its rewind list, but during a turn the
// first Esc stops the turn instead, so /rewind is typed. Exit: two Ctrl+C within 3 s on an empty box (Ctrl+D Ctrl+D
// too); during a turn the first one stops it.

import { geminiInputRows } from "./menu.ts";
import { AfError } from "./errors.ts";

export type ControlAction = "interrupt" | "rewind" | "clear" | "exit";
export const CONTROL_ACTIONS: readonly ControlAction[] = ["interrupt", "rewind", "clear", "exit"];

/**
 * What to do for an action: keys to press (with a pause between groups), a command to type, or clear the agent's
 * own input box: Ctrl+C, but only when the box has text. On an empty box Ctrl+C arms "press again to quit" (claude,
 * codex), so a later Ctrl+C would quit the agent.
 */
export type ControlStep = { keys: string[] } | { text: string } | { wait: number } | { clearBox: true };

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** What gemini shows in its empty box (normal, shell mode, vim mode, voice mode). */
const GEMINI_PLACEHOLDER = /^(Type your message or \S.*|Type your shell command|Press '(Esc|i)' for (NORMAL|INSERT) mode\.)$/;

/**
 * What is typed in the agent's own input box, from its screen with colour codes; "" when empty, undefined when the
 * box is not on screen (a picker or a dialog is). claude: "❯" + no-break space + text; codex: "›" + text, its
 * placeholder ("Ask Codex to do anything", examples) drawn dim; omp: "╰─ " + text (plus a dim completion hint);
 * gemini: " > " + text between ▄▄▄ and ▀▀▀ rows, its placeholder ("Type your message or @path/to/file") drawn gray
 * after the cursor.
 */
export function inputText(agent: string | undefined, ansiScreen: string): string | undefined {
  const lines = ansiScreen.split("\n");
  const plain = (l: string) => l.replace(ANSI, "").replace(/\r$/, "");
  if (agent === "gemini") {
    const shown = lines.map((l) => plain(l).replace(/\u00a0/g, " ").replace(/\s+$/, ""));
    while (shown.length && !shown.at(-1)!.trim()) shown.pop();
    const rows = geminiInputRows(shown);
    if (!rows) return undefined;
    const first = rows[0]!.replace(/^ ?(?:[>!*]|\(r:\)) /, "");
    if (rows.length === 1 && GEMINI_PLACEHOLDER.test(first.trim())) return "";
    return [first, ...rows.slice(1)].map((l) => l.trim()).join("\n").trim();
  }
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
    const raw = lines[i]!;
    const t = plain(raw);
    if (agent === "claude") {
      const m = t.match(/^❯\u00a0(.*)$/);
      if (m) return m[1]!.trim();
    } else if (agent === "codex") {
      const m = t.match(/^›(?:\s(.*))?$/);
      if (!m) continue;
      const after = raw.slice(raw.indexOf("›") + 1);
      const lead = after.match(/^(?:\x1b\[[0-9;?]*[A-Za-z]|\s)*/)?.[0] ?? "";
      if (/\x1b\[(?:0;)?2m/.test(lead)) return ""; // the dim placeholder
      return (m[1] ?? "").trim();
    } else if (agent === "omp") {
      const m = t.match(/^╰─(?:\s(.*))?$/);
      if (m) {
        // the completion hint after the cursor is dim gray: leave it out
        const typed = raw.slice(raw.indexOf("╰─") + 2).replace(/\x1b\[38;2;110;118;129m[^\x1b]*/g, "");
        return plain(typed).trim();
      }
    }
  }
  return undefined;
}

const ESC_ESC: ControlStep[] = [{ keys: ["esc"] }, { wait: 120 }, { keys: ["esc"] }];

const TABLE: Record<string, Record<ControlAction, ControlStep[]>> = {
  claude: {
    interrupt: [{ keys: ["esc"] }],
    // from an empty input: whatever is typed goes first, or Esc Esc would only clear it
    rewind: [{ clearBox: true }, ...ESC_ESC],
    clear: [{ clearBox: true }],
    // claude: the first Ctrl+C clears the box (and arms "Press Ctrl-C again to exit"), the second exits.
    // Ctrl+D right after the first one does nothing (checked live), so it is not used here.
    exit: [{ keys: ["ctrl+c"] }, { wait: 300 }, { keys: ["ctrl+c"] }],
  },
  codex: {
    interrupt: [{ keys: ["esc"] }],
    rewind: [{ clearBox: true }, ...ESC_ESC],
    clear: [{ clearBox: true }],
    exit: [{ keys: ["ctrl+c"] }, { wait: 150 }, { keys: ["ctrl+d"] }],
  },
  omp: {
    interrupt: [{ keys: ["esc"] }],
    rewind: [{ clearBox: true }, { text: "/rewind" }],
    clear: [{ clearBox: true }],
    exit: [{ keys: ["ctrl+c"] }, { wait: 150 }, { keys: ["ctrl+d"] }],
  },
  gemini: {
    interrupt: [{ keys: ["esc"] }],
    rewind: [{ clearBox: true }, { text: "/rewind" }],
    clear: [{ clearBox: true }],
    exit: [{ clearBox: true }, { keys: ["ctrl+c"] }, { wait: 300 }, { keys: ["ctrl+c"] }],
  },
};

/**
 * Keys that clear the agent's own input box (pressed only when it has text, see ControlStep). gemini's are pressed
 * again while text is left: each round clears one line.
 */
export const CLEAR_BOX: Record<string, { keys: string[]; perLine?: boolean } | undefined> = {
  gemini: { keys: ["ctrl+e", "ctrl+u", "backspace"], perLine: true },
};
export const clearBoxKeys = (agent: string | undefined) => CLEAR_BOX[agent ?? ""] ?? { keys: ["ctrl+c"] };

export function controlSteps(agent: string | undefined, action: string): ControlStep[] {
  if (!CONTROL_ACTIONS.includes(action as ControlAction)) throw new AfError("bad_action", `unknown action ${action}; one of ${CONTROL_ACTIONS.join(", ")}`);
  const t = agent ? TABLE[agent] : undefined;
  if (!t) throw new AfError("no_agent", agent ? `controls for ${agent} are not known` : "this pane has no agent");
  return t[action as ControlAction];
}

/**
 * Steering: getting a message into the agent's running turn now. Enter while it works does different things
 * (checked live, claude 2.1.318, codex 0.162.1, omp 18.2.3):
 *   claude   queues it ("ctrl+enter to send now" under the box); Ctrl+Enter sends it now: a running command
 *            moves to the background and the message is answered at once
 *   codex    takes it into the turn, or, while a tool call runs, holds it ("Messages to be submitted after next
 *            tool call (press esc to interrupt and send immediately)"); Esc then sends it now. Esc with
 *            nothing held stops the turn, so it is pressed only while that line is on screen.
 *   omp      sends it now (a running command moves to the background)
 *   gemini   (0.66) queues it ("Queued (press ↑ to edit):" above the box) and sends it when the turn ends; no key
 *            sends it sooner (Esc stops the turn and puts the queued text back in the box). With the experimental
 *            setting experimental.modelSteering on, Enter instead hands it to the running turn as a hint.
 * After typing the message and Enter: wait for `waiting` on screen, then press `keys` (none: the agent holds it).
 */
export const STEER_NOW: Record<string, { waiting: RegExp; keys: string[] } | undefined> = {
  claude: { waiting: /to send now/i, keys: ["ctrl+enter"] },
  codex: { waiting: /Messages to be submitted after next tool call/i, keys: ["esc"] },
  omp: undefined,
  gemini: { waiting: /Queued \(press ↑ to edit\):/, keys: [] },
};

/** What the rewind picker of each agent needs from the user next, for the hint the UI shows. */
export const REWIND_HINT: Record<string, string> = {
  claude: "Pick the message to go back to, then choose Restore conversation.",
  codex: "↑/↓ to the message to go back to, Enter to revert to it, Esc to cancel.",
  omp: "↑/↓ to the point to go back to, Enter to rewind, Esc to cancel.",
  gemini: "↑/↓ to the message to go back to, Enter, then choose Rewind conversation. Esc to cancel.",
};
