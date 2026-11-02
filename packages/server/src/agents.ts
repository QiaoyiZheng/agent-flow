// How each agent kind is launched with the agent-flow protocol injected. Flags come from the step-0 spikes
// (spikes/s2s3-agents/RESULT.md); docs/design.md section 9 explains each one.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "@af/core";

export type Role = "lead" | "worker";

export interface AgentConfig {
  /** Extra flags per kind, appended after the injection flags. From ~/.agent-flow/config.json. */
  args: Partial<Record<AgentKind, string[]>>;
}

export const DEFAULT_CONFIG: AgentConfig = {
  args: { claude: ["--permission-mode", "auto"] },
};

export function loadConfig(home: string): AgentConfig {
  const f = join(home, "config.json");
  if (!existsSync(f)) return DEFAULT_CONFIG;
  const user = JSON.parse(readFileSync(f, "utf8")) as Partial<AgentConfig>;
  return { args: { ...DEFAULT_CONFIG.args, ...(user.args ?? {}) } };
}

export function launchArgs(kind: AgentKind, protocolFile: string, config: AgentConfig): string[] {
  const extra = config.args[kind] ?? [];
  switch (kind) {
    case "claude":
      return ["--append-system-prompt-file", protocolFile, ...extra];
    case "codex": {
      // codex has no file flag for extra instructions; the protocol goes in as one line.
      const oneLine = readFileSync(protocolFile, "utf8").replace(/\s*\n\s*/g, " ").trim();
      return [
        "-c",
        "check_for_update_on_startup=false",
        "-c",
        "sandbox_workspace_write.network_access=true",
        "-c",
        `developer_instructions=${oneLine}`,
        ...extra,
      ];
    }
    case "omp":
      return [`--append-system-prompt=${protocolFile}`, ...extra];
  }
}

/** The line typed into an agent's terminal to wake it up. Matches what the protocols tell agents to look for. */
export function noticeText(count: number, latest: { id: string; from: string; node?: string }) {
  const about = latest.node ? ` (node ${latest.node})` : "";
  return count === 1
    ? `[agent-flow] New message ${latest.id} from ${latest.from}${about}. Run: af inbox`
    : `[agent-flow] ${count} new messages, latest ${latest.id} from ${latest.from}${about}. Run: af inbox`;
}
