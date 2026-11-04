// How each agent kind is launched with the agent-flow protocol injected. Flags come from the step-0 spikes
// (spikes/s2s3-agents/RESULT.md); docs/design.md section 9 explains each one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentKind } from "@af/core";

export type Role = "lead" | "worker";

export interface AgentConfig {
  /** Extra flags per kind, appended after the injection flags. From ~/.agent-flow/config.json. */
  args: Partial<Record<AgentKind, string[]>>;
  /** Settings file with agent-flow's SessionStart hook, passed to claude with --settings. */
  claudeSettings?: string;
}

/**
 * claude settings that add one SessionStart hook: it tells agent-flow which conversation file the agent
 * writes, at startup and again after /clear or a resume. Merged with the user's own settings by claude.
 */
export function writeClaudeSettings(home: string, sock: string, af: string) {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const file = join(home, "claude-settings.json");
  const command = `AF_SOCK=${q(sock)} ${q(af)} hook claude-session`;
  writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command, timeout: 10 }] }] } }, null, 2));
  return file;
}

/** Flags for claude agents agent-flow starts outside runs. */
export function claudeExtraArgs(config: AgentConfig, session: string) {
  return ["--session-id", session, ...(config.claudeSettings ? ["--settings", config.claudeSettings] : [])];
}

export const DEFAULT_CONFIG: AgentConfig = {
  // gemini: YOLO (no approval prompt per command or file write; the user's choice). Gemini allows YOLO only as a
  // flag, not in its settings file. Override in ~/.agent-flow/config.json: {"args": {"gemini": []}}.
  args: { claude: ["--permission-mode", "auto"], gemini: ["--approval-mode=yolo"] },
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
export function launchArgs(kind: AgentKind, role: Role, protocolFile: string, config: AgentConfig, session?: string): string[] {
  const extra = config.args[kind] ?? [];
  switch (kind) {
    case "claude":
      // --session-id: lets agent-flow find the transcript it renders (~/.claude/projects/*/<id>.jsonl)
      return ["--append-system-prompt-file", protocolFile, ...(session ? ["--session-id", session] : []), ...(config.claudeSettings ? ["--settings", config.claudeSettings] : []), ...extra];
    case "codex":
      // --no-alt-screen: in the alternate screen Herdr keeps no scrollback, so the UI could not scroll codex back
      return ["-p", writeCodexProfile(role, protocolFile), "--no-alt-screen", "-c", "sandbox_workspace_write.network_access=true", ...extra];
    case "omp":
      return [`--append-system-prompt=${protocolFile}`, ...extra];
    case "gemini":
      // Gemini CLI has no flag that adds to its system prompt (GEMINI_SYSTEM_MD replaces all of it, and goes stale
      // with every update), so the protocol is its first message: -i runs it and stays interactive, and "@<file>"
      // is Gemini's own way of putting a file's text into a message (the folder must be in its workspace).
      // No --session-id: answering Gemini's folder-trust dialog restarts it with the same arguments, and with a fixed
      // session id that restart fails ("already exists") and Gemini exits. The conversation is found by folder.
      return [
        "--include-directories",
        dirname(protocolFile),
        "-i",
        `@${protocolFile} These are your agent-flow instructions for this whole session. Reply only: ready`,
        ...extra,
      ];
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
export function noticeText(count: number, latest: { id: string; from: string; node?: string }, af = "af") {
  const about = latest.node ? ` (node ${latest.node})` : "";
  return count === 1
    ? `[agent-flow] New message ${latest.id} from ${latest.from}${about}. Run: ${af} inbox`
    : `[agent-flow] ${count} new messages, latest ${latest.id} from ${latest.from}${about}. Run: ${af} inbox`;
}
