// Controls for an agent from the UI: stop its turn, rewind, clear the input, exit. Each agent binds these to
// different keys; the table says what each one does (checked live on claude 2.1.317, codex 0.162.1, omp 18.2.3).
//
//                 claude                     codex                          omp
//   interrupt     Esc                        Esc                            Esc
//   rewind        Esc Esc → its picker       Esc Esc → its transcript       /rewind → its picker
//                 (pick a message, then      ("Browsing", Enter reverts     (Enter rewinds to the highlighted
//                 Restore conversation)      to the highlighted message)    message)
//   clear input   Ctrl+C                     Ctrl+C                         Ctrl+C
//   exit          Ctrl+C Ctrl+C              Ctrl+D (empty input)           Ctrl+D (empty input)
//
// Esc on an empty input is how claude and codex start their rewind pickers, so a second Esc right after an
// interrupt can open one: "interrupt" sends one Esc only. "exit" first clears the input (Ctrl+C): codex and omp
// exit on Ctrl+D only from an empty input, and claude exits on a second Ctrl+C.

import { AfError } from "./orchestrator.ts";

export type ControlAction = "interrupt" | "rewind" | "clear" | "exit";
export const CONTROL_ACTIONS: readonly ControlAction[] = ["interrupt", "rewind", "clear", "exit"];

/** What to do for an action: keys to press (with a pause between groups), or a command to type. */
export type ControlStep = { keys: string[] } | { text: string } | { wait: number };

const ESC_ESC: ControlStep[] = [{ keys: ["esc"] }, { wait: 120 }, { keys: ["esc"] }];

const TABLE: Record<string, Record<ControlAction, ControlStep[]>> = {
  claude: {
    interrupt: [{ keys: ["esc"] }],
    // from an empty input: whatever is typed goes first, or Esc Esc would only clear it
    rewind: [{ keys: ["ctrl+c"] }, { wait: 150 }, ...ESC_ESC],
    clear: [{ keys: ["ctrl+c"] }],
    // claude: the first Ctrl+C clears the box (and arms "Press Ctrl-C again to exit"), the second exits.
    // Ctrl+D right after the first one does nothing (checked live), so it is not used here.
    exit: [{ keys: ["ctrl+c"] }, { wait: 300 }, { keys: ["ctrl+c"] }],
  },
  codex: {
    interrupt: [{ keys: ["esc"] }],
    rewind: [{ keys: ["ctrl+c"] }, { wait: 150 }, ...ESC_ESC],
    clear: [{ keys: ["ctrl+c"] }],
    exit: [{ keys: ["ctrl+c"] }, { wait: 150 }, { keys: ["ctrl+d"] }],
  },
  omp: {
    interrupt: [{ keys: ["esc"] }],
    rewind: [{ keys: ["ctrl+c"] }, { wait: 150 }, { text: "/rewind" }],
    clear: [{ keys: ["ctrl+c"] }],
    exit: [{ keys: ["ctrl+c"] }, { wait: 150 }, { keys: ["ctrl+d"] }],
  },
};

export function controlSteps(agent: string | undefined, action: string): ControlStep[] {
  if (!CONTROL_ACTIONS.includes(action as ControlAction)) throw new AfError("bad_action", `unknown action ${action}; one of ${CONTROL_ACTIONS.join(", ")}`);
  const t = agent ? TABLE[agent] : undefined;
  if (!t) throw new AfError("no_agent", agent ? `controls for ${agent} are not known` : "this pane has no agent");
  return t[action as ControlAction];
}

/** What the rewind picker of each agent needs from the user next, for the hint the UI shows. */
export const REWIND_HINT: Record<string, string> = {
  claude: "Pick the message to go back to, then choose Restore conversation.",
  codex: "↑/↓ to the message to go back to, Enter to revert to it, Esc to cancel.",
  omp: "↑/↓ to the point to go back to, Enter to rewind, Esc to cancel.",
};
