// The live Herdr model of every machine (local, and remote machines over SSH), and viewer panes.
//
// Herdr owns the layout. This module mirrors it for the UI and `af ls`, and turns user/agent requests
// (split, close, show a file, read a pane, prompt an agent) into Herdr calls on the right machine.
// Ids from remote machines carry the machine key as a prefix ("ds03~w3:p4"); local ids have none.
// A viewer pane is an ordinary local Herdr pane that runs `af viewer`; the registry here tells the web UI
// to draw a rich file/web view for it instead.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type HLayout, type HMachine, type HPane, type HTab, type HWorkspace, type HerdrModel, type LayoutNode, type QueuedMessage, type ShowRequest, type SplitDirection, type ViewRec, MACHINE_SEP, splitId } from "@af/core";
import type { TerminalBackend } from "./herdr.ts";
import { AfError } from "./errors.ts";
import { composePrompt, saveLocal, stamp } from "./attachments.ts";
import { type RemoteMachine, machineKey, sq } from "./remote.ts";
import { type Menu, type Overlay, keysToChoose, parseMenu, screenOverlay } from "./menu.ts";
import { REWIND_HINT, STEER_NOW, clearBoxKeys, controlSteps, inputText } from "./controls.ts";
import { claudeSession, parseRemoteCounts, remoteCheckScript, runningTasks, taskDir } from "./background.ts";

/** What Workspaces needs from a remote connection (RemoteMachine, or a fake in tests). */
export type RemoteLike = Pick<RemoteMachine, "state" | "error" | "home" | "connect" | "close" | "exec"> & Partial<Pick<RemoteMachine, "verify" | "masterAlive" | "forwardRemoteSocket">>;

export interface WorkspacesOptions {
  home: string;
  backend: TerminalBackend;
  /** Env for panes agent-flow creates on this machine, so `af` works inside them. */
  paneEnv: () => Record<string, string>;
  /** Builds the connection and Herdr backend for a saved remote machine. */
  remote?: (spec: { key: string; label: string; target: string; session: string }, onChange: () => void) => { remote: RemoteLike; backend: () => TerminalBackend };
  /** How often Herdr's saved machine list is re-read (it can change in the Herdr TUI too). */
  machinesPollMs?: number;
  /** Tell the user about connection trouble. */
  notify?: (level: "error" | "warn" | "info", source: string, text: string, detail?: string) => void;
  now?: () => string;
  /** How background work is found (see background.ts); tests replace it. */
  background?: { session: (pid: number) => string | undefined; dir: (session: string) => string | undefined; count: (dirs: string[]) => Promise<Map<string, number>> };
  /** Screen checks (150 ms apart) for a steered message to show up as waiting (tests make it short). */
  steerPolls?: number;
  /** How long a gemini prompt is watched for staying unsent in its box (tests make it short). */
  submitCheckMs?: number;
  /** How often remote machines are polled (local: every refresh). */
  remotePollMs?: number;
}

interface Machine {
  meta: HMachine;
  /** Herdr's profile id, for remote machines. */
  profileId?: string;
  backend?: TerminalBackend;
  remote?: RemoteLike;
  makeBackend?: () => TerminalBackend;
  workspaces: HWorkspace[];
  tabs: HTab[];
  panes: HPane[];
  layouts: Record<string, HLayout>;
  sigs: Record<string, string>;
  stopWatch?: () => void;
  lastPoll: number;
  /** Consecutive failed snapshots; two in a row make the connection check itself. */
  failedPolls: number;
  /** The connection failed or dropped since it was last fine (so "connected again" is worth saying). */
  troubled?: boolean;
  /** Each pane's agent status and when it changed to it (undefined: it had it when we first looked). */
  since?: Map<string, { status: string; at?: string }>;
  /** Background tasks each claude pane still waits on (see background.ts), and when each was last checked. */
  background?: Map<string, { n: number; at: number; for?: string }>;
  /** Remote machines: panes whose check is on its way over SSH (their turn end waits for it), and whether one runs. */
  bgPending?: Set<string>;
  bgRunning?: boolean;
  /** When each pane last became active (working, or waiting on background work), for turn ends. */
  activeSince?: Map<string, number>;
  /** Panes showing a question Herdr does not report (see checkAsking), and when they were last checked. */
  asking?: Map<string, string>;
  askingAt?: number;
  askingBusy?: boolean;
}

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

/**
 * A workspace's status from its agents, most urgent first: asking (a question on screen, also one Herdr misses) >
 * working > done > idle. Herdr's own workspace status ranks "done" (finished, not looked at yet) above "working", so
 * a workspace with one finished agent showed "done" while another agent in it was still working.
 */
const BACKGROUND = { session: (pid: number) => claudeSession(pid), dir: (sid: string) => taskDir(sid), count: runningTasks };

/** done/idle while background work runs is "background" (still at work, not finished). */
export const effectiveStatus = (status: string, background: number) => ((status === "done" || status === "idle") && background > 0 ? "background" : status);
const STATUS_RANK = ["blocked", "working", "background", "done", "idle", "unknown"];
export function workspaceStatus(panes: HPane[], herdrStatus: string) {
  const statuses = panes.filter((p) => p.agent).map((p) => (p.asking ? "blocked" : effectiveStatus(p.agentStatus, p.background ?? 0) === "background" ? "working" : p.agentStatus));
  if (!statuses.length) return herdrStatus;
  const rank = (st: string) => {
    const i = STATUS_RANK.indexOf(st);
    return i < 0 ? STATUS_RANK.length : i;
  };
  return statuses.sort((a, b) => rank(a) - rank(b))[0]!;
}

export class Workspaces {
  model: HerdrModel = { machines: [], workspaces: [], tabs: [], panes: [], layouts: {} };
  views: Record<string, ViewRec> = {};
  /** Messages waiting for their agent's turn to end, by pane. Saved, so they survive a restart. */
  queue: Record<string, QueuedMessage[]> = {};
  private queueFile: string;
  /** Each machine's agent statuses and when they changed (pane ids as Herdr knows them), saved across restarts. */
  private statusFile: string;
  private savedStatus: Record<string, Record<string, { status: string; at?: string }>> = {};
  private statusSave?: ReturnType<typeof setTimeout>;
  /** When a queued message was last delivered to a pane (the next waits until the agent has taken it up). */
  private queueSentAt = new Map<string, number>();
  private draining = new Set<string>();
  /** When agent-flow last typed a prompt into each pane. Herdr takes a few seconds to see the agent start. */
  private promptedAt = new Map<string, number>();
  /** Sessions by pane: given at launch (claude --session-id) or reported by claude's SessionStart hook. */
  sessions: Record<string, { id: string; path?: string }> = {};
  private machines = new Map<string, Machine>();
  private listeners = new Set<() => void>();
  private refreshing?: Promise<void>;
  private again = false;
  private timer?: ReturnType<typeof setInterval>;
  private debounce?: ReturnType<typeof setTimeout>;
  private lastJson = "";
  private viewsFile: string;
  private now: () => string;
  /** Herdr profile ids of machines the user connected: reconnected on every start until they disconnect. */
  private autoconnect = new Set<string>();
  private autoFile: string;

  constructor(private opts: WorkspacesOptions) {
    this.viewsFile = join(opts.home, "views.json");
    this.statusFile = join(opts.home, "status.json");
    try {
      if (existsSync(this.statusFile)) this.savedStatus = JSON.parse(readFileSync(this.statusFile, "utf8"));
    } catch {}
    this.queueFile = join(opts.home, "queue.json");
    try {
      if (existsSync(this.queueFile)) this.queue = JSON.parse(readFileSync(this.queueFile, "utf8"));
    } catch {}
    this.now = opts.now ?? (() => new Date().toISOString());
    if (existsSync(this.viewsFile)) this.views = JSON.parse(readFileSync(this.viewsFile, "utf8"));
    this.autoFile = join(opts.home, "machines.json");
    if (existsSync(this.autoFile)) for (const id of (JSON.parse(readFileSync(this.autoFile, "utf8")).connected ?? []) as string[]) this.autoconnect.add(id);
    const sf = join(opts.home, "sessions.json");
    if (existsSync(sf))
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(sf, "utf8")) as Record<string, unknown>))
        this.sessions[k] = typeof v === "string" ? { id: v } : (v as { id: string; path?: string });
    this.machines.set("local", this.newMachine({ id: "local", label: "Local", target: "local", local: true, state: "online" }, opts.backend));
  }

  private saveAutoconnect() {
    writeFileSync(this.autoFile, JSON.stringify({ connected: [...this.autoconnect] }, null, 2));
  }

  private newMachine(meta: HMachine, backend?: TerminalBackend): Machine {
    return { meta, backend, workspaces: [], tabs: [], panes: [], layouts: {}, sigs: {}, lastPoll: 0, failedPolls: 0 };
  }

  async start(pollMs = 1500) {
    await this.reloadMachines();
    this.watch(this.machines.get("local")!);
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), pollMs);
    this.machinesTimer = setInterval(() => void this.reloadMachines().catch(() => {}), this.opts.machinesPollMs ?? 15_000);
  }

  private machinesTimer?: ReturnType<typeof setInterval>;

  /** Sync with Herdr's saved machine list: add new profiles, drop removed ones. Keys stay stable per profile. */
  async reloadMachines() {
    const saved = await this.opts.backend.savedMachines();
    const ids = new Set(saved.map((s) => s.id));
    let changed = false;
    for (const [key, m] of this.machines)
      if (!m.meta.local && !ids.has(m.profileId!)) {
        m.stopWatch?.();
        m.remote?.close(true);
        this.machines.delete(key);
        this.autoconnect.delete(m.profileId!);
        changed = true;
      }
    const known = new Set([...this.machines.values()].map((m) => m.profileId));
    const taken = new Set(this.machines.keys());
    for (const s of saved) {
      if (known.has(s.id)) continue;
      const key = machineKey(s.label, taken);
      const m = this.newMachine({ id: key, label: s.label, target: s.target, local: false, state: "offline", session: s.session });
      m.profileId = s.id;
      if (this.opts.remote) {
        const r = this.opts.remote({ key, label: s.label, target: s.target, session: s.session }, () => this.remoteChanged(key));
        m.remote = r.remote;
        m.makeBackend = r.backend;
      } else m.meta.error = "remote machines are not enabled";
      this.machines.set(key, m);
      changed = true;
      // stay connected across restarts: machines the user connected, or whose SSH connection is still up
      if (m.remote && (this.autoconnect.has(s.id) || m.remote.masterAlive?.())) void m.remote.connect().catch(() => {});
    }
    if (changed) this.publish(true);
  }

  /** Save a new SSH machine in Herdr (so the Herdr TUI has it too) and connect to it. */
  async addMachine(target: string, label?: string, session?: string): Promise<HMachine> {
    const t = target.trim();
    if (!t || /\s/.test(t) || t.startsWith("-")) throw new AfError("bad_target", "give an SSH target such as myhost, user@host or ssh://user@host:2222");
    const before = new Set([...this.machines.values()].map((m) => m.profileId));
    try {
      // without a terminal, herdr machine add needs a label: default to the host name
      const host = t.replace(/^ssh:\/\//, "").replace(/^.*@/, "").replace(/:\d+$/, "");
      await this.opts.backend.addMachine(t, label?.trim() || host, session?.trim() || undefined);
    } catch (e) {
      throw new AfError("machine_add_failed", (e as Error).message, 422);
    }
    await this.reloadMachines();
    const added = [...this.machines.values()].find((m) => !m.meta.local && !before.has(m.profileId));
    if (!added) throw new AfError("machine_add_failed", "Herdr saved nothing new; is the machine already in the list?", 409);
    await this.connect(added.meta.id);
    return added.meta;
  }

  /** Remove a machine from Herdr's list. Its remote Herdr server and sessions keep running. */
  async removeMachine(key: string) {
    const m = this.machines.get(key);
    if (!m) throw new AfError("unknown_machine", `no machine ${key}`, 404);
    if (m.meta.local) throw new AfError("local_machine", "the local machine cannot be removed");
    m.remote?.close(true);
    this.autoconnect.delete(m.profileId!);
    this.saveAutoconnect();
    await this.opts.backend.removeMachine(m.profileId!);
    await this.reloadMachines();
    await this.refresh();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.machinesTimer);
    clearTimeout(this.debounce);
    for (const m of this.machines.values()) {
      m.stopWatch?.();
      m.remote?.close(false); // the SSH connections stay up for the next server run
    }
  }

  /** Called when an agent's turn ends (Herdr status working → done or idle). */
  onTurnEnd(fn: (t: { pane: string; machine: string; agent: string; cwd: string; started?: number; ended: number }) => void) {
    this.turnListeners.add(fn);
    return () => this.turnListeners.delete(fn);
  }
  private turnListeners = new Set<(t: { pane: string; machine: string; agent: string; cwd: string; started?: number; ended: number }) => void>();

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private watch(m: Machine) {
    m.stopWatch?.();
    m.stopWatch = m.backend?.watchLifecycle(() => {
      clearTimeout(this.debounce);
      m.lastPoll = 0;
      this.debounce = setTimeout(() => void this.refresh(), 80);
    });
  }

  private remoteChanged(key: string) {
    const m = this.machines.get(key)!;
    const r = m.remote!;
    const prev = m.meta;
    m.meta = { ...m.meta, state: r.state, error: r.error };
    const say = this.opts.notify;
    if (say) {
      const src = `machine:${key}`;
      if (r.state === "error" && (prev.state !== "error" || prev.error !== r.error)) say("error", src, `${m.meta.label}: ${r.error ?? "connection failed"}`, `ssh ${m.meta.target} — retrying automatically`);
      else if (r.state === "connecting" && prev.state === "online") say("warn", src, `Lost the connection to ${m.meta.label}; reconnecting`, r.error);
      else if (r.state === "online" && prev.state !== "online" && m.troubled) say("info", src, `Connected to ${m.meta.label} again`);
      if (r.state === "error" || (r.state === "connecting" && prev.state === "online")) m.troubled = true;
      if (r.state === "online" || r.state === "offline") m.troubled = false;
    }
    if (r.state === "online" && !m.backend && m.makeBackend) {
      m.backend = m.makeBackend();
      this.watch(m);
      m.lastPoll = 0;
      void this.refresh();
    }
    if (r.state !== "online" && m.backend) {
      m.stopWatch?.();
      m.stopWatch = undefined;
      m.backend = undefined;
    }
    // while reconnecting, keep showing the last known workspaces (the UI dims them); forget them on disconnect
    if (r.state === "offline") {
      m.workspaces = [];
      m.tabs = [];
      m.panes = [];
      m.layouts = {};
      m.sigs = {};
    }
    this.publish(true);
  }

  /** Connect a remote machine (no-op for local). Resolves with its state. */
  async connect(key: string): Promise<HMachine> {
    const m = this.machines.get(key);
    if (!m) throw new AfError("unknown_machine", `no machine ${key}. Known: ${[...this.machines.keys()].join(", ")}`, 404);
    if (m.remote) {
      if (m.profileId && !this.autoconnect.has(m.profileId)) {
        this.autoconnect.add(m.profileId);
        this.saveAutoconnect();
      }
      await m.remote.connect().catch(() => {});
      await this.refresh();
    }
    return m.meta;
  }

  /** Stop using a remote machine: end its SSH connection and stop reconnecting it on start. */
  async disconnect(key: string): Promise<HMachine> {
    const m = this.machines.get(key);
    if (!m) throw new AfError("unknown_machine", `no machine ${key}`, 404);
    if (m.meta.local) throw new AfError("local_machine", "the local machine is always connected");
    if (m.profileId) this.autoconnect.delete(m.profileId);
    this.saveAutoconnect();
    m.remote?.close(true);
    await this.refresh();
    return m.meta;
  }

  /** Re-read Herdr on every connected machine. Concurrent calls collapse into one follow-up refresh. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.again = false;
          await Promise.all([...this.machines.values()].map((m) => this.refreshMachine(m)));
          this.publish();
          void this.drainQueues();
        } while (this.again);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /**
   * Which agents show a question or approval on screen though Herdr does not report them blocked (gemini is "idle"
   * during its folder-trust dialog and "working" during its ask_user dialog; Herdr misses some claude dialogs too).
   * Every 2.5 s here, 6 s on remote machines; a screen read is one socket call.
   */
  /**
   * How many background tasks each claude pane waits on. Checked when a pane's turn ends (working → done/idle) or
   * is seen first, and every 3 s while it waits on some: a background task starts only during a turn. Pane ids
   * here are Herdr's own (unprefixed), as in the snapshot.
   */
  private async checkBackground(m: Machine, panes: { id: string; agent?: string; agentStatus: string }[]) {
    const state = (m.background ??= new Map());
    const prev = m.since;
    const due = panes.filter((x) => {
      if (x.agent !== "claude" || (x.agentStatus !== "done" && x.agentStatus !== "idle")) return false;
      const was = prev?.get(x.id)?.status;
      const st = state.get(x.id);
      return !st || was === "working" || (st.n > 0 && Date.now() - st.at >= 3000);
    });
    for (const x of panes) if (x.agent !== "claude" || x.agentStatus === "working" || x.agentStatus === "blocked") state.delete(x.id);
    for (const id of state.keys()) if (!panes.some((x) => x.id === id)) state.delete(id);
    if (due.length) {
      const dirs = new Map<string, string>();
      await Promise.all(
        due.map(async (x) => {
          const procs = await m.backend!.processes(x.id).catch(() => []);
          const pid = procs.find((q) => /(^|\/)claude(\.exe)?$/.test(q.argv[0] ?? ""))?.pid ?? procs.find((q) => q.argv.some((a) => /claude/.test(a)))?.pid;
          const how = this.opts.background ?? BACKGROUND;
          const sid = pid ? how.session(pid) : undefined;
          const dir = sid ? (this.taskDirs.get(sid) ?? how.dir(sid)) : undefined;
          if (sid && dir) this.taskDirs.set(sid, dir);
          if (dir) dirs.set(x.id, dir);
          else state.set(x.id, { n: 0, at: Date.now() });
        }),
      );
      const counts = await (this.opts.background ?? BACKGROUND).count([...new Set(dirs.values())]);
      for (const [pane, dir] of dirs) state.set(pane, { n: counts.get(dir) ?? 0, at: Date.now() });
    }
    return new Map([...state].map(([k, v]) => [k, v.n]));
  }
  private taskDirs = new Map<string, string>();

  /**
   * The same on a remote machine, without holding up the refresh (an SSH round trip): due panes are marked pending,
   * one script runs over the machine's connection (background.ts remoteCheckScript), and its answer is applied on
   * the next refresh, which it starts. Rechecked every 6 s while a pane waits on background work. A failed or slow
   * check counts 0, so nothing waits forever.
   */
  private checkBackgroundRemote(m: Machine, panes: { id: string; agent?: string; agentStatus: string }[]) {
    const state = (m.background ??= new Map());
    const pending = (m.bgPending ??= new Set());
    const prev = m.since;
    for (const x of panes) if (x.agent !== "claude" || x.agentStatus === "working" || x.agentStatus === "blocked") (state.delete(x.id), pending.delete(x.id));
    for (const id of state.keys()) if (!panes.some((x) => x.id === id)) state.delete(id);
    // the status change a check is for: once a check for it has answered, it is not due again for it (the turn end
    // waits for the answer, so the saved status still says "working" when the answer is applied)
    const change = (id: string) => `${prev?.get(id)?.status}@${prev?.get(id)?.at ?? ""}`;
    const due = panes.filter((x) => {
      if (x.agent !== "claude" || (x.agentStatus !== "done" && x.agentStatus !== "idle") || pending.has(x.id)) return false;
      const was = prev?.get(x.id)?.status;
      const st = state.get(x.id);
      return !st || (was === "working" && st.for !== change(x.id)) || (st.n > 0 && Date.now() - st.at >= 6000);
    });
    if (due.length && !m.bgRunning && m.remote && m.backend) {
      for (const x of due) pending.add(x.id);
      const forChange = new Map(due.map((x) => [x.id, change(x.id)]));
      m.bgRunning = true;
      const remote = m.remote;
      const backend = m.backend;
      void (async () => {
        const counts = new Map<string, number>();
        try {
          const entries = await Promise.all(due.map(async (x) => ({ pane: x.id, pids: (await backend.processes(x.id).catch(() => [])).map((q) => q.pid) })));
          const r = await remote.exec(remoteCheckScript(entries), { timeoutMs: 15_000 });
          for (const [k, v] of parseRemoteCounts(r.out.toString())) counts.set(k, v);
        } catch {}
        for (const x of due) {
          state.set(x.id, { n: counts.get(x.id) ?? 0, at: Date.now(), for: forChange.get(x.id) });
          pending.delete(x.id);
        }
        m.bgRunning = false;
        void this.changed(m.meta.id);
      })();
    }
    return new Map([...state].map(([k, v]) => [k, v.n]));
  }

  /**
   * The agent's work has really ended: it is not working, not asking anything, not just given a prompt it has
   * not started on, and not waiting on background work (a Monitor, a background command). For teams and anything
   * else that waits for an agent to finish.
   */
  settled(pane: string) {
    const p = this.model.panes.find((x) => x.id === pane);
    return !!p && !!p.agent && !p.asking && !p.background && (p.agentStatus === "done" || p.agentStatus === "idle") && !this.busy(p);
  }

  private async checkAsking(m: Machine) {
    const every = m.meta.local ? 2500 : 6000;
    if (m.askingBusy || Date.now() - (m.askingAt ?? 0) < every) return;
    m.askingBusy = true;
    m.askingAt = Date.now();
    try {
      const next = new Map<string, string>();
      for (const p of m.panes) {
        if (!p.agent || p.agentStatus === "blocked" || p.scrolled) continue;
        const st = await this.screenState(p.id).catch(() => ({}) as { menu?: Menu });
        if (!st.menu) continue;
        const q = [...st.menu.question, ...(st.menu.code ?? [])]
          .join(" ")
          .replace(/[─-╿▀-▟]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        next.set(p.id, (q || st.menu.options.map((o) => o.label).join(" / ")).slice(0, 300) || "a question");
      }
      const changed = next.size !== (m.asking?.size ?? 0) || [...next].some(([k, v]) => m.asking?.get(k) !== v);
      m.asking = next;
      if (changed) {
        m.panes = m.panes.map((x) => ({ ...x, asking: next.get(x.id) || undefined }));
        m.workspaces = m.workspaces.map((ws) => ({ ...ws, agentStatus: workspaceStatus(m.panes.filter((x) => x.workspaceId === ws.id), ws.agentStatus) }));
        this.publish();
      }
    } finally {
      m.askingBusy = false;
    }
  }

  private async refreshMachine(m: Machine) {
    if (!m.backend) return; // remote and not connected: the last known model stays until it disconnects
    if (!m.meta.local && Date.now() - m.lastPoll < (this.opts.remotePollMs ?? 3000)) return;
    m.lastPoll = Date.now();
    try {
      const key = m.meta.id;
      const p = (id: string) => (key === "local" ? id : `${key}${MACHINE_SEP}${id}`);
      const snap = await m.backend.snapshot();
      const layouts: Record<string, HLayout> = {};
      const stale: string[] = [];
      for (const t of snap.tabs) {
        const old = m.layouts[p(t.id)];
        if (old && m.sigs[t.id] === snap.layoutSigs[t.id]) layouts[p(t.id)] = old;
        else stale.push(t.id);
      }
      const fresh = await Promise.all(stale.map((id) => m.backend!.exportLayout(id).catch(() => undefined)));
      const prefixTree = (n: LayoutNode): LayoutNode => (n.type === "pane" ? { type: "pane", paneId: p(n.paneId) } : { ...n, first: prefixTree(n.first), second: prefixTree(n.second) });
      stale.forEach((id, i) => {
        const l = fresh[i];
        if (!l) return;
        layouts[p(id)] = { ...l, tabId: p(id), root: prefixTree(l.root), focusedPaneId: l.focusedPaneId ? p(l.focusedPaneId) : undefined };
        m.sigs[id] = snap.layoutSigs[id] ?? "";
      });
      for (const id of Object.keys(m.sigs)) if (!snap.tabs.some((t) => t.id === id)) delete m.sigs[id];
      m.workspaces = snap.workspaces.map((w) => ({ ...w, machine: key, id: p(w.id), activeTabId: w.activeTabId ? p(w.activeTabId) : undefined }));
      m.tabs = snap.tabs.map((t) => ({ ...t, id: p(t.id), workspaceId: p(t.workspaceId) }));
      // background work claude still waits on after its turn ended (local only: see background.ts)
      const bg = m.meta.local ? await this.checkBackground(m, snap.panes) : m.remote ? this.checkBackgroundRemote(m, snap.panes) : new Map<string, number>();
      const bgPending = m.bgPending ?? new Set<string>();
      // when each agent's status changed: "finished" in Needs you means finished after the user last looked.
      // Saved across restarts: a status that changed while the server was down changed now. The status tracked is
      // the effective one: done/idle while background work runs counts as "background", not done.
      const since = (m.since ??= new Map(Object.entries(this.savedStatus[key] ?? {})));
      const active = (m.activeSince ??= new Map());
      const now = new Date().toISOString();
      let changed = false;
      for (const x of snap.panes) {
        const eff = effectiveStatus(x.agentStatus, bg.get(x.id) ?? 0);
        const was = since.get(x.id);
        // a remote pane just went done while its background check is on its way: not finished until it answers
        if (bgPending.has(x.id) && (eff === "done" || eff === "idle") && (was?.status === "working" || was?.status === "background")) continue;
        if (eff === "working" || eff === "background") {
          if (!active.has(x.id)) active.set(x.id, was && was.status !== eff ? Date.now() : (Date.parse(was?.at ?? "") || Date.now()));
        }
        if (!was || was.status !== eff) {
          since.set(x.id, { status: eff, at: was ? now : undefined });
          changed = true;
          // the work ended (working or waiting on background work → done/idle): tell who wants to know, with when it
          // began. Wake-ups between monitor events (background → working → background) are not ends.
          if ((was?.status === "working" || was?.status === "background") && x.agent && (eff === "done" || eff === "idle")) {
            const started = active.get(x.id);
            for (const l of this.turnListeners) l({ pane: p(x.id), machine: key, agent: x.agent, cwd: x.cwd, started, ended: Date.parse(now) });
          }
        }
        if (eff !== "working" && eff !== "background") active.delete(x.id);
      }
      for (const id of since.keys())
        if (!snap.panes.some((x) => x.id === id)) {
          since.delete(id);
          active.delete(id);
          changed = true;
        }
      if (changed) this.saveStatus(key, since);
      m.panes = snap.panes.map((x) => ({ ...x, machine: key, id: p(x.id), tabId: p(x.tabId), workspaceId: p(x.workspaceId), statusAt: since.get(x.id)?.at, asking: m.asking?.get(p(x.id)) || undefined, ...(bg.get(x.id) ? { background: bg.get(x.id) } : {}) }));
      m.workspaces = m.workspaces.map((ws) => ({ ...ws, agentStatus: workspaceStatus(m.panes.filter((x) => x.workspaceId === ws.id), ws.agentStatus) }));
      void this.checkAsking(m);
      m.layouts = layouts;
      if (m.meta.local && m.failedPolls > 0) this.opts.notify?.("info", "herdr", "Herdr is responding again");
      m.failedPolls = 0;
      if (m.meta.local) {
        // forget viewers whose pane is gone
        const live = new Set(m.panes.map((x) => x.id));
        let dropped = false;
        for (const id of Object.keys(this.views))
          if (!live.has(id)) {
            delete this.views[id];
            dropped = true;
          }
        if (dropped) this.saveViews();
      }
    } catch (e) {
      m.failedPolls++;
      if (m.remote && m.failedPolls >= 2) void m.remote.verify?.();
      if (m.meta.local && m.failedPolls === 1) this.opts.notify?.("error", "herdr", "Herdr is not responding", `${(e as Error).message} — is the Herdr server running?`);
      if (m.failedPolls === 1 || m.failedPolls % 20 === 0) console.error(`herdr refresh (${m.meta.id}):`, (e as Error).message);
    }
  }

  private publish(force = false) {
    const ms = [...this.machines.values()];
    this.model = {
      machines: ms.map((m) => m.meta),
      workspaces: ms.flatMap((m) => m.workspaces),
      tabs: ms.flatMap((m) => m.tabs),
      panes: ms.flatMap((m) => m.panes),
      layouts: Object.assign({}, ...ms.map((m) => m.layouts)),
    };
    const json = JSON.stringify([this.model, this.views, this.queue]);
    if (force || json !== this.lastJson) {
      this.lastJson = json;
      for (const l of this.listeners) l();
    }
  }

  private saveViews() {
    writeFileSync(this.viewsFile, JSON.stringify(this.views, null, 2));
  }

  /** Which machine and backend an id belongs to, and the id Herdr knows it by. */
  route(id: string) {
    const { machine, raw } = splitId(id);
    const m = this.machines.get(machine);
    if (!m) throw new AfError("unknown_machine", `no machine ${machine}`, 404);
    if (!m.backend) throw new AfError("machine_offline", `${m.meta.label} is not connected${m.meta.error ? `: ${m.meta.error}` : ""}`, 503);
    const p = (x: string) => (machine === "local" ? x : `${machine}${MACHINE_SEP}${x}`);
    return { m, backend: m.backend, raw, local: m.meta.local, prefix: p };
  }

  private pane(id: string) {
    const p = this.model.panes.find((x) => x.id === id);
    if (!p) throw new AfError("unknown_pane", `no Herdr pane ${id}. Run af ls to see panes.`, 404);
    return p;
  }

  private changed(machine = "local") {
    const m = this.machines.get(machine);
    if (m) m.lastPoll = 0;
    this.lastJson = "";
    return this.refresh();
  }

  // -------------------------------------------------------------------------------------------
  // operations (used by the UI and by agents through the af CLI)

  async split(pane: string, direction: SplitDirection, opts: { cwd?: string; ratio?: number } = {}) {
    const base = this.pane(pane);
    const r = this.route(pane);
    const res = await r.backend.splitPane(r.raw, direction, opts.cwd ?? base.cwd, r.local ? this.opts.paneEnv() : {}, opts.ratio);
    await this.changed(r.m.meta.id);
    return { paneId: r.prefix(res.paneId), tabId: r.prefix(res.tabId) };
  }

  async close(pane: string) {
    this.pane(pane);
    const r = this.route(pane);
    await r.backend.closePane(r.raw);
    if (this.views[pane]) {
      delete this.views[pane];
      this.saveViews();
    }
    await this.changed(r.m.meta.id);
  }

  async newTab(workspaceId: string, cwd?: string) {
    const ws = this.model.workspaces.find((w) => w.id === workspaceId);
    if (!ws) throw new AfError("unknown_workspace", `no Herdr workspace ${workspaceId}`, 404);
    const r = this.route(workspaceId);
    const anyPane = this.model.panes.find((p) => p.workspaceId === workspaceId);
    const res = await r.backend.createTab(r.raw, cwd ?? anyPane?.cwd ?? (r.local ? (process.env.HOME ?? "/") : (r.m.remote?.home ?? "/")), "shell", r.local ? this.opts.paneEnv() : {});
    await this.changed(r.m.meta.id);
    return { paneId: r.prefix(res.paneId), tabId: r.prefix(res.tabId) };
  }

  async newWorkspace(label: string, cwd: string | undefined, machine = "local") {
    const m = this.machines.get(machine);
    if (!m?.backend) throw new AfError("machine_offline", `${machine} is not connected`, 503);
    let dir = cwd?.trim() || (m.meta.local ? (process.env.HOME ?? "/") : (m.remote?.home ?? "~"));
    if (m.meta.local && !existsSync(dir)) throw new AfError("bad_cwd", `${dir} does not exist`);
    if (!m.meta.local) {
      if (dir === "~" || dir.startsWith("~/")) dir = `${m.remote?.home ?? ""}${dir.slice(1)}`;
      const r = await m.remote!.exec(`test -d ${sq(dir)} && echo ok`);
      if (r.out.toString().trim() !== "ok") throw new AfError("bad_cwd", `${dir} does not exist on ${m.meta.label}`);
    }
    const r = await m.backend.createWorkspace(label.trim() || basename(dir) || "workspace", dir);
    await this.changed(machine);
    const p = (x: string) => (machine === "local" ? x : `${machine}${MACHINE_SEP}${x}`);
    return { workspaceId: p(r.workspaceId), tabId: p(r.tabId), paneId: p(r.paneId) };
  }

  /** Rename a workspace (in Herdr, so the Herdr TUI shows the new name too). */
  async renameWorkspace(workspaceId: string, label: string) {
    if (!this.model.workspaces.some((w) => w.id === workspaceId)) throw new AfError("unknown_workspace", `no Herdr workspace ${workspaceId}`, 404);
    const name = label.replace(/\s+/g, " ").trim();
    if (!name) throw new AfError("empty_name", "a workspace needs a name");
    if (name.length > 80) throw new AfError("long_name", "keep the name under 80 characters");
    const r = this.route(workspaceId);
    await r.backend.renameWorkspace(r.raw, name);
    await this.changed(r.m.meta.id);
    return { workspace: workspaceId, label: name };
  }

  /** Close a workspace and stop everything running in it. */
  async closeWorkspace(workspaceId: string) {
    if (!this.model.workspaces.some((w) => w.id === workspaceId)) throw new AfError("unknown_workspace", `no Herdr workspace ${workspaceId}`, 404);
    const r = this.route(workspaceId);
    try {
      await r.backend.closeWorkspace(r.raw);
    } catch (e) {
      // a repo workspace with linked worktree workspaces must be closed as a group
      if (!/group/i.test((e as Error).message)) throw new AfError("close_failed", (e as Error).message);
      await r.backend.closeWorkspace(r.raw, true);
    }
    for (const id of Object.keys(this.views)) if (!this.model.panes.some((p) => p.id === id && p.workspaceId !== workspaceId)) delete this.views[id];
    this.saveViews();
    await this.changed(r.m.meta.id);
  }

  async closeTab(tabId: string) {
    const r = this.route(tabId);
    await r.backend.closeTab(r.raw);
    await this.changed(r.m.meta.id);
  }

  async setRatio(tabId: string, path: boolean[], ratio: number) {
    if (!(ratio > 0.05 && ratio < 0.95)) throw new AfError("bad_ratio", "ratio must be between 0.05 and 0.95");
    const r = this.route(tabId);
    await r.backend.setSplitRatio(r.raw, path, ratio);
    await this.changed(r.m.meta.id);
  }

  async prompt(pane: string, text: string) {
    this.pane(pane);
    const r = this.route(pane);
    // typed text + Enter would answer a question, approval or notice on screen (Herdr does not always see them)
    const st = await this.screenState(pane);
    if (st.menu || st.overlay) throw new AfError("agent_asking", "the agent is showing a question or a notice; answer it first", 409);
    await r.backend.prompt(r.raw, text);
    this.promptedAt.set(pane, Date.now());
    if (this.pane(pane).agent === "gemini") await this.submitIfLeft(pane, text);
  }

  /**
   * gemini takes an Enter that comes right after pasted text as part of the paste, so a prompt can stay in its box
   * unsent (seen with Gemini CLI 0.66 right after it starts). If the box still holds the start of the text a moment
   * later, press Enter once more.
   */
  private async submitIfLeft(pane: string, text: string) {
    const p = this.pane(pane);
    const r = this.route(pane);
    const norm = (t: string) => t.replace(/\s+/g, " ").trim();
    const head = norm(text).slice(0, 24);
    // the box can read empty for a moment before the pasted text is drawn: watch it for a while, and press Enter
    // only when the text has stayed in it for half a second (being sent, it leaves at once)
    const until = Date.now() + (this.opts.submitCheckMs ?? 3000);
    let seenAt = 0;
    while (Date.now() < until) {
      await Bun.sleep(200);
      const box = inputText(p.agent, await r.backend.readScreen(r.raw, true).catch(() => ""));
      if (box === undefined) return; // the box is gone: the agent took it (or shows something else)
      if (box && norm(box).startsWith(head)) {
        if (!seenAt) seenAt = Date.now();
        else if (Date.now() - seenAt >= 500) return void (await r.backend.sendKeys(r.raw, ["enter"]));
      } else seenAt = 0;
    }
  }


  /**
   * Send a message into the agent's running turn now, as its own "send now" does (see STEER_NOW): type it with
   * Enter, then, when the agent shows it waiting, press its send-now key. An agent that was not working just gets
   * the message.
   */
  async steerNow(pane: string, text: string) {
    const p = this.pane(pane);
    await this.prompt(pane, text);
    const how = STEER_NOW[p.agent ?? ""];
    if (!how) return { sentNow: true };
    const r = this.route(pane);
    for (let i = 0; i < (this.opts.steerPolls ?? 20); i++) {
      await Bun.sleep(150);
      if (how.waiting.test(await r.backend.readScreen(r.raw))) {
        if (!how.keys.length) return { sentNow: false }; // the agent holds it until its turn ends (gemini)
        await r.backend.sendKeys(r.raw, how.keys);
        return { sentNow: true };
      }
    }
    return { sentNow: false }; // taken in already (codex between tool calls), or the agent was not working
  }

  /**
   * Free to be typed to: an agent pane that is not working, not asking anything, and was not just given a prompt it
   * has not started on yet. (Typing also checks the screen for a menu or notice: see prompt.)
   */
  isFree(pane: string) {
    const p = this.model.panes.find((x) => x.id === pane);
    return !!p && !!p.agent && !p.asking && !p.scrolled && !this.busy(p);
  }

  /** When agent-flow last typed a prompt into the pane (ms), if it did. */
  promptedAtMs(pane: string) {
    return this.promptedAt.get(pane);
  }

  /** Working, asking, or just given a prompt that Herdr has not seen it start on yet. */
  private busy(p: HPane) {
    if (p.agentStatus === "working" || p.agentStatus === "blocked") return true;
    const at = this.promptedAt.get(p.id);
    return !!at && Date.now() - at < 15_000 && !(p.statusAt && Date.parse(p.statusAt) >= at);
  }

  // -------------------------------------------------------------------------------------------
  // the message queue: what the user sends while an agent works waits here, and goes out when the turn ends.
  // Steering sends it at once: each agent takes text typed during a turn into that turn (claude and omp after
  // the current tool call, codex right away).

  /** Send now if the agent is free, else queue it for the end of its turn (or steer: send now regardless). */
  async send(pane: string, body: string, files: string[], mode: "auto" | "queue" | "steer" = "auto") {
    const p = this.pane(pane);
    if (!p.agent) throw new AfError("no_agent", `pane ${pane} has no agent to prompt`);
    const text = composePrompt(body, files);
    if (!text) throw new AfError("empty", "nothing to send");
    const busy = this.busy(p) || (this.queue[pane]?.length ?? 0) > 0;
    if (mode === "steer" && this.busy(p)) return { sent: text, ...(await this.steerNow(pane, text)) };
    if (mode === "queue" || (mode === "auto" && busy)) {
      const item: QueuedMessage = { id: Math.random().toString(36).slice(2, 10), body: body.trim(), files, at: this.now() };
      (this.queue[pane] ??= []).push(item);
      this.saveQueue();
      return { queued: item };
    }
    await this.prompt(pane, text);
    return { sent: text };
  }

  /** Send a queued message now, into the agent's current turn. */
  async steer(pane: string, id: string) {
    const list = this.queue[pane] ?? [];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw new AfError("not_queued", "that message is not in the queue any more", 404);
    const item = list[i]!;
    const text = composePrompt(item.body, item.files);
    const p = this.pane(pane);
    // throws (and keeps it queued) if the agent is asking something
    const r = this.busy(p) ? await this.steerNow(pane, text) : (await this.prompt(pane, text), { sentNow: true });
    list.splice(i, 1);
    this.saveQueue();
    return { sent: text, ...r };
  }

  /** Take a message out of the queue (to delete it, or to edit it in the composer). */
  unqueue(pane: string, id: string) {
    const list = this.queue[pane] ?? [];
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw new AfError("not_queued", "that message is not in the queue any more", 404);
    const [item] = list.splice(i, 1);
    this.saveQueue();
    return item!;
  }

  private saveStatus(machine: string, since: Map<string, { status: string; at?: string }>) {
    this.savedStatus[machine] = Object.fromEntries(since);
    clearTimeout(this.statusSave);
    this.statusSave = setTimeout(() => {
      try {
        writeFileSync(this.statusFile, JSON.stringify(this.savedStatus));
      } catch {}
    }, 1000);
  }

  private saveQueue() {
    for (const k of Object.keys(this.queue)) if (!this.queue[k]!.length) delete this.queue[k];
    writeFileSync(this.queueFile, JSON.stringify(this.queue, null, 2));
    this.publish(true);
  }

  /** Deliver the next queued message to each agent that has finished its turn. */
  private async drainQueues() {
    for (const [pane, list] of Object.entries(this.queue)) {
      if (!list.length || this.draining.has(pane)) continue;
      const p = this.model.panes.find((x) => x.id === pane);
      if (!p) {
        // the pane is gone (not just out of sight on a disconnected machine): its queue has no one to go to
        const m = this.machines.get(splitId(pane).machine);
        if (m?.backend && m.lastPoll > 0 && m.failedPolls === 0 && (m.meta.local || m.meta.state === "online")) {
          delete this.queue[pane];
          this.saveQueue();
        }
        continue;
      }
      if (!p.agent || this.busy(p)) continue;
      // after a delivery (or a failed try), wait until the agent has taken it up (its status changed since), or 30 s
      const last = Math.max(this.queueSentAt.get(pane) ?? 0, this.promptedAt.get(pane) ?? 0);
      if (last && Date.now() - last < 30_000 && !(p.statusAt && Date.parse(p.statusAt) >= last && p.agentStatus !== "unknown")) continue;
      this.draining.add(pane);
      try {
        const item = list[0]!;
        await this.prompt(pane, composePrompt(item.body, item.files));
        this.queueSentAt.set(pane, Date.now());
        if (this.queue[pane]?.[0]?.id === item.id) this.queue[pane]!.shift();
        this.saveQueue();
      } catch (e) {
        // asking something, or unreachable: try again later
        this.queueSentAt.set(pane, Date.now());
        if ((e as AfError).code !== "agent_asking") this.opts.notify?.("warn", `queue:${pane}`, `A queued message for ${pane} could not be sent yet`, (e as Error).message);
      } finally {
        this.draining.delete(pane);
      }
    }
  }

  /** Clear what is typed in the agent's own input box (its clear keys, only when there is text: see controls.ts). */
  async clearBox(pane: string) {
    const p = this.pane(pane);
    const r = this.route(pane);
    let text: string | undefined = inputText(p.agent, await r.backend.readScreen(r.raw, true));
    if (!text) return false;
    const how = clearBoxKeys(p.agent);
    // per line: again while text is left and the last round changed it (a long draft: at most 40 rounds)
    for (let round = 0; round < (how.perLine ? 40 : 1); round++) {
      await r.backend.sendKeys(r.raw, how.keys);
      const before: string = text;
      for (let i = 0; i < 15; i++) {
        await Bun.sleep(60);
        text = inputText(p.agent, await r.backend.readScreen(r.raw, true));
        if (!text || text !== before) break;
      }
      if (!text || text === before) break;
    }
    return true;
  }

  /** Stop, rewind, clear or exit an agent, with the keys its own terminal uses for that (see controls.ts). */
  async control(pane: string, action: string) {
    const p = this.pane(pane);
    const steps = controlSteps(p.agent, action);
    const r = this.route(pane);
    for (const st of steps) {
      if ("wait" in st) await Bun.sleep(st.wait);
      else if ("clearBox" in st) await this.clearBox(pane);
      else if ("keys" in st) await r.backend.sendKeys(r.raw, st.keys);
      else {
        await r.backend.sendText(r.raw, st.text);
        await Bun.sleep(120);
        await r.backend.sendKeys(r.raw, ["enter"]);
      }
    }
    // a rewind picker or an exit changes the screen: look again soon
    this.lastJson = "";
    return { action, agent: p.agent, hint: action === "rewind" ? REWIND_HINT[p.agent ?? ""] : undefined };
  }

  async sendKeys(pane: string, keys: string[]) {
    this.pane(pane);
    const ok = keys.every((k) => /^(esc|escape|enter|tab|shift\+tab|space|up|down|left|right|backspace|pageup|pagedown|home|end|ctrl\+[a-z])$/.test(k));
    if (!ok || !keys.length) throw new AfError("bad_keys", "allowed keys: esc, enter, tab, shift+tab, space, arrows, backspace, page up/down, home, end, ctrl+<letter>");
    const r = this.route(pane);
    await r.backend.sendKeys(r.raw, keys);
  }

  /** Store an attachment where the pane's agent can read it: locally, or on the pane's remote machine. */
  async saveAttachment(pane: string, bytes: Uint8Array, name: string) {
    const r = pane ? this.route(pane) : undefined;
    if (!r || r.local) return { path: saveLocal(this.opts.home, bytes, name), name, size: bytes.length, remote: false };
    const { date, id } = stamp();
    const res = await r.m.remote!.exec(`d="$HOME/.agent-flow/attachments/${date}"; mkdir -p "$d" && cat > "$d/${id}-"${sq(name)} && echo "$d/${id}-"${sq(name)}`, { stdin: bytes, timeoutMs: 120_000 });
    const path = res.out.toString().trim();
    if (res.code !== 0 || !path) throw new AfError("upload_failed", `could not store the file on ${r.m.meta.label}: ${res.err}`);
    return { path, name, size: bytes.length, remote: true };
  }

  /** The option menu an agent is showing (a question, an approval), if any. */
  async menu(pane: string): Promise<Menu | undefined> {
    return (await this.screenState(pane)).menu;
  }

  /** What the agent shows besides its conversation: an option menu, or a panel/notice instead of its input box. */
  /** The pane's visible screen (with colour codes when `ansi`). */
  async visible(pane: string, ansi = false) {
    this.pane(pane);
    const r = this.route(pane);
    return r.backend.readScreen(r.raw, ansi);
  }

  /** Press keys in a pane (no checks: for agent-flow's own key sequences). */
  async press(pane: string, keys: string[]) {
    const r = this.route(pane);
    await r.backend.sendKeys(r.raw, keys);
  }

  /** Type text into a pane without pressing Enter. */
  async typeText(pane: string, text: string) {
    const r = this.route(pane);
    await r.backend.sendText(r.raw, text);
  }

  async screenState(pane: string): Promise<{ menu?: Menu; overlay?: Overlay }> {
    // the visible screen: "recent-unwrapped" joins full-width rows, and dialog rows are padded to full width
    const p = this.pane(pane);
    if (p.scrolled) return {}; // the viewport shows history
    const r = this.route(pane);
    const screen = await r.backend.readScreen(r.raw);
    const menu = parseMenu(screen, p.agent);
    return menu ? { menu } : { overlay: screenOverlay(screen, p.agent) };
  }

  /**
   * Pick option `index` of the menu on screen, as a user would with the arrow keys and Enter. `label` must
   * still match, so a menu that changed in the meantime is not answered by mistake. `text` fills in a
   * free-text option ("Type something.", "No, and tell Claude what to do differently").
   */
  /**
   * Pick option `index`. `key` confirms with another key the dialog names instead of Enter (claude's /model: "s to
   * use this session only"); `setting` first moves the dialog's ←/→ setting to that value (claude's effort).
   */
  async choose(pane: string, index: number, label: string, text?: string, opts: { key?: string; setting?: string } = {}) {
    const menu = await this.menu(pane);
    if (!menu) throw new AfError("no_menu", "the agent is not showing a menu any more", 409);
    const opt = menu.options[index];
    if (!opt || (label && opt.label !== label)) throw new AfError("menu_changed", "the menu changed; look again", 409);
    if (opts.key && !menu.extraKeys?.some((k) => k.key === opts.key)) throw new AfError("bad_key", `the dialog does not offer the key ${opts.key}`);
    const r = this.route(pane);
    if (opts.setting && menu.setting?.levels && opts.setting !== menu.setting.value) {
      const from = menu.setting.levels.findIndex((l) => l.toLowerCase() === menu.setting!.value.toLowerCase());
      const to = menu.setting.levels.findIndex((l) => l.toLowerCase() === opts.setting!.toLowerCase());
      if (from < 0 || to < 0) throw new AfError("bad_setting", `${opts.setting} is not one of ${menu.setting.levels.join(", ")}`);
      await r.backend.sendKeys(r.raw, Array(Math.abs(to - from)).fill(to > from ? "right" : "left"));
      await Bun.sleep(120);
    }
    const keys = keysToChoose(menu, index);
    if (opts.key) keys.splice(keys.length - 1, 1, opts.key); // the arrows, then the dialog's own key instead of Enter
    if (text?.trim() && opt.freeText) {
      if (keys.length > 1) await r.backend.sendKeys(r.raw, keys.slice(0, -1));
      await r.backend.sendText(r.raw, text.replace(/[\r\n]+/g, " ").trim());
      await r.backend.sendKeys(r.raw, ["enter"]);
    } else await r.backend.sendKeys(r.raw, keys);
    return { keys, option: opt.label };
  }

  async read(pane: string, lines = 120) {
    this.pane(pane);
    const r = this.route(pane);
    return r.backend.readPane(r.raw, lines);
  }

  terminalArgv(pane: string, mode: "control" | "observe", cols: number, rows: number) {
    const r = this.route(pane);
    return r.backend.terminalSessionArgv(r.raw, mode, cols, rows);
  }

  processes(pane: string) {
    const r = this.route(pane);
    return r.backend.processes(r.raw);
  }

  processArgv(pane: string) {
    const r = this.route(pane);
    return r.backend.processArgv(r.raw);
  }

  remoteOf(pane: string): RemoteLike | undefined {
    const { machine } = splitId(pane);
    return machine === "local" ? undefined : this.machines.get(machine)?.remote;
  }

  /** Show a file, directory, or URL: in an existing viewer pane, in a new split, or in a new tab. Local only. */
  async show(req: ShowRequest, by: string): Promise<ViewRec> {
    const target = req.target;
    for (const ref of [req.in, req.of, req.tabIn])
      if (ref && splitId(ref).machine !== "local") throw new AfError("remote_viewer", "showing files in panes on remote machines is not supported yet");
    if (!isUrl(target) && !existsSync(target)) throw new AfError("not_found", `${target} does not exist`);
    if (req.in) {
      this.pane(req.in);
      if (!this.views[req.in]) throw new AfError("not_a_viewer", `pane ${req.in} is not a viewer pane; use --split to open a new one next to it`);
      return this.register(req.in, target, by);
    }
    const cwd = isUrl(target) ? undefined : statSync(target).isDirectory() ? target : dirname(target);
    let paneId: string;
    if (req.tabIn) paneId = (await this.newTab(req.tabIn, cwd)).paneId;
    else {
      const base = req.of ?? req.pane;
      if (!base) throw new AfError("no_pane", "say where to show it: --in <viewer pane>, --of <pane> (split it), or --tab <workspace>");
      paneId = (await this.split(base, req.split ?? "right", { cwd })).paneId;
    }
    const rec = this.register(paneId, target, by);
    await this.opts.backend.runInPane(paneId, "exec af viewer");
    await this.opts.backend.renamePane(paneId, `≡ ${isUrl(target) ? target.replace(/^https?:\/\//, "").slice(0, 40) : basename(target)}`);
    await this.changed();
    return rec;
  }

  register(paneId: string, target: string, by: string): ViewRec {
    const rec = { paneId, target, by, at: this.now() };
    this.views[paneId] = rec;
    this.saveViews();
    this.publish(true);
    return rec;
  }

  rememberSession(paneId: string, id: string, path?: string) {
    this.sessions[paneId] = { id, path };
    writeFileSync(join(this.opts.home, "sessions.json"), JSON.stringify(this.sessions, null, 2));
  }

  view(paneId: string): ViewRec | undefined {
    return this.views[paneId];
  }

  /** Agent name (in a run) or pane id -> pane id. */
  resolvePane(ref: string, agentPanes: Record<string, string | undefined>) {
    if (this.model.panes.some((p) => p.id === ref)) return ref;
    const byRun = agentPanes[ref];
    if (byRun) return byRun;
    const byName = this.model.panes.find((p) => p.agentName === ref);
    if (byName) return byName.id;
    throw new AfError("unknown_pane", `no pane or agent named ${ref}. Run af ls to see panes.`, 404);
  }
}
