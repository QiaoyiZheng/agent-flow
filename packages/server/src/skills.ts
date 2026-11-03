// The "agent-flow" skill for sessions the user starts themselves (claude, codex; omp reads claude's skill
// folder). It teaches them to hand work to other agents through agent-flow when the user asks for that:
// "让别的 session 同时做…", "开两个 codex 并行…". Written on server start with this server's af command.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function skillText(af: string) {
  return `---
name: agent-flow
description: Hand work to other agents (claude, codex, omp) that run at the same time in their own terminals, tracked as a graph the user watches in the agent-flow UI. Use when the user asks to have other sessions or agents do things in parallel or in a pipeline (e.g. "让别的 session 同时做…", "开两个 codex 并行改…", "让 omp 去查…，codex 去写…", "fan out", "dispatch to codex", "have another agent review it"), or to start an agent-flow workflow template. Not for work you can simply do yourself.
---

# agent-flow: run other agents from this session

The af command is \`${af}\` (use this full path; it may not be on PATH). Each call is one shell command.

## 1. Make this session the lead (once)

    ${af} here

This creates a run in this Herdr workspace with you as its lead. The agent-flow UI shows its graph next to
this workspace. Running it again is harmless.

## 2. Hand out work as graph nodes

    ${af} graph add <id> --kind codex|claude|omp --task "<task>" [--after a,b] [--on <outcome>] [--shared] [--auto-accept]

- Nodes without --after start at once, in parallel; each gets a fresh agent in its own tab.
- Write each task so a fresh agent can do it without this conversation: goal, files, constraints, how to
  verify, and which outcomes to submit (e.g. "submit outcome pass or fail"). Ask for long results as a file
  in $AF_OUT, passed with --result.
- --shared for read-only work (research, review); otherwise each node works on its own git branch, merged
  into the run's integration branch when you accept it (never into the user's checkout).
- Loops: \`${af} graph link review code --on fail --max 3\` sends work back while review says fail.
- Templates: \`${af} workflow list\`, then \`${af} graph apply <workflow> --goal "<goal>"\` adds a whole flow.

Then tell the user what is running and end your turn. Do not wait or poll.

## 3. When a worker submits

A line like \`[agent-flow] New message m3 from agent-flow (node code#1). Run: ${af} inbox\` is typed into this
session. Then:

    ${af} inbox                                 # what was submitted
    ${af} diff <node>                           # what an isolated node changed
    ${af} graph accept <node>                   # take it; dependent nodes start
    ${af} graph reject <node> --reason "..."    # the same agent fixes it

When nothing more can run you get a "quiescent" message: report the result to the user. Work from isolated
nodes is on the branch \`${af} graph show\` prints; merge it into the user's branch only if they ask.

## Other commands

    ${af} graph show        ${af} read <agent>        ${af} send <agent> "<text>"
    ${af} graph edit|rm|cancel|retry <node>           ${af} run stop
    ${af} guide lead        # the full guide
`;
}

/** Install the skill where claude and codex look for user skills. Returns the files written. */
export function installSkill(af: string, home = process.env.HOME ?? homedir()) {
  const written: string[] = [];
  for (const root of [join(home, ".claude"), join(home, ".codex")]) {
    if (!existsSync(root)) continue; // that agent is not installed
    const dir = join(root, "skills", "agent-flow");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), skillText(af));
    written.push(join(dir, "SKILL.md"));
  }
  return written;
}
