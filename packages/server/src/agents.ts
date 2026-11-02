// How each agent kind is launched with the agent-flow protocol injected. Flags come from the step-0 spikes
// (spikes/s2s3-agents/RESULT.md); docs/design.md section 9 explains each one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Flags that start `kind` with the protocol injected. Herdr types the command into a shell, and macOS caps
 * a typed line at 1024 bytes (MAX_CANON), so the protocol text never goes on the command line: claude and
 * omp take a file path, codex takes a profile name.
 */
export function launchArgs(kind: AgentKind, role: Role, protocolFile: string, config: AgentConfig): string[] {
  const extra = config.args[kind] ?? [];
  switch (kind) {
    case "claude":
      return ["--append-system-prompt-file", protocolFile, ...extra];
    case "codex":
      return ["-p", writeCodexProfile(role, protocolFile), "-c", "sandbox_workspace_write.network_access=true", ...extra];
    case "omp":
      return [`--append-system-prompt=${protocolFile}`, ...extra];
  }
}

const TOML_LITERAL_FENCE = "'".repeat(3);

/** codex reads $CODEX_HOME/<name>.config.toml for `-p <name>`. Writes agent-flow-<role>.config.toml and returns <name>. */
export function writeCodexProfile(role: Role, protocolFile: string, codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  const name = `agent-flow-${role}`;
  const text = readFileSync(protocolFile, "utf8");
  if (text.includes(TOML_LITERAL_FENCE)) throw new Error(`${protocolFile} must not contain ${TOML_LITERAL_FENCE}; it is embedded as a TOML literal string`);
  mkdirSync(codexHome, { recursive: true });
  const toml = [
    `# Written by agent-flow for agents it starts with \`codex -p ${name}\`. Safe to delete.`,
    "check_for_update_on_startup = false",
    `developer_instructions = ${TOML_LITERAL_FENCE}`,
    `${text}${TOML_LITERAL_FENCE}`,
    "",
  ].join("\n");
  writeFileSync(join(codexHome, `${name}.config.toml`), toml);
  return name;
}

/** The line typed into an agent's terminal to wake it up. Matches what the protocols tell agents to look for. */
export function noticeText(count: number, latest: { id: string; from: string; node?: string }) {
  const about = latest.node ? ` (node ${latest.node})` : "";
  return count === 1
    ? `[agent-flow] New message ${latest.id} from ${latest.from}${about}. Run: af inbox`
    : `[agent-flow] ${count} new messages, latest ${latest.id} from ${latest.from}${about}. Run: af inbox`;
}
