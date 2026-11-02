// Wire types shared by the server, the af CLI, and the web UI.

import type { AgentKind, Command } from "./graph.ts";
import type { RunEvent, RunState } from "./run.ts";

/** Who is calling. CLI calls made by an agent carry AF_RUN/AF_AGENT; calls with no agent come from the human user. */
export interface Caller {
  run?: string;
  agent?: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export interface CreateRunRequest {
  cwd: string;
  team?: string;
  /** Lead agent kind when no team file is given. */
  leadKind?: AgentKind;
  /** First message for the lead, typed into its terminal once it is ready. */
  prompt?: string;
}

export interface GraphRequest extends Caller {
  command: Command;
}

export interface SendRequest extends Caller {
  to: string;
  body: string;
  attachments?: string[];
  replyTo?: string;
}

export interface DoneRequest extends Caller {
  outcome?: string;
  result?: string;
  note?: string;
}

export interface SpawnRequest extends Caller {
  name: string;
  kind: AgentKind;
  role?: string;
}

export interface OpenRequestBody extends Caller {
  target: string;
}

export interface RunSummary {
  id: string;
  cwd: string;
  createdAt: string;
  stopped: boolean;
  lead: string;
  attention: number;
  quiescent: boolean;
  /** Herdr workspace the run's agents live in. */
  workspace?: string;
}

// ---------------------------------------------------------------------------------------------
// The live Herdr model (machines, workspaces, tabs, panes, split layouts), mirrored for the UI and `af ls`.

export type SplitDirection = "right" | "down";

export type LayoutNode =
  | { type: "split"; direction: SplitDirection; ratio: number; first: LayoutNode; second: LayoutNode }
  | { type: "pane"; paneId: string };

/** Ids from remote machines carry their machine key: "ds03~w3:p4". Local ids have no prefix. */
export const MACHINE_SEP = "~";
export const splitId = (id: string) => {
  const i = id.indexOf(MACHINE_SEP);
  return i < 0 ? { machine: "local", raw: id } : { machine: id.slice(0, i), raw: id.slice(i + 1) };
};

export interface HWorkspace {
  machine: string;
  id: string;
  label: string;
  number: number;
  activeTabId?: string;
  agentStatus: string;
}

export interface HTab {
  id: string;
  workspaceId: string;
  label: string;
  number: number;
}

export interface HPane {
  machine: string;
  id: string;
  tabId: string;
  workspaceId: string;
  /** Agent kind Herdr detected in the pane (claude, codex, ...), if any. */
  agent?: string;
  /** Herdr agent name, if the agent was started with a name. */
  agentName?: string;
  agentStatus: string;
  label?: string;
  title?: string;
  cwd: string;
  /** Session the agent's Herdr integration reported: a transcript path (omp) or a session id (codex). */
  session?: { kind: "path" | "id"; value: string };
}

export interface HLayout {
  tabId: string;
  root: LayoutNode;
  zoomed: boolean;
  focusedPaneId?: string;
}

export interface HMachine {
  /** "local", or a slug of the saved machine's label; used as the id prefix. */
  id: string;
  label: string;
  /** "local", or the SSH target of a saved Herdr machine. */
  target: string;
  local: boolean;
  /** Remote machines connect on demand (when the UI expands them or an agent asks). */
  state: "online" | "connecting" | "offline" | "error";
  error?: string;
  /** Remote Herdr session name. */
  session?: string;
}

export interface HerdrModel {
  machines: HMachine[];
  workspaces: HWorkspace[];
  tabs: HTab[];
  panes: HPane[];
  layouts: Record<string, HLayout>;
}

/** A pane that shows a file, directory, or URL instead of a terminal. Keyed by Herdr pane id. */
export interface ViewRec {
  paneId: string;
  target: string;
  by: string;
  at: string;
}

export interface ShowRequest extends Caller {
  /** Absolute path or URL. */
  target: string;
  /** Show it in this existing viewer pane. */
  in?: string;
  /** Or split this pane (default: the caller's own pane) ... */
  of?: string;
  /** ... in this direction (default right). */
  split?: SplitDirection;
  /** Or open it as a new tab in this workspace. */
  tabIn?: string;
  /** The caller's Herdr pane, from $HERDR_PANE_ID. */
  pane?: string;
}

// ---------------------------------------------------------------------------------------------
// Rendered agent output: read from each agent's own transcript file (claude, codex, omp), normalized.

export type ChatBlock =
  | { kind: "user"; text: string }
  /** Assistant prose: markdown with LaTeX math. */
  | { kind: "text"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      /** One line, e.g. the shell command or the file path. */
      summary: string;
      /** Full input when the summary does not say everything. */
      input?: string;
      /** For edits: a unified-diff-like patch, or before/after text. */
      patch?: string;
      edit?: { path: string; before: string; after: string };
      output?: string;
      error?: boolean;
      done: boolean;
    }
  /** Compact line: slash commands, agent-flow wake-up notices, interruptions. */
  | { kind: "notice"; text: string };

export interface ChatEntry {
  key: string;
  at?: string;
  block: ChatBlock;
}

export type ChatOp = { op: "add"; entry: ChatEntry } | { op: "result"; id: string; output: string; error?: boolean };

export interface ChatSource {
  agent: "claude" | "codex" | "omp";
  path: string;
  /** How the transcript was found: exact session id/path, or a guess from the pane's folder. */
  how: "session" | "folder";
}

/** Messages the server pushes to the web UI over WebSocket. */
export type ServerPush =
  | { type: "hello"; runs: RunSummary[] }
  | { type: "herdr"; model: HerdrModel; views: Record<string, ViewRec> }
  | { type: "chat.reset"; id: string; source: ChatSource | null; reason?: string; ops: ChatOp[] }
  | { type: "chat.ops"; id: string; ops: ChatOp[] }
  | { type: "snapshot"; run: string; state: RunState }
  | { type: "event"; run: string; event: RunEvent }
  | { type: "term.frame"; id: string; bytes: string; width: number; height: number; full: boolean }
  | { type: "term.closed"; id: string; reason?: string };

/** Messages the web UI sends to the server over WebSocket. */
export type ClientPush =
  | { type: "watch"; run: string }
  | { type: "term.open"; id: string; paneId: string; cols: number; rows: number; mode: "control" | "observe" }
  | { type: "term.input"; id: string; text: string }
  | { type: "term.resize"; id: string; cols: number; rows: number }
  | { type: "term.scroll"; id: string; direction: "up" | "down"; lines: number }
  | { type: "term.close"; id: string }
  | { type: "chat.open"; id: string; paneId: string }
  | { type: "chat.close"; id: string };
