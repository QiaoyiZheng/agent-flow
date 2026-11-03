// Herdr adapter. Everything agent-flow needs from the terminal layer goes through this interface, so the
// backend can be swapped (tmux, our own PTY server) and tests can use a fake.

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind, AgentStatus, HLayout, HPane, HTab, HWorkspace, LayoutNode, SplitDirection } from "@af/core";

export interface HerdrAgentInfo {
  name?: string;
  paneId: string;
  tabId: string;
  status: AgentStatus;
}

export type StartResult = { ok: true } | { ok: false; code: string; message: string };

export interface TerminalBackend {
  createWorkspace(label: string, cwd: string, env?: Record<string, string>): Promise<{ workspaceId: string; tabId: string; paneId: string }>;
  renameTab(tabId: string, label: string): Promise<void>;
  createTab(workspaceId: string, cwd: string, label: string, env: Record<string, string>): Promise<{ tabId: string; paneId: string }>;
  startAgent(name: string, kind: AgentKind, paneId: string, args: string[]): Promise<StartResult>;
  listAgents(): Promise<HerdrAgentInfo[]>;
  /** Type `text` into the agent's prompt and submit it. Does not wait for the turn. `name` may be a pane id. */
  prompt(name: string, text: string): Promise<void>;
  /** Send logical keys (esc, enter, up, ctrl+c) to the agent in a pane. */
  sendKeys(target: string, keys: string[]): Promise<void>;
  /** Type literal text into a pane, without Enter. */
  sendText(paneId: string, text: string): Promise<void>;
  readPane(paneId: string, lines: number): Promise<string>;
  /** The screen exactly as drawn (rows as they are, no unwrapping): for reading dialogs. */
  readScreen(paneId: string): Promise<string>;
  paneExists(paneId: string): Promise<boolean>;
  closeTab(tabId: string): Promise<void>;
  closeWorkspace(workspaceId: string, group?: boolean): Promise<void>;
  /** argv for a streaming terminal session (control or observe), used by the WebSocket bridge. */
  terminalSessionArgv(paneId: string, mode: "control" | "observe", cols: number, rows: number): string[];

  // layout (Herdr owns workspaces, tabs and split panes; agent-flow shows and edits them)
  snapshot(): Promise<HerdrSnapshot>;
  exportLayout(tabId: string): Promise<HLayout>;
  splitPane(paneId: string, direction: SplitDirection, cwd: string | undefined, env: Record<string, string>, ratio?: number): Promise<{ paneId: string; tabId: string }>;
  closePane(paneId: string): Promise<void>;
  setSplitRatio(tabId: string, path: boolean[], ratio: number): Promise<void>;
  /** Type a command into a shell pane and press Enter. */
  runInPane(paneId: string, command: string): Promise<void>;
  renamePane(paneId: string, label: string): Promise<void>;
  /** Saved remote machines (`herdr machine list`). Only meaningful on the local backend. */
  savedMachines(): Promise<SavedMachine[]>;
  /** `herdr machine add`, non-interactive: fails (with Herdr's message) if the remote needs approval to install. */
  addMachine(target: string, label?: string, session?: string): Promise<void>;
  removeMachine(profileId: string): Promise<void>;
  /** argv of the pane's foreground processes. */
  processArgv(paneId: string): Promise<string[][]>;
  /** Call `onEvent` on any workspace/tab/pane/layout lifecycle event. Returns a stop function. */
  watchLifecycle(onEvent: () => void): () => void;
}

export interface SavedMachine {
  /** Herdr's profile id. */
  id: string;
  label: string;
  target: string;
  session: string;
}

export interface HerdrSnapshot {
  workspaces: HWorkspace[];
  tabs: HTab[];
  panes: HPane[];
  /** Per tab: a signature of its pane rectangles and splits, to tell when the layout tree must be re-exported. */
  layoutSigs: Record<string, string>;
}

export const LIFECYCLE_EVENTS = [
  "workspace.created", "workspace.closed", "workspace.renamed",
  "tab.created", "tab.closed", "tab.renamed",
  "pane.created", "pane.closed", "pane.moved", "pane.exited", "pane.updated", "pane.agent_detected",
  "layout.updated",
];

function toLayoutNode(n: any): LayoutNode {
  if (n.type === "pane") return { type: "pane", paneId: n.pane_id };
  return { type: "split", direction: n.direction, ratio: n.ratio, first: toLayoutNode(n.first), second: toLayoutNode(n.second) };
}

export class HerdrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HerdrError";
  }
}

const STATUSES: AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

export class Herdr implements TerminalBackend {
  constructor(
    readonly bin = process.env.HERDR_BIN_PATH ?? "herdr",
    readonly socket = process.env.HERDR_SOCKET_PATH ?? join(homedir(), ".config/herdr/herdr.sock"),
    /** For a remote machine: how to stream its terminals (over SSH, with the remote herdr binary). */
    readonly terminalVia?: (paneId: string, mode: "control" | "observe", cols: number, rows: number) => string[],
  ) {}

  private async cli(args: string[], timeoutMs = 120_000): Promise<any> {
    const started = performance.now();
    const p = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HERDR_SOCKET_PATH: this.socket } });
    const killer = setTimeout(() => p.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(killer);
    const secs = (performance.now() - started) / 1000;
    if (secs > 5) console.warn(`[herdr] ${args.slice(0, 3).join(" ")} took ${secs.toFixed(1)}s (exit ${p.exitCode})`);
    if (p.signalCode) throw new HerdrError("timeout", `herdr ${args.slice(0, 3).join(" ")} did not finish within ${timeoutMs / 1000}s`);
    const text = (out.trim() || err.trim()).split("\n").filter(Boolean).at(-1) ?? "";
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      if (p.exitCode === 0) return {};
      throw new HerdrError("cli_failed", `herdr ${args.slice(0, 3).join(" ")} failed: ${(err || out).trim().slice(0, 300)}`);
    }
    if (json.error) throw new HerdrError(json.error.code ?? "error", json.error.message ?? JSON.stringify(json.error));
    return json.result ?? json;
  }

  private rpc(method: string, params: object = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const s = connect(this.socket);
      let buf = "";
      const timer = setTimeout(() => {
        s.destroy();
        reject(new HerdrError("timeout", `herdr ${method} timed out`));
      }, 10_000);
      s.on("connect", () => s.write(JSON.stringify({ id: "af", method, params }) + "\n"));
      s.on("data", (d) => {
        buf += d;
        const i = buf.indexOf("\n");
        if (i < 0) return;
        clearTimeout(timer);
        s.end();
        const r = JSON.parse(buf.slice(0, i));
        if (r.error) reject(new HerdrError(r.error.code, r.error.message));
        else resolve(r.result);
      });
      s.on("error", (e) => {
        clearTimeout(timer);
        reject(new HerdrError("socket", `cannot reach Herdr at ${this.socket}: ${e.message}. Is Herdr running?`));
      });
    });
  }

  async createWorkspace(label: string, cwd: string, env: Record<string, string> = {}) {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const r = await this.cli(["workspace", "create", "--cwd", cwd, "--label", label, ...envArgs, "--no-focus"]);
    return { workspaceId: r.workspace.workspace_id, tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
  }

  async createTab(workspaceId: string, cwd: string, label: string, env: Record<string, string>) {
    const envArgs = Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`]);
    const r = await this.cli(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, ...envArgs, "--no-focus"]);
    return { tabId: r.tab.tab_id, paneId: r.root_pane.pane_id };
  }

  async startAgent(name: string, kind: AgentKind, paneId: string, args: string[]): Promise<StartResult> {
    try {
      await this.cli(["agent", "start", name, "--kind", kind, "--pane", paneId, "--timeout", "60000", "--", ...args]);
      return { ok: true };
    } catch (e) {
      if (e instanceof HerdrError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }
  }

  async listAgents(): Promise<HerdrAgentInfo[]> {
    const r = await this.rpc("agent.list");
    return (r.agents ?? []).map((a: any) => ({
      name: a.name,
      paneId: a.pane_id,
      tabId: a.tab_id,
      status: STATUSES.includes(a.agent_status) ? a.agent_status : "unknown",
    }));
  }

  async prompt(name: string, text: string) {
    await this.cli(["agent", "prompt", name, text]);
  }

  async sendKeys(target: string, keys: string[]) {
    await this.cli(["agent", "send-keys", target, ...keys]);
  }

  async sendText(paneId: string, text: string) {
    await this.cli(["pane", "send-text", paneId, text]);
  }

  async readScreen(paneId: string) {
    const p = Bun.spawn([this.bin, "pane", "read", paneId, "--source", "visible"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HERDR_SOCKET_PATH: this.socket } });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  }

  async readPane(paneId: string, lines: number) {
    const p = Bun.spawn([this.bin, "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HERDR_SOCKET_PATH: this.socket } });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  }

  async paneExists(paneId: string) {
    return this.cli(["pane", "get", paneId]).then(
      () => true,
      () => false,
    );
  }

  async closeTab(tabId: string) {
    await this.cli(["tab", "close", tabId]).catch(() => {});
  }

  /** Close a workspace and everything running in it. `group` also closes its linked worktree workspaces. */
  async closeWorkspace(workspaceId: string, group = false) {
    await this.rpc("workspace.close", { workspace_id: workspaceId, close_group: group });
  }

  async snapshot(): Promise<HerdrSnapshot> {
    const s = (await this.rpc("session.snapshot")).snapshot;
    const names = new Map<string, string>((s.agents ?? []).filter((a: any) => a.name).map((a: any) => [a.pane_id, a.name]));
    const sessions = new Map<string, { kind: "path" | "id"; value: string }>(
      (s.agents ?? []).filter((a: any) => a.agent_session?.value).map((a: any) => [a.pane_id, { kind: a.agent_session.kind === "path" ? "path" : "id", value: a.agent_session.value }]),
    );
    return {
      workspaces: s.workspaces.map((w: any) => ({ machine: "local", id: w.workspace_id, label: w.label, number: w.number, activeTabId: w.active_tab_id, agentStatus: w.agent_status })),
      tabs: s.tabs.map((t: any) => ({ id: t.tab_id, workspaceId: t.workspace_id, label: t.label, number: t.number })),
      panes: s.panes.map((p: any) => ({
        machine: "local",
        id: p.pane_id,
        tabId: p.tab_id,
        workspaceId: p.workspace_id,
        agent: p.agent ?? undefined,
        agentName: names.get(p.pane_id),
        agentStatus: p.agent_status,
        label: p.label ?? undefined,
        title: p.terminal_title_stripped || undefined,
        cwd: p.foreground_cwd ?? p.cwd,
        session: sessions.get(p.pane_id),
        scrolled: (p.scroll?.offset_from_bottom ?? 0) > 0 || undefined,
      })),
      layoutSigs: Object.fromEntries(s.layouts.map((l: any) => [l.tab_id, JSON.stringify([l.zoomed, l.panes.map((p: any) => [p.pane_id, p.rect]), l.splits])])),
    };
  }

  async exportLayout(tabId: string): Promise<HLayout> {
    const l = (await this.rpc("layout.export", { tab_id: tabId })).layout;
    return { tabId, root: toLayoutNode(l.root), zoomed: !!l.zoomed, focusedPaneId: l.focused_pane_id ?? undefined };
  }

  async splitPane(paneId: string, direction: SplitDirection, cwd: string | undefined, env: Record<string, string>, ratio?: number) {
    const r = await this.rpc("pane.split", { target_pane_id: paneId, direction, cwd: cwd ?? null, env, ratio: ratio ?? null, focus: false });
    return { paneId: r.pane.pane_id as string, tabId: r.pane.tab_id as string };
  }

  async closePane(paneId: string) {
    await this.rpc("pane.close", { pane_id: paneId });
  }

  async setSplitRatio(tabId: string, path: boolean[], ratio: number) {
    await this.rpc("layout.set_split_ratio", { tab_id: tabId, path, ratio });
  }

  async runInPane(paneId: string, command: string) {
    await this.cli(["pane", "run", paneId, command]);
  }

  async renameTab(tabId: string, label: string) {
    await this.cli(["tab", "rename", tabId, label]).catch(() => {});
  }

  async renamePane(paneId: string, label: string) {
    await this.cli(["pane", "rename", paneId, label]).catch(() => {});
  }

  async processArgv(paneId: string): Promise<string[][]> {
    const r = await this.rpc("pane.process_info", { pane_id: paneId }).catch(() => undefined);
    return (r?.process_info?.foreground_processes ?? []).map((p: any) => (Array.isArray(p.argv) ? p.argv : []));
  }

  async addMachine(target: string, label?: string, session?: string) {
    const p = Bun.spawn([this.bin, "machine", "add", target, ...(label ? ["--label", label] : []), ...(session ? ["--remote-session", session] : [])], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HERDR_SOCKET_PATH: this.socket },
    });
    const killer = setTimeout(() => p.kill(), 120_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(killer);
    if (p.exitCode !== 0) throw new HerdrError("machine_add_failed", (err.trim() || out.trim() || `herdr machine add exited with ${p.exitCode}`).split("\n").slice(-4).join(" "));
  }

  async removeMachine(profileId: string) {
    const p = Bun.spawnSync([this.bin, "machine", "remove", profileId], { stdout: "pipe", stderr: "pipe", env: { ...process.env, HERDR_SOCKET_PATH: this.socket } });
    if (p.exitCode !== 0) throw new HerdrError("machine_remove_failed", p.stderr.toString().trim() || p.stdout.toString().trim());
  }

  async savedMachines() {
    const p = Bun.spawnSync([this.bin, "machine", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
    try {
      return (JSON.parse(p.stdout.toString()) as any[]).filter((m) => m.enabled).map((m) => ({ id: String(m.id), label: String(m.label), target: String(m.target), session: String(m.session ?? "default") }));
    } catch {
      return [];
    }
  }

  watchLifecycle(onEvent: () => void) {
    let stopped = false;
    let sock: ReturnType<typeof connect> | undefined;
    const open = () => {
      if (stopped) return;
      sock = connect(this.socket);
      sock.on("connect", () => sock!.write(JSON.stringify({ id: "af-watch", method: "events.subscribe", params: { subscriptions: LIFECYCLE_EVENTS.map((type) => ({ type })) } }) + "\n"));
      sock.on("data", () => onEvent());
      sock.on("close", () => setTimeout(open, 1000));
      sock.on("error", () => {});
    };
    open();
    return () => {
      stopped = true;
      sock?.destroy();
    };
  }

  terminalSessionArgv(paneId: string, mode: "control" | "observe", cols: number, rows: number) {
    if (this.terminalVia) return this.terminalVia(paneId, mode, cols, rows);
    return [this.bin, "terminal", "session", mode, paneId, ...(mode === "control" ? ["--takeover"] : []), "--cols", String(cols), "--rows", String(rows)];
  }
}
