// What an agent offers after "/" (and "$" for codex skills), for the composer's command menu.
//
// Built-in commands are listed per agent (names and wording from each agent's own UI). Skills come from
// the agent's own session, so the list matches what that agent actually loaded:
//   claude: `skill_listing` attachments in its transcript ("- name: description" lines; includes plugin skills)
//   codex:  the "### Available skills" catalog in its session's instructions; invoked as $name
//   omp:    SKILL.md files in the folders it discovers; invoked as /skill:name

import type { CommandItem } from "@af/core";
import { sq } from "./remote.ts";
import type { TranscriptFS } from "./transcripts/index.ts";

const cmd = (name: string, description: string): CommandItem => ({ name, insert: `/${name}`, description, kind: "command" });

const BUILTIN: Record<"claude" | "codex" | "omp", CommandItem[]> = {
  // Claude Code 2.1.317 ("/cost" and "/stats" are aliases of /usage; /agents was removed)
  claude: [
    cmd("help", "Show help and available commands"),
    cmd("clear", "Start a new session with empty context (the old one stays resumable)"),
    cmd("compact", "Summarize the conversation to free context (optional focus instructions)"),
    cmd("context", "Show how the context window is used"),
    cmd("model", "Set the AI model"),
    cmd("effort", "Set the effort level for the model"),
    cmd("fast", "Toggle fast mode"),
    cmd("resume", "Resume an earlier conversation"),
    cmd("rewind", "Restore the code and/or conversation to an earlier point"),
    cmd("fork", "Copy this conversation into a new background session and keep working here"),
    cmd("branch", "Branch the conversation at this point"),
    cmd("btw", "Ask a quick side question without interrupting the main conversation"),
    cmd("rename", "Rename the conversation"),
    cmd("goal", "Set a goal Claude checks before stopping"),
    cmd("loop", "Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo)"),
    cmd("plan", "Enable plan mode or view the current plan"),
    cmd("tasks", "View and manage everything running in the background"),
    cmd("subtask", "Send a subagent off with your full context; its result comes back here"),
    cmd("recap", "Generate a one-line session recap now"),
    cmd("copy", "Copy Claude's last response (or /copy N for the Nth-latest)"),
    cmd("diff", "View uncommitted changes and per-turn diffs"),
    cmd("export", "Export the conversation to a file or the clipboard"),
    cmd("init", "Initialize a CLAUDE.md file with codebase documentation"),
    cmd("config", "Open settings"),
    cmd("permissions", "Manage allow and deny tool permission rules"),
    cmd("output-style", "List output styles or switch to one"),
    cmd("advisor", "Let Claude consult a stronger model at key moments"),
    cmd("mcp", "Manage MCP servers"),
    cmd("memory", "Edit CLAUDE.md files and memory settings"),
    cmd("skills", "List available skills"),
    cmd("hooks", "View hook configurations for tool events"),
    cmd("plugin", "Manage plugins"),
    cmd("add-dir", "Add a working directory"),
    cmd("background", "Send this session to the background and free the terminal"),
    cmd("status", "Show version, model, account, API connectivity and tool status"),
    cmd("usage", "Show session cost, plan usage and activity stats"),
    cmd("doctor", "Check the installation"),
    cmd("login", "Sign in or switch Anthropic accounts"),
    cmd("logout", "Sign out"),
  ],
  codex: [
    cmd("model", "choose what model and reasoning effort to use"),
    cmd("permissions", "choose what Codex is allowed to do"),
    cmd("skills", "use skills to improve how Codex performs specific tasks"),
    cmd("review", "review my current changes and find issues"),
    cmd("new", "start a new chat during a conversation"),
    cmd("resume", "resume a saved chat"),
    cmd("fork", "fork the current chat"),
    cmd("rename", "rename the current thread"),
    cmd("init", "create an AGENTS.md file with instructions for Codex"),
    cmd("compact", "summarize conversation to prevent hitting the context limit"),
    cmd("plan", "switch to Plan mode"),
    cmd("diff", "show git diff (including untracked files)"),
    cmd("mention", "mention a file"),
    cmd("status", "show current session configuration and token usage"),
    cmd("copy", "copy the last response or part of it"),
    cmd("export", "export the conversation as markdown"),
    cmd("mcp", "list MCP tools; use /mcp verbose or /mcp login <name>"),
    cmd("clear", "clear the terminal and start a new chat"),
    cmd("logout", "log out of Codex"),
    cmd("exit", "exit Codex"),
  ],
  omp: [
    cmd("model", "Switch model for this session"),
    cmd("new", "Start a new session"),
    cmd("fork", "Create a new fork from a previous message"),
    cmd("tree", "Navigate session tree (switch branches)"),
    cmd("compact", "Manually compact the session context"),
    cmd("todo", "View or modify the agent's todo list"),
    cmd("goal", "Toggle goal mode (persistent autonomous objective for this session)"),
    cmd("settings", "Open settings menu"),
    cmd("session", "Session management commands"),
    cmd("share", "Share session via an encrypted link"),
    cmd("hotkeys", "Show all keyboard shortcuts"),
    cmd("login", "Login with OAuth provider"),
    cmd("logout", "Logout from OAuth provider"),
    cmd("quit", "Quit the application"),
  ],
};

/** "- name: description" lines → skills. */
function bulletSkills(text: string, insert: (name: string) => string): CommandItem[] {
  const out: CommandItem[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^- ([A-Za-z0-9_.:@/-]+): (.*)$/);
    if (!m) continue;
    out.push({ name: m[1]!, insert: insert(m[1]!), description: m[2]!.replace(/\s*\(file: [^)]*\)\s*$/, "").trim(), kind: "skill" });
  }
  return out;
}

/** Skills a claude session loaded, from the skill_listing attachments at the start of its transcript. */
export function claudeSkills(head: string): CommandItem[] {
  const byName = new Map<string, CommandItem>();
  for (const line of head.split("\n")) {
    if (!line.includes('"skill_listing"')) continue;
    try {
      const a = JSON.parse(line).attachment;
      if (a?.type !== "skill_listing" || typeof a.content !== "string") continue;
      if (a.isInitial) byName.clear();
      for (const s of bulletSkills(a.content, (n) => `/${n}`)) byName.set(s.name, s);
    } catch {}
  }
  return [...byName.values()];
}

/** Skills in a codex session's catalog; codex invokes them with $name. */
export function codexSkills(head: string): CommandItem[] {
  for (const line of head.split("\n")) {
    if (!line.includes("### Available skills")) continue;
    try {
      const p = JSON.parse(line).payload;
      for (const c of p?.content ?? []) {
        const t: string = c?.text ?? "";
        const i = t.indexOf("### Available skills");
        if (i < 0) continue;
        const block = t.slice(i).split(/\n#{2,3} (?!Available skills)/)[0]!;
        return bulletSkills(block, (n) => `$${n}`);
      }
    } catch {}
  }
  return [];
}

/** SKILL.md frontmatter → name and description. */
export function skillFromFrontmatter(text: string): { name?: string; description?: string } {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return {};
  const get = (k: string) => {
    const m = fm[1]!.match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : undefined;
  };
  return { name: get("name"), description: get("description") };
}

/** Skills omp can see: SKILL.md files in the folders it discovers. */
export async function ompSkills(fs: TranscriptFS, cwd: string): Promise<CommandItem[]> {
  // each folder is one shell word: $HOME expands inside double quotes; the project path is single-quoted
  const dirs = ['"$HOME/.omp/agent/skills"', '"$HOME/.omp/skills"', '"$HOME/.claude/skills"', '"$HOME/.agents/skills"', ...[".claude/skills", ".omp/skills", ".agents/skills"].map((d) => sq(`${cwd}/${d}`))];
  const out = await fs.sh(`for d in ${dirs.join(" ")}; do for f in "$d"/*/SKILL.md; do [ -f "$f" ] || continue; echo "@@@ $f"; head -n 15 "$f"; done; done 2>/dev/null`);
  const byName = new Map<string, CommandItem>();
  for (const chunk of out.split("@@@ ").slice(1)) {
    const nl = chunk.indexOf("\n");
    const path = chunk.slice(0, nl).trim();
    const { name, description } = skillFromFrontmatter(chunk.slice(nl + 1));
    const n = name ?? path.split("/").at(-2)!;
    if (!byName.has(n)) byName.set(n, { name: n, insert: `/skill:${n}`, description: description ?? "", kind: "skill" });
  }
  return [...byName.values()];
}

export async function commandsFor(agent: string, fs: TranscriptFS, transcript: string | undefined, cwd: string): Promise<CommandItem[]> {
  if (agent !== "claude" && agent !== "codex" && agent !== "omp") return [];
  let skills: CommandItem[] = [];
  if (agent === "omp") skills = await ompSkills(fs, cwd);
  else if (transcript) {
    const head = await fs.readFrom(transcript, 0, 3 * 1024 * 1024);
    const text = head?.data.toString("utf8") ?? "";
    skills = agent === "claude" ? claudeSkills(text) : codexSkills(text);
  }
  // a skill with a built-in's name (claude's /init, /review) is the same thing: keep one entry
  const builtins = BUILTIN[agent].filter((c) => !skills.some((s) => s.insert === c.insert));
  return [...builtins, ...skills];
}
