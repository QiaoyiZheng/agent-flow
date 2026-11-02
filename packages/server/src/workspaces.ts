// The live Herdr model of every machine (local, and remote machines over SSH), and viewer panes.
//
// Herdr owns the layout. This module mirrors it for the UI and `af ls`, and turns user/agent requests
// (split, close, show a file, read a pane, prompt an agent) into Herdr calls on the right machine.
// Ids from remote machines carry the machine key as a prefix ("ds03~w3:p4"); local ids have none.
// A viewer pane is an ordinary local Herdr pane that runs `af viewer`; the registry here tells the web UI
// to draw a rich file/web view for it instead.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type HLayout, type HMachine, type HPane, type HTab, type HWorkspace, type HerdrModel, type LayoutNode, type ShowRequest, type SplitDirection, type ViewRec, MACHINE_SEP, splitId } from "@af/core";
import type { TerminalBackend } from "./herdr.ts";
import { AfError } from "./orchestrator.ts";
import { saveLocal, stamp } from "./attachments.ts";
import { type RemoteMachine, machineKey, sq } from "./remote.ts";

/** What Workspaces needs from a remote connection (RemoteMachine, or a fake in tests). */
export type RemoteLike = Pick<RemoteMachine, "state" | "error" | "home" | "connect" | "close" | "exec">;

export interface WorkspacesOptions {
  home: string;
  backend: TerminalBackend;
  /** Env for panes agent-flow creates on this machine, so `af` works inside them. */
  paneEnv: () => Record<string, string>;
  /** Builds the connection and Herdr backend for a saved remote machine. */
  remote?: (spec: { key: string; label: string; target: string; session: string }, onChange: () => void) => { remote: RemoteLike; backend: () => TerminalBackend };
  now?: () => string;
  /** How often remote machines are polled (local: every refresh). */
  remotePollMs?: number;
}

interface Machine {
  meta: HMachine;
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
}

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

export class Workspaces {
  model: HerdrModel = { machines: [], workspaces: [], tabs: [], panes: [], layouts: {} };
  views: Record<string, ViewRec> = {};
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

  constructor(private opts: WorkspacesOptions) {
    this.viewsFile = join(opts.home, "views.json");
    this.now = opts.now ?? (() => new Date().toISOString());
    if (existsSync(this.viewsFile)) this.views = JSON.parse(readFileSync(this.viewsFile, "utf8"));
    const sf = join(opts.home, "sessions.json");
    if (existsSync(sf))
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(sf, "utf8")) as Record<string, unknown>))
        this.sessions[k] = typeof v === "string" ? { id: v } : (v as { id: string; path?: string });
    this.machines.set("local", this.newMachine({ id: "local", label: "Local", target: "local", local: true, state: "online" }, opts.backend));
  }

  private newMachine(meta: HMachine, backend?: TerminalBackend): Machine {
    return { meta, backend, workspaces: [], tabs: [], panes: [], layouts: {}, sigs: {}, lastPoll: 0 };
  }

  async start(pollMs = 1500) {
    const taken = new Set(["local"]);
    for (const s of await this.opts.backend.savedMachines()) {
      const key = machineKey(s.label, taken);
      const m = this.newMachine({ id: key, label: s.label, target: s.target, local: false, state: "offline", session: s.session });
      if (this.opts.remote) {
        const r = this.opts.remote({ key, ...s }, () => this.remoteChanged(key));
        m.remote = r.remote;
        m.makeBackend = r.backend;
      } else m.meta.error = "remote machines are not enabled";
      this.machines.set(key, m);
    }
    this.watch(this.machines.get("local")!);
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), pollMs);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    for (const m of this.machines.values()) {
      m.stopWatch?.();
      m.remote?.close();
    }
  }

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
    m.meta = { ...m.meta, state: r.state, error: r.error };
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
    this.publish(true);
  }

  /** Connect a remote machine (no-op for local). Resolves with its state. */
  async connect(key: string): Promise<HMachine> {
    const m = this.machines.get(key);
    if (!m) throw new AfError("unknown_machine", `no machine ${key}. Known: ${[...this.machines.keys()].join(", ")}`, 404);
    if (m.remote) {
      await m.remote.connect().catch(() => {});
      await this.refresh();
    }
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
        } while (this.again);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async refreshMachine(m: Machine) {
    if (!m.backend) {
      m.workspaces = [];
      m.tabs = [];
      m.panes = [];
      m.layouts = {};
      return;
    }
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
      m.panes = snap.panes.map((x) => ({ ...x, machine: key, id: p(x.id), tabId: p(x.tabId), workspaceId: p(x.workspaceId) }));
      m.layouts = layouts;
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
      console.error(`herdr refresh (${m.meta.id}):`, (e as Error).message);
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
    const json = JSON.stringify([this.model, this.views]);
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

  async newWorkspace(label: string, cwd: string, machine = "local") {
    const m = this.machines.get(machine);
    if (!m?.backend) throw new AfError("machine_offline", `${machine} is not connected`, 503);
    if (m.meta.local && !existsSync(cwd)) throw new AfError("bad_cwd", `${cwd} does not exist`);
    const r = await m.backend.createWorkspace(label, cwd);
    await this.changed(machine);
    const p = (x: string) => (machine === "local" ? x : `${machine}${MACHINE_SEP}${x}`);
    return { workspaceId: p(r.workspaceId), tabId: p(r.tabId), paneId: p(r.paneId) };
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
    await r.backend.prompt(r.raw, text);
  }

  async sendKeys(pane: string, keys: string[]) {
    this.pane(pane);
    const ok = keys.every((k) => /^(esc|escape|enter|tab|up|down|left|right|backspace|ctrl\+[a-z])$/.test(k));
    if (!ok || !keys.length) throw new AfError("bad_keys", "allowed keys: esc, enter, tab, arrows, backspace, ctrl+<letter>");
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

  async read(pane: string, lines = 120) {
    this.pane(pane);
    const r = this.route(pane);
    return r.backend.readPane(r.raw, lines);
  }

  terminalArgv(pane: string, mode: "control" | "observe", cols: number, rows: number) {
    const r = this.route(pane);
    return r.backend.terminalSessionArgv(r.raw, mode, cols, rows);
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
