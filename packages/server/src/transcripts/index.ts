// Find the transcript file behind an agent pane and stream its entries to the UI as they are written.
// Works for local panes (files on this machine) and remote panes (files read over SSH).
//
// Finding the file, most exact first:
//   1. a session id agent-flow gave the agent at launch (claude --session-id), or recorded for a pane;
//   2. what the agent's Herdr integration reported: a path (omp) or a session id (codex);
//   3. claude only: a session id in the process's own argv (--resume/--session-id, also how Herdr restores);
//   4. claude only: the newest transcript for the pane's folder, when no other claude pane shares that folder.
// If none works, the UI shows the plain terminal.

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatOp, ChatSource, HPane } from "@af/core";
import { type Agent, PARSERS, type ParseCtx } from "./parse.ts";
import { sq } from "../remote.ts";

/** Load at most this much of a transcript when opening it; older history is skipped. */
export const MAX_INITIAL = 8 * 1024 * 1024;
const RECENT_DAYS = 14;

/** File access for transcripts, on this machine or another one. */
export interface TranscriptFS {
  claudeById(id: string): Promise<string | undefined>;
  codexById(id: string): Promise<string | undefined>;
  /** Claude transcripts (last two weeks) whose recorded cwd is `cwd`, newest first, at most `limit`. */
  claudeForFolder(cwd: string, limit: number): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  /** Bytes from `offset` (at most `max`), and the file's current size. undefined if the file is gone. */
  readFrom(path: string, offset: number, max: number): Promise<{ size: number; data: Buffer } | undefined>;
}

export interface Roots {
  claude: string;
  codex: string;
}

export const defaultRoots = (): Roots => ({
  claude: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
  codex: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
});

function readHead(path: string, bytes = 16384) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export class LocalFS implements TranscriptFS {
  private cwdCache = new Map<string, { mtime: number; cwd?: string }>();
  constructor(readonly roots: Roots = defaultRoots()) {}

  async claudeById(id: string) {
    if (!existsSync(this.roots.claude)) return undefined;
    for (const dir of readdirSync(this.roots.claude)) {
      const f = join(this.roots.claude, dir, `${id}.jsonl`);
      if (existsSync(f)) return f;
    }
    return undefined;
  }

  async codexById(id: string) {
    const root = this.roots.codex;
    if (!existsSync(root)) return undefined;
    const desc = (d: string) => (existsSync(d) ? readdirSync(d).sort().reverse() : []);
    for (const y of desc(root))
      for (const m of desc(join(root, y)))
        for (const d of desc(join(root, y, m))) {
          const hit = readdirSync(join(root, y, m, d)).find((f) => f.endsWith(`-${id}.jsonl`));
          if (hit) return join(root, y, m, d, hit);
        }
    return undefined;
  }

  async claudeForFolder(cwd: string, limit: number) {
    if (!existsSync(this.roots.claude)) return [];
    const cutoff = Date.now() - RECENT_DAYS * 86400_000;
    const hits: { path: string; mtime: number }[] = [];
    for (const dir of readdirSync(this.roots.claude)) {
      const d = join(this.roots.claude, dir);
      let files: string[];
      try {
        files = readdirSync(d).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const path = join(d, f);
        const mtime = statSync(path).mtimeMs;
        if (mtime < cutoff) continue;
        let c = this.cwdCache.get(path);
        if (!c || c.mtime !== mtime) {
          const m = readHead(path).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
          c = { mtime, cwd: m ? JSON.parse(`"${m[1]}"`) : undefined };
          this.cwdCache.set(path, c);
        }
        if (c.cwd === cwd) hits.push({ path, mtime });
      }
    }
    return hits.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map((h) => h.path);
  }

  async exists(path: string) {
    return existsSync(path);
  }

  async readFrom(path: string, offset: number, max: number) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return undefined;
    }
    if (size <= offset) return { size, data: Buffer.alloc(0) };
    const len = Math.min(size - offset, max);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      return { size, data: buf };
    } finally {
      closeSync(fd);
    }
  }
}

/** Transcript files on a remote machine, read with short shell commands over the SSH master connection. */
export class SshFS implements TranscriptFS {
  constructor(private exec: (cmd: string, opts?: { timeoutMs?: number }) => Promise<{ code: number; out: Buffer; err: string }>) {}

  private async line(cmd: string) {
    const r = await this.exec(cmd);
    const s = r.out.toString().trim().split("\n")[0]?.trim();
    return s || undefined;
  }

  claudeById(id: string) {
    if (!/^[0-9a-f-]+$/i.test(id)) return Promise.resolve(undefined);
    return this.line(`ls -1 "$HOME"/.claude/projects/*/${id}.jsonl 2>/dev/null | head -n 1`);
  }

  codexById(id: string) {
    if (!/^[0-9a-z-]+$/i.test(id)) return Promise.resolve(undefined);
    return this.line(`ls -1 "$HOME"/.codex/sessions/*/*/*/*-${id}.jsonl 2>/dev/null | head -n 1`);
  }

  async claudeForFolder(cwd: string, limit: number) {
    const needle = sq(`"cwd":${JSON.stringify(cwd)}`);
    const r = await this.exec(
      `find "$HOME/.claude/projects" -name '*.jsonl' -mtime -${RECENT_DAYS} 2>/dev/null | xargs ls -t 2>/dev/null | head -n 120 | while IFS= read -r f; do head -c 20000 "$f" | grep -qF ${needle} && echo "$f"; done | head -n ${Math.max(1, Math.floor(limit))}`,
    );
    return r.out.toString().split("\n").map((l) => l.trim()).filter(Boolean);
  }

  async exists(path: string) {
    return (await this.line(`test -f ${sq(path)} && echo yes`)) === "yes";
  }

  async readFrom(path: string, offset: number, max: number) {
    const o = Math.max(0, Math.floor(offset));
    const r = await this.exec(
      `f=${sq(path)}; [ -f "$f" ] || exit 3; s=$(wc -c < "$f" | tr -d ' '); echo "$s"; if [ ${max} -gt 0 ] && [ "$s" -gt ${o} ]; then n=$((s-${o})); [ "$n" -gt ${max} ] && n=${max}; tail -c +$((${o}+1)) "$f" | head -c "$n"; fi`,
      { timeoutMs: 60_000 },
    );
    if (r.code !== 0) return undefined;
    const nl = r.out.indexOf(10);
    if (nl < 0) return undefined;
    const size = Number(r.out.subarray(0, nl).toString());
    return Number.isFinite(size) ? { size, data: Buffer.from(r.out.subarray(nl + 1)) } : undefined;
  }
}

export interface ResolveInput {
  pane: HPane;
  /** All panes, to tell when several claude agents share one folder. */
  panes: HPane[];
  /** Session known to agent-flow for this pane: given at launch, or reported by the agent's SessionStart hook. */
  knownSession?: string;
  knownPath?: string;
  /** The pane's recent screen text, to tell apart several claude agents in one folder. */
  screen?: () => Promise<string>;
  /** argv of the pane's foreground processes, fetched lazily. */
  argv: () => Promise<string[][]>;
}

const isAgent = (a: string | undefined): a is Agent => a === "claude" || a === "codex" || a === "omp";

/** Text compared between a screen and a transcript: no whitespace, markdown marks, or bullets. */
export const norm = (t: string) => t.replace(/[\s*_`#>|$\\~•●⏺❯›⎿]+/g, "").toLowerCase();

/** Lines the agent drew for prompts and replies ("❯ …", "● …"), normalized, as matching keys. */
export function screenSnippets(screen: string) {
  const out = new Set<string>();
  for (const line of screen.split("\n")) {
    const m = line.match(/^\s*(?:❯|>|●|⏺)\s*(.+)$/);
    if (!m) continue;
    const n = norm(m[1]!);
    if (n.length >= 10) out.add(n.slice(0, 24));
  }
  return [...out];
}

/** Normalized user text, assistant text and tool lines of a claude transcript's last part. */
async function transcriptText(fs: TranscriptFS, path: string) {
  const head = await fs.readFrom(path, 0, 0);
  if (!head) return "";
  const from = Math.max(0, head.size - 2 * 1024 * 1024);
  const r = await fs.readFrom(path, from, 2 * 1024 * 1024);
  if (!r) return "";
  const ctx = { n: 0 };
  const parts: string[] = [];
  for (const l of r.data.toString("utf8").split("\n")) {
    try {
      for (const op of PARSERS.claude(JSON.parse(l), ctx))
        if (op.op === "add") {
          const b = op.entry.block;
          parts.push(b.kind === "tool" ? `${b.name}(${b.summary}` : "text" in b ? b.text : "");
        }
    } catch {}
  }
  return norm(parts.join("\n"));
}

/** Of several candidate transcripts, the one whose content the pane's screen shows, if that is clear. */
export async function matchByScreen(fs: TranscriptFS, candidates: string[], screen: string) {
  const snippets = screenSnippets(screen);
  if (!snippets.length || !candidates.length) return undefined;
  const scored = await Promise.all(
    candidates.map(async (path) => {
      const text = await transcriptText(fs, path);
      return { path, score: snippets.filter((s) => text.includes(s)).length };
    }),
  );
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  const enough = best!.score >= Math.min(2, snippets.length);
  return enough && best!.score > (next?.score ?? 0) ? best!.path : undefined;
}

export async function resolveTranscript(fs: TranscriptFS, { pane, panes, knownSession, knownPath, screen, argv }: ResolveInput): Promise<{ source: ChatSource } | { reason: string }> {
  const agent = pane.agent;
  if (!isAgent(agent)) return { reason: pane.agent ? `rendering ${pane.agent} output is not supported yet` : "no agent in this pane" };
  const byId = (id: string) => (agent === "claude" ? fs.claudeById(id) : agent === "codex" ? fs.codexById(id) : Promise.resolve(undefined));
  const found = (path: string | undefined, how: ChatSource["how"]) => (path ? { source: { agent, path, how } } : undefined);

  if (knownPath && (await fs.exists(knownPath))) return { source: { agent, path: knownPath, how: "session" } };
  if (knownSession) {
    const r = found(await byId(knownSession), "session");
    if (r) return r;
  }
  if (pane.session?.kind === "path" && (await fs.exists(pane.session.value))) return { source: { agent, path: pane.session.value, how: "session" } };
  if (pane.session?.kind === "id") {
    const r = found(await byId(pane.session.value), "session");
    if (r) return r;
  }
  if (agent === "claude") {
    for (const args of await argv()) {
      const i = args.findIndex((a) => a === "--resume" || a === "-r" || a === "--session-id");
      const id = i >= 0 ? args[i + 1] : args.find((a) => /^--(resume|session-id)=/.test(a))?.split("=")[1];
      if (id && /^[0-9a-f-]{36}$/i.test(id)) {
        const r = found(await fs.claudeById(id), "session");
        if (r) return r;
      }
    }
    const sharing = panes.filter((p) => p.agent === "claude" && p.cwd === pane.cwd && p.machine === pane.machine).length;
    if (sharing > 1) {
      const candidates = await fs.claudeForFolder(pane.cwd, 15);
      const hit = screen ? await matchByScreen(fs, candidates, await screen().catch(() => "")) : undefined;
      if (hit) return { source: { agent, path: hit, how: "screen" } };
      return { reason: `${sharing} claude agents run in ${pane.cwd} and the screen does not show which conversation is this one yet` };
    }
    const r = found((await fs.claudeForFolder(pane.cwd, 1))[0], "folder");
    if (r) return r;
    return { reason: "no claude transcript for this folder yet" };
  }
  return { reason: knownSession || pane.session ? "the transcript file has not been written yet" : `${agent} has not reported its session to Herdr yet` };
}

/** Follows one transcript file: parses what is there (the last MAX_INITIAL bytes), then whatever gets appended. */
export class TranscriptTail {
  private offset = -1;
  private partial = Buffer.alloc(0);
  private ctx: ParseCtx = { n: 0 };
  /** Bytes skipped at the start because the file was larger than MAX_INITIAL. */
  skipped = 0;

  constructor(
    readonly source: ChatSource,
    private fs: TranscriptFS,
    private maxInitial = MAX_INITIAL,
  ) {}

  /** New ops since the last call. Restarts from scratch if the file shrank (rewritten). */
  async read(): Promise<{ ops: ChatOp[]; reset: boolean }> {
    let reset = false;
    if (this.offset < 0) {
      const head = await this.fs.readFrom(this.source.path, 0, 0);
      if (!head) return { ops: [], reset };
      this.offset = Math.max(0, head.size - this.maxInitial);
      this.skipped = this.offset;
    }
    const chunk = await this.fs.readFrom(this.source.path, this.offset, 16 * 1024 * 1024);
    if (!chunk) return { ops: [], reset };
    if (chunk.size < this.offset) {
      this.offset = 0;
      this.skipped = 0;
      this.partial = Buffer.alloc(0);
      this.ctx = { n: 0 };
      reset = true;
      return { ...(await this.read()), reset };
    }
    if (!chunk.data.length) return { ops: [], reset };
    // split on newline bytes, so a read that ends inside a multi-byte character cannot corrupt a line
    let buf = this.partial.length ? Buffer.concat([this.partial, chunk.data]) : chunk.data;
    if (this.skipped && this.offset === this.skipped && !this.partial.length) buf = buf.subarray(buf.indexOf(10) + 1); // drop the cut first line
    this.offset += chunk.data.length;
    const end = buf.lastIndexOf(10);
    this.partial = Buffer.from(buf.subarray(end + 1));
    const lines = end < 0 ? [] : buf.subarray(0, end).toString("utf8").split("\n");
    const parse = PARSERS[this.source.agent];
    const ops: ChatOp[] = [];
    for (const l of lines) {
      if (!l.trim()) continue;
      try {
        ops.push(...parse(JSON.parse(l), this.ctx));
      } catch {}
    }
    return { ops, reset };
  }
}
