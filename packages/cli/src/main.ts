#!/usr/bin/env bun
// af: the agent-flow CLI. Used by the human and by agents. Team members and routers get AF_TEAM, AF_AGENT and AF_SOCK
// from the environment agent-flow starts them in; any other session is known by its Herdr pane (HERDR_PANE_ID).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { HerdrModel, QueueItem, TeamSummary, Ticket } from "@af/core";

const HOME = process.env.AF_HOME ?? join(homedir(), ".agent-flow");
const SOCK = process.env.AF_SOCK ?? join(HOME, "server.sock");
const AGENT = process.env.AF_AGENT || undefined;

const BOOL = new Set(["json", "all", "help", "down", "right", "tab", "worktree", "no-worktree", "done", "failed", "dropped", "cancelled", "delegate"]);
/**
 * Set when this af runs on the Mac for a session on another machine (its af script sends the command here): paths are
 * on that machine, relative to its folder AF_CWD, and files it names are read there.
 */
const REMOTE = process.env.AF_REMOTE || undefined;
const PANE = process.env.HERDR_PANE_ID || undefined;

function parse(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (v !== undefined) flags[k] = v;
      else if (BOOL.has(k)) flags[k] = true;
      else {
        const next = argv[i + 1];
        if (next === undefined) die(`--${k} needs a value`);
        flags[k] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { flags, pos };
}

function die(msg: string, code = 1): never {
  console.error(`af: ${msg}`);
  process.exit(code);
}

async function call<T = any>(method: "GET" | "POST", path: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!existsSync(SOCK)) die(`agent-flow server is not running (no ${SOCK}). Start it with: af server`);
  const payload: Record<string, unknown> = { team: TEAM, agent: AGENT, ...(AGENT ? {} : { callerPane: PANE }), ...body };
  const url = method === "GET" ? `http://af${path}?${new URLSearchParams(Object.entries(payload).filter(([, v]) => v !== undefined) as [string, string][])}` : `http://af${path}`;
  let r: Response;
  try {
    r = await fetch(url, { method, unix: SOCK, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(payload) : undefined } as RequestInit);
  } catch (e) {
    die(`cannot reach the agent-flow server at ${SOCK}: ${(e as Error).message}`);
  }
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) die(data?.error?.message ?? `HTTP ${r.status}`);
  return data as T;
}

const TEAM: string | undefined = process.env.AF_TEAM || undefined;

const out = (flags: Record<string, unknown>, data: unknown, text: () => string) => console.log(flags.json ? JSON.stringify(data, null, 2) : text());
const str = (v: string | true | undefined) => (typeof v === "string" ? v : undefined);
async function readTask(flags: Record<string, string | true>, pos: string[]) {
  if (typeof flags["task-file"] !== "string") return typeof flags.task === "string" ? flags.task : pos.join(" ");
  const file = absolute(flags["task-file"]);
  if (REMOTE) return (await call<{ text: string }>("POST", "/remote/read", { path: file })).text;
  return readFileSync(file, "utf8");
}

/** --worktree / --no-worktree: a new member in a git repository needs one of them (undefined: not given). */
const worktreeFlag = (flags: Record<string, string | true>) => (flags.worktree ? true : flags["no-worktree"] ? false : undefined);

/** --cwd for another machine stays as written ("~/x" is its home); here it is made absolute. */
const cwdFlag = (flags: Record<string, string | true>) => (typeof flags.cwd !== "string" ? undefined : typeof flags.on === "string" && flags.on !== "local" ? flags.cwd : flags.cwd.startsWith("~") ? flags.cwd : absolute(flags.cwd));

function showTickets(list: (Ticket & { stage: string })[]) {
  if (!list.length) return "(no tickets yet)";
  return list
    .map((k) => `${k.id.padEnd(4)} ${k.assignee.padEnd(12)} ${k.stage.padEnd(12)} ${k.round > 1 ? `r${k.round} of ${k.thread} ` : ""}${k.title}${k.branch ? `  [${k.branch}]` : ""}`)
    .join("\n");
}

function formatLs(r: { model: HerdrModel; views: Record<string, { target: string }>; teams: Record<string, string>; shellWorkspace?: string }) {
  const lines: string[] = [];
  const { model, views, teams } = r;
  for (const m of model.machines) {
    lines.push(m.local ? m.label : `${m.label} [${m.id}] ${m.state}${m.error ? `: ${m.error}` : ""}${m.state === "offline" ? `  (af connect ${m.id})` : ""}`);
    for (const w of model.workspaces.filter((x) => x.machine === m.id)) {
      if (w.id === r.shellWorkspace) continue;
      lines.push(`  ${w.id}  ${w.label}${teams[w.id] ? `  [team ${teams[w.id]}]` : ""}`);
      for (const t of model.tabs.filter((t) => t.workspaceId === w.id)) {
        lines.push(`    tab ${t.id}  ${t.label}`);
        for (const p of model.panes.filter((p) => p.tabId === t.id)) {
          const what = views[p.id] ? `view ${views[p.id]!.target}` : p.agent ? `${p.agent}${p.agentName ? ` (${p.agentName})` : ""} ${p.agentStatus}` : "shell";
          lines.push(`      ${p.id.padEnd(8)} ${what}${p.label && !views[p.id] ? `  "${p.label}"` : ""}  ${p.cwd}${p.id === PANE ? "   <- you" : ""}`);
        }
      }
    }
  }
  return lines.join("\n");
}

const HELP = `af — agent-flow CLI

Server:
  af server [--port N]                      start the agent-flow server
  af guide router|member                    the instructions routers and members are started with

Mode 1 — hand out tasks from this session (it gets each session's final reply in its queue):
  af task <claude|codex|omp|gemini> "<task>" --worktree|--no-worktree [--name N] [--title T]   a new session in a new tab
                                            (--worktree|--no-worktree: required in a git repository; see below)
         [--on <machine> [--cwd DIR]]       start it on a connected SSH machine (af ls lists them)
         [--prepare "<command>"]            run a command once in its folder first (installs, links); off by default
  af task --to <name> "<task>"              more work for a session you started (same context)
  af queue [--all]                          what waits in your queue    af queue take   take all of it
  af tell <ticket|name> "<text>"            add to a ticket (typed in when the session is free)
  af answer <ticket|name> <n> [--text T]    answer the question on its screen (permission and trust prompts and
                                            notices only after af delegate on)
  af delegate on|off                        let this session answer its sessions' trust prompts, permission prompts
                                            and notices for the user (only when the user said you may); or stop
  af status <name>                          its status, last reply and screen
  af context                                the project context the sessions you start read (in their agent.md): its
                                            file, to edit; each change goes to them
  af context set "<text>" | --file F        replace it
  af handoff                                hand off to a fresh session in this pane: where to write the handoff
  af handoff ready <file>                   document; once it is written (agent-flow then restarts this session,
                                            closes the sessions you started that have finished, keeps the rest)
  af report "<text>"                        (in a session started with af task) tell the session that gave you the
                                            task what your conversation with the user changed; answers are not passed on
  af tickets [--json]    af ticket show <T>

Mode 2 — agent teams with a router:
  af playbook list
  af team new --goal "..." [--playbook P] [--router claude|codex|omp|gemini] [--name N] [--cwd DIR] [--on <machine>]
  af team list | stop [<team>]
  router:  af ticket open <member> --title T (--task "..." | --task-file F) [--kind K] [--from T] [--max N]
                                   [--worktree|--no-worktree] [--on <machine>] [--cwd DIR] [--prepare "<command>"]
                                   [--note "..."] [--role "..."]
           af ticket close <T> [--failed|--dropped|--cancelled] [--note "..."]    af thread max <T> <N>
           af queue take    af queue done <seq>...|--all    af reply <seq> "<answer>"
           af tell / af answer / af status (as above)    af report "<text>" [--done]
  member:  af submit --status ready|blocked|failed|dropped --note "..." [--to <member>]
           af progress "<text>"    af ask "<question>"
  af whoami    af machines                   (the machines --on can name: this Mac and connected SSH machines)

Panes (everyone; Herdr owns the layout, the web UI shows it):
  af ls [--json]                                 machines, workspaces, tabs, panes (agents, viewers, shells)
  af read <agent|pane> [--lines N]               recent output of another agent or pane
  af open <path|url> [--down] [--of PANE]        show a file, folder or page in a new pane next to yours (or PANE)
  af open <path|url> --in <viewer pane>          show it in an existing viewer pane instead
  af open <path|url> --tab [WORKSPACE]           show it in a new tab
  af open <path> --app vscode|obsidian|default|finder   open it in that app on the user's Mac
  af deliver <file>... [--title T] [--note N]    hand a finished document to the user (open buttons under your reply)
  af split [PANE] [--down] [--agent K]           split a pane (default yours): a shell, or an agent
  af close <pane>
  af workspace rename <workspace> "<name>"
  af connect <machine>                           connect a saved SSH machine (Herdr's own list); its ids look like ds03~w3:p4
                                                 it stays connected (and reconnects after restarts) until:
  af disconnect <machine>`;

// ---------------------------------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, pos } = parse(rest);
  if (!cmd || cmd === "help" || cmd === "--help" || flags.help) return console.log(HELP);

  switch (cmd) {
    case "server": {
      const { main: serverMain } = await import("../../server/src/main.ts");
      return serverMain(rest);
    }
    case "whoami": {
      const w = await call("GET", "/whoami");
      return out(flags, w, () => (w.kind === "member" || w.kind === "router" ? `${w.member} (${w.kind}) in team ${w.team}` : w.kind === "pane" ? `the session in pane ${w.pane}` : "the user"));
    }
    case "guide": {
      const which = pos[0] === "member" ? "member" : "router";
      return process.stdout.write(readFileSync(join(import.meta.dir, `../../skill/${which}.md`), "utf8"));
    }
    case "task": {
      const kind = flags.to ? undefined : pos[0];
      const text = await readTask(flags, flags.to ? pos : pos.slice(1));
      if ((!flags.to && !kind) || !text.trim()) die('usage: af task <claude|codex|omp|gemini> "<task>" --worktree|--no-worktree [--name N] [--on M --cwd D] [--prepare "..."]   or   af task --to <name> "<task>"');
      const r = await call("POST", "/task", {
        kind,
        task: text,
        name: str(flags.name),
        to: str(flags.to),
        title: str(flags.title),
        worktree: worktreeFlag(flags),
        machine: str(flags.on),
        cwd: cwdFlag(flags),
        prepare: str(flags.prepare),
        ...(flags.delegate ? { delegate: true } : {}),
      });
      const where = r.machine && r.machine !== "local" ? ` on ${r.machine} in ${r.cwd}` : "";
      return out(flags, r, () =>
        `${r.ticket} for ${r.member}${r.started ? ` (starting in a new tab${where})` : ""}${r.branch ? ` on branch ${r.branch}` : ""}. Its final reply comes to your queue; end your turn now.`,
      );
    }
    case "team": {
      const sub = pos[0] ?? "list";
      if (sub === "list") {
        const teams = await call<TeamSummary[]>("GET", "/teams");
        return out(flags, teams, () =>
          teams.map((x) => `${x.id}  ${x.mode.padEnd(6)} ${x.stopped ? "stopped " : "active  "} ${String(x.tickets).padStart(3)} tickets  ${x.name}${x.goal ? ` — ${x.goal.slice(0, 60)}` : ""}`).join("\n") || "(no teams)",
        );
      }
      if (sub === "new") {
        const goal = str(flags.goal) ?? pos.slice(1).join(" ");
        if (!goal.trim()) die('usage: af team new --goal "..." [--playbook P] [--router K] [--name N] [--cwd DIR]');
        const r = await call("POST", "/team/new", { goal, playbook: str(flags.playbook), router: str(flags.router), name: str(flags.name), cwd: cwdFlag(flags), machine: str(flags.on), ...(flags.delegate ? { delegate: true } : {}) });
        return out(flags, r, () =>
          `team ${r.team} (${r.name}) is starting in its own workspace${r.machine && r.machine !== "local" ? ` on ${r.machine}` : ""}${r.playbook ? ` with playbook ${r.playbook}` : ""}${r.parent ? `; it is ${r.parent.ticket} in your tickets, and its reports come to your queue` : ""}.`,
        );
      }
      if (sub === "stop") {
        const r = await call("POST", "/team/stop", { id: pos[1] });
        return console.log(`team ${r.team} stopped`);
      }
      return die(`unknown: af team ${sub}`);
    }
    case "playbook": {
      const list = await call("GET", "/playbooks", { cwd: process.cwd() });
      return out(flags, list, () =>
        (list as any[]).map((p) => `${p.id.padEnd(22)} ${p.source.padEnd(9)} ${p.error ? `ERROR ${p.error}` : `${p.name} — ${p.description}`}`).join("\n") + '\n\nStart one: af team new --playbook <id> --goal "..."',
      );
    }
    case "queue": {
      const sub = pos[0];
      if (sub === "take") {
        const r = await call("POST", "/team/take");
        return out(flags, r, () => r.text);
      }
      if (sub === "done") {
        if (!flags.all && pos.length < 2) die("usage: af queue done <seq>... | --all");
        const r = await call("POST", "/team/handled", { all: !!flags.all, seqs: pos.slice(1).map((x) => Number(x.replace(/^#/, ""))) });
        return console.log(`marked ${r.handled.map((s: number) => `#${s}`).join(", ") || "nothing"} as dealt with`);
      }
      const r = await call<{ items: QueueItem[] }>("GET", "/team/queue", { all: flags.all ? "1" : undefined });
      return out(flags, r, () => r.items.map((q) => `#${q.seq} ${q.state.padEnd(7)} ${q.kind.padEnd(7)} ${q.ticket ?? ""} ${q.from ?? ""}: ${q.text.split("\n")[0]}`).join("\n") || "(your queue is empty)");
    }
    case "tickets": {
      const list = await call("GET", "/team/tickets");
      return out(flags, list, () => showTickets(list));
    }
    case "ticket": {
      const sub = pos[0];
      if (sub === "open") {
        const member = pos[1];
        const task = await readTask(flags, []);
        if (!member || !task.trim() || typeof flags.title !== "string")
          die('usage: af ticket open <member> --title "..." (--task "..." | --task-file F) [--kind K] [--from T] [--max N] [--note "..."] [--worktree|--no-worktree] [--on M --cwd D] [--prepare "..."]');
        const r = await call("POST", "/team/ticket", {
          member,
          title: flags.title,
          task,
          kind: str(flags.kind),
          role: str(flags.role),
          from: str(flags.from),
          max: typeof flags.max === "string" ? Number(flags.max) : undefined,
          note: str(flags.note),
          inputs: typeof flags.input === "string" ? flags.input.split(",").map((x) => absolute(x.trim())) : undefined,
          worktree: worktreeFlag(flags),
          machine: str(flags.on),
          cwd: cwdFlag(flags),
          prepare: str(flags.prepare),
        });
        return out(flags, r, () => `${r.ticket} for ${r.member}${r.round > 1 ? ` (round ${r.round} of thread ${r.thread})` : ""}${r.started ? "; starting it in a new tab" : ""}. Folder: ${r.dir}`);
      }
      if (sub === "close") {
        if (!pos[1]) die("usage: af ticket close <T> [--failed|--dropped|--cancelled] [--note ...]");
        const outcome = flags.failed ? "failed" : flags.dropped ? "dropped" : flags.cancelled ? "cancelled" : "done";
        const r = await call("POST", "/team/close", { ticket: pos[1], outcome, note: str(flags.note) });
        return console.log(`${r.id} closed (${r.outcome})`);
      }
      if (sub === "show") {
        if (!pos[1]) die("usage: af ticket show <T|member>");
        const r = await call("GET", "/team/ticket", { ticket: pos[1] });
        return out(flags, r, () =>
          [
            `${r.ticket.id} for ${r.ticket.assignee}: ${r.ticket.title}  [${r.ticket.status}${r.ticket.outcome ? ` ${r.ticket.outcome}` : ""}]${r.ticket.round > 1 ? `  round ${r.ticket.round} of ${r.ticket.thread}` : ""}`,
            `folder: ${r.dir}`,
            ...(r.related.length ? [`related: ${r.related.join("; ")}`] : []),
            "--- task.md", (r.task ?? "").trimEnd(),
            "--- result.md", (r.result ?? "(not written yet)").trimEnd(),
          ].join("\n"),
        );
      }
      return die("usage: af ticket open|close|show ...");
    }
    case "thread": {
      if (pos[0] !== "max" || !pos[1] || !pos[2]) die("usage: af thread max <ticket> <N>");
      const r = await call("POST", "/team/max", { thread: pos[1], max: Number(pos[2]) });
      return console.log(`thread ${r.thread}: at most ${r.max} rounds per member`);
    }
    case "tell": {
      if (pos.length < 2) die('usage: af tell <ticket|name> "<text>"');
      const r = await call("POST", "/team/tell", { ref: pos[0], text: pos.slice(1).join(" ") });
      return console.log(r.opened ? `${r.ticket} opened for ${r.to}` : `${r.to} gets it for ${r.ticket} when it is free`);
    }
    case "delegate": {
      const on = pos[0] ?? "on";
      if (on !== "on" && on !== "off") die("usage: af delegate on|off");
      const r = await call("POST", "/team/delegate", { on: on === "on" });
      return console.log(
        r.delegate
          ? `on: the trust prompts, permission prompts and notices of the sessions you hand work to come to your queue (team ${r.team}); answer them with af answer <ticket> <n>`
          : `off: those prompts are the user's again (team ${r.team})`,
      );
    }
    case "answer": {
      if (pos.length < 2) die('usage: af answer <ticket|name> <option number> [--text "..."]');
      const r = await call("POST", "/team/answer", { ref: pos[0], option: Number(pos[1]), text: str(flags.text) });
      return console.log(`answered ${r.member}: ${r.option}`);
    }
    case "reply": {
      if (pos.length < 2) die('usage: af reply <seq> "<answer>"');
      const r = await call("POST", "/team/reply", { seq: Number(pos[0]!.replace(/^#/, "")), text: pos.slice(1).join(" ") });
      return console.log(`${r.to} gets the answer when it is free`);
    }
    case "status": {
      if (!pos[0]) die("usage: af status <name|ticket>");
      const r = await call("GET", "/team/status", { ref: pos[0] });
      return out(flags, r, () =>
        [
          `${r.member} (${r.kind}): ${r.status}${r.asking ? `, asking: ${r.asking}` : ""}${r.ticket ? `; ${r.ticket.id} ${r.ticket.stage}` : ""}`,
          ...(r.lastReply ? ["--- last reply", r.lastReply] : []),
          "--- screen", r.screen,
        ].join("\n"),
      );
    }
    case "handoff": {
      if (pos[0] === "ready") {
        const doc = pos[1] ? absolute(pos[1]) : undefined;
        if (!doc) die("usage: af handoff ready <the handoff document>");
        const r = await call("POST", "/handoff/ready", { path: doc });
        return console.log(
          `Handed off: ${r.doc}. End your turn now, with one line to the user that you handed off and where the document is. ` +
            "When your turn ends, agent-flow closes the sessions you started that have finished, closes this session, and starts a new one in this pane that reads the document. Do nothing else.",
        );
      }
      const r = await call("POST", "/handoff/start", {});
      return console.log(`Write the handoff document (the handoff skill says what goes in it) to:\n  ${r.doc}\nThen run: ${r.af} handoff ready ${r.doc}`);
    }
    case "context": {
      if (pos[0] === "set") {
        const file = str(flags.file);
        const text = file ? (REMOTE ? (await call<{ text: string }>("POST", "/remote/read", { path: absolute(file) })).text : readFileSync(absolute(file), "utf8")) : pos.slice(1).join(" ");
        if (!file && !pos[1]) die('usage: af context set "<text>" | af context set --file F');
        const r = await call("POST", "/team/context", { text });
        return console.log(r.changed ? `project context set; told: ${r.told.join(", ") || "(no session has read it yet)"}` : "project context unchanged");
      }
      const r = await call("GET", "/team/context", {});
      return out(flags, r, () =>
        [
          REMOTE
            ? "The project context your sessions read. To change it, write the new text to a file here and run: af context set --file <file>"
            : `The project context your sessions read. Edit this file to change it (agent-flow sends each change to them):\n  ${r.path}`,
          `Sessions that have read it: ${r.sessions.join(", ") || "(none yet)"}`,
          "--- now:",
          r.text.trim() || "(empty)",
        ].join("\n"),
      );
    }
    case "report": {
      if (!pos.length) die('usage: af report "<text>" [--done]');
      const r = await call("POST", "/team/report", { text: pos.join(" "), done: !!flags.done });
      return console.log(`reported to ${r.to}`);
    }
    case "submit": {
      const status = str(flags.status) ?? "ready";
      const r = await call("POST", "/team/submit", { status, note: str(flags.note), to: str(flags.to), ticket: str(flags.ticket) });
      return console.log(`${r.ticket} submitted (${r.status})${r.result ? "" : ". Note: you did not write result.md"}. Now stop and wait.`);
    }
    case "progress": {
      if (!pos.length) die('usage: af progress "<text>"');
      const r = await call("POST", "/team/progress", { text: pos.join(" ") });
      return console.log(`noted on ${r.ticket}`);
    }
    case "ask": {
      if (!pos.length) die('usage: af ask "<question>"');
      const r = await call("POST", "/team/ask", { text: pos.join(" ") });
      return console.log(`asked (#${r.seq}); end your turn, the answer is typed in when it comes`);
    }
    case "deliver": {
      // hand a finished document to the user: open buttons under this agent's reply in the chat view
      if (!pos.length) die('usage: af deliver <file>... [--title "<what it is>"] [--note "<one line>"]');
      for (const f of pos) {
        const r = await call("POST", "/deliver", {
          path: absolute(f),
          title: typeof flags.title === "string" ? flags.title : undefined,
          note: typeof flags.note === "string" ? flags.note : undefined,
          pane: PANE,
        });
        const d = r.delivery;
        const app = { vscode: "VS Code", obsidian: "Obsidian", default: "its default app", finder: "Finder" }[r.app as string] ?? r.app;
        console.log(
          `handed over ${d.path}; ${d.opened ? `opened in ${app}` : `the user can open it in ${app} from the buttons under your reply in agent-flow`}`,
        );
      }
      return;
    }
    case "open": {
      if (!pos[0]) die("usage: af open <url|path> [--in <viewer pane>] [--of <pane>] [--down] [--tab] [--app vscode|obsidian|default|finder]");
      if (typeof flags.app === "string") {
        const r = await call("POST", "/open-with", { path: absolute(pos[0]), app: flags.app, pane: PANE });
        return console.log(`opened ${r.path} in ${r.app}`);
      }
      const target = /^[a-z][a-z0-9+.-]*:\/\//i.test(pos[0]) ? pos[0] : absolute(pos[0]);
      const ls = flags.tab ? await call("GET", "/ls") : undefined;
      const tabIn = flags.tab ? (typeof flags.tab === "string" ? flags.tab : ls.model.panes.find((p: any) => p.id === (flags.of ?? PANE))?.workspaceId) : undefined;
      if (flags.tab && !tabIn) die("--tab needs a workspace id outside Herdr: --tab <workspace>");
      const v = await call("POST", "/show", {
        target,
        in: typeof flags.in === "string" ? flags.in : undefined,
        of: typeof flags.of === "string" ? flags.of : undefined,
        split: flags.down ? "down" : "right",
        tabIn,
        pane: PANE,
      });
      return console.log(`showing ${v.target} in pane ${v.paneId}`);
    }
    case "hook": {
      // called by claude's SessionStart hook; must never fail or block the agent
      if (pos[0] !== "claude-session") return;
      try {
        const input = await Promise.race([Bun.stdin.text(), Bun.sleep(3000).then(() => "")]);
        const d = JSON.parse(input || "{}");
        if (PANE && d.session_id && existsSync(SOCK))
          await fetch("http://af/session", { method: "POST", unix: SOCK, headers: { "content-type": "application/json" }, body: JSON.stringify({ pane: PANE, id: d.session_id, path: d.transcript_path, source: d.source }) } as RequestInit);
      } catch {}
      return;
    }
    case "viewer":
      return (await import("./viewer.ts")).runViewer(SOCK, PANE);
    case "machines": {
      // the machines members can run on (--on): this Mac and the connected SSH machines
      const r = await call("GET", "/machines");
      return out(flags, r, () => (r as { id: string; label: string; state: string; error?: string }[]).map((m) => `${m.id.padEnd(22)} ${m.state}${m.error ? `: ${m.error}` : ""}${m.label !== m.id ? `  (${m.label})` : ""}`).join("\n"));
    }
    case "ls": {
      const r = await call("GET", "/ls");
      return out(flags, r, () => formatLs(r));
    }
    case "read": {
      if (!pos[0]) die("usage: af read <agent|pane> [--lines N]");
      const r = await call("POST", "/pane/read", { ref: pos[0], lines: typeof flags.lines === "string" ? Number(flags.lines) : 120 });
      return console.log(r.text.trimEnd());
    }
    case "split": {
      const pane = pos[0] ?? PANE;
      if (!pane) die("usage: af split [<pane>] [--down] [--agent claude|codex|omp|gemini]");
      const r = await call("POST", "/pane/split", { pane, direction: flags.down ? "down" : "right", kind: typeof flags.agent === "string" ? "agent" : "shell", agentKind: flags.agent });
      return console.log(`new pane ${r.paneId}${r.agent ? ` running ${r.agent}` : ""}`);
    }
    case "connect": {
      if (!pos[0]) die("usage: af connect <machine>   (machines: af ls)");
      const m = await call("POST", "/machine/connect", { machine: pos[0] });
      return console.log(`${m.label}: ${m.state}${m.error ? ` (${m.error})` : ""}`);
    }
    case "workspace": {
      if (pos[0] !== "rename" || !pos[1] || !pos[2]) die('usage: af workspace rename <workspace> "<name>"   (ids: af ls)');
      const r = await call("POST", "/workspace/rename", { workspace: pos[1], label: pos.slice(2).join(" ") });
      return console.log(`${r.workspace} is now "${r.label}"`);
    }
    case "disconnect": {
      if (!pos[0]) die("usage: af disconnect <machine>");
      const m = await call("POST", "/machine/disconnect", { machine: pos[0] });
      return console.log(`${m.label}: ${m.state}`);
    }
    case "close": {
      if (!pos[0]) die("usage: af close <pane>");
      await call("POST", "/pane/close", { pane: pos[0] });
      return console.log(`closed ${pos[0]}`);
    }
    default:
      die(`unknown command ${cmd}. Run af help.`);
  }
}

const absolute = (p: string) => (isAbsolute(p) ? p : resolve(process.env.AF_CWD || process.cwd(), p));

await main();
