// An in-memory TerminalBackend with real workspace/tab/split-tree behavior, for tests.

import type { AgentKind, AgentStatus, HLayout, LayoutNode, SplitDirection } from "@af/core";
import type { HerdrAgentInfo, HerdrSnapshot, StartResult, TerminalBackend } from "../src/herdr.ts";

interface FPane {
  id: string;
  tabId: string;
  workspaceId: string;
  cwd: string;
  env: Record<string, string>;
  label?: string;
  agent?: { name: string; kind: AgentKind; args: string[]; status: AgentStatus };
  typed: string[];
}

export class FakeBackend implements TerminalBackend {
  workspaces = new Map<string, { id: string; label: string }>();
  tabs = new Map<string, { id: string; workspaceId: string; label: string; root: LayoutNode }>();
  panes = new Map<string, FPane>();
  prompts: { name: string; text: string }[] = [];
  envs = new Map<string, Record<string, string>>();
  blockOnStart = new Set<string>();
  failOnStart = new Set<string>();
  /** name -> how many start attempts report a busy pane first */
  busyStarts = new Map<string, number>();
  closed: string[] = [];
  ratios: { tabId: string; path: boolean[]; ratio: number }[] = [];
  private n = 0;
  private lifecycle = new Set<() => void>();

  private id(prefix: string) {
    return `${prefix}${++this.n}`;
  }
  private bump() {
    for (const f of this.lifecycle) f();
  }
  private newPane(tabId: string, workspaceId: string, cwd: string, env: Record<string, string>) {
    const id = `${workspaceId}:p${++this.n}`;
    this.panes.set(id, { id, tabId, workspaceId, cwd, env, typed: [] });
    return id;
  }

  async createWorkspace(label: string, cwd: string, env: Record<string, string> = {}) {
    const workspaceId = this.id("w");
    this.workspaces.set(workspaceId, { id: workspaceId, label });
    const tabId = `${workspaceId}:t${++this.n}`;
    const paneId = this.newPane(tabId, workspaceId, cwd, env);
    if (env.AF_AGENT) this.envs.set(env.AF_AGENT, env);
    this.tabs.set(tabId, { id: tabId, workspaceId, label: "1", root: { type: "pane", paneId } });
    this.bump();
    return { workspaceId, tabId, paneId };
  }
  async createTab(workspaceId: string, cwd: string, label: string, env: Record<string, string>) {
    const tabId = `${workspaceId}:t${++this.n}`;
    const paneId = this.newPane(tabId, workspaceId, cwd, env);
    this.tabs.set(tabId, { id: tabId, workspaceId, label, root: { type: "pane", paneId } });
    this.envs.set(label, env);
    this.bump();
    return { tabId, paneId };
  }
  async splitPane(paneId: string, direction: SplitDirection, cwd: string | undefined, env: Record<string, string>, ratio?: number) {
    const base = this.panes.get(paneId)!;
    const tab = this.tabs.get(base.tabId)!;
    const id = this.newPane(base.tabId, base.workspaceId, cwd ?? base.cwd, env);
    const replace = (n: LayoutNode): LayoutNode =>
      n.type === "pane"
        ? n.paneId === paneId
          ? { type: "split", direction, ratio: ratio ?? 0.5, first: n, second: { type: "pane", paneId: id } }
          : n
        : { ...n, first: replace(n.first), second: replace(n.second) };
    tab.root = replace(tab.root);
    this.bump();
    return { paneId: id, tabId: base.tabId };
  }
  async closePane(paneId: string) {
    const p = this.panes.get(paneId);
    if (!p) return;
    this.panes.delete(paneId);
    const tab = this.tabs.get(p.tabId)!;
    const drop = (n: LayoutNode): LayoutNode | undefined => {
      if (n.type === "pane") return n.paneId === paneId ? undefined : n;
      const a = drop(n.first);
      const b = drop(n.second);
      return a && b ? { ...n, first: a, second: b } : (a ?? b);
    };
    const root = drop(tab.root);
    if (root) tab.root = root;
    else this.tabs.delete(tab.id);
    this.bump();
  }
  async closeTab(tabId: string) {
    this.closed.push(tabId);
    for (const [k, p] of this.panes) if (p.tabId === tabId) this.panes.delete(k);
    this.tabs.delete(tabId);
    this.bump();
  }
  async closeWorkspace(workspaceId: string) {
    for (const t of [...this.tabs.values()]) if (t.workspaceId === workspaceId) await this.closeTab(t.id);
    this.workspaces.delete(workspaceId);
  }
  async startAgent(name: string, kind: AgentKind, paneId: string, args: string[]): Promise<StartResult> {
    if (this.failOnStart.has(name)) return { ok: false, code: "timeout", message: "agent did not become ready" };
    if ((this.busyStarts.get(name) ?? 0) > 0) {
      this.busyStarts.set(name, this.busyStarts.get(name)! - 1);
      return { ok: false, code: "agent_pane_busy", message: "the shell is not ready" };
    }
    const blocked = this.blockOnStart.has(name);
    const p = this.panes.get(paneId)!;
    p.agent = { name, kind, args, status: blocked ? "blocked" : "idle" };
    return blocked ? { ok: false, code: "agent_not_ready", message: "blocked during startup" } : { ok: true };
  }
  async listAgents(): Promise<HerdrAgentInfo[]> {
    return [...this.panes.values()].filter((p) => p.agent).map((p) => ({ name: p.agent!.name, paneId: p.id, tabId: p.tabId, status: p.agent!.status }));
  }
  async prompt(name: string, text: string) {
    this.prompts.push({ name, text });
  }
  keys: { target: string; keys: string[] }[] = [];
  async sendKeys(target: string, keys: string[]) {
    this.keys.push({ target, keys });
  }
  texts: { pane: string; text: string }[] = [];
  screens = new Map<string, string>();
  async sendText(pane: string, text: string) {
    this.texts.push({ pane, text });
  }
  async readPane(paneId: string) {
    return this.screens.get(paneId) ?? `screen of ${paneId}\n`;
  }
  async readScreen(paneId: string) {
    return this.screens.get(paneId) ?? `screen of ${paneId}\n`;
  }
  async paneExists(paneId: string) {
    return this.panes.has(paneId);
  }
  terminalSessionArgv() {
    return [];
  }
  async snapshot(): Promise<HerdrSnapshot> {
    return {
      workspaces: [...this.workspaces.values()].map((w, i) => ({ machine: "local", id: w.id, label: w.label, number: i + 1, agentStatus: "unknown" })),
      tabs: [...this.tabs.values()].map((t, i) => ({ id: t.id, workspaceId: t.workspaceId, label: t.label, number: i + 1 })),
      panes: [...this.panes.values()].map((p) => ({ machine: "local", id: p.id, tabId: p.tabId, workspaceId: p.workspaceId, agent: p.agent?.kind, agentName: p.agent?.name, agentStatus: p.agent?.status ?? "unknown", label: p.label, cwd: p.cwd })),
      layoutSigs: Object.fromEntries([...this.tabs.values()].map((t) => [t.id, JSON.stringify(t.root)])),
    };
  }
  async exportLayout(tabId: string): Promise<HLayout> {
    return { tabId, root: structuredClone(this.tabs.get(tabId)!.root), zoomed: false };
  }
  async setSplitRatio(tabId: string, path: boolean[], ratio: number) {
    this.ratios.push({ tabId, path, ratio });
    let n = this.tabs.get(tabId)!.root;
    for (const second of path) {
      if (n.type !== "split") throw new Error("bad path");
      n = second ? n.second : n.first;
    }
    if (n.type !== "split") throw new Error("path does not end at a split");
    n.ratio = ratio;
    this.bump();
  }
  async runInPane(paneId: string, command: string) {
    this.panes.get(paneId)!.typed.push(command);
  }
  async renameTab(tabId: string, label: string) {
    this.tabs.get(tabId)!.label = label;
  }
  async renamePane(paneId: string, label: string) {
    this.panes.get(paneId)!.label = label;
  }
  async processArgv(): Promise<string[][]> {
    return [];
  }
  saved: { id: string; label: string; target: string; session: string }[] = [];
  addFails?: string;
  async savedMachines() {
    return this.saved;
  }
  async addMachine(target: string, label?: string, session?: string) {
    if (this.addFails) throw new Error(this.addFails);
    this.saved.push({ id: `prof${this.saved.length + 1}`, label: label ?? target.replace(/^.*@/, ""), target, session: session ?? "default" });
  }
  async removeMachine(id: string) {
    this.saved = this.saved.filter((m) => m.id !== id);
  }
  watchLifecycle(onEvent: () => void) {
    this.lifecycle.add(onEvent);
    return () => this.lifecycle.delete(onEvent);
  }

  // test helpers
  agentPane(name: string) {
    return [...this.panes.values()].find((p) => p.agent?.name === name);
  }
  set(name: string, status: AgentStatus) {
    this.agentPane(name)!.agent!.status = status;
  }
  remove(name: string) {
    const p = this.agentPane(name);
    if (p) delete p.agent;
  }
  promptsTo(name: string) {
    return this.prompts.filter((p) => p.name === name).map((p) => p.text);
  }
}
