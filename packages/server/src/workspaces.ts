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
import { type Menu, type Overlay, keysToChoose, parseMenu, screenOverlay } from "./menu.ts";

/** What Workspaces needs from a remote connection (RemoteMachine, or a fake in tests). */
export type RemoteLike = Pick<RemoteMachine, "state" | "error" | "home" | "connect" | "close" | "exec"> & Partial<Pick<RemoteMachine, "verify" | "masterAlive">>;

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
  /** Herdr profile ids of machines the user connected: reconnected on every start until they disconnect. */
  private autoconnect = new Set<string>();
  private autoFile: string;

  constructor(private opts: WorkspacesOptions) {
    this.viewsFile = join(opts.home, "views.json");
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
        } while (this.again);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
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
      m.panes = snap.panes.map((x) => ({ ...x, machine: key, id: p(x.id), tabId: p(x.tabId), workspaceId: p(x.workspaceId) }));
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

  /** The option menu an agent is showing (a question, an approval), if any. */
  async menu(pane: string): Promise<Menu | undefined> {
    return (await this.screenState(pane)).menu;
  }

  /** What the agent shows besides its conversation: an option menu, or a panel/notice instead of its input box. */
  async screenState(pane: string): Promise<{ menu?: Menu; overlay?: Overlay }> {
    // the visible screen: "recent-unwrapped" joins full-width rows, and dialog rows are padded to full width
    const p = this.pane(pane);
    if (p.scrolled) return {}; // the viewport shows history
    const r = this.route(pane);
    const screen = await r.backend.readScreen(r.raw);
    const menu = parseMenu(screen);
    return menu ? { menu } : { overlay: screenOverlay(screen, p.agent) };
  }

  /**
   * Pick option `index` of the menu on screen, as a user would with the arrow keys and Enter. `label` must
   * still match, so a menu that changed in the meantime is not answered by mistake. `text` fills in a
   * free-text option ("Type something.", "No, and tell Claude what to do differently").
   */
  async choose(pane: string, index: number, label: string, text?: string) {
    const menu = await this.menu(pane);
    if (!menu) throw new AfError("no_menu", "the agent is not showing a menu any more", 409);
    const opt = menu.options[index];
    if (!opt || (label && opt.label !== label)) throw new AfError("menu_changed", "the menu changed; look again", 409);
    const keys = keysToChoose(menu, index);
    const r = this.route(pane);
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
