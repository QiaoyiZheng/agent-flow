#!/usr/bin/env bun
// af: the agent-flow CLI. Used by the human and by agents. Agents get AF_RUN, AF_AGENT and AF_SOCK from
// the environment agent-flow starts them in; the human passes --run or relies on the only/latest run.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentKind, Command, GraphState, Mail, NodeSpec, RunState, RunSummary } from "@af/core";
import { activeInstance, instanceLabel, latestInstance, liveEdges, liveNodes } from "@af/core";

const HOME = process.env.AF_HOME ?? join(homedir(), ".agent-flow");
const SOCK = process.env.AF_SOCK ?? join(HOME, "server.sock");
const AGENT = process.env.AF_AGENT || undefined;

const BOOL = new Set(["shared", "isolated", "hold", "no-hold", "auto-accept", "no-auto-accept", "json", "all", "stat", "help"]);

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
  const payload = { run: RUN, agent: AGENT, ...body };
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

let RUN: string | undefined = process.env.AF_RUN || undefined;

async function resolveRun(flag: string | true | undefined) {
  if (typeof flag === "string") return (RUN = flag);
  if (RUN) return RUN;
  const runs = (await call<RunSummary[]>("GET", "/runs")).filter((r) => !r.stopped);
  if (!runs.length) die("no active run. Start one with: af up");
  if (runs.length > 1) console.error(`af: several runs are active; using the latest (${runs[0]!.id}). Pass --run to choose.`);
  return (RUN = runs[0]!.id);
}

const out = (flags: Record<string, unknown>, data: unknown, text: () => string) => console.log(flags.json ? JSON.stringify(data, null, 2) : text());

// ---------------------------------------------------------------------------------------------

function specFromFlags(flags: Record<string, string | true>, partial: boolean): Partial<NodeSpec> {
  const spec: Partial<NodeSpec> = {};
  if (typeof flags.task === "string") spec.task = flags.task;
  if (typeof flags["task-file"] === "string") spec.task = require("node:fs").readFileSync(flags["task-file"], "utf8");
  if (typeof flags.kind === "string") spec.executor = { kind: flags.kind as AgentKind };
  if (typeof flags.agent === "string") spec.executor = { agent: flags.agent };
  if (flags.shared) spec.isolation = "shared";
  if (flags.isolated) spec.isolation = "isolated";
  if (flags.hold) spec.hold = true;
  if (flags["no-hold"]) spec.hold = false;
  if (flags["auto-accept"]) spec.autoAccept = true;
  if (flags["no-auto-accept"]) spec.autoAccept = false;
  if (!partial && !spec.task) die('graph add needs --task "<task>" (or --task-file <path>)');
  return spec;
}

function showGraph(s: RunState) {
  const g: GraphState = s.graph;
  const m = s.meta!;
  const lines = [`run ${m.id}  lead=${m.lead}  ${s.stopped ? "stopped" : g.quiescent ? "quiescent" : "active"}${m.branch ? `  branch=${m.branch}` : ""}`];
  const nodes = liveNodes(g);
  if (!nodes.length) lines.push("(no nodes yet: af graph add <id> --kind codex --task \"...\")");
  for (const n of nodes) {
    const ex = "kind" in n.spec.executor ? n.spec.executor.kind : `@${n.spec.executor.agent}`;
    const flags = [n.spec.isolation === "shared" ? "shared" : "", n.spec.autoAccept ? "auto-accept" : "", n.spec.hold ? "hold" : ""].filter(Boolean).join(",");
    const i = latestInstance(n);
    const sub = i?.submissions.at(-1);
    const state = i ? `${instanceLabel(i)} ${i.state}${i.held ? " (held)" : ""}${i.agent ? ` by ${i.agent}` : ""}${sub?.outcome ? ` outcome=${sub.outcome}` : ""}` : "waiting";
    lines.push(`  ${n.id.padEnd(14)} ${ex.padEnd(8)} ${flags.padEnd(18)} ${state}`);
  }
  const edges = liveEdges(g);
  if (edges.length)
    lines.push(
      "edges: " +
        edges.map((e) => `${e.from}->${e.to}${e.on ? ` [on ${e.on}]` : ""}${e.back ? ` (loop ${e.fired}/${e.max}${e.blocked ? ", LIMIT" : ""})` : ""}${e.queue.length ? ` queued=${e.queue.length}` : ""}`).join("  "),
    );
  const att = Object.values(s.attention);
  if (att.length) lines.push("needs attention:", ...att.map((a) => `  ! ${a.text}`));
  return lines.join("\n");
}

const fmtMail = (m: Mail) => `--- ${m.id} from ${m.from}${m.node ? ` | ${m.node}` : ""}${m.replyTo ? ` | reply to ${m.replyTo}` : ""} | ${m.kind} ---\n${m.body}${m.attachments?.length ? `\nattachments: ${m.attachments.join(", ")}` : ""}`;

const HELP = `af — agent-flow CLI

Run and server:
  af server [--port N]                      start the agent-flow server
  af up [team] [--kind claude|codex|omp] [--prompt "..."] [--cwd DIR]
  af run list | show | stop                 (--run ID to pick a run)
  af spawn <name> --kind K [--role "..."]

Graph (lead):
  af graph add <id> (--kind K | --agent NAME) --task "..." [--after a,b] [--on OUTCOME] [--shared] [--hold] [--auto-accept]
  af graph edit <id> [--task ...] [--kind K | --agent N] [--shared|--isolated] [--hold|--no-hold] [--auto-accept|--no-auto-accept]
  af graph link <from> <to> [--on OUTCOME] [--max N]     af graph unlink <from> <to>     af graph max <from> <to> <N>
  af graph rm <id>   af graph start <id>   af graph cancel <id>   af graph retry <id>
  af graph accept <id>   af graph reject <id> --reason "..."
  af graph show [--json]          af diff <node> [--stat]

Messages (everyone):
  af inbox [--all] [--json]   af send <agent|user> <text...> [--attach PATH]   af reply <msg-id> <text...>
  af done [--outcome X] [--note "..."] [--result PATH]     af open <url|path>     af whoami`;

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
    case "whoami":
      return console.log(AGENT ? `${AGENT} in run ${RUN}` : `the user${RUN ? ` (run ${RUN})` : ""}`);
    case "up": {
      const meta = await call("POST", "/runs", {
        cwd: resolve(typeof flags.cwd === "string" ? flags.cwd : process.cwd()),
        team: pos[0],
        leadKind: typeof flags.kind === "string" ? flags.kind : undefined,
        prompt: typeof flags.prompt === "string" ? flags.prompt : undefined,
      });
      return out(flags, meta, () => `run ${meta.id} started; lead "${meta.lead}" is starting${meta.branch ? `; work goes to branch ${meta.branch}` : ""}`);
    }
    case "run": {
      const sub = pos[0] ?? "list";
      if (sub === "list") {
        const runs = await call<RunSummary[]>("GET", "/runs");
        return out(flags, runs, () => runs.map((r) => `${r.id}  ${r.stopped ? "stopped " : r.quiescent ? "quiet   " : "active  "} ${r.attention ? `!${r.attention} ` : "   "}${r.cwd}`).join("\n") || "(no runs)");
      }
      await resolveRun(flags.run);
      if (sub === "show") return out(flags, await call("GET", "/run"), () => "");
      if (sub === "stop") return (await call("POST", "/run/stop"), console.log(`run ${RUN} stopped`));
      return die(`unknown: af run ${sub}`);
    }
    case "spawn": {
      await resolveRun(flags.run);
      if (!pos[0] || typeof flags.kind !== "string") die("usage: af spawn <name> --kind claude|codex|omp [--role ...]");
      const a = await call("POST", "/spawn", { name: pos[0], kind: flags.kind, role: flags.role });
      return console.log(`spawned ${a.name} (${a.kind})`);
    }
    case "graph":
      return graph(pos, flags);
    case "diff": {
      await resolveRun(flags.run);
      if (!pos[0]) die("usage: af diff <node> [--stat]");
      const r = await call("GET", "/diff", { node: pos[0], stat: flags.stat ? "1" : undefined });
      return console.log(r.diff || "(no changes)");
    }
    case "inbox": {
      await resolveRun(flags.run);
      const mail = await call<Mail[]>("POST", "/inbox", { all: !!flags.all });
      return out(flags, mail, () => (mail.length ? mail.map(fmtMail).join("\n\n") : "(no new messages)"));
    }
    case "send": {
      await resolveRun(flags.run);
      if (pos.length < 2) die("usage: af send <agent|user> <text...>");
      const m = await call("POST", "/send", { to: pos[0], body: pos.slice(1).join(" "), attachments: typeof flags.attach === "string" ? [absolute(flags.attach)] : undefined });
      return console.log(`sent ${m.id} to ${m.to}`);
    }
    case "reply": {
      await resolveRun(flags.run);
      if (pos.length < 2) die("usage: af reply <msg-id> <text...>");
      const m = await call("POST", "/reply", { id: pos[0], body: pos.slice(1).join(" "), attachments: typeof flags.attach === "string" ? [absolute(flags.attach)] : undefined });
      return console.log(`sent ${m.id} to ${m.to}`);
    }
    case "done": {
      await resolveRun(flags.run);
      const r = await call("POST", "/done", {
        outcome: typeof flags.outcome === "string" ? flags.outcome : undefined,
        note: typeof flags.note === "string" ? flags.note : undefined,
        result: typeof flags.result === "string" ? absolute(flags.result) : undefined,
      });
      return console.log(r.message);
    }
    case "open": {
      await resolveRun(flags.run);
      if (!pos[0]) die("usage: af open <url|path>");
      const target = /^[a-z]+:\/\//i.test(pos[0]) ? pos[0] : absolute(pos[0]);
      const o = await call("POST", "/open", { target });
      return console.log(`opened ${o.target}${o.node ? ` (attached to ${o.node})` : ""}`);
    }
    default:
      die(`unknown command ${cmd}. Run af help.`);
  }
}

const absolute = (p: string) => (isAbsolute(p) ? p : resolve(process.cwd(), p));

async function graph(pos: string[], flags: Record<string, string | true>) {
  await resolveRun(flags.run);
  const [sub, a, b, c] = pos;
  const send = async (command: Command) => {
    const r = await call<{ events: { type: string }[] }>("POST", "/graph", { command });
    const created = r.events.filter((e: any) => e.type === "instance.created").map((e: any) => `${e.node}#${e.n}`);
    console.log(`ok${created.length ? ` (ready: ${created.join(", ")})` : ""}`);
  };
  const need = (cond: unknown, usage: string) => cond || die(`usage: ${usage}`);
  switch (sub) {
    case "show": {
      const s = await call<RunState>("GET", "/run");
      return out(flags, s.graph, () => showGraph(s));
    }
    case "add": {
      need(a, "af graph add <id> --kind K --task ...");
      const after = typeof flags.after === "string" ? flags.after.split(",").map((f) => ({ from: f.trim(), on: typeof flags.on === "string" ? flags.on : undefined })) : undefined;
      if (flags.on && !after) die("--on needs --after");
      return send({ type: "node.add", id: a!, spec: specFromFlags(flags, false) as NodeSpec, after });
    }
    case "edit":
      need(a, "af graph edit <id> [--task ...]");
      return send({ type: "node.edit", id: a!, patch: specFromFlags(flags, true) });
    case "rm":
      need(a, "af graph rm <id>");
      return send({ type: "node.remove", id: a! });
    case "link":
      need(a && b, "af graph link <from> <to> [--on OUTCOME] [--max N]");
      return send({ type: "edge.link", from: a!, to: b!, on: typeof flags.on === "string" ? flags.on : undefined, max: typeof flags.max === "string" ? Number(flags.max) : undefined });
    case "unlink":
      need(a && b, "af graph unlink <from> <to>");
      return send({ type: "edge.unlink", from: a!, to: b! });
    case "max":
      need(a && b && c, "af graph max <from> <to> <N>");
      return send({ type: "edge.set_max", from: a!, to: b!, max: Number(c) });
    case "start":
      need(a, "af graph start <id>");
      return send({ type: "instance.start", node: a! });
    case "cancel":
      need(a, "af graph cancel <id>");
      return send({ type: "instance.cancel", node: a! });
    case "retry":
      need(a, "af graph retry <id>");
      return send({ type: "instance.retry", node: a! });
    case "accept":
      need(a, "af graph accept <id>");
      return send({ type: "instance.accept", node: a! });
    case "reject":
      need(a && typeof flags.reason === "string", 'af graph reject <id> --reason "..."');
      return send({ type: "instance.reject", node: a!, reason: flags.reason as string });
    default:
      die(`unknown: af graph ${sub ?? ""}. Run af help.`);
  }
}

await main();
