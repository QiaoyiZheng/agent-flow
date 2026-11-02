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

export interface HWorkspace {
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
}

export interface HLayout {
  tabId: string;
  root: LayoutNode;
  zoomed: boolean;
  focusedPaneId?: string;
}

export interface HMachine {
  id: string;
  label: string;
  /** "local", or the SSH target of a saved Herdr machine. */
  target: string;
  /** Whether agent-flow can browse it. Remote machines need Herdr >= 0.9.5 (--machine). */
  available: boolean;
  note?: string;
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

/** Messages the server pushes to the web UI over WebSocket. */
export type ServerPush =
  | { type: "hello"; runs: RunSummary[] }
  | { type: "herdr"; model: HerdrModel; views: Record<string, ViewRec> }
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
  | { type: "term.close"; id: string };
