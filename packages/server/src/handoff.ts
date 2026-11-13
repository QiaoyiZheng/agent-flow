// A session whose context is nearly full hands off to a fresh one in its pane.
//   1. After each turn of a main session (the session that hands out tasks, mode 1), agent-flow reads how full its
//      context is from its transcript (the footer's meter: transcripts/peek.ts). At `at` (80% by default) it types a
//      request: write a handoff document to <path> with the handoff skill, then run af handoff ready <path>.
//      Any session can also hand off when the user asks it to (af handoff gives it the path), or presses Refresh
//      (refresh: the same request, now).
//   2. af handoff ready: when that turn has ended (and the user is not typing to it), agent-flow closes the sessions
//      it started that have nothing left to do (Teams.closeFinished), ends the agent and starts a new conversation of
//      the same agent, with the same flags, in the same pane: it is the same main session for agent-flow, so the
//      sessions still running report to it. Its first message: read the handoff document; who was closed, who runs.
// Settings: "handoff": {"at": 0.8} in ~/.agent-flow/config.json; {"at": 0} turns the request off (af handoff stays).

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { splitId } from "@af/core";
import type { TranscriptAccess } from "./access.ts";
import { inputText } from "./controls.ts";
import { AfError } from "./errors.ts";
import { sq } from "./remote.ts";
import { agentArgs, agentProcess, keptOptions } from "./sleep.ts";
import type { Teams } from "./teams.ts";
import type { Workspaces } from "./workspaces.ts";

export interface HandoffSettings {
  /** Ask for a handoff when this share of the context window is used (0: never ask). */
  at: number;
}
export const DEFAULT_HANDOFF: HandoffSettings = { at: 0.8 };

export function loadHandoffSettings(home: string): HandoffSettings {
  try {
    const h = JSON.parse(readFileSync(join(home, "config.json"), "utf8"))?.handoff;
    if (h === false) return { at: 0 };
    if (h && typeof h.at === "number" && h.at >= 0 && h.at < 1) return { at: h.at };
  } catch {}
  return DEFAULT_HANDOFF;
}

/** The arguments for a new conversation of `agent` started with `args`: its options, without the ones for one conversation. */
export function freshArgs(agent: string, args: string[], opts: { session?: string; claudeSettings?: string } = {}): string[] {
  const keep = keptOptions(agent, args);
  if (agent !== "claude") return keep;
  return [...keep, ...(opts.session ? ["--session-id", opts.session] : []), ...(opts.claudeSettings && !keep.includes("--settings") ? ["--settings", opts.claudeSettings] : [])];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M` : `${Math.round(n / 1000)}k`);

/** The request to hand off: when the context is nearly full (used, tokens, window), or when the user pressed Refresh. */
export function requestText(o: { used?: number; tokens?: number; window?: number; doc: string; af: string }) {
  return [
    o.used !== undefined ? `[agent-flow] Your context is ${pct(o.used)} full (${tokens(o.tokens!)} of ${tokens(o.window!)} tokens).` : "[agent-flow] The user pressed Refresh for this session.",
    `Hand off to a fresh session now, with the handoff skill: write the handoff document to ${o.doc}, then run: ${o.af} handoff ready ${o.doc}`,
    "When your turn ends, agent-flow closes the sessions you started that have finished (their results taken), closes this session, and starts a new one in this pane that reads the document. The sessions still working stay and report to the new session: say in the document what each one does and what you wait for. Do not start other work first.",
  ].join("\n");
}

export interface Children {
  closed: string[];
  running: { name: string; ticket?: string; title?: string; stage: string }[];
}

export function takeoverText(o: { agent: string; doc: string; transcript?: string; af: string; main: boolean; children?: Children }) {
  const c = o.children;
  return [
    `[agent-flow] You take over from the previous ${o.agent} session in this pane: it handed off (its context was nearly full, or the user asked), and agent-flow closed it and started you.`,
    `Read its handoff document first: ${o.doc}`,
    ...(o.transcript ? [`If you need a detail it left out, the previous conversation is in ${o.transcript} (search it; do not read it all).`] : []),
    ...(c?.closed.length ? [`agent-flow closed the sessions it started that had finished: ${c.closed.join(", ")} (their tasks and results stay in their tickets: ${o.af} tickets).`] : []),
    ...(c?.running.length
      ? [`Still running, and now reporting to you (their results come to your queue: ${o.af} queue): ${c.running.map((r) => `${r.name}${r.ticket ? ` (${r.ticket}${r.title ? `: ${r.title.slice(0, 60)}` : ""})` : ""}, ${r.stage}`).join("; ")}.`]
      : o.main
        ? ["None of the sessions it started is still running."]
        : []),
    "Then tell the user in a few lines what you took over and what comes next, and go on with it.",
  ].join("\n");
}

interface Pending {
  doc: string;
  /** When af handoff ready was run (ms): the turn that ends after it is the last one. */
  at: number;
  used?: number;
}

export class Handoffs {
  /** pane -> the share of its context used when it was last asked to hand off. */
  private asked = new Map<string, number>();
  /** pane -> the status time whose turn was looked at. */
  private looked = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private replacing = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private w: Workspaces,
    private teams: Teams,
    private access: TranscriptAccess,
    private opts: { home: string; settings?: HandoffSettings; claudeSettings?: string; notify?: (level: "info" | "warn" | "error", key: string, text: string, detail?: string) => void; now?: () => number },
  ) {}

  private get settings() {
    return this.opts.settings ?? DEFAULT_HANDOFF;
  }
  private now() {
    return this.opts.now?.() ?? Date.now();
  }

  start(everyMs = 3000) {
    this.timer = setInterval(() => void this.tick(), everyMs);
  }
  stop() {
    clearInterval(this.timer);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const pane of [...this.pending.keys()]) await this.replaceIfDone(pane).catch((e) => this.fail(pane, e));
      if (this.settings.at > 0) for (const pane of this.teams.mainPanes()) await this.check(pane).catch(() => {});
    } finally {
      this.ticking = false;
    }
  }

  /** Where `pane`'s handoff document goes: agent-flow's folder on its machine (made if missing). */
  async docPath(pane: string) {
    const p = this.w.model.panes.find((x) => x.id === pane);
    const ws = p && this.w.model.workspaces.find((x) => x.id === p.workspaceId);
    const stamp = new Date(this.now()).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
    const slug = (ws?.label ?? p?.agent ?? "session").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "session";
    const machine = splitId(pane).machine;
    if (machine === "local") {
      const dir = join(this.opts.home, "handoffs");
      mkdirSync(dir, { recursive: true });
      return join(dir, `${stamp}-${slug}.md`);
    }
    const home = this.w.remoteOf(pane)?.home;
    if (!home) throw new AfError("machine_offline", `${machine} is not connected`, 503);
    const dir = `${home}/.agent-flow/handoffs`;
    await this.w.machineExec(machine, `mkdir -p ${sq(dir)}`);
    return `${dir}/${stamp}-${slug}.md`;
  }

  /** af handoff: the path to write the document to (a session the user asked to hand off). */
  async begin(pane: string) {
    this.agentPane(pane);
    const doc = await this.docPath(pane);
    return { doc, af: this.teams.afPathOn(splitId(pane).machine) };
  }

  /**
   * The Refresh button: ask the session to hand off now, as when its context is nearly full. It goes now if the agent
   * is free, else when its turn ends (agent-flow's queue).
   */
  async refresh(pane: string) {
    const p = this.agentPane(pane);
    if (this.pending.has(pane) || this.replacing.has(pane)) throw new AfError("busy", "it is handing off already", 409);
    const doc = await this.docPath(pane);
    const r = await this.w.send(pane, requestText({ doc, af: this.teams.afPathOn(p.machine) }), [], "auto");
    return { doc, agent: p.agent, queued: "queued" in r };
  }

  /** af handoff ready <doc>: the document is written; the session is replaced once its turn ends. */
  async ready(pane: string, doc: string) {
    const p = this.agentPane(pane);
    if (!doc.startsWith("/")) throw new AfError("bad_path", "give the document's absolute path");
    const machine = splitId(pane).machine;
    const ok = machine === "local" ? existsSync(doc) && statSync(doc).isFile() && statSync(doc).size > 0 : (await this.w.machineExec(machine, `test -s ${sq(doc)} && echo ok`).catch(() => "")).trim() === "ok";
    if (!ok) throw new AfError("not_found", `${doc} is missing or empty${machine === "local" ? "" : ` on ${machine}`}; write the handoff document there first`, 404);
    this.pending.set(pane, { doc, at: this.now(), used: this.asked.get(pane) });
    this.w.hold(pane, true); // no queue notice into this session meanwhile: its successor gets them
    return { doc, agent: p.agent };
  }

  private agentPane(pane: string) {
    const p = this.w.model.panes.find((x) => x.id === pane);
    if (!p?.agent) throw new AfError("no_agent", "run this inside an agent's session (it is known by its Herdr pane)");
    // a team member or a session another one started: it gets new tickets instead (its manager decides)
    if (this.teams.isMemberPane(pane)) throw new AfError("forbidden", "a session that works for a team or on a task does not hand off; the session that gave it the work gives it to a new one", 403);
    if (p.asleep) throw new AfError("asleep", "this agent is stopped", 409);
    return p;
  }

  /** After a turn of a main session: ask it to hand off when its context is nearly full. */
  private async check(pane: string) {
    const p = this.w.model.panes.find((x) => x.id === pane);
    if (!p?.agent || p.asleep || !p.statusAt || this.pending.has(pane) || this.replacing.has(pane) || this.teams.isMemberPane(pane)) return;
    if (!this.w.settled(pane) || this.looked.get(pane) === p.statusAt) return;
    const pk = await this.access.peek(pane).catch(() => undefined);
    this.looked.set(pane, p.statusAt);
    if (!pk?.contextTokens || !pk.contextWindow) return;
    const used = pk.contextTokens / pk.contextWindow;
    const was = this.asked.get(pane);
    if (used < this.settings.at) {
      if (was !== undefined && used < was - 0.1) this.asked.delete(pane); // compacted, or cleared
      return;
    }
    if (was !== undefined && used < was + 0.05) return; // asked already: again only after 5 points more
    const doc = await this.docPath(pane);
    try {
      await this.w.prompt(pane, requestText({ used, tokens: pk.contextTokens, window: pk.contextWindow, doc, af: this.teams.afPathOn(p.machine) }));
      this.asked.set(pane, used);
    } catch {
      this.looked.delete(pane); // the user is typing, or it shows a question: next time
    }
  }

  /** The turn after af handoff ready has ended: end the agent and start a fresh one in its pane. */
  private async replaceIfDone(pane: string) {
    const h = this.pending.get(pane)!;
    const p = this.w.model.panes.find((x) => x.id === pane);
    if (!p?.agent) {
      this.pending.delete(pane);
      this.w.hold(pane, false);
      return;
    }
    if (this.replacing.has(pane) || !p.statusAt || Date.parse(p.statusAt) < h.at) return;
    if (!this.w.settled(pane) || (await this.w.userTyping(pane))) return;
    if (inputText(p.agent, await this.w.visible(pane, true).catch(() => "")) === undefined) return; // a question on screen
    this.replacing.add(pane);
    try {
      const me = agentProcess(p.agent, await this.w.processes(pane));
      if (!me) throw new AfError("no_process", `cannot find ${p.agent}'s process`);
      const r = await this.access.resolve(pane).catch(() => undefined);
      const transcript = r && "source" in r && !r.source.pending ? r.source.path : undefined;
      const session = p.agent === "claude" ? crypto.randomUUID() : undefined;
      const local = splitId(pane).machine === "local";
      const args = freshArgs(p.agent, agentArgs(p.agent, me.argv), { session, claudeSettings: local ? this.opts.claudeSettings : undefined });
      // the sessions it started: those with nothing left to do are closed; those still running stay, for the new one
      const main = this.teams.mainPanes().includes(pane);
      const children = main ? await this.teams.closeFinished(pane) : undefined;
      await this.w.replaceAgent(pane, me.pid, { agent: p.agent, bin: p.agent, args, cwd: p.cwd, session });
      const text = takeoverText({ agent: p.agent, doc: h.doc, transcript, af: this.teams.afPathOn(p.machine), main, children });
      let typed = false;
      for (let i = 0; i < 40 && !typed; i++) {
        try {
          await this.w.prompt(pane, text, true);
          typed = true;
        } catch {
          await Bun.sleep(1500); // it shows a question (the user answers it), or it is still starting
        }
      }
      const ws = this.w.model.workspaces.find((x) => x.id === p.workspaceId)?.label ?? pane;
      const kids = children ? ` Closed ${children.closed.length} finished session(s)${children.closed.length ? ` (${children.closed.join(", ")})` : ""}; ${children.running.length} still running.` : "";
      this.opts.notify?.(typed ? "info" : "warn", `handoff:${pane}`, `${ws}: ${p.agent} handed off to a new session${h.used ? ` (its context was ${pct(h.used)} full)` : ""}`, `${typed ? `Handoff document: ${h.doc}.` : `The new session did not take its first message; tell it to read ${h.doc}.`}${kids}`);
      this.asked.delete(pane);
      this.looked.delete(pane);
    } finally {
      this.pending.delete(pane);
      this.replacing.delete(pane);
      this.w.hold(pane, false);
    }
  }

  private fail(pane: string, e: unknown) {
    this.opts.notify?.("error", `handoff:${pane}`, `The handoff in ${pane} did not go through`, (e as Error).message);
  }
}
