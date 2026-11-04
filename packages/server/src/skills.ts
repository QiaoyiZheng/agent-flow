// The "agent-flow" and "deliver-document" skills for sessions the user starts themselves (claude, codex; omp reads claude's skill
// folder). It teaches them to hand work to other agents through agent-flow when the user asks for that:
// "让别的 session 同时做…", "开两个 codex 并行…". Written on server start with this server's af command.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function skillText(af: string) {
  return `---
name: agent-flow
description: Hand work to other agents (claude, codex, omp, gemini) that run at the same time in their own terminals, which the user watches in the agent-flow UI. Use when the user asks to have other sessions or agents do things in parallel or in a pipeline (e.g. "让别的 session 同时做…", "开几个 session，claude 规划、codex 执行、gemini 写", "开两个 codex 并行改…", "让 gemini 也看一下", "fan out", "dispatch to codex", "have another agent review it"), or to start an agent team ("开个 agent team", "写和审循环", "super agent", a playbook). Not for work you can simply do yourself.
---

# agent-flow: hand work to other sessions

The af command is \`${af}\` (use this full path; it may not be on PATH). Each call is one shell command.

## Mode 1: hand out tasks yourself (quick work, you decide the order)

    ${af} task claude|codex|omp|gemini "<task>" [--name <name>] [--worktree]
    ${af} task --to <name> "<more work for the same session>"

- Each call opens a ticket and starts a new session in a new tab of this workspace (or, with --to, gives it to a
  session you started before, which keeps its context). The task text is its first message.
- Write the task so a fresh agent can do it without this conversation: the goal in the user's words, the files,
  how to check the result. Independent tasks run at the same time; for a step that needs an earlier result, wait
  for that result and then hand out the next task.
- --worktree: its own git worktree and branch (af/<team>/<name>), for code changes running in parallel. Nothing
  is merged for you; tell the user which branch has the work.

Then tell the user what is running and end your turn. Do not wait or poll.

When a session finishes its turn, a line like this is typed here:

    [agent-flow] 1 new in your queue: T1 plan finished. Run: ${af} queue take

Run \`${af} queue take\`: you get each session's final reply (the full text is in the file it names). Then hand out
the next task, tell a session more (\`${af} tell T1 "<text>"\`), or report to the user. The queue also tells you when
a session asks a question on its screen (answer it with \`${af} answer T2 <option number>\` if it is about the task;
permission prompts are the user's), may be stuck, or exited (\`${af} status <name>\` shows what it is doing).

## Mode 2: an agent team with a router (loops, longer work)

    ${af} playbook list
    ${af} team new --goal "<the goal in the user's words>" [--playbook humanize-loop|super-agent|bugfix|...] [--router claude]

A router agent starts in its own workspace and runs the team: it opens tickets for members, passes results between
them, and counts the rounds of a loop. You only hear its reports (in your queue, as above). More for the team:
\`${af} tell <its ticket> "<text>"\`. Use this when the user wants members to work with each other (write and review
until it passes) or a team that keeps taking requests.

## Other commands

    ${af} tickets           ${af} ticket show <T>         ${af} read <name>        ${af} team stop <team>
`;
}

/**
 * The "deliver-document" skill: when an agent has finished a document for the user (a report, a write-up, slides),
 * it hands it over with af deliver. The user sees it next to the agent and opens it in Obsidian / VS Code / its
 * app with one click (or it opens by itself, per the user's settings).
 */
export function deliverSkillText(af: string) {
  return `---
name: deliver-document
description: Hand a finished document to the user so they can open it in Obsidian, VS Code or its own app with one click. Use right after you finish writing (or substantially rewriting) a file meant for the user to read — a report, analysis, write-up, summary, plan, paper or paper section, notes they asked for, slides (.pptx), a Word/Excel/PDF file, an HTML page, a figure. Not for code, tests, configs, or your own scratch, memory or log files, and not for every small edit.
---

# Hand over a finished document

When a document for the user is done, run (one shell command; use the full path):

    ${af} deliver <file> --title "<what it is, a few words>"

- Several documents: \`${af} deliver a.md b.pptx --title "..."\`.
- \`--note "<one line>"\` for something the user should know before opening it (e.g. "figures are placeholders").
- It shows the file next to your pane in the agent-flow UI and lists it under "Needs you" with buttons to open it in
  Obsidian (Markdown), VS Code (text, code, LaTeX) or its own app (PowerPoint, Word, PDF…). Depending on the user's
  settings it may also open the app by itself. You do not open apps yourself.
- Hand over a document once when it is ready, and again only after a revision the user should look at.
- Then, in your reply, say what the document is and where it is (its path).

This applies however you wrote the file: with your edit tools, a script, a shell command, or a tool that generates
it (python-pptx, pandoc, LaTeX). Hand it over before your final reply, at the end of the turn that produced it.

If the command fails (agent-flow is not running, or this session is not in it), just give the file's path in your
reply. Do not retry, and do not open the file with other commands.
`;
}

/** Install the skills where claude and codex look for user skills. Returns the files written. */
export function installSkill(af: string, home = process.env.HOME ?? homedir()) {
  const written: string[] = [];
  // gemini reads ~/.gemini/skills/<name>/SKILL.md in the same format
  for (const root of [join(home, ".claude"), join(home, ".codex"), join(home, ".gemini")]) {
    if (!existsSync(root)) continue; // that agent is not installed
    for (const [name, text] of [
      ["agent-flow", skillText(af)],
      ["deliver-document", deliverSkillText(af)],
    ] as const) {
      const dir = join(root, "skills", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), text);
      written.push(join(dir, "SKILL.md"));
    }
  }
  return written;
}
