// Wire types shared by the server, the af CLI, and the web UI.

import type { AgentKind, Command } from "./graph.ts";
import type { Attention, RunEvent, RunState } from "./run.ts";

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
  /** Start from a workflow template (its id) with this goal: the graph is built at once. */
  workflow?: string;
  goal?: string;
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
  /** The lead's pane: its "finished" shows in Needs you, the workers' do not (the lead handles those). */
  leadPane?: string;
  attention: number;
  /** The open attention items themselves, with the pane of the agent each is about. */
  needs: (Attention & { paneId?: string })[];
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
  /** Scrolled up: the visible screen is history, not what the agent shows now. */
  scrolled?: boolean;
  /** When agentStatus last changed, if agent-flow saw it change (not set for the status found at server start). */
  statusAt?: string;
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
  | {
      kind: "user";
      text: string;
      /** Images the user gave the agent directly (pasted in its own terminal): data: URLs or file paths. */
      images?: string[];
      /** The slash command or skill the message ran ("/grill-me"): shown as a badge before the text. */
      command?: string;
    }
  /** Assistant prose: markdown with LaTeX math. */
  | { kind: "text"; text: string }
  /** The model's readable reasoning (claude thinking, codex reasoning summaries, omp thinking): folded by default. */
  | { kind: "thinking"; text: string }
  | ToolBlock
  /**
   * A compact line: slash command output, agent-flow wake-ups, interruptions, errors, compaction.
   * tone: how it looks (info is the default). detail: folded text under it (a command's output, a summary).
   * divider: drawn across the conversation (context compacted, session resumed).
   */
  | { kind: "notice"; text: string; tone?: "info" | "warn" | "error"; detail?: string; divider?: boolean };

export interface ToolBlock {
  kind: "tool";
  id: string;
  name: string;
  /** One line, e.g. the shell command or the file path. */
  summary: string;
  /** Full input when the summary does not say everything. */
  input?: string;
  /**
   * For edits: a unified diff. Hunk headers "@@ -12,3 +12,4 @@" give line numbers when known; several files are
   * introduced by "--- a/<path>" + "+++ b/<path>" (or "*** Update File: <path>") lines.
   */
  patch?: string;
  /** For edits when no diff is known: the text before and after. */
  edit?: { path: string; before: string; after: string };
  /** Files this call changed (for the folded steps label: "edited calc.js, test.js"). */
  files?: string[];
  output?: string;
  /** Markdown worth reading rendered (a subagent's report, a plan, a todo list as "- [x] …"). */
  report?: string;
  /** Images in the result (screenshots, viewed images): data: URLs or file paths. */
  images?: string[];
  error?: boolean;
  /** Ended without finishing: the user interrupted it. */
  aborted?: boolean;
  /** Runs in the background (claude run_in_background, a codex background terminal): done when it reports back. */
  background?: boolean;
  done: boolean;
}

/** What the agent's session is set to, shown in the footer. Each field is the latest value seen. */
export interface ChatMeta {
  model?: string;
  /** Reasoning effort or thinking level. */
  effort?: string;
  /** Permission or approval mode: "auto", "plan", "acceptEdits", codex sandbox policy, … */
  mode?: string;
  /** Tokens in the context window after the last turn, and the window's size. */
  contextTokens?: number;
  contextWindow?: number;
  /** Cost so far in USD, when the agent records it. */
  cost?: number;
}

export interface ChatEntry {
  key: string;
  at?: string;
  block: ChatBlock;
  /** Byte offset in the transcript file where this entry's line starts: a fork point ("fork from here"). */
  ref?: number;
}

/** Something the user should know about: a failed connection, a broken terminal stream, a lost Herdr. */
export interface Notice {
  id: string;
  level: "error" | "warn" | "info";
  /** Where it came from: "machine:ds03", "herdr", "terminal:w1:p2", "ui". */
  source: string;
  text: string;
  detail?: string;
  at: string;
  /** How many times the same notice happened in a row (shown as ×N instead of repeating it). */
  count: number;
}

/** A slash command or skill an agent offers, for the composer's "/" menu. */
export interface CommandItem {
  name: string;
  /** Text the composer inserts: "/model", "/skill:x" (omp), "$x" (codex skills). */
  insert: string;
  description: string;
  kind: "command" | "skill";
}

export type ChatOp =
  | { op: "add"; entry: ChatEntry }
  /** A tool call's result: marks it done (unless background), with its output. */
  | { op: "result"; id: string; output: string; error?: boolean; images?: string[]; background?: boolean }
  /** A later change to a tool call: a background task finished, a subagent's report arrived, the real diff is known. */
  | { op: "update"; id: string; set: Partial<Omit<ToolBlock, "kind" | "id">> }
  /** Session settings and usage for the footer (merged: later values win). */
  | { op: "meta"; meta: ChatMeta }
  /** Take entries out again (by key): an abandoned branch after a rewind, a placeholder replaced by the real thing. */
  | { op: "remove"; keys: string[] };

export interface ChatSource {
  agent: "claude" | "codex" | "omp" | "gemini";
  path: string;
  /** How the transcript was found: exact session id/path, the screen's content, or a guess from the pane's folder. */
  how: "session" | "title" | "screen" | "folder";
  /**
   * Locked to this pane's conversation, but the agent has not written it yet: every agent creates its file (and
   * codex its database row) only when the first message arrives. Shown as an empty conversation that fills in by
   * itself. `path` is where it will be when known (omp), else "".
   */
  pending?: boolean;
}

/** Messages the server pushes to the web UI over WebSocket. */
/** A document an agent handed over to the user (af deliver). */
export interface Delivery {
  id: string;
  /** Absolute path on `machine`. */
  path: string;
  machine: string;
  /** The pane of the agent that handed it over, and its workspace. */
  pane?: string;
  workspace?: string;
  /** The agent's name in its run, when it is in one. */
  agent?: string;
  title?: string;
  note?: string;
  /** The viewer pane it is shown in. */
  viewer?: string;
  /** The app it was opened in by itself (settings: auto). */
  opened?: string;
  /** Opened or dismissed by the user: no longer in "Needs you". */
  done?: boolean;
  /** Found by agent-flow (the agent changed it during its turn), not handed over with af deliver. */
  found?: boolean;
  at: string;
}

export type OpenAppName = "vscode" | "obsidian" | "default" | "finder";

/** How handed-over documents open: by themselves or with a click, and in which app per kind of file. */
export interface OpenSettings {
  auto: boolean;
  markdown: OpenAppName;
  text: OpenAppName;
  document: OpenAppName;
}

/** A message for an agent, held by agent-flow while the agent works; sent when its turn ends, or now when steered. */
export interface QueuedMessage {
  id: string;
  /** What the user typed. */
  body: string;
  /** Attachment paths, read before the message. */
  files: string[];
  at: string;
}

export type ServerPush =
  | { type: "hello"; runs: RunSummary[] }
  | { type: "herdr"; model: HerdrModel; views: Record<string, ViewRec>; queue: Record<string, QueuedMessage[]> }
  /** more: earlier conversation exists; it comes as chat.prepend when asked for with chat.more. */
  | { type: "chat.reset"; id: string; source: ChatSource | null; reason?: string; ops: ChatOp[]; more?: boolean }
  | { type: "chat.prepend"; id: string; ops: ChatOp[]; more: boolean }
  | { type: "chat.ops"; id: string; ops: ChatOp[] }
  | { type: "notices"; list: Notice[] }
  | { type: "deliveries"; list: Delivery[]; settings: OpenSettings; apps: Record<OpenAppName, boolean> }
  | { type: "notice"; notice: Notice }
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
  /** The user scrolled to the top: send the conversation before what was sent. */
  | { type: "chat.more"; id: string }
  | { type: "chat.close"; id: string };
