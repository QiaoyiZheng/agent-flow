// Process management: agents that have sat idle a long time are stopped to free memory, and started again on their
// own conversation when needed. Only the agent's process ends. Its pane, its place in the layout and its chat view
// stay, and the UI keeps showing it as it was (idle or done). A message to it (from the UI, af tell, a team's
// delivery) or opening its terminal starts it again with its resume flag, then sends (Workspaces.wake).
//
// An agent is stopped when all of these hold:
//   - it has been idle (done or idle, not asking, nothing typed in its box) for `idleHours` (8 by default); a worker
//     another session dispatched (af task, a team member) that has nothing more to do: for `workerMinutes`;
//   - it waits on no work of its own: claude's background commands and Monitors (background.ts), a cron or a
//     ScheduleWakeup it made (from its transcript), or processes it started that still run (an experiment);
//   - no team has anything for it (Teams.sleepInfo): no open ticket, no message waiting, its result taken. Routers
//     and members that stand for a whole team are never stopped.
// How each agent resumes: claude --resume <id>, codex resume <id>, omp --resume=<path>, gemini --resume <id>, with the
// flags it was started with, minus the ones that start a new conversation or send a first message.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { ChatSource, HPane } from "@af/core";
import type { TranscriptAccess } from "./access.ts";
import { inputText } from "./controls.ts";
import { AfError } from "./errors.ts";
import { sq } from "./remote.ts";
import type { Workspaces } from "./workspaces.ts";

export const SLEEP_AGENTS = ["claude", "codex", "omp", "gemini"] as const;

/** An agent agent-flow stopped, and how to start it again. Saved, so a restart keeps it. */
export interface SleepRecord {
  pane: string;
  agent: string;
  /** Its Herdr agent name (team members: "<team>-<member>"): it is started again under it. */
  name?: string;
  /** Its command and the arguments it was started with. */
  bin: string;
  args: string[];
  cwd: string;
  /** Its status and when it got it, shown while it is stopped. */
  status: string;
  statusAt?: string;
  /** The conversation: claude/codex/gemini by id, omp by file. */
  session: { id?: string; path?: string };
  /** Its transcript, for the chat view while no process runs. */
  source?: ChatSource;
  herdrSession?: HPane["session"];
  since: string;
  reason: string;
}

// ---------------------------------------------------------------------------------------------
// resuming

/** Options of each agent that take a value (the next argument), or several (the arguments up to the next option). */
const OPTS: Record<string, { value: string[]; many?: string[]; drop: string[] }> = {
  claude: {
    value: ["--settings", "--permission-mode", "--model", "--append-system-prompt", "--append-system-prompt-file", "--system-prompt", "--system-prompt-file", "--effort", "--fallback-model", "--agent", "--agents", "--setting-sources", "--output-format", "--input-format", "--name", "-n", "--debug-file", "--max-budget-usd", "--json-schema", "--plugin-dir", "--session-id", "--resume", "-r", "--from-pr"],
    many: ["--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--disallowed-tools", "--mcp-config", "--betas", "--tools", "--file"],
    // a new or another conversation, or a one-shot run
    drop: ["--session-id", "--resume", "-r", "--continue", "-c", "--fork-session", "--from-pr", "--print", "-p"],
  },
  codex: {
    value: ["-c", "--config", "-m", "--model", "-s", "--sandbox", "-a", "--ask-for-approval", "-p", "--profile", "-C", "--cd", "--add-dir", "--enable", "--disable", "--local-provider", "--remote", "--remote-auth-token-env"],
    many: ["-i", "--image"],
    drop: ["-i", "--image", "--last", "--all"],
  },
  omp: {
    value: ["--model", "--provider", "--profile", "--session-dir", "--append-system-prompt", "--system-prompt", "--resume", "-r", "--export", "--max-time"],
    drop: ["--resume", "-r", "--continue", "-c", "--no-session", "--export", "--from-claude", "--from-codex", "--print", "-p"],
  },
  gemini: {
    value: ["-m", "--model", "--approval-mode", "--include-directories", "-e", "--extensions", "--allowed-tools", "--allowed-mcp-server-names", "--output-format", "-i", "--prompt-interactive", "-p", "--prompt", "-r", "--resume", "--session-id", "--session-file"],
    // -i: the first message (a team's protocol): the conversation has it already
    drop: ["-i", "--prompt-interactive", "-p", "--prompt", "-r", "--resume", "--session-id", "--session-file", "--list-sessions"],
  },
};

/** The options in `args` worth keeping on a resume: no positional arguments (a first message, a subcommand). */
export function keptOptions(agent: string, args: string[]): string[] {
  const o = OPTS[agent];
  if (!o) return [];
  const value = new Set(o.value);
  const many = new Set(o.many ?? []);
  const drop = new Set(o.drop);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") break; // what follows is a message
    if (!a.startsWith("-") || a === "-") continue;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    const vals: string[] = [];
    // a value never starts with "-": `claude --resume --settings x` is --resume without one (it picks from a list)
    if (eq < 0 && many.has(name)) while (i + 1 < args.length && !args[i + 1]!.startsWith("-")) vals.push(args[++i]!);
    else if (eq < 0 && value.has(name) && i + 1 < args.length && !args[i + 1]!.startsWith("-")) vals.push(args[++i]!);
    if (!drop.has(name)) out.push(a, ...vals);
  }
  return out;
}

/**
 * The agent's own arguments in its process's argv: after the agent itself, which may run through an interpreter
 * (`bun …/omp …`, `node --import=… …/gemini.js …`). It is started again by its name, as a shell finds it (the user's
 * shell functions and settings apply again, like a gemini gateway), so the interpreter's part is left out.
 */
export function agentArgs(agent: string, argv: string[]): string[] {
  const i = argv.findIndex((a) => basename(a).startsWith(agent));
  return argv.slice(i < 0 ? 1 : i + 1);
}

/** Options naming a file that must exist for the agent to start (agent-flow's hook settings, a protocol file). */
const FILE_OPTS: Record<string, string[]> = { claude: ["--settings", "--append-system-prompt-file"], omp: ["--append-system-prompt"] };

/**
 * Leave out options whose file is gone (`exists` says), so the agent still starts: after a reboot, files under /tmp
 * (agent-flow's own when its home is there) are gone. Returns the arguments and the files left out.
 */
export function dropMissingFiles(agent: string, args: string[], exists: (path: string) => boolean): { args: string[]; dropped: string[] } {
  const opts = new Set(FILE_OPTS[agent] ?? []);
  const out: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    const name = a.startsWith("--") && eq > 0 ? a.slice(0, eq) : a;
    if (!opts.has(name)) {
      out.push(a);
      continue;
    }
    const file = eq > 0 && a.startsWith("--") ? a.slice(eq + 1) : args[i + 1];
    const takesNext = !(eq > 0 && a.startsWith("--"));
    if (file && !file.startsWith("-") && !exists(file)) {
      dropped.push(file);
      if (takesNext) i++;
      continue;
    }
    out.push(a);
    if (takesNext && file !== undefined) out.push(args[++i]!);
  }
  return { args: out, dropped };
}

/** The arguments that start `agent` again on its conversation; undefined when the conversation is not known. */
export function resumeArgs(agent: string, args: string[], session: { id?: string; path?: string }): string[] | undefined {
  const keep = keptOptions(agent, args);
  switch (agent) {
    case "claude":
      return session.id ? [...keep, "--resume", session.id] : undefined;
    case "codex":
      return session.id ? ["resume", ...keep, session.id] : undefined;
    case "omp":
      return session.path ? [...keep, `--resume=${session.path}`] : undefined;
    case "gemini":
      return session.id ? [...keep, "--resume", session.id] : undefined;
  }
  return undefined;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The conversation's id or file, from its transcript and what Herdr reports. gemini's id is in its file's first line. */
export function sessionOf(agent: string, source: ChatSource | undefined, herdr: HPane["session"], geminiHead?: string): { id?: string; path?: string } | undefined {
  const fileId = source ? basename(source.path).match(new RegExp(`(${UUID.source})\\.jsonl$`, "i"))?.[1] : undefined;
  switch (agent) {
    case "claude":
      return fileId ? { id: fileId, path: source!.path } : undefined;
    case "codex": {
      const id = herdr?.kind === "id" && UUID.test(herdr.value) ? herdr.value : fileId;
      return id ? { id, path: source?.path } : undefined;
    }
    case "omp": {
      const path = source?.path ?? (herdr?.kind === "path" ? herdr.value : undefined);
      return path ? { path } : undefined;
    }
    case "gemini": {
      let id = herdr?.kind === "id" && UUID.test(herdr.value) ? herdr.value : undefined;
      if (!id && geminiHead)
        try {
          const v = JSON.parse(geminiHead.split("\n")[0]!)?.sessionId;
          if (typeof v === "string" && UUID.test(v)) id = v;
        } catch {}
      return id ? { id, path: source?.path } : undefined;
    }
  }
  return undefined;
}

/** The pane's process that is the agent itself (Herdr lists the pane's foreground processes). */
export function agentProcess(agent: string, procs: { pid: number; argv: string[] }[]) {
  const is = (p: { argv: string[] }) => {
    const b = basename(p.argv[0] ?? "");
    if (agent === "claude") return b.startsWith("claude");
    if (agent === "codex") return b === "codex";
    return p.argv.slice(0, 3).some((a) => basename(a).startsWith(agent));
  };
  return procs.find(is);
}

// ---------------------------------------------------------------------------------------------
// work still running

export const PS_CMD = "ps -eo pid=,ppid=,etime=,rss=,args=";

export interface Proc {
  pid: number;
  ppid: number;
  /** Seconds since it started. */
  age: number;
  /** Resident memory, KB. */
  rss: number;
  /** Its program (the command line's first word). */
  comm: string;
  /** Its whole command line. */
  args: string;
}

/** ps's elapsed time, [[dd-]hh:]mm:ss, in seconds. */
export function etimeSeconds(s: string) {
  const [d, rest] = s.includes("-") ? (s.split("-") as [string, string]) : ["0", s];
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  return Number(d) * 86400 + parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
}

export function parsePs(out: string): Map<number, Proc> {
  const m = new Map<number, Proc>();
  for (const l of out.split("\n")) {
    const r = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.+)$/);
    if (r) {
      const args = r[5]!.trim();
      m.set(Number(r[1]), { pid: Number(r[1]), ppid: Number(r[2]), age: etimeSeconds(r[3]!), rss: Number(r[4]), comm: args.split(/\s+/)[0]!, args });
    }
  }
  return m;
}

export function descendants(procs: Map<number, Proc>, pid: number): Proc[] {
  const kids = new Map<number, Proc[]>();
  for (const p of procs.values()) {
    const l = kids.get(p.ppid);
    if (l) l.push(p);
    else kids.set(p.ppid, [p]);
  }
  const out: Proc[] = [];
  const queue = [pid];
  const seen = new Set<number>();
  while (queue.length) {
    const at = queue.shift()!;
    for (const k of kids.get(at) ?? [])
      if (!seen.has(k.pid)) {
        seen.add(k.pid);
        out.push(k);
        queue.push(k.pid);
      }
  }
  return out;
}

/** Helpers agents keep running for themselves, not work. */
const HELPERS = new Set(["caffeinate", "codex-code-mode-host", "node_repl"]);
/** Plugins and MCP servers (codex starts its computer-use plugin again now and then): not work either. */
const HELPER_ARGS = /\/plugins\/|\bmcp\b|mcp-server|modelcontextprotocol|\/\.codex\/packages\//i;
export const isHelper = (p: Proc) => HELPERS.has(basename(p.comm)) || HELPER_ARGS.test(p.args);

/**
 * Processes the agent started during its turns that still run (an experiment, a server): its descendants that
 * started a minute or more after it did, other than its helpers, plugins and MCP servers (and theirs).
 */
export function childWork(procs: Map<number, Proc>, agentPid: number): string[] {
  const me = procs.get(agentPid);
  if (!me) return [];
  const helper = new Set<number>();
  for (const p of descendants(procs, agentPid)) if (isHelper(p) || helper.has(p.ppid)) helper.add(p.pid);
  return descendants(procs, agentPid)
    .filter((p) => p.age < me.age - 60 && !helper.has(p.pid))
    .map((p) => basename(p.comm));
}

/**
 * Memory the agent and everything it started use, MB. `footprint` (pid → MB, from top on a Mac) counts what macOS
 * compressed or swapped out too; ps's resident size leaves that out, so a Mac short of memory shows tiny numbers.
 */
export function memoryMb(procs: Map<number, Proc>, agentPid: number, footprint?: Map<number, number>) {
  const me = procs.get(agentPid);
  if (!me) return 0;
  const of = (p: Proc) => footprint?.get(p.pid) ?? p.rss / 1024;
  return Math.round(of(me) + descendants(procs, agentPid).reduce((s, p) => s + of(p), 0));
}

/** macOS top's memory column for every process (`top -l 1 -stats pid,mem`): "929M", "12K", "1.2G", "8M+". */
export const TOP_CMD = "top -l 1 -n 5000 -stats pid,mem";
export function parseTopMem(out: string): Map<number, number> {
  const unit: Record<string, number> = { B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 };
  const m = new Map<number, number>();
  for (const l of out.split("\n")) {
    const r = l.trim().match(/^(\d+)\s+([\d.]+)([BKMG])[+-]?$/);
    if (r) m.set(Number(r[1]), Number(r[2]) * unit[r[3]!]!);
  }
  return m;
}

/** The lines of a claude transcript that name its schedule tools (a grep's output). */
export const SCHEDULE_GREP = `"name":"(CronCreate|CronDelete|ScheduleWakeup)"`;

/**
 * What claude has scheduled that has not fired yet, from its transcript's tool calls: crons it made (CronCreate)
 * and did not remove (CronDelete) in the last 7 days (session crons end after that), or a ScheduleWakeup whose time
 * has not come. Counted, not matched by id: when unsure, the agent stays.
 */
export function scheduledWork(lines: string[], now = Date.now()): string | undefined {
  let crons = 0;
  let wake: { at: number; delay: number; stop: boolean } | undefined;
  for (const l of lines) {
    let d: any;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    const at = Date.parse(d?.timestamp ?? "") || now;
    for (const c of Array.isArray(d?.message?.content) ? d.message.content : []) {
      if (c?.type !== "tool_use") continue;
      if (c.name === "CronCreate" && now - at < 7 * 86400_000) crons++;
      else if (c.name === "CronDelete") crons = Math.max(0, crons - 1);
      else if (c.name === "ScheduleWakeup") wake = { at, delay: Number(c.input?.delaySeconds) || 3600, stop: !!c.input?.stop };
    }
  }
  if (crons > 0) return `${crons} scheduled task${crons > 1 ? "s" : ""} (cron)`;
  if (wake && !wake.stop && now < wake.at + Math.min(wake.delay, 3600) * 1000 + 10 * 60_000) return "a scheduled wake-up";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// the policy

export interface ProcessSettings {
  /** Stop idle agents at all. */
  enabled: boolean;
  /** An agent idle this long is stopped. */
  idleHours: number;
  /** A dispatched worker with nothing more to do is stopped after this long. */
  workerMinutes: number;
  /** Also on other machines (off: they may be shared, and it frees nothing on this Mac). */
  remote: boolean;
}
export const DEFAULT_PROCESS_SETTINGS: ProcessSettings = { enabled: true, idleHours: 8, workerMinutes: 10, remote: false };

/** What a team says about stopping the agent in a pane: undefined when no team has it. */
export interface TeamSleepInfo {
  worker: boolean;
  ok: boolean;
  why?: string;
}

/** One agent in the process list. */
export interface ProcessRow {
  pane: string;
  machine: string;
  workspace: string;
  agent: string;
  name?: string;
  title?: string;
  status: string;
  /** When it went idle (or the server first saw it so). */
  idleSince?: string;
  memoryMb?: number;
  worker: boolean;
  asleep?: { since: string; reason: string };
  /** Why it is kept running (absent: it will be stopped, or it is stopped). */
  keep?: string;
  /** When it will be stopped if nothing changes. */
  due?: string;
}

const dur = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m / 144) / 10} d`;
};

export class Sleeper {
  settings: ProcessSettings = { ...DEFAULT_PROCESS_SETTINGS };
  private file: string;
  private timer?: ReturnType<typeof setInterval>;
  private first?: ReturnType<typeof setTimeout>;
  private running = false;
  private readonly started = Date.now();

  constructor(
    private w: Workspaces,
    private access: TranscriptAccess,
    private teams: { sleepInfo(pane: string): TeamSleepInfo | undefined },
    home: string,
    /** Ids of teams and old runs: their agents' Herdr names start with "<id>-". */
    private dispatchers: () => string[] = () => [],
    private now = () => Date.now(),
  ) {
    this.file = join(home, "settings.json");
    try {
      if (existsSync(this.file)) this.settings = { ...DEFAULT_PROCESS_SETTINGS, ...(JSON.parse(readFileSync(this.file, "utf8")).processes ?? {}) };
    } catch {}
  }

  /** Stopping idle agents (every `everyMs`, if the settings say so). */
  start(everyMs = 5 * 60_000) {
    this.first = setTimeout(() => void this.tick(), 60_000);
    this.timer = setInterval(() => void this.tick(), everyMs);
  }

  /**
   * Remembering how to start each running agent again, for after a Herdr restart (Workspaces.known): right after
   * each turn (a /clear or a resume may have changed its conversation), and every `everyMs` for agents not
   * remembered yet, started again since, or not looked at for half an hour.
   */
  startRemembering(everyMs = 2 * 60_000) {
    this.unTurn = this.w.onTurnEnd((t) => void this.remember(t.pane, true).catch(() => {}));
    this.rememberFirst = setTimeout(() => void this.rememberAll(), 20_000);
    this.rememberTimer = setInterval(() => void this.rememberAll(), everyMs);
  }

  stop() {
    clearTimeout(this.first);
    clearInterval(this.timer);
    clearTimeout(this.rememberFirst);
    clearInterval(this.rememberTimer);
    this.unTurn?.();
  }

  private rememberFirst?: ReturnType<typeof setTimeout>;
  private rememberTimer?: ReturnType<typeof setInterval>;
  private unTurn?: () => void;
  private remembering = false;

  async rememberAll() {
    if (this.remembering) return;
    this.remembering = true;
    try {
      for (const p of this.w.model.panes) {
        if (!p.agent || p.asleep || !SLEEP_AGENTS.includes(p.agent as (typeof SLEEP_AGENTS)[number])) continue;
        if (this.w.model.machines.find((m) => m.id === p.machine)?.state !== "online") continue;
        await this.remember(p.id).catch(() => {});
      }
    } finally {
      this.remembering = false;
    }
  }

  /** Remember how to start the agent in `pane` again. `fresh`: even if it was looked at recently. */
  async remember(pane: string, fresh = false) {
    const p = this.w.model.panes.find((x) => x.id === pane);
    if (!p?.agent || p.asleep) return;
    const me = agentProcess(p.agent, await this.w.processes(pane));
    if (!me) return;
    const was = this.w.knownAgent(pane);
    if (!fresh && was && was.agentPid === me.pid && this.now() - Date.parse(was.at) < 30 * 60_000) return;
    const shellPid = await this.w.shellPid(pane);
    if (!shellPid) return;
    const rec = await this.record(p, me);
    if (!rec) return;
    this.w.rememberAgent({ ...rec, shellPid, agentPid: me.pid, paneCwd: p.cwd, at: new Date(this.now()).toISOString() });
  }

  setSettings(s: Partial<ProcessSettings>) {
    const next = { ...this.settings };
    if (typeof s.enabled === "boolean") next.enabled = s.enabled;
    if (typeof s.remote === "boolean") next.remote = s.remote;
    if (Number.isFinite(s.idleHours) && s.idleHours! > 0) next.idleHours = Math.min(24 * 30, Number(s.idleHours));
    if (Number.isFinite(s.workerMinutes) && s.workerMinutes! > 0) next.workerMinutes = Math.min(24 * 60 * 30, Number(s.workerMinutes));
    this.settings = next;
    let all: any = {};
    try {
      if (existsSync(this.file)) all = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {}
    writeFileSync(this.file, JSON.stringify({ ...all, processes: next }, null, 2));
    return next;
  }

  /** Stop every agent that is due. */
  async tick() {
    if (!this.settings.enabled || this.running) return [];
    this.running = true;
    const stopped: string[] = [];
    try {
      for (const row of await this.list(true)) {
        if (row.asleep || row.keep) continue;
        try {
          await this.sleepPane(row.pane, row.worker ? `finished worker, idle ${dur(this.now() - Date.parse(row.idleSince ?? ""))}` : `idle ${dur(this.now() - Date.parse(row.idleSince ?? ""))}`);
          stopped.push(row.pane);
          this.failed.delete(row.pane);
        } catch (e) {
          // shown in the list, and not tried again for half an hour
          this.failed.set(row.pane, { why: (e as Error).message.replace(/^not stopped: /, ""), at: this.now() });
        }
      }
    } finally {
      this.running = false;
    }
    return stopped;
  }

  private footprintNow?: Map<number, number>;
  private footprintAt = 0;
  /** This Mac's per-process memory as top counts it (about a second to read: kept 30 s). */
  private async footprint() {
    if (process.platform !== "darwin") return undefined;
    if (!this.footprintNow || this.now() - this.footprintAt > 30_000) {
      const m = parseTopMem(await this.w.machineExec("local", TOP_CMD).catch(() => ""));
      if (m.size) {
        this.footprintNow = m;
        this.footprintAt = this.now();
      }
    }
    return this.footprintNow;
  }

  /** Every agent pane, running or stopped, with why it is kept running. `full`: check the slow things too. */
  async list(full = false): Promise<ProcessRow[]> {
    const rows: ProcessRow[] = [];
    const ps = new Map<string, Map<number, Proc>>();
    await this.footprint();
    const procsOf = async (machine: string) => {
      if (!ps.has(machine)) ps.set(machine, parsePs(await this.w.machineExec(machine, PS_CMD).catch(() => "")));
      return ps.get(machine)!;
    };
    const wsLabel = (id: string) => this.w.model.workspaces.find((x) => x.id === id)?.label ?? id;
    for (const p of this.w.model.panes) {
      if (!p.agent || !SLEEP_AGENTS.includes(p.agent as (typeof SLEEP_AGENTS)[number])) continue;
      if (this.w.model.machines.find((m) => m.id === p.machine)?.state !== "online") continue;
      const rec = this.w.asleepRecord(p.id);
      const row: ProcessRow = { pane: p.id, machine: p.machine, workspace: wsLabel(p.workspaceId), agent: p.agent, name: p.agentName, title: p.title, status: p.agentStatus, worker: false };
      rows.push(row);
      if (rec) {
        row.asleep = { since: rec.since, reason: rec.reason };
        row.idleSince = rec.statusAt;
        continue;
      }
      row.keep = await this.whyKeep(p, row, procsOf, full).catch((e) => `could not check: ${(e as Error).message}`);
    }
    return rows;
  }

  /** Stops that failed at a check, and why: not tried again for half an hour. */
  private failed = new Map<string, { why: string; at: number }>();

  private async whyKeep(p: HPane, row: ProcessRow, procsOf: (machine: string) => Promise<Map<number, Proc>>, full: boolean): Promise<string | undefined> {
    if (p.machine !== "local" && !this.settings.remote) return "on another machine (stopping there is off)";
    const procs = await procsOf(p.machine);
    const me = agentProcess(p.agent!, await this.w.processes(p.id).catch(() => []));
    if (me) row.memoryMb = memoryMb(procs, me.pid, p.machine === "local" ? this.footprintNow : undefined);
    if (p.agentStatus === "working") return "working";
    if (p.agentStatus === "blocked" || p.asking) return "waiting for an answer";
    if (p.background) return `${p.background} background task${p.background > 1 ? "s" : ""} running`;
    if (p.agentStatus !== "done" && p.agentStatus !== "idle") return `status ${p.agentStatus}`;
    if (p.scrolled) return "its terminal is scrolled up";
    const fail = this.failed.get(p.id);
    if (fail && this.now() - fail.at < 30 * 60_000) return `the last try to stop it failed: ${fail.why}`;
    const team = this.teams.sleepInfo(p.id);
    row.worker = team?.worker ?? (!!p.agentName && this.dispatchers().some((id) => p.agentName!.startsWith(`${id}-`)));
    if (team && !team.ok) return team.why ?? "its team has work for it";
    row.idleSince = p.statusAt ?? new Date(this.started).toISOString();
    const limit = row.worker ? this.settings.workerMinutes * 60_000 : this.settings.idleHours * 3600_000;
    const idle = this.now() - Date.parse(row.idleSince);
    if (idle < limit) {
      row.due = new Date(Date.parse(row.idleSince) + limit).toISOString();
      return `idle ${dur(idle)}`;
    }
    if (!me) return "no agent process found";
    const kids = childWork(procs, me.pid);
    if (kids.length) return `runs ${[...new Set(kids)].slice(0, 3).join(", ")}`;
    if (!full) return undefined;
    if (!this.w.settled(p.id)) return "not settled";
    const box = inputText(p.agent, await this.w.visible(p.id, true));
    if (box === undefined) return "shows something other than its input box";
    if (box) return "has text typed in its box";
    const plan = await this.plan(p, me);
    if ("keep" in plan) return plan.keep;
    return undefined;
  }

  /** Everything needed to start it again, or why it cannot be stopped. */
  private async plan(p: HPane, me: { pid: number; argv: string[] }): Promise<{ rec: SleepRecord } | { keep: string }> {
    const r = await this.access.resolve(p.id);
    const source = "source" in r && !r.source.pending ? r.source : undefined;
    if (p.agent === "claude" && source) {
      const out = await this.access.fsFor(p.id).fs.sh(`grep -h -E ${sq(SCHEDULE_GREP)} ${sq(source.path)} 2>/dev/null | tail -n 200`).catch(() => "");
      const sched = scheduledWork(out.split("\n").filter(Boolean), this.now());
      if (sched) return { keep: sched };
    }
    const rec = await this.record(p, me, r);
    return rec ? { rec } : { keep: "cannot tell its conversation, so it could not be resumed" };
  }

  /** How to start the agent in `p` (process `me`) again on its conversation; undefined when that is not known. */
  private async record(p: HPane, me: { pid: number; argv: string[] }, resolved?: Awaited<ReturnType<TranscriptAccess["resolve"]>>): Promise<SleepRecord | undefined> {
    const r = resolved ?? (await this.access.resolve(p.id));
    const source = "source" in r && !r.source.pending ? r.source : undefined;
    const fs = this.access.fsFor(p.id).fs;
    const head = p.agent === "gemini" && source ? (await fs.readFrom(source.path, 0, 64 * 1024).catch(() => undefined))?.data.toString("utf8") : undefined;
    const session = sessionOf(p.agent!, source, p.session, head);
    const args = agentArgs(p.agent!, me.argv);
    if (!session || !resumeArgs(p.agent!, args, session)) return undefined;
    return {
      pane: p.id,
      agent: p.agent!,
      name: p.agentName,
      bin: p.agent!,
      args,
      cwd: p.cwd,
      status: p.agentStatus,
      statusAt: p.statusAt,
      session,
      source,
      herdrSession: p.session,
      since: new Date(this.now()).toISOString(),
      reason: "",
    };
  }

  /** Stop the agent in `pane` now (it must be idle; `reason` is shown). */
  async sleepPane(pane: string, reason = "stopped by you") {
    const p = this.w.model.panes.find((x) => x.id === pane);
    if (!p?.agent || !SLEEP_AGENTS.includes(p.agent as (typeof SLEEP_AGENTS)[number])) throw new AfError("no_agent", "no agent agent-flow can resume in this pane");
    if (this.w.asleepRecord(pane)) return this.w.asleepRecord(pane)!;
    if (!this.w.settled(pane)) throw new AfError("busy", `${p.agent} is not idle`, 409);
    const box = inputText(p.agent, await this.w.visible(pane, true));
    if (box === undefined) throw new AfError("agent_asking", `${p.agent} shows something other than its input box`, 409);
    if (box) throw new AfError("draft", `${p.agent} has text typed in its box`, 409);
    const me = agentProcess(p.agent, await this.w.processes(pane));
    if (!me) throw new AfError("no_process", `cannot find ${p.agent}'s process`);
    const kids = childWork(parsePs(await this.w.machineExec(p.machine, PS_CMD).catch(() => "")), me.pid);
    if (kids.length) throw new AfError("keep", `not stopped: it runs ${[...new Set(kids)].slice(0, 3).join(", ")}`, 409);
    const plan = await this.plan(p, me);
    if ("keep" in plan) throw new AfError("keep", `not stopped: ${plan.keep}`, 409);
    await this.w.putToSleep({ ...plan.rec, reason }, me.pid);
    return plan.rec;
  }
}
