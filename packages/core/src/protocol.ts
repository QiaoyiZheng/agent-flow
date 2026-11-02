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
}

/** Messages the server pushes to the web UI over WebSocket. */
export type ServerPush =
  | { type: "hello"; runs: RunSummary[] }
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
