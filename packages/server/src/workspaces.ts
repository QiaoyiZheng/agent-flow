// The live Herdr model (machines, workspaces, tabs, panes, split layouts) and viewer panes.
//
// Herdr owns the layout. This module mirrors it for the UI and `af ls`, and turns user/agent requests
// (split, close, show a file, read a pane) into Herdr calls. A viewer pane is an ordinary Herdr pane that
// runs `af viewer`; the registry here tells the web UI to draw a rich file/web view for it instead.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { HLayout, HerdrModel, ShowRequest, SplitDirection, ViewRec } from "@af/core";
import type { TerminalBackend } from "./herdr.ts";
import { AfError } from "./orchestrator.ts";

export interface WorkspacesOptions {
  home: string;
  backend: TerminalBackend;
  /** Env for panes agent-flow creates, so `af` works inside them. */
  paneEnv: () => Record<string, string>;
  now?: () => string;
}

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

export class Workspaces {
  model: HerdrModel = { machines: [], workspaces: [], tabs: [], panes: [], layouts: {} };
  views: Record<string, ViewRec> = {};
  /** Session ids of agents started by agent-flow outside runs (claude --session-id), by pane. */
  sessions: Record<string, string> = {};
  private sigs: Record<string, string> = {};
  private listeners = new Set<() => void>();
  private refreshing?: Promise<void>;
  private again = false;
  private timer?: ReturnType<typeof setInterval>;
  private stopWatch?: () => void;
  private debounce?: ReturnType<typeof setTimeout>;
  private lastJson = "";
  private viewsFile: string;
  private now: () => string;

  constructor(private opts: WorkspacesOptions) {
    this.viewsFile = join(opts.home, "views.json");
    this.now = opts.now ?? (() => new Date().toISOString());
    if (existsSync(this.viewsFile)) this.views = JSON.parse(readFileSync(this.viewsFile, "utf8"));
    const sf = join(opts.home, "sessions.json");
    if (existsSync(sf)) this.sessions = JSON.parse(readFileSync(sf, "utf8"));
  }

  async start(pollMs = 1500) {
    this.model.machines = await this.opts.backend.machines();
    await this.refresh();
    this.stopWatch = this.opts.backend.watchLifecycle(() => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => void this.refresh(), 80);
    });
    this.timer = setInterval(() => void this.refresh(), pollMs);
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.stopWatch?.();
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Re-read Herdr. Concurrent calls collapse into one follow-up refresh. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      try {
        do {
          this.again = false;
          await this.refreshOnce();
        } while (this.again);
      } catch (e) {
        console.error("herdr refresh:", (e as Error).message);
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  private async refreshOnce() {
    const snap = await this.opts.backend.snapshot();
    const layouts: Record<string, HLayout> = {};
    const stale: string[] = [];
    for (const t of snap.tabs) {
      if (this.model.layouts[t.id] && this.sigs[t.id] === snap.layoutSigs[t.id]) layouts[t.id] = this.model.layouts[t.id]!;
      else stale.push(t.id);
    }
    const fresh = await Promise.all(stale.map((id) => this.opts.backend.exportLayout(id).catch(() => undefined)));
    stale.forEach((id, i) => {
      if (fresh[i]) {
        layouts[id] = fresh[i]!;
        this.sigs[id] = snap.layoutSigs[id] ?? "";
      }
    });
    for (const id of Object.keys(this.sigs)) if (!layouts[id]) delete this.sigs[id];

    // forget viewers whose pane is gone
    const live = new Set(snap.panes.map((p) => p.id));
    let viewsChanged = false;
    for (const id of Object.keys(this.views))
      if (!live.has(id)) {
        delete this.views[id];
        viewsChanged = true;
      }
    if (viewsChanged) this.saveViews();

    this.model = { machines: this.model.machines, workspaces: snap.workspaces, tabs: snap.tabs, panes: snap.panes, layouts };
    const json = JSON.stringify([this.model, this.views]);
    if (json !== this.lastJson) {
      this.lastJson = json;
      for (const l of this.listeners) l();
    }
  }

  private saveViews() {
    writeFileSync(this.viewsFile, JSON.stringify(this.views, null, 2));
  }

  private pane(id: string) {
    const p = this.model.panes.find((x) => x.id === id);
    if (!p) throw new AfError("unknown_pane", `no Herdr pane ${id}. Run af ls to see panes.`, 404);
    return p;
  }

  private changed() {
    this.lastJson = "";
    return this.refresh();
  }

  // -------------------------------------------------------------------------------------------
  // operations (used by the UI and by agents through the af CLI)

  async split(pane: string, direction: SplitDirection, opts: { cwd?: string; ratio?: number } = {}) {
    const base = this.pane(pane);
    const r = await this.opts.backend.splitPane(pane, direction, opts.cwd ?? base.cwd, this.opts.paneEnv(), opts.ratio);
    await this.changed();
    return r;
  }

  async close(pane: string) {
    this.pane(pane);
    await this.opts.backend.closePane(pane);
    if (this.views[pane]) {
      delete this.views[pane];
      this.saveViews();
    }
    await this.changed();
  }

  async newTab(workspaceId: string, cwd?: string) {
    const ws = this.model.workspaces.find((w) => w.id === workspaceId);
    if (!ws) throw new AfError("unknown_workspace", `no Herdr workspace ${workspaceId}`, 404);
    const anyPane = this.model.panes.find((p) => p.workspaceId === workspaceId);
    const r = await this.opts.backend.createTab(workspaceId, cwd ?? anyPane?.cwd ?? process.env.HOME ?? "/", "shell", this.opts.paneEnv());
    await this.changed();
    return r;
  }

  async newWorkspace(label: string, cwd: string) {
    if (!existsSync(cwd)) throw new AfError("bad_cwd", `${cwd} does not exist`);
    const r = await this.opts.backend.createWorkspace(label, cwd);
    await this.changed();
    return r;
  }

  async closeTab(tabId: string) {
    await this.opts.backend.closeTab(tabId);
    await this.changed();
  }

  async setRatio(tabId: string, path: boolean[], ratio: number) {
    if (!(ratio > 0.05 && ratio < 0.95)) throw new AfError("bad_ratio", "ratio must be between 0.05 and 0.95");
    await this.opts.backend.setSplitRatio(tabId, path, ratio);
    await this.changed();
  }

  async read(pane: string, lines = 120) {
    this.pane(pane);
    return this.opts.backend.readPane(pane, lines);
  }

  /** Show a file, directory, or URL: in an existing viewer pane, in a new split, or in a new tab. */
  async show(req: ShowRequest, by: string): Promise<ViewRec> {
    const target = req.target;
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
    this.lastJson = "";
    for (const l of this.listeners) l();
    return rec;
  }

  rememberSession(paneId: string, session: string) {
    this.sessions[paneId] = session;
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
