// af on other machines (docs/design.md 4.8). A session or team member on a connected SSH machine runs
// ~/.agent-flow/bin/af there: a small sh script that sends the command, over ~/.agent-flow/af.sock, to this server.
// That socket leads (ssh -O forward -R, on the machine's master connection) to a socket of this server that serves
// only that machine:
//   - only the commands for handing out work, tickets and queues (no typing into panes, no files on this Mac);
//   - the caller's Herdr pane gets the machine's prefix ("w3:p4" -> "joy~w3:p4"), and a member may only speak for a
//     member that runs on that machine;
//   - POST /cli runs this server's own af CLI for the command (AF_REMOTE=<machine>, AF_CWD=<its folder>), so the
//     remote script needs only sh and curl, and every command behaves the same everywhere.
// The machine also gets the agent-flow skill (in ~/.claude, ~/.codex, ~/.gemini skills, where those exist), with
// the path of its af.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MACHINE_SEP } from "@af/core";
import { sq } from "./remote.ts";
import type { Teams } from "./teams.ts";
import type { RemoteLike, Workspaces } from "./workspaces.ts";

/** The af script written to ~/.agent-flow/bin/af on each machine. Needs sh and curl (7.40+). */
export const REMOTE_AF = `#!/bin/sh
# agent-flow's af on this machine, written by the agent-flow server on the user's Mac. Every command runs on that
# server, through the SSH connection it keeps to this machine (~/.agent-flow/af.sock).
S="$HOME/.agent-flow/af.sock"
if [ ! -S "$S" ]; then echo "af: agent-flow is not connected to this machine right now (no $S). It reconnects by itself; try again in a minute." >&2; exit 1; fi
command -v curl >/dev/null 2>&1 || { echo "af: needs curl" >&2; exit 1; }
printf '%s\\000' "$PWD" "\${AF_TEAM-}" "\${AF_AGENT-}" "\${HERDR_PANE_ID-}" "$@" |
  curl -sS -N --max-time 300 --unix-socket "$S" --data-binary @- -H 'content-type: application/octet-stream' http://af/cli |
  { IFS= read -r code
    if [ -z "$code" ]; then echo "af: no answer from agent-flow" >&2; exit 1; fi
    if [ "$code" = 0 ]; then cat; else cat >&2; fi
    exit "$code"; }
`;

/** What a remote caller may use: handing out work, tickets, queues. Everything else works on the Mac only. */
const ALLOWED = new Set([
  "GET /health",
  "GET /whoami",
  "GET /teams",
  "GET /team",
  "POST /task",
  "POST /team/new",
  "POST /team/stop",
  "GET /playbooks",
  "GET /machines",
  "GET /team/queue",
  "POST /team/take",
  "POST /team/handled",
  "POST /team/ticket",
  "POST /team/close",
  "GET /team/ticket",
  "GET /team/tickets",
  "POST /team/max",
  "POST /team/tell",
  "POST /team/answer",
  "POST /team/reply",
  "GET /team/status",
  "POST /team/report",
  "POST /team/submit",
  "POST /team/progress",
  "POST /team/ask",
  // a document handed over from there (its path is on that machine), and a viewer pane there following its target
  "POST /deliver",
  "GET /view",
]);

/** af subcommands that only make sense on the Mac itself (they would act there, not on the caller's machine). */
const MAC_ONLY = new Set(["server", "viewer", "hook", "open", "split", "close", "connect", "disconnect", "workspace", "ls"]);

/** The /cli body: NUL-separated cwd, AF_TEAM, AF_AGENT, HERDR_PANE_ID, then the arguments. */
export function parseCliBody(body: Uint8Array) {
  const parts = Buffer.from(body).toString("utf8").split("\0");
  if (parts.at(-1) === "") parts.pop();
  const [cwd = "", team = "", agent = "", pane = "", ...argv] = parts;
  return { cwd, team, agent, pane, argv };
}

const fail = (code: string, message: string, status = 400) => Response.json({ error: { code, message } }, { status });

export interface RemoteAfOptions {
  /** agent-flow's folder on this Mac (the per-machine sockets go in its ssh/ folder). */
  home: string;
  w: Workspaces;
  teams: Teams;
  /** The server's API handler (the same routes the Mac's af uses). */
  handler: (req: Request) => Promise<Response>;
  /** packages/cli/src/main.ts, run with bun for /cli. */
  cliMain: string;
  /** Write the agent-flow skill on each machine (the main server does; a second server does not). */
  skillText?: (af: string) => string;
  /** The deliver-document skill's text for that machine's af (agents there hand over documents with af deliver). */
  deliverText?: (af: string) => string;
  log?: (msg: string) => void;
}

export class RemoteAf {
  private servers = new Map<string, { stop: (force?: boolean) => void; sock: string }>();
  private ready = new Map<string, number>();
  private busy = new Set<string>();
  private skilled = new Set<string>();
  /** Machines where setting up af failed: when to try again (1 min, doubling to 30 min), and the last reason logged. */
  private failed = new Map<string, { n: number; until: number; why: string }>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private opts: RemoteAfOptions) {}

  start(everyMs = 15_000) {
    this.timer = setInterval(() => void this.tick(), everyMs);
    void this.tick();
  }

  stop() {
    clearInterval(this.timer);
    for (const s of this.servers.values()) {
      s.stop(true);
      rmSync(s.sock, { force: true });
    }
    this.servers.clear();
  }

  /** The socket on this Mac that serves `machine`. */
  sockOf(machine: string) {
    return join(this.opts.home, "ssh", `${machine}.af.sock`);
  }

  async tick() {
    for (const m of this.opts.w.model.machines) if (!m.local && m.state === "online") void this.ensure(m.id);
  }

  /** Set the machine up (or check it is still set up): its socket here, the forward, the af script, the skill. */
  async ensure(machine: string) {
    if (this.busy.has(machine) || Date.now() - (this.ready.get(machine) ?? 0) < 60_000) return;
    if (Date.now() < (this.failed.get(machine)?.until ?? 0)) return;
    // forwardRemoteSocket: RemoteMachine's (remote.ts); fakes in tests may not have it
    const remote = this.opts.w.remoteOf(`${machine}${MACHINE_SEP}x`) as (RemoteLike & { forwardRemoteSocket?: (remotePath: string, localPath: string) => Promise<void> }) | undefined;
    if (!remote?.home || !remote.forwardRemoteSocket) return;
    this.busy.add(machine);
    try {
      const local = this.listen(machine);
      const there = `${remote.home}/.agent-flow/af.sock`;
      const w = await remote.exec(`mkdir -p "$HOME/.agent-flow/bin" && chmod 700 "$HOME/.agent-flow" && cat > "$HOME/.agent-flow/bin/af" && chmod 755 "$HOME/.agent-flow/bin/af"`, { stdin: new TextEncoder().encode(REMOTE_AF) });
      if (w.code !== 0) throw new Error(`could not write ~/.agent-flow/bin/af: ${w.err}`);
      const healthy = async () => (await remote.exec(`curl -s -m 5 --unix-socket ${sq(there)} http://af/health`)).out.toString().includes('"ok":true');
      if (!(await healthy())) {
        await remote.forwardRemoteSocket(there, local);
        if (!(await healthy())) throw new Error(`${there} does not answer after forwarding it (does this sshd allow AllowStreamLocalForwarding?)`);
      }
      if (this.opts.skillText && !this.skilled.has(machine)) {
        const af = `${remote.home}/.agent-flow/bin/af`;
        const put = (skill: string, text: string) =>
          remote.exec(
            `t=$(mktemp) && cat > "$t" && for d in .claude .codex .gemini; do if [ -d "$HOME/$d" ]; then mkdir -p "$HOME/$d/skills/${skill}" && cp "$t" "$HOME/$d/skills/${skill}/SKILL.md" && echo "$d"; fi; done; rm -f "$t"`,
            { stdin: new TextEncoder().encode(text) },
          );
        const r = await put("agent-flow", this.opts.skillText(af));
        if (this.opts.deliverText) await put("deliver-document", this.opts.deliverText(af));
        if (r.code === 0) {
          this.skilled.add(machine);
          this.opts.log?.(`  skill on ${machine}: ${r.out.toString().trim().split("\n").filter(Boolean).join(", ") || "(no agent folders)"}`);
        }
      }
      this.ready.set(machine, Date.now());
      if (this.failed.has(machine)) this.opts.log?.(`af on ${machine}: works again`);
      this.failed.delete(machine);
    } catch (e) {
      // a machine whose sshd does not forward Unix sockets fails the same way every time: try again later and later,
      // and log a reason only when it is new
      const why = (e as Error).message;
      const was = this.failed.get(machine);
      const n = (was?.n ?? 0) + 1;
      const wait = Math.min(60_000 * 2 ** (n - 1), 30 * 60_000);
      this.failed.set(machine, { n, until: Date.now() + wait, why });
      if (was?.why !== why) this.opts.log?.(`af on ${machine}: ${why} (trying again later, at most every 30 min)`);
    } finally {
      this.busy.delete(machine);
    }
  }

  private listen(machine: string) {
    const sock = this.sockOf(machine);
    if (this.servers.has(machine)) return sock;
    if (existsSync(sock)) rmSync(sock);
    mkdirSync(dirname(sock), { recursive: true, mode: 0o700 }); // made by the SSH connection too, but not always first
    const server = Bun.serve({ unix: sock, fetch: (req) => this.serve(machine, req) });
    this.servers.set(machine, { stop: (f) => server.stop(f), sock });
    return sock;
  }

  /** A request from `machine`: /cli and /remote/read here, the allowed routes on to the API with the caller tagged. */
  async serve(machine: string, req: Request): Promise<Response> {
    const url = new URL(req.url);
    const key = `${req.method} ${url.pathname}`;
    const label = this.opts.w.model.machines.find((m) => m.id === machine)?.label ?? machine;
    try {
      if (key === "POST /cli") return await this.cli(machine, new Uint8Array(await req.arrayBuffer()));
      const body: Record<string, any> = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
      if (body.callerPane && !String(body.callerPane).includes(MACHINE_SEP)) body.callerPane = `${machine}${MACHINE_SEP}${body.callerPane}`;
      // panes named by the caller are its machine's; a file it hands over is there
      if ((key === "POST /deliver" || key === "GET /view") && body.pane && !String(body.pane).includes(MACHINE_SEP)) body.pane = `${machine}${MACHINE_SEP}${body.pane}`;
      if (key === "POST /deliver") body.machine = machine;
      // a member or router speaks for itself only: it must be one that runs on this machine
      if (body.team && body.agent) {
        let m;
        try {
          m = this.opts.teams.get(String(body.team)).members[String(body.agent)];
        } catch {}
        if (!m || (m.machine ?? "local") !== machine) return fail("forbidden", `${body.agent} of team ${body.team} does not run on ${label}`, 403);
      }
      if (key === "POST /remote/read") return await this.read(machine, String(body.path ?? ""));
      if (key === "POST /pane/read") return await this.readPane(machine, body);
      if (!ALLOWED.has(key))
        return fail("mac_only", `that works only on the Mac that runs agent-flow. From ${label}: af task, af team, af playbook, af machines, af queue, af ticket(s), af tell / answer / reply / status / report, af submit / progress / ask, af read, af whoami`, 403);
      if (key === "POST /team/stop" && body.id) return fail("mac_only", `from ${label}, af team stop stops your own team only (no id)`, 403);
      const fwd =
        req.method === "POST"
          ? new Request(`http://af${url.pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
          : new Request(`http://af${url.pathname}?${new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined) as [string, string][])}`);
      return await this.opts.handler(fwd);
    } catch (e) {
      return fail("internal", (e as Error).message, 500);
    }
  }

  /** A file on that machine (af ticket open --task-file there). */
  private async read(machine: string, path: string) {
    if (!path.startsWith("/")) return fail("bad_path", "give an absolute path");
    const remote = this.opts.w.remoteOf(`${machine}${MACHINE_SEP}x`);
    if (!remote) return fail("machine_offline", `${machine} is not connected`, 503);
    const r = await remote.exec(`test -f ${sq(path)} && head -c 1048576 ${sq(path)}`);
    if (r.code !== 0) return fail("not_found", `${path} is not a file on ${machine}`, 404);
    return Response.json({ text: r.out.toString("utf8") });
  }

  /** af read <member|pane>, for panes on that machine. */
  private async readPane(machine: string, body: Record<string, any>) {
    const who = this.opts.teams.who({ team: body.team, agent: body.agent, pane: body.callerPane });
    const team = who.kind === "member" || who.kind === "router" ? who.team : who.kind === "pane" ? this.opts.teams.directTeamOf(who.pane)?.id : undefined;
    let ref = String(body.ref ?? "");
    if (ref && !ref.includes(MACHINE_SEP) && /^w[\w-]*:p[\w-]+$/.test(ref)) ref = `${machine}${MACHINE_SEP}${ref}`;
    const pane = this.opts.w.resolvePane(ref, this.opts.teams.memberPanes(team));
    if (!pane.startsWith(`${machine}${MACHINE_SEP}`)) return fail("mac_only", `${body.ref} is not on ${machine}; from there af read reads panes on ${machine} only`, 403);
    return Response.json({ pane, text: await this.opts.w.read(pane, Number(body.lines) || 120) });
  }

  /** Run this server's af for a command typed on `machine`. Answer: the exit code on the first line, then the output. */
  private async cli(machine: string, raw: Uint8Array) {
    const { cwd, team, agent, pane, argv } = parseCliBody(raw);
    if (MAC_ONLY.has(argv[0] ?? "")) return new Response(`1\naf: af ${argv[0]} works only on the Mac that runs agent-flow\n`);
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/",
      AF_SOCK: this.sockOf(machine),
      AF_REMOTE: machine,
      AF_CWD: cwd || "/",
      ...(team ? { AF_TEAM: team } : {}),
      ...(agent ? { AF_AGENT: agent } : {}),
      ...(pane ? { HERDR_PANE_ID: pane } : {}),
    };
    const p = Bun.spawn([process.execPath, this.opts.cliMain, ...argv], { cwd: tmpdir(), env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 280_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    clearTimeout(timer);
    return new Response(`${p.exitCode ?? 1}\n${out}${err}`);
  }
}
