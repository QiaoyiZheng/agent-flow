// A remote machine reached over SSH. One SSH master connection per machine (ControlMaster) carries:
//   - a forwarded Unix socket to the remote Herdr server, so the normal Herdr adapter (JSON API, events,
//     and the local herdr CLI with HERDR_SOCKET_PATH) works against it;
//   - `ssh <host> <remote herdr> terminal session ...` for live terminal streams (same NDJSON as local);
//   - short shell commands for reading transcripts and storing attachments.
// Nothing is installed or started on the remote machine. SSH must work without a password prompt.

import { existsSync, mkdirSync, rmSync } from "node:fs";
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

export class RemoteMachine {
  state: RemoteState = "offline";
  error?: string;
  home?: string;
  bin?: string;
  private master?: ReturnType<typeof Bun.spawn>;
  private connecting?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private failures = 0;
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

  /** Run a shell command on the remote machine through the master connection. */
  async exec(command: string, opts: { stdin?: Uint8Array; timeoutMs?: number } = {}) {
    const p = Bun.spawn([...this.sshBase(["-T"]), this.spec.target, command], { stdin: opts.stdin ? new Blob([opts.stdin as Uint8Array<ArrayBuffer>]) : "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 20_000);
    const [out, err] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(timer);
    return { code: p.exitCode ?? -1, out: Buffer.from(out), err: err.trim() };
  }

  /** Connect if needed. Resolves when online; rejects with a readable reason. */
  connect(): Promise<void> {
    this.wanted = true;
    if (this.state === "online") return Promise.resolve();
    this.connecting ??= this.doConnect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async doConnect() {
    this.set("connecting");
    clearTimeout(this.retryTimer);
    try {
      rmSync(this.ctl, { force: true });
      rmSync(this.sock, { force: true });
      // the master connection: long-lived, owns the control socket
      this.master = Bun.spawn([...this.sshBase(["-N", "-o", "ControlMaster=yes", "-o", "ControlPersist=no", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"]), this.spec.target], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      });
      const master = this.master;
      const masterErr = new Response(master.stderr as ReadableStream<Uint8Array>).text();
      for (let i = 0; i < 100 && !existsSync(this.ctl); i++) {
        if (master.exitCode !== null) break;
        await Bun.sleep(100);
      }
      if (!existsSync(this.ctl)) {
        master.kill();
        throw new Error(explainSsh(await masterErr, this.spec.target));
      }
      void master.exited.then(() => {
        if (this.master !== master) return;
        this.master = undefined;
        this.set("error", "connection lost");
        this.scheduleRetry();
      });

      // where is Herdr on the remote side?
      const sockRel = this.spec.session && this.spec.session !== "default" ? `.config/herdr/sessions/${this.spec.session}/herdr.sock` : ".config/herdr/herdr.sock";
      const probe = await this.exec(
        `echo "$HOME"; for b in herdr "$HOME/.local/bin/herdr" "$HOME/.herdr/bin/herdr" /usr/local/bin/herdr; do if command -v "$b" >/dev/null 2>&1; then command -v "$b"; break; fi; done; test -S "$HOME/${sockRel}" && echo socket-ok`,
      );
      const [home, bin, sockOk] = probe.out.toString().trim().split("\n");
      if (!home) throw new Error(`could not read the remote home directory: ${probe.err}`);
      if (!bin || bin === "socket-ok") throw new Error("Herdr is not installed there");
      if (sockOk !== "socket-ok") throw new Error("the Herdr server is not running there (run `herdr` on that machine once)");
      this.home = home;
      this.bin = bin;

      const fwd = Bun.spawnSync([...this.sshBase(["-O", "forward", "-o", "StreamLocalBindUnlink=yes", "-L", `${this.sock}:${home}/${sockRel}`]), this.spec.target], { stdout: "pipe", stderr: "pipe" });
      for (let i = 0; i < 50 && !existsSync(this.sock); i++) await Bun.sleep(100);
      if (!existsSync(this.sock)) throw new Error(`could not forward the Herdr socket: ${fwd.stderr.toString().trim()}`);
      this.failures = 0;
      this.set("online");
    } catch (e) {
      this.master?.kill();
      this.master = undefined;
      this.failures++;
      this.set("error", (e as Error).message);
      this.scheduleRetry();
      throw e;
    }
  }

  private scheduleRetry() {
    if (!this.wanted) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(this.failures, 4));
    this.retryTimer = setTimeout(() => void this.connect().catch(() => {}), delay);
  }

  /** argv for a live terminal stream of a remote pane. */
  terminalArgv(paneId: string, mode: "control" | "observe", cols: number, rows: number) {
    const cmd = `${sq(this.bin ?? "herdr")} terminal session ${mode} ${sq(paneId)}${mode === "control" ? " --takeover" : ""} --cols ${cols} --rows ${rows}`;
    return [...this.sshBase(["-T"]), this.spec.target, cmd];
  }

  close() {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.master?.kill();
    this.master = undefined;
    rmSync(this.sock, { force: true });
    this.set("offline");
  }
}

function explainSsh(stderr: string, target: string) {
  const e = stderr.trim();
  if (/Permission denied|publickey|password/i.test(e)) return `ssh ${target} needs a password or key that is not available without a prompt (run \`ssh ${target}\` in a terminal to check)`;
  if (/Could not resolve|Name or service not known|nodename nor servname/i.test(e)) return `cannot resolve ${target}`;
  if (/timed out|Connection refused|No route/i.test(e)) return `cannot reach ${target}: ${e.split("\n").at(-1)}`;
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
