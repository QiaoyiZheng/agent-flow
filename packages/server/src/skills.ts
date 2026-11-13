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

    ${af} task claude|codex|omp|gemini "<task>" --worktree|--no-worktree [--name <name>]
    ${af} task --to <name> "<more work for the same session>"

- Each call opens a ticket and starts a new session in a new tab of this workspace (or, with --to, gives it to a
  session you started before, which keeps its context). The task text is its first message.
- Write the task so a fresh agent can do it without this conversation: the goal in the user's words, the files,
  how to check the result. Independent tasks run at the same time; for a step that needs an earlier result, wait
  for that result and then hand out the next task.
- In a git repository, every new session needs one of these (af refuses without it), so decide each time:
  --worktree: its own git worktree and branch (af/<team>/<name>), when it changes files while other sessions change
  the same repository. Nothing is merged for you; tell the user which branch has the work.
  --no-worktree: it works in the folder itself (read-only work, or it is the only one editing).
  If you cannot tell whether sessions will edit the same files, ask the user.
- --on <machine> [--cwd '<folder there>']: start it on a connected SSH machine (\`${af} machines\` lists them; quote a
  ~ path so it means that machine's home). Use it for work that belongs there: GPUs, data, a remote checkout.
- --prepare "<command>": run a command once in its folder before it starts (an install, a link to data). Off unless
  given; only when the session cannot do its task without it.

Then tell the user what is running and end your turn. Do not wait or poll.

When a session finishes its turn, a line like this is typed here:

    [agent-flow] 1 new in your queue: T1 plan finished. Run: ${af} queue take

Run \`${af} queue take\`: you get each session's final reply (the full text is in the file it names). Then hand out
the next task, tell a session more (\`${af} tell T1 "<text>"\`), or report to the user. The queue also tells you when
a session asks a question on its screen (answer it with \`${af} answer T2 <option number>\` if it is about the task;
permission prompts are the user's: when a session waits for one, tell the user), may be stuck, or exited
(\`${af} status <name>\` shows what it is doing).

The user may talk with a session directly after you took its result. Its answers to them do not come to you; the
session tells you itself when that changes something for the work (progress, or a change to what was agreed): it
shows in your queue as "reported". Take that into account; you need not repeat it to the user, who was there.

Each session you start reads an agent.md first: agent-flow's rules for it, then the project context, which you keep.
When the user gives new context or requirements that all your sessions should follow (scope, framing, decisions,
constraints, numbers, where things are), put them there instead of repeating them in every task: \`${af} context\` shows
the file to edit; each change goes to the sessions already working (or \`${af} context set --file <file>\`). Keep it to
what every session needs, current and short; the details of one task go in that task.

If the user says you may answer those prompts for them (folder trust, permission prompts, "Enter to continue"
notices of the sessions you start), run \`${af} delegate on\` (or add --delegate to af task / af team new). Never
turn it on by yourself. Then such a prompt reaches your queue as "has a prompt for you to answer", with its options:
answer it as the user would (\`${af} answer T2 <option number>\`). Allow what the task needs; leave anything
destructive or outside the task to the user (\`${af} queue done <seq>\`: it stays in their Needs you).
\`${af} delegate off\` gives them back to the user.

## Mode 2: an agent team with a router (loops, longer work)

    ${af} playbook list
    ${af} team new --goal "<the goal in the user's words>" [--playbook humanize-loop|super-agent|bugfix|...] [--router claude] [--on <machine> --cwd '<folder>']

A router agent starts in its own workspace and runs the team: it opens tickets for members, passes results between
them, and counts the rounds of a loop. You only hear its reports (in your queue, as above). More for the team:
\`${af} tell <its ticket> "<text>"\`. Use this when the user wants members to work with each other (write and review
until it passes) or a team that keeps taking requests.

## Other commands

    ${af} tickets           ${af} ticket show <T>         ${af} read <name>        ${af} team stop <team>
    ${af} open <path|url>   show a file, folder or web page in a pane next to yours (when the user asks to see it)
`;
}

/**
 * The "deliver-document" skill: when the user asks to see a file, folder or page, the agent shows it with af open (a
 * viewer pane next to its own). When an agent has finished a document for the user (a report, a write-up, slides), it
 * hands it over with af deliver. The user gets buttons under the agent's reply to open it in Obsidian / VS Code / its
 * app with one click (or it opens by itself, per the user's settings). The description names the user's requests
 * ("打开预览") because agents pick a skill by its description: without them they built their own previews.
 */
export function deliverSkillText(af: string) {
  return `---
name: deliver-document
description: Show the user a document, file, folder or web page in agent-flow. Use when the user asks to open, show or preview one (e.g. "打开预览", "预览一下", "在右边/右侧 pane 打开", "给我看看那个文件", "用 Obsidian/VS Code 打开", "open it next to me", "show me the PDF"), and right after you finish writing (or substantially rewriting) a file meant for the user to read — a report, analysis, write-up, summary, plan, paper or paper section, notes they asked for, slides (.pptx), a Word/Excel/PDF file, an HTML page, a figure. Not for code, tests, configs, or your own scratch, memory or log files, and not for every small edit.
---

# When the user asks to see something: af open

When the user asks to open, show or preview a file, folder or web page, run (one shell command; use the full path):

    ${af} open <path|url>

- It opens a viewer pane to the right of yours in agent-flow. It shows Markdown (formatted), images, PDFs, Office
  files, other text and code, folders, and web pages, and reloads when the file changes.
- \`--down\` puts it below yours, \`--tab\` in a new tab, \`--in <viewer pane>\` replaces what an open viewer shows.
- When the user names an app ("用 Obsidian 打开", "open it in VS Code"):
  \`${af} open <path> --app obsidian|vscode|default|finder\`.
- af open is the preview. Do not make one yourself: no pane split with less/glow/bat/cat, no \`open\`, no browser.
- If it fails, tell the user the error and stop. Do not fall back to another way of opening the file.

# When you finish a document: af deliver

When a document for the user is done, run (one shell command; use the full path):

    ${af} deliver <file> --title "<what it is, a few words>"

- Several documents: \`${af} deliver a.md b.pptx --title "..."\`.
- \`--note "<one line>"\` for something the user should know before opening it (e.g. "figures are placeholders").
- It puts buttons under your reply in the agent-flow UI to open it in Obsidian (Markdown), VS Code (text, code,
  LaTeX) or its own app (PowerPoint, Word, PDF…), or to preview it next to you. Nothing opens by itself unless the user
  chose that. Do not open it as well, unless the user asks to see it now: then use af open (above).
- Hand over a document once when it is ready, and again only after a revision the user should look at.
- Then, in your reply, say what the document is and where it is (its path).

This applies however you wrote the file: with your edit tools, a script, a shell command, or a tool that generates
it (python-pptx, pandoc, LaTeX). Hand it over before your final reply, at the end of the turn that produced it.

If the command fails (agent-flow is not running, or this session is not in it), just give the file's path in your
reply. Do not retry, and do not open the file with other commands.
`;
}

/**
 * The "handoff" skill: a session hands off to a fresh one in its pane when its context is nearly full (agent-flow asks
 * it, handoff.ts) or when the user asks. It writes the document; agent-flow closes it and starts the new session.
 */
export function handoffSkillText(af: string) {
  return `---
name: handoff
description: Hand this session off to a fresh one that continues the work, by writing a handoff document; agent-flow then closes this session and starts the new one in its pane. Use when agent-flow says your context is nearly full ("[agent-flow] Your context is …% full … handoff") or that the user pressed Refresh ("[agent-flow] The user pressed Refresh"), or when the user asks to hand off or to go on in a new session ("交接一下", "写个 handoff", "开个新 session 接着做", "上下文快满了", "hand off", "start fresh").
---

# Hand off to a fresh session

1. The document's path: the one in agent-flow's message, if it gave one; else run \`${af} handoff\` (it prints one).
2. Write the handoff document there. Its reader is a new session of you that has not seen this conversation and must
   go on from where you stop. Facts, not a story; paths, ticket numbers and commands, not pasted contents. Put in:
   - The goal, and the user's current request, in the user's words where the wording matters.
   - What the user decided or asked for along the way, and what they said not to do (corrections, preferences,
     framing). This is what a new session gets wrong most easily.
   - Where things stand: what is done (files, commits, branches, results with their paths); what is in progress and
     who does it; what waits on the user.
   - The sessions you started (\`${af} tickets\`). Those that have finished are closed when you hand off: put the
     paths of their results in the document if the work needs them. Those still working stay and report to the new
     session: say what each one does and what you wait for from it.
   - What to do next, in order.
   - What to read first (files, docs), and things learned the hard way: commands that work, machines and folders,
     traps. Say what is not checked yet.
   Keep it as short as it can be while complete; the next session can open the files you name.
3. Run \`${af} handoff ready <the document's path>\`. Then end your turn with one line to the user: that you handed off,
   and where the document is.

agent-flow then closes this session and starts a new one in this pane, which reads the document first. Do not close
yourself, close the sessions you started, start a session yourself, or go on working after \`${af} handoff ready\`.

If the command fails (agent-flow is not running, or this session is not in it), give the user the document's path and
say that a new session should read it.
`;
}

/**
 * Install the skills where claude, codex, gemini and omp look for user skills. Returns the files written. omp reads
 * ~/.claude/skills too: its own folder gets them only where there is no ~/.claude (else omp would list them twice).
 */
export function installSkill(af: string, home = process.env.HOME ?? homedir()) {
  const written: string[] = [];
  // [the agent's folder, its skills folder]; gemini reads ~/.gemini/skills/<name>/SKILL.md in the same format
  const roots: [string, string][] = [".claude", ".codex", ".gemini"].map((d) => [join(home, d), join(home, d, "skills")]);
  if (!existsSync(join(home, ".claude"))) roots.push([join(home, ".omp"), join(home, ".omp", "agent", "skills")]);
  for (const [agentDir, root] of roots) {
    if (!existsSync(agentDir)) continue; // that agent is not installed
    for (const [name, text] of [
      ["agent-flow", skillText(af)],
      ["deliver-document", deliverSkillText(af)],
      ["handoff", handoffSkillText(af)],
    ] as const) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), text);
      written.push(join(dir, "SKILL.md"));
    }
  }
  return written;
}
