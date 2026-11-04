// A machine team members can run on: this Mac, or a saved SSH machine that is connected. The same few operations
// for both (a shell command, a file, a git worktree, that machine's Herdr), so teams.ts does not care where a member
// lives. Remote operations go through the machine's SSH master connection (remote.ts).

import { basename, dirname } from "node:path";
import { MACHINE_SEP, splitId } from "@af/core";
import { AfError } from "./errors.ts";
import type { TerminalBackend } from "./herdr.ts";
import { sq } from "./remote.ts";
import type { Workspaces } from "./workspaces.ts";

export interface Host {
  /** "local" or the machine's id (the prefix of its Herdr ids). */
  machine: string;
  local: boolean;
  label: string;
  home: string;
  /** agent-flow's folder there: ~/.agent-flow on remote machines (where af.sock and the af script live). */
  afHome: string;
  /** The af command there. */
  afBin: string;
  /** That machine's Herdr. Ids it takes and returns are raw (no machine prefix). */
  backend: TerminalBackend;
  prefix(raw: string): string;
  raw(id: string): string;
  /** Run a shell command there (sh -c), optionally in `cwd`, with input. */
  sh(cmd: string, opts?: { cwd?: string; stdin?: string; timeoutMs?: number }): Promise<{ code: number; out: string; err: string }>;
  writeFile(path: string, text: string): Promise<void>;
  readFile(path: string, max?: number): Promise<string | undefined>;
  /** "~" and "~/x" as that machine's home. */
  expand(path: string): string;
}

export interface LocalHostParts {
  backend: TerminalBackend;
  /** agent-flow's folder on this Mac (AF_HOME). */
  afHome: string;
  binDir: string;
}

const READ_MAX = 1024 * 1024;

async function localSh(cmd: string, opts: { cwd?: string; stdin?: string; timeoutMs?: number } = {}) {
  const p = Bun.spawn(["sh", "-c", cmd], { cwd: opts.cwd, stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const timer = setTimeout(() => p.kill(), opts.timeoutMs ?? 30_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(timer);
  return { code: p.exitCode ?? -1, out, err: err.trim() };
}

/** The host for a machine id ("local" or a connected saved machine). Throws when a remote machine is not connected. */
export function hostOf(w: Workspaces, machine: string, local: LocalHostParts): Host {
  if (!machine || machine === "local") {
    const home = process.env.HOME ?? "/";
    return {
      machine: "local",
      local: true,
      label: "this Mac",
      home,
      afHome: local.afHome,
      afBin: `${local.binDir}/af`,
      backend: local.backend,
      prefix: (x) => x,
      raw: (x) => x,
      sh: localSh,
      async writeFile(path, text) {
        const r = await localSh(`mkdir -p ${sq(dirname(path))} && cat > ${sq(path)}`, { stdin: text });
        if (r.code !== 0) throw new AfError("write_failed", `could not write ${path}: ${r.err}`);
      },
      async readFile(path, max = READ_MAX) {
        const f = Bun.file(path);
        if (!(await f.exists())) return undefined;
        return (await f.slice(0, max).text()) as string;
      },
      expand: (p) => (p === "~" ? home : p.startsWith("~/") ? `${home}${p.slice(1)}` : p),
    };
  }
  const meta = w.model.machines.find((m) => m.id === machine);
  if (!meta) throw new AfError("unknown_machine", `no machine ${machine} (machines: ${w.model.machines.map((m) => m.id).join(", ")})`, 404);
  const remote = w.remoteOf(`${machine}${MACHINE_SEP}x`);
  if (!remote || meta.state !== "online" || !remote.home) throw new AfError("machine_offline", `${meta.label} is not connected${meta.error ? `: ${meta.error}` : ""}. Connect it first (af connect ${machine}).`, 503);
  const route = w.route(`${machine}${MACHINE_SEP}x`);
  const home = remote.home;
  const afHome = `${home}/.agent-flow`;
  const sh: Host["sh"] = async (cmd, opts = {}) => {
    const r = await remote.exec(opts.cwd ? `cd ${sq(opts.cwd)} && ${cmd}` : cmd, { stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined, timeoutMs: opts.timeoutMs ?? 30_000 });
    return { code: r.code, out: r.out.toString(), err: r.err };
  };
  return {
    machine,
    local: false,
    label: meta.label,
    home,
    afHome,
    afBin: `${afHome}/bin/af`,
    backend: route.backend,
    prefix: route.prefix,
    raw: (id) => splitId(id).raw,
    sh,
    async writeFile(path, text) {
      const r = await sh(`mkdir -p ${sq(dirname(path))} && cat > ${sq(path)}`, { stdin: text });
      if (r.code !== 0) throw new AfError("write_failed", `could not write ${path} on ${meta.label}: ${r.err}`);
    },
    async readFile(path, max = READ_MAX) {
      const r = await sh(`test -f ${sq(path)} && head -c ${max} ${sq(path)}`);
      return r.code === 0 ? r.out : undefined;
    },
    expand: (p) => {
      if (p === "~") return home;
      if (p.startsWith("~/")) return `${home}${p.slice(1)}`;
      // a path the Mac's shell expanded from ~ (af task --on <machine> --cwd ~/x, run on the Mac): that machine's home
      const mine = process.env.HOME;
      if (mine && (p === mine || p.startsWith(`${mine}/`))) return `${home}${p.slice(mine.length)}`;
      return p;
    },
  };
}

/** The git top level of `cwd` on the host, or undefined when it is not in a repository with commits. */
export async function gitTop(host: Host, cwd: string): Promise<string | undefined> {
  const r = await host.sh(`git rev-parse --show-toplevel && git rev-parse --verify -q HEAD >/dev/null`, { cwd });
  return r.code === 0 ? r.out.trim().split("\n")[0] : undefined;
}

/**
 * A worktree with `branch` for a member, under <top>/.agent-flow/worktrees/<team>/<member>, cut from the HEAD of
 * `cwd` (the manager's checkout); .agent-flow/ goes into the repository's info/exclude. Existing ones are reused.
 * Returns the worktree's path.
 */
export async function addWorktree(host: Host, cwd: string, team: string, member: string, branch: string): Promise<string> {
  const script = [
    "set -e",
    'top=$(git rev-parse --show-toplevel)',
    `wt="$top/.agent-flow/worktrees/${team}/${member}"`,
    'if [ ! -e "$wt/.git" ]; then',
    '  mkdir -p "$(dirname "$wt")"',
    `  if git show-ref --verify -q ${sq(`refs/heads/${branch}`)}; then git worktree add -q "$wt" ${sq(branch)}; else git worktree add -q -b ${sq(branch)} "$wt" HEAD; fi`,
    "fi",
    'ex=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || (cd "$top" && cd "$(git rev-parse --git-common-dir)" && pwd))/info/exclude',
    'mkdir -p "$(dirname "$ex")"',
    "grep -qxF '.agent-flow/' \"$ex\" 2>/dev/null || echo '.agent-flow/' >> \"$ex\"",
    'echo "$wt"',
  ].join("\n");
  const r = await host.sh(script, { cwd });
  if (r.code !== 0) throw new AfError("worktree_failed", `could not make a worktree for ${member} in ${cwd}${host.local ? "" : ` on ${host.label}`}: ${r.err || r.out}`);
  return r.out.trim().split("\n").at(-1)!;
}

/** Where a file of the team's folder (on this Mac) is on another host: the same place under its ~/.agent-flow. */
export function hostPathOf(host: Host, localAfHome: string, path: string) {
  if (host.local) return path;
  if (path === localAfHome || path.startsWith(`${localAfHome}/`)) return `${host.afHome}${path.slice(localAfHome.length)}`;
  return path;
}

export const fileName = basename;
