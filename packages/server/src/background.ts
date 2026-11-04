// Background work an agent is still waiting on after its turn ended: claude's background Bash commands and
// Monitors. A claude that starts an experiment with a Monitor ends its turn ("done") and wakes only when the
// monitor reports, so Herdr's done does not mean the work is over.
//
// The signal: claude writes each background task's output to <tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output,
// and the task's processes hold that file open while they run (checked live: open while `sleep` ran, closed when it
// ended). Once claude's turn has ended no foreground tool runs, so any file open there is background work.
// Which session a pane's claude is in comes from claude's own registry, ~/.claude/sessions/<pid>.json.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);

/** Where claude keeps per-session task folders: <base>/<project slug>/<session id>/tasks. */
export function taskBases(): string[] {
  const id = uid();
  const out = new Set<string>();
  for (const b of [`/tmp/claude-${id}`, join(tmpdir(), `claude-${id}`), join(homedir(), `.claude-${id}`)]) {
    try {
      if (existsSync(b)) out.add(realpathSync(b));
    } catch {}
  }
  return [...out];
}

/** A claude session's task folder, if it has one (it is made with the session's first background or tool task). */
export function taskDir(sessionId: string, bases = taskBases()): string | undefined {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return undefined;
  for (const b of bases) {
    let slugs: string[];
    try {
      slugs = readdirSync(b);
    } catch {
      continue;
    }
    for (const s of slugs) {
      const d = join(b, s, sessionId, "tasks");
      if (existsSync(d)) return d;
    }
  }
  return undefined;
}

/** The session a running claude process is in (claude's registry), if it says. */
export function claudeSession(pid: number, claudeHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")): string | undefined {
  try {
    const r = JSON.parse(readFileSync(join(claudeHome, "sessions", `${pid}.json`), "utf8"));
    return r?.pid === pid && typeof r.sessionId === "string" ? r.sessionId : undefined;
  } catch {
    return undefined;
  }
}

/** Parse `lsof -Fn` output: the open files' paths. */
export function openPaths(lsofOut: string): string[] {
  return lsofOut
    .split("\n")
    .filter((l) => l.startsWith("n/"))
    .map((l) => l.slice(1));
}

/**
 * How many background tasks hold files open in each folder: one lsof run for all of them (about 0.1 s). A task is
 * counted once however many of its processes hold its file. Folders lsof cannot read count 0.
 */
export async function runningTasks(dirs: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(dirs.map((d) => [d, 0]));
  if (!dirs.length || !Bun.which("lsof")) return out;
  const p = Bun.spawn(["lsof", "-Fn", ...dirs.flatMap((d) => ["+d", d])], { stdout: "pipe", stderr: "ignore" });
  const text = await Promise.race([new Response(p.stdout).text(), Bun.sleep(5000).then(() => (p.kill(), ""))]);
  const real = new Map(dirs.map((d) => [safeReal(d), d]));
  const seen = new Map<string, Set<string>>();
  for (const path of openPaths(text)) {
    const slash = path.lastIndexOf("/");
    const dir = real.get(path.slice(0, slash));
    if (!dir || !path.endsWith(".output")) continue;
    let s = seen.get(dir);
    if (!s) seen.set(dir, (s = new Set()));
    s.add(path.slice(slash + 1));
  }
  for (const [d, s] of seen) out.set(d, s.size);
  return out;
}

const safeReal = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// ---------------------------------------------------------------------------------------------
// The same check on a remote machine, in one shell command over its SSH connection: claude's registry there gives
// each pane's session, its tasks folder is under the remote user's tmp, and lsof (or, without it, /proc/*/fd on
// Linux) tells which output files are open. Checked on Linux machines (tea2: /tmp/claude-<uid>/<slug>/<sid>/tasks).

const PANE_ID = /^[A-Za-z0-9:_.~-]+$/;

/**
 * A shell script printing "<pane> <count>" per pane: the background tasks the claude in that pane (one of `pids`)
 * still runs. A pane whose session or folder is not found prints 0.
 */
export function remoteCheckScript(entries: { pane: string; pids: number[] }[]) {
  const calls = entries
    .filter((e) => PANE_ID.test(e.pane))
    .map((e) => `chk '${e.pane}' ${e.pids.filter((p) => Number.isInteger(p) && p > 1).join(" ")}`)
    .join("\n");
  return String.raw`u=$(id -u)
cnt() {
  if command -v lsof >/dev/null 2>&1; then lsof -Fn +d "$1" 2>/dev/null | sed -n 's/^n//p'
  else find /proc/[0-9]*/fd -lname "$1/*" -printf '%l\n' 2>/dev/null; fi | grep '\.output$' | sort -u | wc -l | tr -d ' '
}
chk() {
  pane=$1; shift
  for pid in "$@"; do
    f="$HOME/.claude/sessions/$pid.json"; [ -f "$f" ] || continue
    sid=$(sed -n 's/.*"sessionId" *: *"\([0-9a-fA-F-]*\)".*/\1/p' "$f" | head -n 1); [ -n "$sid" ] || continue
    for d in /tmp/claude-$u/*/"$sid"/tasks "$${"{"}TMPDIR:-/tmp}"/claude-$u/*/"$sid"/tasks "$HOME"/.claude-$u/*/"$sid"/tasks; do
      if [ -d "$d" ]; then echo "$pane $(cnt "$d")"; return; fi
    done
  done
  echo "$pane 0"
}
${calls}
`;
}

/** The answer of remoteCheckScript: pane → count. */
export function parseRemoteCounts(out: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of out.split("\n")) {
    const r = l.trim().match(/^(\S+) (\d+)$/);
    if (r) m.set(r[1]!, Number(r[2]));
  }
  return m;
}
