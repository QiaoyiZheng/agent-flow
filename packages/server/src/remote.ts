// A remote machine reached over SSH. One SSH master connection per machine (ControlMaster) carries:
//   - a forwarded Unix socket to the remote Herdr server, so the normal Herdr adapter (JSON API, events,
//     and the local herdr CLI with HERDR_SOCKET_PATH) works against it;
//   - `ssh <host> <remote herdr> terminal session ...` for live terminal streams (same NDJSON as local);
//   - short shell commands for reading transcripts and storing attachments.
// Nothing is installed or started on the remote machine. SSH must work without a password prompt.
//
// The connection is meant to stay up (user requirement):
//   - the master runs detached (ControlPersist=yes), so it survives agent-flow server restarts; a restarted
//     server finds it with `ssh -O check` and goes online at once;
//   - keepalives every 10s tolerate a minute of network trouble before SSH gives up;
//   - a health check every 15s (control socket and the forwarded Herdr socket) reconnects at once when either
//     is gone, and retries forever (3s, 6s, ... at most 30s) until the user disconnects.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import type { HMachine } from "@af/core";

export interface RemoteSpec {
  key: string;
  label: string;
  /** SSH target from `herdr machine list` (host alias or user@host). */
  target: string;
  /** Remote Herdr session name; "default" uses ~/.config/herdr/herdr.sock. */
  session: string;
}

export type RemoteState = HMachine["state"];

/** Quote for a POSIX shell. */
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const KEEPALIVE = ["-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=6", "-o", "TCPKeepAlive=yes"];

/** Can we talk to a Unix socket at all (the forwarded Herdr socket)? */
const socketAlive = (path: string) =>
  new Promise<boolean>((res) => {
    if (!existsSync(path)) return res(false);
    const s = netConnect(path);
    const t = setTimeout(() => (s.destroy(), res(false)), 2000);
    s.on("connect", () => (clearTimeout(t), s.end(), res(true)));
    s.on("error", () => (clearTimeout(t), res(false)));
  });

export class RemoteMachine {
  state: RemoteState = "offline";
  error?: string;
  home?: string;
  bin?: string;
  private connecting?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private healthTimer?: ReturnType<typeof setInterval>;
  private failures = 0;
  /** True while the user wants this machine connected; cleared by close(). */
  private wanted = false;
  readonly ctl: string;
  readonly sock: string;

  constructor(
    readonly spec: RemoteSpec,
    dir: string,
    private onChange: () => void,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.ctl = join(dir, `${spec.key}.ctl`);
    this.sock = join(dir, `${spec.key}.sock`);
  }

  private sshBase(extra: string[] = []) {
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", `ControlPath=${this.ctl}`, ...extra];
  }

  private set(state: RemoteState, error?: string) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.onChange();
  }

  /** Is a master connection (ours, possibly from an earlier server run) alive? */
  masterAlive() {
    if (!existsSync(this.ctl)) return false;
    return Bun.spawnSync([...this.sshBase(["-O", "check"]), this.spec.target], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  }

  /** Run a shell command on the remote machine through the master connection. */
  async exec(command: string, opts: { stdin?: Uint8Array; timeoutMs?: number } = {}) {
    const p = Bun.spawn([...this.sshBase(["-T"]), this.spec.target, command], {
      stdin: opts.stdin ? new Blob([opts.stdin as Uint8Array<ArrayBuffer>]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 20_000);
    const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr as ReadableStream<Uint8Array>).text()]);
    await p.exited;
    clearTimeout(timer);
    return { code: p.exitCode ?? -1, out: Buffer.from(out), err: err.trim() };
  }

  /** Connect (or reuse a live connection). Resolves when online; rejects with a readable reason. Keeps retrying afterwards. */
  connect(): Promise<void> {
    this.wanted = true;
    this.startHealth();
    if (this.state === "online") return Promise.resolve();
    this.connecting ??= this.doConnect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect() {
    this.set("connecting", this.error);
    clearTimeout(this.retryTimer);
    try {
      if (!this.masterAlive()) {
        rmSync(this.ctl, { force: true });
        // detached master (-f): it outlives this server process; ControlPersist keeps it after the last client
        const p = Bun.spawn(
          [...this.sshBase(["-f", "-N", "-o", "ControlMaster=yes", "-o", "ControlPersist=yes", ...KEEPALIVE]), this.spec.target],
          { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
        );
        const err = await new Response(p.stderr as ReadableStream<Uint8Array>).text();
        await p.exited;
        if (p.exitCode !== 0 || !this.masterAlive()) throw new Error(explainSsh(err, this.spec.target));
      }

      // where is Herdr on the remote side?
      const sockRel = this.spec.session && this.spec.session !== "default" ? `.config/herdr/sessions/${this.spec.session}/herdr.sock` : ".config/herdr/herdr.sock";
      if (!this.home || !this.bin) {
        const probe = await this.exec(
          `echo "$HOME"; for b in herdr "$HOME/.local/bin/herdr" "$HOME/.herdr/bin/herdr" /usr/local/bin/herdr; do if command -v "$b" >/dev/null 2>&1; then command -v "$b"; break; fi; done`,
        );
        const [home, bin] = probe.out.toString().trim().split("\n");
        if (!home) throw new Error(`could not read the remote home directory: ${probe.err}`);
        if (!bin) throw new Error("Herdr is not installed there");
        this.home = home;
        this.bin = bin;
      }
      const remoteSock = `${this.home}/${sockRel}`;

      if (!(await socketAlive(this.sock))) {
        const ok = (await this.exec(`test -S ${sq(remoteSock)} && echo ok`)).out.toString().trim() === "ok";
        if (!ok) throw new Error("the Herdr server is not running there (run `herdr` on that machine once)");
        rmSync(this.sock, { force: true });
        const spec = `${this.sock}:${remoteSock}`;
        Bun.spawnSync([...this.sshBase(["-O", "cancel", "-L", spec]), this.spec.target], { stdout: "ignore", stderr: "ignore" });
        const fwd = Bun.spawnSync([...this.sshBase(["-O", "forward", "-o", "StreamLocalBindUnlink=yes", "-L", spec]), this.spec.target], { stdout: "pipe", stderr: "pipe" });
        for (let i = 0; i < 50 && !(await socketAlive(this.sock)); i++) await Bun.sleep(100);
        if (!(await socketAlive(this.sock))) throw new Error(`could not forward the Herdr socket: ${fwd.stderr.toString().trim() || "no answer"}`);
      }
      this.failures = 0;
      this.set("online");
    } catch (e) {
      this.failures++;
      this.set("error", (e as Error).message);
      this.scheduleRetry();
      throw e;
    }
  }

  /** Something failed while using the connection: check it now, and reconnect if it is broken. */
  async verify() {
    if (!this.wanted || this.connecting) return;
    const ok = this.masterAlive() && (await socketAlive(this.sock));
    if (ok) {
      if (this.state !== "online") this.set("online");
      return;
    }
    if (this.state === "online") this.set("connecting", "connection lost; reconnecting");
    await this.connect().catch(() => {});
  }

  private startHealth() {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => void this.verify(), 15_000);
  }

  private scheduleRetry() {
    if (!this.wanted) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(30_000, 3_000 * 2 ** Math.min(this.failures - 1, 4));
    this.retryTimer = setTimeout(() => void this.connect().catch(() => {}), delay);
  }

  /** argv for a live terminal stream of a remote pane. */
  terminalArgv(paneId: string, mode: "control" | "observe", cols: number, rows: number) {
    const cmd = `${sq(this.bin ?? "herdr")} terminal session ${mode} ${sq(paneId)}${mode === "control" ? " --takeover" : ""} --cols ${cols} --rows ${rows}`;
    return [...this.sshBase(["-T", ...KEEPALIVE]), this.spec.target, cmd];
  }

  /** Stop using the machine. `hangUp` also ends the background SSH connection (Disconnect, Remove). */
  close(hangUp = false) {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.healthTimer);
    this.healthTimer = undefined;
    if (hangUp) {
      Bun.spawnSync([...this.sshBase(["-O", "exit"]), this.spec.target], { stdout: "ignore", stderr: "ignore" });
      rmSync(this.sock, { force: true });
      rmSync(this.ctl, { force: true });
    }
    this.set("offline");
  }
}

function explainSsh(stderr: string, target: string) {
  const e = stderr.trim();
  if (/Permission denied|publickey|password/i.test(e)) return `ssh ${target} needs a password or key that is not available without a prompt (run \`ssh ${target}\` in a terminal to check)`;
  if (/Could not resolve|Name or service not known|nodename nor servname/i.test(e)) return `cannot resolve ${target}`;
  if (/timed out|Connection refused|No route|unreachable/i.test(e)) return `cannot reach ${target}: ${e.split("\n").at(-1)}`;
  if (/Host key verification failed/i.test(e)) return `the host key of ${target} is unknown or changed (run \`ssh ${target}\` once)`;
  return e ? e.split("\n").at(-1)! : `ssh to ${target} failed`;
}

/** Slug for ids: "allinai2plus-campus" -> "allinai2plus-campus", "Build box" -> "build-box". */
export function machineKey(label: string, taken: Set<string>) {
  const base = label.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "machine";
  let key = base === "local" ? "local-2" : base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  taken.add(key);
  return key;
}
