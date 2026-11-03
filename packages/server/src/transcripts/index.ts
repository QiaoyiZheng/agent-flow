// Find the transcript file behind an agent pane and stream its entries to the UI as they are written.
// Works for local panes (files on this machine) and remote panes (files read over SSH).
//
// Finding the file, most exact first:
//   1. a session id agent-flow gave the agent at launch (claude --session-id), or recorded for a pane;
//   2. what the agent's Herdr integration reported: a path (omp) or a session id (codex);
//   3. claude only: a session id in the process's own argv (--resume/--session-id, also how Herdr restores);
//   4. claude only: the newest transcript for the pane's folder, when no other claude pane shares that folder.
// If none works, the UI shows the plain terminal.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChatOp, ChatSource, HPane } from "@af/core";
import { type Agent, PARSERS, type ParseCtx } from "./parse.ts";
import { sq } from "../remote.ts";

/** Load at most this much of a transcript when opening it; older history is skipped. */
export const MAX_INITIAL = 8 * 1024 * 1024;
const RECENT_DAYS = 14;
/** How many of the last bytes read a transcript tail compares on the next read, to notice a rewritten file. */
const TAIL_MARK = 512;

/** File access for transcripts, on this machine or another one. */
export interface TranscriptFS {
  claudeById(id: string): Promise<string | undefined>;
  codexById(id: string): Promise<string | undefined>;
  /** Claude transcripts (last two weeks) whose recorded cwd is `cwd`, newest first, at most `limit`. */
  claudeForFolder(cwd: string, limit: number): Promise<string[]>;
  /** Codex rollout files (last two weeks) whose session_meta cwd is `cwd`, newest first, at most `limit`. */
  codexForFolder(cwd: string, limit: number): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  /**
   * Bytes from `offset` (at most `max`), and the file's current size. undefined if the file is gone. `file` names the
   * file itself (device and inode, when known): another one means the file was replaced (rewritten and renamed over).
   */
  readFrom(path: string, offset: number, max: number): Promise<{ size: number; data: Buffer; file?: string } | undefined>;
  /** Write the first `bytes` of `src` (all of it when undefined) to `dst`, replacing every `from` with `to`. */
  copyPrefix(src: string, dst: string, bytes: number | undefined, from: string, to: string): Promise<void>;
  /** Run a shell command where the files are (to list skills). */
  sh(cmd: string): Promise<string>;
  /** The session a running claude process is in: claude keeps <config>/sessions/<pid>.json up to date (also after /clear). */
  claudeSessionOfPid(pid: number): Promise<string | undefined>;
  /** The rollout file a running codex process (or its children) holds open, from lsof. */
  codexRolloutOfPids(pids: number[]): Promise<string | undefined>;
}

const validPids = (pids: number[]) => pids.filter((p) => Number.isInteger(p) && p > 1);
/** A shell command printing the first codex rollout that these processes or their children hold open. */
export const openRolloutCmd = (pids: number[]) =>
  String.raw`pids="$(for p in ${validPids(pids).join(" ")}; do echo $p; pgrep -P $p 2>/dev/null; done | paste -sd, -)"; [ -n "$pids" ] && lsof -Fn -p "$pids" 2>/dev/null | sed -n 's/^n\(.*\/sessions\/.*rollout-.*\.jsonl\)$/\1/p' | head -n 1`;

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

  async claudeSessionOfPid(pid: number) {
    if (!validPids([pid]).length) return undefined;
    try {
      const rec = JSON.parse(readFileSync(join(dirname(this.roots.claude), "sessions", `${pid}.json`), "utf8"));
      return typeof rec?.sessionId === "string" && rec.pid === pid ? rec.sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  async codexRolloutOfPids(pids: number[]) {
    if (!validPids(pids).length) return undefined;
    const p = Bun.spawnSync(["sh", "-c", openRolloutCmd(pids)], { stdout: "pipe", stderr: "ignore" });
    return p.stdout.toString().trim().split("\n")[0] || undefined;
  }

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

  async codexForFolder(cwd: string, limit: number) {
    const root = this.roots.codex;
    if (!existsSync(root)) return [];
    const cutoff = Date.now() - RECENT_DAYS * 86400_000;
    const hits: { path: string; mtime: number }[] = [];
    const desc = (d: string) => (existsSync(d) ? readdirSync(d).sort().reverse() : []);
    for (const y of desc(root))
      for (const m of desc(join(root, y)))
        for (const d of desc(join(root, y, m))) {
          const dir = join(root, y, m, d);
          for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
            const path = join(dir, f);
            const mtime = statSync(path).mtimeMs;
            if (mtime < cutoff) continue;
            let c = this.cwdCache.get(path);
            if (!c || c.mtime !== mtime) {
              const m2 = readHead(path, 8192).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
              c = { mtime, cwd: m2 ? JSON.parse(`"${m2[1]}"`) : undefined };
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

  async copyPrefix(src: string, dst: string, bytes: number | undefined, from: string, to: string) {
    const all = readFileSync(src);
    const part = bytes === undefined ? all : all.subarray(0, bytes);
    writeFileSync(dst, part.toString("utf8").split(from).join(to));
  }

  async sh(cmd: string) {
    const p = Bun.spawnSync(["sh", "-c", cmd], { stdout: "pipe", stderr: "ignore" });
    return p.stdout.toString();
  }

  async readFrom(path: string, offset: number, max: number) {
    let size: number;
    let file: string;
    try {
      const st = statSync(path);
      size = st.size;
      file = `${st.dev}:${st.ino}`;
    } catch {
      return undefined;
    }
    if (size <= offset) return { size, data: Buffer.alloc(0), file };
    const len = Math.min(size - offset, max);
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, offset);
      return { size, data: buf, file };
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

  async claudeSessionOfPid(pid: number) {
    if (!validPids([pid]).length) return undefined;
    const r = await this.exec(`cat "$HOME/.claude/sessions/${pid}.json" 2>/dev/null`);
    try {
      const rec = JSON.parse(r.out.toString());
      return typeof rec?.sessionId === "string" && rec.pid === pid ? rec.sessionId : undefined;
    } catch {
      return undefined;
    }
  }

  codexRolloutOfPids(pids: number[]) {
    if (!validPids(pids).length) return Promise.resolve(undefined);
    return this.line(openRolloutCmd(pids));
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

  async codexForFolder(cwd: string, limit: number) {
    const needle = sq(`"cwd":${JSON.stringify(cwd)}`);
    const r = await this.exec(
      `find "$HOME/.codex/sessions" -name 'rollout-*.jsonl' -mtime -${RECENT_DAYS} 2>/dev/null | xargs ls -t 2>/dev/null | head -n 120 | while IFS= read -r f; do head -c 8192 "$f" | grep -qF ${needle} && echo "$f"; done | head -n ${Math.max(1, Math.floor(limit))}`,
    );
    return r.out.toString().split("\n").map((l) => l.trim()).filter(Boolean);
  }

  async exists(path: string) {
    return (await this.line(`test -f ${sq(path)} && echo yes`)) === "yes";
  }

  async copyPrefix(src: string, dst: string, bytes: number | undefined, from: string, to: string) {
    if (!/^[0-9a-z-]+$/i.test(from) || !/^[0-9a-z-]+$/i.test(to)) throw new Error("ids must be plain uuids");
    const take = bytes === undefined ? `cat ${sq(src)}` : `head -c ${Math.max(0, Math.floor(bytes))} ${sq(src)}`;
    const r = await this.exec(`${take} | sed 's/${from}/${to}/g' > ${sq(dst)}`, { timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`could not copy the conversation: ${r.err}`);
  }

  async sh(cmd: string) {
    return (await this.exec(cmd)).out.toString();
  }

  async readFrom(path: string, offset: number, max: number) {
    const o = Math.max(0, Math.floor(offset));
    const r = await this.exec(
      `f=${sq(path)}; [ -f "$f" ] || exit 3; s=$(wc -c < "$f" | tr -d ' '); i=$(ls -di "$f" | awk '{print $1}'); echo "$s $i"; if [ ${max} -gt 0 ] && [ "$s" -gt ${o} ]; then n=$((s-${o})); [ "$n" -gt ${max} ] && n=${max}; tail -c +$((${o}+1)) "$f" | head -c "$n"; fi`,
      { timeoutMs: 60_000 },
    );
    if (r.code !== 0) return undefined;
    const nl = r.out.indexOf(10);
    if (nl < 0) return undefined;
    const [sizeText, file] = r.out.subarray(0, nl).toString().trim().split(/\s+/);
    const size = Number(sizeText);
    return Number.isFinite(size) ? { size, data: Buffer.from(r.out.subarray(nl + 1)), ...(file ? { file } : {}) } : undefined;
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
  /** pids of the pane's foreground processes, fetched lazily: the exact way to a running claude's or codex's file. */
  pids?: () => Promise<number[]>;
}

const isAgent = (a: string | undefined): a is Agent => a === "claude" || a === "codex" || a === "omp";

/** Text compared between a screen and a transcript: no whitespace, markdown marks, or bullets. */
export const norm = (t: string) => t.replace(/[\s*_`#>|$\\~•●⏺❯›⎿]+/g, "").toLowerCase();

/** Lines the agent drew for prompts and replies ("❯ …", "● …"), normalized, as matching keys. */
export function screenSnippets(screen: string) {
  const out = new Set<string>();
  for (const line of screen.split("\n")) {
    const m = line.match(/^\s*(?:❯|›|>|●|⏺|•)\s*(.+)$/);
    if (!m) continue;
    const n = norm(m[1]!);
    if (n.length >= 10) out.add(n.slice(0, 24));
  }
  return [...out];
}

/** Normalized user text, assistant text and tool lines of a transcript's last part. */
async function transcriptText(fs: TranscriptFS, path: string, agent: Agent) {
  const head = await fs.readFrom(path, 0, 0);
  if (!head) return "";
  const from = Math.max(0, head.size - 2 * 1024 * 1024);
  const r = await fs.readFrom(path, from, 2 * 1024 * 1024);
  if (!r) return "";
  const ctx = { n: 0 };
  const parts: string[] = [];
  for (const l of r.data.toString("utf8").split("\n")) {
    try {
      for (const op of PARSERS[agent](JSON.parse(l), ctx))
        if (op.op === "add") {
          const b = op.entry.block;
          parts.push(b.kind === "tool" ? `${b.name}(${b.summary}` : "text" in b ? b.text : "");
        }
    } catch {}
  }
  return norm(parts.join("\n"));
}

/** Of several candidate transcripts, the one whose content the pane's screen shows, if that is clear. */
export async function matchByScreen(fs: TranscriptFS, candidates: string[], screen: string, agent: Agent = "claude") {
  const snippets = screenSnippets(screen);
  if (!snippets.length || !candidates.length) return undefined;
  const scored = await Promise.all(
    candidates.map(async (path) => {
      const text = await transcriptText(fs, path, agent);
      return { path, score: snippets.filter((s) => text.includes(s)).length };
    }),
  );
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  const enough = best!.score >= Math.min(2, snippets.length);
  return enough && best!.score > (next?.score ?? 0) ? best!.path : undefined;
}

/** The title claude gave a conversation: it appends {"type":"ai-title","aiTitle":…} records all through the
 *  file, and shows the same text as the terminal title (which Herdr reports). Cached while the file does not grow. */
const titleCache = new WeakMap<TranscriptFS, Map<string, { size: number; title?: string }>>();
export async function claudeTitle(fs: TranscriptFS, path: string): Promise<string | undefined> {
  let cache = titleCache.get(fs);
  if (!cache) titleCache.set(fs, (cache = new Map()));
  const head = await fs.readFrom(path, 0, 0);
  if (!head) return undefined;
  const hit = cache.get(path);
  if (hit && hit.size === head.size) return hit.title;
  let title: string | undefined;
  for (const span of [256 * 1024, 4 * 1024 * 1024]) {
    const r = await fs.readFrom(path, Math.max(0, head.size - span), span);
    const all = r ? [...r.data.toString("utf8").matchAll(/"type":"ai-title","aiTitle":("(?:[^"\\]|\\.)*")/g)] : [];
    if (all.length) {
      try {
        title = JSON.parse(all.at(-1)![1]!);
      } catch {}
      break;
    }
    if (head.size <= span) break;
  }
  cache.set(path, { size: head.size, title });
  return title;
}

/** Of several candidate transcripts, the one whose title is the pane's terminal title, if exactly one is. */
export async function matchByTitle(fs: TranscriptFS, candidates: string[], paneTitle: string | undefined) {
  const want = paneTitle?.trim();
  if (!want || !candidates.length) return undefined;
  const titles = await Promise.all(candidates.map((c) => claudeTitle(fs, c).catch(() => undefined)));
  const hits = candidates.filter((_, i) => titles[i]?.trim() === want);
  return hits.length === 1 ? hits[0] : undefined;
}

export async function resolveTranscript(fs: TranscriptFS, { pane, panes, knownSession, knownPath, screen, argv, pids }: ResolveInput): Promise<{ source: ChatSource } | { reason: string }> {
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
  // the running process says which session it is in
  const procs = pids ? await pids().catch(() => [] as number[]) : [];
  if (agent === "claude")
    for (const pid of procs) {
      const id = await fs.claudeSessionOfPid(pid).catch(() => undefined);
      const r = id ? found(await fs.claudeById(id), "session") : undefined;
      if (r) return r;
    }
  if (agent === "codex" && procs.length) {
    const r = found(await fs.codexRolloutOfPids(procs).catch(() => undefined), "session");
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
    const candidates = await fs.claudeForFolder(pane.cwd, 15);
    // the terminal title is the conversation's title: the surest sign when nothing above reported the session
    const titled = await matchByTitle(fs, candidates, pane.title);
    if (titled) return { source: { agent, path: titled, how: "title" } };
    const sharing = panes.filter((p) => p.agent === "claude" && p.cwd === pane.cwd && p.machine === pane.machine).length;
    if (sharing > 1) {
      const hit = screen ? await matchByScreen(fs, candidates, await screen().catch(() => "")) : undefined;
      if (hit) return { source: { agent, path: hit, how: "screen" } };
      return { reason: `${sharing} claude agents run in ${pane.cwd} and the screen does not show which conversation is this one yet` };
    }
    const r = found(candidates[0], "folder");
    if (r) return r;
    return { reason: "no claude transcript for this folder yet" };
  }
  if (agent === "codex") {
    // not reported to Herdr (started before its integration, or by hand): find it by folder, like claude
    const candidates = await fs.codexForFolder(pane.cwd, 15);
    const sharing = panes.filter((p) => p.agent === "codex" && p.cwd === pane.cwd && p.machine === pane.machine).length;
    if (candidates.length && sharing <= 1) return { source: { agent, path: candidates[0]!, how: "folder" } };
    if (candidates.length && screen) {
      const hit = await matchByScreen(fs, candidates, await screen().catch(() => ""), "codex");
      if (hit) return { source: { agent, path: hit, how: "screen" } };
    }
    if (candidates.length) return { reason: `${sharing} codex agents run in ${pane.cwd} and the screen does not show which conversation is this one yet` };
  }
  return { reason: knownSession || pane.session ? "the transcript file has not been written yet" : `${agent} has not reported its session to Herdr yet` };
}

/** Follows one transcript file: parses what is there (the last MAX_INITIAL bytes), then whatever gets appended. */
export class TranscriptTail {
  private offset = -1;
  private partial = Buffer.alloc(0);
  private ctx: ParseCtx = { n: 0 };
  /** The last bytes read (up to TAIL_MARK): read again each time to notice a rewrite. */
  private mark = Buffer.alloc(0);
  /** The file read (device and inode), when the file access tells it. */
  private file?: string;
  /** Bytes skipped at the start because the file was larger than MAX_INITIAL. */
  skipped = 0;

  constructor(
    readonly source: ChatSource,
    private fs: TranscriptFS,
    private maxInitial = MAX_INITIAL,
  ) {}

  /**
   * New ops since the last call. Starts over if the file was rewritten: it shrank, it is another file now (written
   * next to it and renamed over it, as omp does when it rewrites a session, e.g. to prune old tool output: often to
   * the same size or larger), or the bytes just before the read offset changed. Bytes further back may change in
   * place without a restart (omp's fixed-width title line).
   */
  async read(again = false): Promise<{ ops: ChatOp[]; reset: boolean }> {
    const reset = again;
    if (this.offset < 0) {
      const head = await this.fs.readFrom(this.source.path, 0, 0);
      if (!head) return { ops: [], reset };
      this.offset = Math.max(0, head.size - this.maxInitial);
      this.skipped = this.offset;
      this.file = head.file;
    }
    const back = this.mark.length;
    const chunk = await this.fs.readFrom(this.source.path, this.offset - back, 16 * 1024 * 1024 + back);
    if (!chunk) return { ops: [], reset };
    const replaced = !!this.file && !!chunk.file && chunk.file !== this.file;
    if (replaced || chunk.size < this.offset || (back && !chunk.data.subarray(0, back).equals(this.mark))) {
      this.offset = -1; // as when first opened: the last MAX_INITIAL bytes
      this.skipped = 0;
      this.partial = Buffer.alloc(0);
      this.mark = Buffer.alloc(0);
      this.file = undefined;
      this.ctx = { n: 0 };
      if (again) return { ops: [], reset }; // rewritten again while starting over: the next read starts over once more
      return this.read(true);
    }
    this.file ??= chunk.file;
    const data = chunk.data.subarray(back);
    if (!data.length) return { ops: [], reset };
    this.mark = Buffer.from((data.length >= TAIL_MARK ? data : Buffer.concat([this.mark, data])).subarray(-TAIL_MARK));
    // split on newline bytes, so a read that ends inside a multi-byte character cannot corrupt a line
    let buf = this.partial.length ? Buffer.concat([this.partial, data]) : data;
    // byte offset in the file where buf starts: entries remember where their line starts (fork points)
    let start = this.offset - this.partial.length;
    if (this.skipped && this.offset === this.skipped && !this.partial.length) {
      const cut = buf.indexOf(10) + 1; // drop the cut first line
      buf = buf.subarray(cut);
      start += cut;
    }
    this.offset += data.length;
    const end = buf.lastIndexOf(10);
    this.partial = Buffer.from(buf.subarray(end + 1));
    const parse = PARSERS[this.source.agent];
    const ops: ChatOp[] = [];
    for (let pos = 0; pos <= end; ) {
      const nl = buf.indexOf(10, pos);
      const line = buf.subarray(pos, nl).toString("utf8");
      const lineStart = start + pos;
      pos = nl + 1;
      if (!line.trim()) continue;
      try {
        for (const op of parse(JSON.parse(line), this.ctx)) {
          if (op.op === "add") op.entry.ref = lineStart;
          ops.push(op);
        }
      } catch {}
    }
    return { ops, reset };
  }
}
