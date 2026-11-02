// Herdr adapter. Everything agent-flow needs from the terminal layer goes through this interface, so the
// backend can be swapped (tmux, our own PTY server) and tests can use a fake.

import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentKind, AgentStatus } from "@af/core";

export interface HerdrAgentInfo {
  name?: string;
  paneId: string;
  tabId: string;
  status: AgentStatus;
}

export type StartResult = { ok: true } | { ok: false; code: string; message: string };

export interface TerminalBackend {
  createWorkspace(label: string, cwd: string): Promise<{ workspaceId: string; tabId: string; paneId: string }>;
  createTab(workspaceId: string, cwd: string, label: string, env: Record<string, string>): Promise<{ tabId: string; paneId: string }>;
  startAgent(name: string, kind: AgentKind, paneId: string, args: string[]): Promise<StartResult>;
  listAgents(): Promise<HerdrAgentInfo[]>;
  /** Type `text` into the agent's prompt and submit it. Does not wait for the turn. */
  prompt(name: string, text: string): Promise<void>;
  readPane(paneId: string, lines: number): Promise<string>;
  closeTab(tabId: string): Promise<void>;
  closeWorkspace(workspaceId: string): Promise<void>;
  /** argv for a streaming terminal session (control or observe), used by the WebSocket bridge. */
  terminalSessionArgv(paneId: string, mode: "control" | "observe", cols: number, rows: number): string[];
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
  ) {}

  private async cli(args: string[]): Promise<any> {
    const p = Bun.spawn([this.bin, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
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

  async createWorkspace(label: string, cwd: string) {
    const r = await this.cli(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
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

  async readPane(paneId: string, lines: number) {
    const p = Bun.spawn([this.bin, "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  }

  async closeTab(tabId: string) {
    await this.cli(["tab", "close", tabId]).catch(() => {});
  }

  async closeWorkspace(workspaceId: string) {
    await this.cli(["workspace", "close", workspaceId]).catch(() => {});
  }

  terminalSessionArgv(paneId: string, mode: "control" | "observe", cols: number, rows: number) {
    return [this.bin, "terminal", "session", mode, paneId, ...(mode === "control" ? ["--takeover"] : []), "--cols", String(cols), "--rows", String(rows)];
  }
}
