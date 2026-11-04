// Find the transcript file behind an agent pane and stream its entries to the UI as they are written.
// Works for local panes (files on this machine) and remote panes (files read over SSH).
//
// Finding the file, most exact first:
//   1. a session id agent-flow gave the agent at launch (claude --session-id), or recorded for a pane;
//   2. what the agent's Herdr integration reported: a path (omp) or a session id (codex);
//   3. claude only: a session id in the process's own argv (--resume/--session-id, also how Herdr restores);
//   4. claude only: the newest transcript for the pane's folder, when no other claude pane shares that folder.
// gemini reports nothing and holds no file open: its session is the newest of the folder's sessions written since its
// process started (it writes the file at startup, a new one after /clear or a trust restart, and appends to the one
// it resumes), told apart from other gemini agents in the folder by the screen.
// If none works, the UI shows the plain terminal.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ChatOp, ChatSource, HPane } from "@af/core";
import { type Agent, PARSERS, type ParseCtx } from "./parse.ts";
import { sq } from "../remote.ts";

/** Load at most this much of a transcript when opening it; older history is skipped. */
/**
 * How much of a transcript is opened at first, and how much more each time the user scrolls to the top: about this
 * much conversation. A line counts at most LINE_WEIGHT bytes, so a few huge lines (screenshots, request dumps)
 * cannot push the rest of the conversation out.
 */
export const WINDOW_WEIGHT = 1536 * 1024;
const LINE_WEIGHT = 4096;
/** Raw bytes read for one window at most (over SSH less: it is slower). */
export const WINDOW_RAW = 96 * 1024 * 1024;
export const WINDOW_RAW_REMOTE = 24 * 1024 * 1024;
/** Kept for callers that size the first window in bytes (tests). */
export const MAX_INITIAL = WINDOW_WEIGHT;
const SCAN_CHUNK = 4 * 1024 * 1024;

/**
 * The start of the window that ends at `end`: a line start such that the lines in [start, end) weigh about
 * `weight` (each line at most LINE_WEIGHT), or 0. Never more than `raw` bytes back.
 */
export async function windowStart(fs: TranscriptFS, path: string, end: number, weight: number, raw: number): Promise<number> {
  let lineStart = end; // start of the last line counted (end itself: nothing counted yet)
  let total = 0;
  let pos = end;
  while (pos > 0) {
    const from = Math.max(0, pos - SCAN_CHUNK);
    const r = await fs.readFrom(path, from, pos - from);
    if (!r) return lineStart;
    const d = r.data;
    for (let i = d.length - 1; i >= 0; i--) {
      if (d[i] !== 10) continue;
      const start = from + i + 1;
      if (start < lineStart) {
        total += Math.min(lineStart - start, LINE_WEIGHT);
        lineStart = start;
        if (total >= weight || end - lineStart >= raw) return lineStart;
      }
    }
    pos = from;
  }
  return 0;
}

/**
 * Images in chat ops travel as references ("afimg:<id>"), fetched by the browser only when shown: screenshots made
 * transcripts send megabytes on every open. A reference names the line the image is on; reading it again gives the
 * image. Small images stay inline.
 */
const INLINE_IMAGE = 24 * 1024;
interface ImageRef {
  fs: TranscriptFS;
  agent: Agent;
  path: string;
  line: number;
  k: number;
}
const imageRefs = new Map<string, ImageRef>();
let imageSeq = 0;
const MAX_REFS = 20_000;
function refImage(ref: ImageRef) {
  const id = `${(++imageSeq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  imageRefs.set(id, ref);
  if (imageRefs.size > MAX_REFS) imageRefs.delete(imageRefs.keys().next().value!);
  return `afimg:${id}`;
}

/** Every image list in an op, in order. */
function imageLists(op: ChatOp): string[][] {
  if (op.op === "add") {
    const b = op.entry.block as { images?: string[] };
    return b.images ? [b.images] : [];
  }
  if (op.op === "result") return op.images ? [op.images] : [];
  if (op.op === "update") return op.set.images ? [op.set.images] : [];
  return [];
}

/** The image an "afimg:" reference stands for: its bytes and type, read from the transcript again. */
export async function chatImage(id: string): Promise<{ type: string; bytes: Buffer } | undefined> {
  const ref = imageRefs.get(id);
  if (!ref) return undefined;
  const r = await ref.fs.readFrom(ref.path, ref.line, 64 * 1024 * 1024);
  if (!r) return undefined;
  const nl = r.data.indexOf(10);
  const line = r.data.subarray(0, nl < 0 ? r.data.length : nl).toString("utf8");
  let ops: ChatOp[];
  try {
    ops = PARSERS[ref.agent](JSON.parse(line), { n: 0 });
  } catch {
    return undefined;
  }
  const all = ops.flatMap(imageLists).flat();
  const url = all[ref.k];
  const m = url?.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!m) return undefined;
  return { type: m[1] || "image/png", bytes: m[2] ? Buffer.from(m[3]!, "base64") : Buffer.from(decodeURIComponent(m[3]!)) };
}
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
  /** Gemini CLI session files (last two weeks) of the project for `cwd`, last written first, at most `limit`. */
  geminiForFolder(cwd: string, limit: number): Promise<GeminiSession[]>;
  /** The Gemini CLI session file of a session id (chats/session-<time>-<first 8 of the id>.jsonl). */
  geminiById(id: string): Promise<string | undefined>;
  /** When the youngest of these processes (or their children) that runs Gemini CLI started, by that machine's clock. */
  geminiStartOfPids(pids: number[]): Promise<number | undefined>;
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
  /** The codex rollout file named by an id: a thread's first file ("…-<id>.jsonl") or a later page ("…_<id>.jsonl"). */
  codexFilesById(id: string): Promise<string[]>;
  /** The session a running claude process is in: claude keeps <config>/sessions/<pid>.json up to date (also after /clear). */
  claudeSessionOfPid(pid: number): Promise<string | undefined>;
  /**
   * The rollout file a running codex process (or its children) holds open, from lsof. null: checked, none open (a
   * codex that has not been sent anything yet); undefined: could not check.
   */
  codexRolloutOfPids(pids: number[]): Promise<string | null | undefined>;
}

const validPids = (pids: number[]) => pids.filter((p) => Number.isInteger(p) && p > 1);
/** A shell command printing the first codex rollout that these processes or their children hold open. */
export const openRolloutCmd = (pids: number[]) =>
  String.raw`command -v lsof >/dev/null 2>&1 || exit 0; pids="$(for p in ${validPids(pids).join(" ")}; do echo $p; pgrep -P $p 2>/dev/null; done | paste -sd, -)"; [ -n "$pids" ] || exit 0; lsof -Fn -p "$pids" 2>/dev/null | sed -n 's/^n\(.*\/sessions\/.*rollout-.*\.jsonl\)$/\1/p' | head -n 1; echo "#checked"`;
/** The answer of openRolloutCmd: the open rollout, null when none is open, undefined when lsof could not run. */
export const parseOpenRollout = (out: string) => {
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.includes("#checked")) return undefined;
  return lines.find((l) => l !== "#checked") ?? null;
};

/** A Gemini CLI session file: when it was last written, and when its session started (its header's startTime), in ms. */
export interface GeminiSession {
  path: string;
  mtime: number;
  start?: number;
}

/** A shell command printing "<pid> <elapsed> <command>" for these processes and their children, then "#now <epoch s>". */
export const processStartCmd = (pids: number[]) =>
  String.raw`pids="$(for p in ${validPids(pids).join(" ")}; do echo $p; pgrep -P $p 2>/dev/null; done | paste -sd, -)"; [ -n "$pids" ] && ps -o pid= -o etime= -o command= -p "$pids" 2>/dev/null; echo "#now $(date +%s)"`;

/** ps's elapsed time ("[[dd-]hh:]mm:ss") in seconds. */
const elapsed = (e: string) => {
  const m = e.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  return m ? ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3])) * 60 + Number(m[4]) : undefined;
};

/** The answer of processStartCmd: when the youngest Gemini CLI process started (ms), or undefined. */
export function parseGeminiStart(out: string): number | undefined {
  const now = Number(out.match(/^#now (\d+)$/m)?.[1]);
  if (!Number.isFinite(now)) return undefined;
  let start: number | undefined;
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    // the gemini executable or its script (node …/gemini.js), not a command that merely mentions it
    if (!m || !/(^|\/)gemini(\.js)?(\s|$)/.test(m[3]!)) continue;
    const e = elapsed(m[2]!);
    if (e === undefined) continue;
    const t = (now - e) * 1000;
    if (start === undefined || t > start) start = t;
  }
  return start;
}

/**
 * A shell command printing "<mtime s>\t<startTime>\t<path>" for the Gemini CLI sessions of the project whose folder
 * is `cwd` (the folder ~/.gemini/tmp/<project>/.project_root names), last written first.
 */
export const geminiFolderCmd = (cwd: string, limit: number) =>
  String.raw`g="${"$"}{GEMINI_CLI_HOME:-$HOME}/.gemini"; want=${sq(cwd)}; for d in "$g"/tmp/*/; do [ "$(cat "$d.project_root" 2>/dev/null)" = "$want" ] || continue; find "$d"chats -maxdepth 1 -name 'session-*.jsonl' -mtime -${RECENT_DAYS} 2>/dev/null | while IFS= read -r f; do m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null); st=$(head -c 2000 "$f" | head -n 1 | sed -n 's/.*"startTime":"\([^"]*\)".*/\1/p'); printf '%s\t%s\t%s\n' "$m" "$st" "$f"; done; done | sort -rn | head -n ${Math.max(1, Math.floor(limit))}`;

export const parseGeminiFolder = (out: string): GeminiSession[] =>
  out
    .split("\n")
    .map((l) => l.split("\t"))
    .filter((p) => p.length >= 3 && p[2]!.trim() && Number.isFinite(Number(p[0])))
    .map(([m, st, ...path]) => ({ path: path.join("\t").trim(), mtime: Number(m) * 1000, ...(Date.parse(st!) ? { start: Date.parse(st!) } : {}) }));

export interface Roots {
  claude: string;
  codex: string;
  /** Gemini CLI's folder (~/.gemini). */
  gemini?: string;
}

export const defaultRoots = (): Roots => ({
  claude: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
  codex: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
  gemini: join(process.env.GEMINI_CLI_HOME ?? homedir(), ".gemini"),
});

/** The first line of a Gemini session file: {sessionId, startTime, kind}. */
function geminiHeader(path: string): { sessionId?: string; startTime?: string; kind?: string } {
  try {
    const head = readHead(path, 4096);
    const nl = head.indexOf("\n");
    return JSON.parse(nl < 0 ? head : head.slice(0, nl));
  } catch {
    return {};
  }
}

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
  private geminiStarts = new Map<string, number>();
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
    return parseOpenRollout(p.stdout.toString());
  }

  async geminiStartOfPids(pids: number[]) {
    if (!validPids(pids).length) return undefined;
    // asked every few seconds while a gemini pane is open: not blocking the server meanwhile
    const p = Bun.spawn(["sh", "-c", processStartCmd(pids)], { stdout: "pipe", stderr: "ignore" });
    return parseGeminiStart(await new Response(p.stdout).text());
  }

  private get geminiRoot() {
    return this.roots.gemini ?? join(process.env.GEMINI_CLI_HOME ?? homedir(), ".gemini");
  }

  /** The folder Gemini CLI keeps a project's sessions in (tmp/<project>), from projects.json or the folders' markers. */
  private geminiProject(cwd: string): string | undefined {
    const tmp = join(this.geminiRoot, "tmp");
    try {
      const slug = JSON.parse(readFileSync(join(this.geminiRoot, "projects.json"), "utf8"))?.projects?.[cwd];
      if (typeof slug === "string" && existsSync(join(tmp, slug))) return join(tmp, slug);
    } catch {}
    if (!existsSync(tmp)) return undefined;
    for (const d of readdirSync(tmp)) {
      try {
        if (readFileSync(join(tmp, d, ".project_root"), "utf8").trim() === cwd) return join(tmp, d);
      } catch {}
    }
    return undefined;
  }

  async geminiForFolder(cwd: string, limit: number) {
    const dir = this.geminiProject(cwd);
    const chats = dir && join(dir, "chats");
    if (!chats || !existsSync(chats)) return [];
    const cutoff = Date.now() - RECENT_DAYS * 86400_000;
    const hits: GeminiSession[] = [];
    for (const f of readdirSync(chats)) {
      if (!f.startsWith("session-") || !f.endsWith(".jsonl")) continue;
      const path = join(chats, f);
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtime < cutoff) continue;
      // the start never changes: read once per file
      let start = this.geminiStarts.get(path);
      if (start === undefined) {
        start = Date.parse(geminiHeader(path).startTime ?? "");
        this.geminiStarts.set(path, start);
      }
      hits.push({ path, mtime, ...(Number.isFinite(start) ? { start } : {}) });
    }
    return hits.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
  }

  async geminiById(id: string) {
    const tmp = join(this.geminiRoot, "tmp");
    if (!/^[0-9a-z_-]+$/i.test(id) || !existsSync(tmp)) return undefined;
    const short = `-${id.slice(0, 8)}.jsonl`;
    for (const d of readdirSync(tmp)) {
      const chats = join(tmp, d, "chats");
      let files: string[];
      try {
        files = readdirSync(chats);
      } catch {
        continue;
      }
      for (const f of files) if (f.startsWith("session-") && f.endsWith(short) && geminiHeader(join(chats, f)).sessionId === id) return join(chats, f);
    }
    return undefined;
  }

  async claudeById(id: string) {
    if (!existsSync(this.roots.claude)) return undefined;
    for (const dir of readdirSync(this.roots.claude)) {
      const f = join(this.roots.claude, dir, `${id}.jsonl`);
      if (existsSync(f)) return f;
    }
    return undefined;
  }

  async codexFilesById(id: string) {
    const root = this.roots.codex;
    if (!existsSync(root) || !/^[0-9a-z-]+$/i.test(id)) return [];
    const out: string[] = [];
    const ls = (d: string) => (existsSync(d) ? readdirSync(d).sort().reverse() : []);
    for (const y of ls(root))
      for (const m of ls(join(root, y)))
        for (const d of ls(join(root, y, m)))
          for (const f of ls(join(root, y, m, d))) if (f.endsWith(`-${id}.jsonl`) || f.endsWith(`_${id}.jsonl`)) out.push(join(root, y, m, d, f));
    return out;
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

  async codexRolloutOfPids(pids: number[]) {
    if (!validPids(pids).length) return undefined;
    const r = await this.exec(openRolloutCmd(pids));
    return parseOpenRollout(r.out.toString());
  }

  async geminiStartOfPids(pids: number[]) {
    if (!validPids(pids).length) return undefined;
    const r = await this.exec(processStartCmd(pids));
    return parseGeminiStart(r.out.toString());
  }

  async geminiForFolder(cwd: string, limit: number) {
    const r = await this.exec(geminiFolderCmd(cwd, limit));
    return parseGeminiFolder(r.out.toString());
  }

  geminiById(id: string) {
    if (!/^[0-9a-z_-]+$/i.test(id)) return Promise.resolve(undefined);
    const needle = sq(`"sessionId":${JSON.stringify(id)}`);
    return this.line(`for f in "${"$"}{GEMINI_CLI_HOME:-$HOME}"/.gemini/tmp/*/chats/session-*-${id.slice(0, 8)}.jsonl; do [ -f "$f" ] && head -c 2000 "$f" | head -n 1 | grep -qF ${needle} && echo "$f"; done 2>/dev/null | head -n 1`);
  }

  claudeById(id: string) {
    if (!/^[0-9a-f-]+$/i.test(id)) return Promise.resolve(undefined);
    return this.line(`ls -1 "$HOME"/.claude/projects/*/${id}.jsonl 2>/dev/null | head -n 1`);
  }

  async codexFilesById(id: string) {
    if (!/^[0-9a-z-]+$/i.test(id)) return [];
    const r = await this.exec(`ls -1 "$HOME"/.codex/sessions/*/*/*/*-${id}.jsonl "$HOME"/.codex/sessions/*/*/*/*_${id}.jsonl 2>/dev/null`);
    return r.out
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
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

const isAgent = (a: string | undefined): a is Agent => a === "claude" || a === "codex" || a === "omp" || a === "gemini";

/** Text compared between a screen and a transcript: no whitespace, markdown marks, or bullets. */
export const norm = (t: string) => t.replace(/[\s*_`#>|$\\~•●⏺❯›⎿✦]+/g, "").toLowerCase();

/** Lines the agent drew for prompts and replies ("❯ …", "● …"), normalized, as matching keys. */
export function screenSnippets(screen: string) {
  const out = new Set<string>();
  for (const line of screen.split("\n")) {
    const m = line.match(/^\s*(?:❯|›|>|●|⏺|•|✦)\s*(.+)$/);
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
  const found = (path: string | undefined | null, how: ChatSource["how"]) => (path ? { source: { agent, path, how } } : undefined);
  /** Locked to a conversation the agent has not written yet. */
  const pending = (path = "") => ({ source: { agent, path, how: "session" as const, pending: true } });
  const procs = pids ? await pids().catch(() => [] as number[]) : [];
  if (agent === "gemini") return resolveGemini(fs, { pane, panes, knownSession, knownPath, screen, argv, pids }, procs);
  const args = procs.length || agent !== "omp" ? await argv().catch(() => [] as string[][]) : [];
  const flat = args.flat();

  // 1. what the running process says: exact, and up to date after /clear or /new
  if (agent === "claude") {
    for (const pid of procs) {
      const id = await fs.claudeSessionOfPid(pid).catch(() => undefined);
      if (!id) continue;
      const r = found(await fs.claudeById(id), "session");
      if (r) return r;
      // a fresh session (its file comes with the first message) — unless it resumes one, which has its own file
      if (!flat.some((a) => /^(--resume|-r|--continue|-c)(=|$)/.test(a))) return pending();
    }
  }
  if (agent === "codex" && procs.length) {
    const open = await fs.codexRolloutOfPids(procs).catch(() => undefined);
    if (open) return { source: { agent, path: open, how: "session" } };
    if (open === null) {
      // codex resume/fork <id> shows that conversation before writing anything of its own
      const i = flat.findIndex((a) => a === "resume" || a === "fork");
      const id = i >= 0 ? flat.slice(i + 1).find((a) => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(a)) : undefined;
      const r = id ? found(await fs.codexById(id), "session") : undefined;
      return r ?? pending();
    }
  }

  // 2. what agent-flow or Herdr was told
  if (knownPath && (await fs.exists(knownPath))) return { source: { agent, path: knownPath, how: "session" } };
  if (knownSession) {
    const r = found(await byId(knownSession), "session");
    if (r) return r;
  }
  if (pane.session?.kind === "path") return (await fs.exists(pane.session.value)) ? { source: { agent, path: pane.session.value, how: "session" } } : pending(pane.session.value);
  if (pane.session?.kind === "id") {
    const r = found(await byId(pane.session.value), "session");
    if (r) return r;
  }
  if (knownSession || pane.session) return pending(knownPath ?? "");

  // 3. guesses, for agents whose process cannot be asked
  if (agent === "claude") {
    for (const a of args) {
      const i = a.findIndex((x) => x === "--resume" || x === "-r" || x === "--session-id");
      const id = i >= 0 ? a[i + 1] : a.find((x) => /^--(resume|session-id)=/.test(x))?.split("=")[1];
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
    const candidates = await fs.codexForFolder(pane.cwd, 15);
    const sharing = panes.filter((p) => p.agent === "codex" && p.cwd === pane.cwd && p.machine === pane.machine).length;
    if (candidates.length && sharing <= 1) return { source: { agent, path: candidates[0]!, how: "folder" } };
    if (candidates.length && screen) {
      const hit = await matchByScreen(fs, candidates, await screen().catch(() => ""), "codex");
      if (hit) return { source: { agent, path: hit, how: "screen" } };
    }
    if (candidates.length) return { reason: `${sharing} codex agents run in ${pane.cwd} and the screen does not show which conversation is this one yet` };
  }
  return { reason: `${agent} has not reported its session to Herdr yet` };
}

/** ps gives a process's start in whole seconds, and a session file is written a moment after its process starts. */
const START_SLACK = 3000;

/**
 * gemini: Herdr reports no session for it and it holds no file open. It writes its session file when it starts (and a
 * new one after /clear, or when it restarts itself after the folder-trust question), and appends to a session it
 * resumes, so its session is the last written of the folder's sessions that were written since its process started.
 * Several gemini agents in one folder are told apart by the session that started with the process, or the screen.
 */
async function resolveGemini(fs: TranscriptFS, { pane, panes, knownSession, knownPath, screen }: ResolveInput, procs: number[]): Promise<{ source: ChatSource } | { reason: string }> {
  const agent = "gemini" as const;
  const found = (path: string, how: ChatSource["how"]) => ({ source: { agent, path, how } });
  const start = procs.length ? await fs.geminiStartOfPids(procs).catch(() => undefined) : undefined;
  const all = await fs.geminiForFolder(pane.cwd, 20).catch(() => [] as GeminiSession[]);
  const mine = start === undefined ? [] : all.filter((c) => c.mtime >= start - START_SLACK);
  const sharing = panes.filter((p) => p.agent === "gemini" && p.cwd === pane.cwd && p.machine === pane.machine).length;

  // what agent-flow or Herdr was told: exact, unless the process started after it was last written (a restart)
  const told =
    knownPath && (await fs.exists(knownPath))
      ? knownPath
      : knownSession
        ? await fs.geminiById(knownSession).catch(() => undefined)
        : pane.session?.kind === "path" && (await fs.exists(pane.session.value))
          ? pane.session.value
          : pane.session?.kind === "id"
            ? await fs.geminiById(pane.session.value).catch(() => undefined)
            : undefined;
  if (told) {
    const c = all.find((x) => x.path === told);
    if (start === undefined || !c || c.mtime >= start - START_SLACK) {
      // alone in the folder, a session of this process written after it (/clear) is the one shown now
      const newer = sharing <= 1 && c ? mine.find((x) => x.mtime > c.mtime && x.path !== told) : undefined;
      return found(newer?.path ?? told, "session");
    }
  }

  if (start !== undefined) {
    if (!mine.length) return { source: { agent, path: "", how: "session", pending: true } }; // starting: its file comes in a moment
    if (sharing <= 1) return found(mine[0]!.path, "session");
    // the only session that started with this process (another agent's older session may have been written since)
    const own = mine.filter((c) => c.start !== undefined && c.start >= start - START_SLACK);
    if (own.length === 1) return found(own[0]!.path, "session");
    const hit = screen ? await matchByScreen(fs, mine.map((c) => c.path), await screen().catch(() => ""), agent) : undefined;
    if (hit) return found(hit, "screen");
    return { reason: `${sharing} gemini agents run in ${pane.cwd} and the screen does not show which conversation is this one yet` };
  }

  // the process could not be asked: guesses from the folder
  if (!all.length) return { reason: "no gemini session for this folder yet" };
  if (sharing <= 1) return found(all[0]!.path, "folder");
  const hit = screen ? await matchByScreen(fs, all.slice(0, 15).map((c) => c.path), await screen().catch(() => ""), agent) : undefined;
  if (hit) return found(hit, "screen");
  return { reason: `${sharing} gemini agents run in ${pane.cwd} and the screen does not show which conversation is this one yet` };
}

/** A transcript's first line, parsed (session headers), or undefined. */
async function firstLine(fs: TranscriptFS, path: string): Promise<any> {
  const r = await fs.readFrom(path, 0, 512 * 1024);
  if (!r) return undefined;
  const nl = r.data.indexOf(10);
  try {
    return JSON.parse(r.data.subarray(0, nl < 0 ? r.data.length : nl).toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The earlier files a codex rollout continues, nearest first: after a rewind (or a fork) codex starts a new file
 * whose header names its base (history_base: the id the base file is named by, and the byte it ends at) and holds
 * only what comes after it. The first rewind names the thread's first file, a later one the page before it.
 */
export async function codexBases(fs: TranscriptFS, path: string, depth = 0): Promise<{ path: string; end: number }[]> {
  if (depth > 30) return [];
  const head = await firstLine(fs, path);
  const base = head?.type === "session_meta" ? head.payload?.history_base : undefined;
  const id = typeof base?.thread_id === "string" ? base.thread_id : undefined;
  const end = Number(base?.end_byte_offset);
  if (!id || !Number.isFinite(end) || end <= 0) return [];
  const file = (await fs.codexFilesById(id).catch(() => [] as string[])).find((f) => f !== path);
  if (!file) return [];
  return [{ path: file, end }, ...(await codexBases(fs, file, depth + 1))];
}

/**
 * Follows one transcript file: parses its last part (about WINDOW_WEIGHT of conversation), then whatever gets
 * appended, and earlier parts on request (the user scrolled to the top).
 */
export class TranscriptTail {
  private offset = -1;
  private partial = Buffer.alloc(0);
  private ctx: ParseCtx = { n: 0 };
  /** The last bytes read (up to TAIL_MARK): read again each time to notice a rewrite. */
  private mark = Buffer.alloc(0);
  /** The file read (device and inode), when the file access tells it. */
  private file?: string;
  /** Where the part shown so far starts (a line start): earlier parts are read from before it. 0: all of it. */
  skipped = 0;
  private pages = 0;
  /** Earlier files this one continues (codex after a rewind), nearest first, and how far back each is read. */
  private bases: { path: string; end: number }[] = [];
  private baseAt = -1;
  private baseSkipped = 0;
  /** Files (this one, its bases) that start where a rewind went back to. */
  private rewound = new Set<string>();

  constructor(
    readonly source: ChatSource,
    private fs: TranscriptFS,
    /** About how much conversation a window holds (see WINDOW_WEIGHT). */
    private weight = WINDOW_WEIGHT,
    private raw = WINDOW_RAW,
    /** Byte ranges of this file whose entries are hidden (turns removed by a rewind the file does not show yet). */
    private cuts: () => { from: number; to: number }[] = () => [],
  ) {}

  /** Earlier conversation exists before what was read. */
  get more() {
    if (this.baseAt < 0) return this.skipped > 0 || this.bases.length > 0;
    return this.baseSkipped > 0 || this.baseAt < this.bases.length - 1;
  }

  /**
   * Parse [from, to) of a file (whole lines), with `ctx`. Entries of the transcript itself remember where their line
   * starts (fork and rewind points); entries of a base file do not. Entries in a cut range are left out.
   */
  private async parseRange(from: number, to: number, ctx: ParseCtx, data?: Buffer, path = this.source.path): Promise<ChatOp[]> {
    const buf = data ?? (await this.fs.readFrom(path, from, to - from))?.data;
    if (!buf) return [];
    const own = path === this.source.path;
    const cuts = own ? this.cuts() : [];
    const parse = PARSERS[this.source.agent];
    const ops: ChatOp[] = [];
    for (let pos = 0; pos < buf.length; ) {
      let nl = buf.indexOf(10, pos);
      if (nl < 0) nl = buf.length;
      const lineStart = from + pos;
      const raw = buf.subarray(pos, nl);
      pos = nl + 1;
      if (raw.length < 2) continue;
      let lineOps: ChatOp[];
      try {
        lineOps = parse(JSON.parse(raw.toString("utf8")), ctx);
      } catch {
        continue;
      }
      const hidden = cuts.some((c) => lineStart >= c.from && lineStart < c.to);
      let k = 0;
      for (const op of lineOps) {
        if (op.op === "add") {
          if (hidden) continue; // still parsed: the parser's state (open tool calls, the conversation tree) stays right
          if (own) op.entry.ref = lineStart;
          const b = op.entry.block;
          if (lineStart === 0 && this.rewound.has(path) && b.kind === "notice" && b.divider && /^(Continued from an earlier file|Forked from)/.test(b.text))
            op.entry.block = { ...b, text: "↶ Rewound here: the turns that came after this point were removed" };
        }
        for (const list of imageLists(op))
          for (let i = 0; i < list.length; i++, k++)
            if (list[i]!.length > INLINE_IMAGE && list[i]!.startsWith("data:")) list[i] = refImage({ fs: this.fs, agent: this.source.agent, path, line: lineStart, k });
        ops.push(op);
      }
    }
    return ops;
  }

  /**
   * New ops since the last call. Starts over if the file was rewritten: it shrank, it is another file now (written
   * next to it and renamed over it, as omp does when it rewrites a session, e.g. to prune old tool output: often to
   * the same size or larger), or the bytes just before the read offset changed. Bytes further back may change in
   * place without a restart (omp's fixed-width title line).
   */
  async read(again = false): Promise<{ ops: ChatOp[]; reset: boolean }> {
    const reset = again;
    let first = false;
    if (this.offset < 0) {
      const head = await this.fs.readFrom(this.source.path, 0, 0);
      if (!head) return { ops: [], reset };
      this.offset = await windowStart(this.fs, this.source.path, head.size, this.weight, this.raw);
      this.skipped = this.offset;
      this.file = head.file;
      this.bases = this.source.agent === "codex" ? await codexBases(this.fs, this.source.path).catch(() => []) : [];
      this.baseAt = -1;
      // a file whose base goes on past the point it continues from: the turns after that point were rewound away
      this.rewound.clear();
      const chain = [this.source.path, ...this.bases.map((b) => b.path)];
      for (let i = 0; i < this.bases.length; i++) {
        const b = this.bases[i]!;
        if (((await this.fs.readFrom(b.path, 0, 0))?.size ?? 0) > b.end) this.rewound.add(chain[i]!);
      }
      first = true;
    }
    const back = this.mark.length;
    // the first read takes the whole window at once; later ones what was appended (16 MB at a time)
    const chunk = await this.fs.readFrom(this.source.path, this.offset - back, (first ? this.raw : 16 * 1024 * 1024) + back);
    if (!chunk) return { ops: [], reset };
    const replaced = !!this.file && !!chunk.file && chunk.file !== this.file;
    if (replaced || chunk.size < this.offset || (back && !chunk.data.subarray(0, back).equals(this.mark))) {
      this.offset = -1; // as when first opened
      this.skipped = 0;
      this.partial = Buffer.alloc(0);
      this.mark = Buffer.alloc(0);
      this.file = undefined;
      this.ctx = { n: 0 };
      this.pages = 0;
      if (again) return { ops: [], reset }; // rewritten again while starting over: the next read starts over once more
      return this.read(true);
    }
    this.file ??= chunk.file;
    const data = chunk.data.subarray(back);
    if (!data.length) return { ops: [], reset };
    this.mark = Buffer.from((data.length >= TAIL_MARK ? data : Buffer.concat([this.mark, data])).subarray(-TAIL_MARK));
    // split on newline bytes, so a read that ends inside a multi-byte character cannot corrupt a line
    const buf = this.partial.length ? Buffer.concat([this.partial, data]) : data;
    // byte offset in the file where buf starts: entries remember where their line starts (fork points)
    const start = this.offset - this.partial.length;
    this.offset += data.length;
    const end = buf.lastIndexOf(10);
    this.partial = Buffer.from(buf.subarray(end + 1));
    const ops = end < 0 ? [] : await this.parseRange(start, start + end + 1, this.ctx, buf.subarray(0, end + 1));
    // a codex file that continues earlier ones (after rewinds) and is read whole: earlier parts go first, until the
    // first window is about full
    if (first && this.skipped === 0 && this.bases.length) {
      let before: ChatOp[] = [];
      let read = start + end + 1 - this.skipped;
      for (let i = 0; i < 40 && this.more && read < this.weight; i++) {
        const earlier = await this.readEarlier();
        before = [...earlier.ops, ...before];
        read += earlier.bytes;
      }
      return { ops: [...before, ...ops], reset };
    }
    return { ops, reset };
  }

  /**
   * The conversation before what was read so far, about one window of it. Parsed on its own (fresh state), with
   * keys of its own, so it can be put in front of what the browser has.
   */
  async readEarlier(): Promise<{ ops: ChatOp[]; more: boolean; bytes: number }> {
    let path = this.source.path;
    let end: number;
    if (this.baseAt < 0 && this.skipped > 0) end = this.skipped;
    else {
      // this file is read to its start: go on in the file it continues
      if (this.baseAt < 0 || this.baseSkipped <= 0) {
        if (this.baseAt + 1 >= this.bases.length) return { ops: [], more: false, bytes: 0 };
        this.baseAt++;
        this.baseSkipped = this.bases[this.baseAt]!.end;
      }
      path = this.bases[this.baseAt]!.path;
      end = this.baseSkipped;
    }
    const from = await windowStart(this.fs, path, end, this.weight, this.raw);
    const page = ++this.pages;
    const ctx: ParseCtx = { n: 0 };
    const ops = await this.parseRange(from, end, ctx, undefined, path);
    const key = (k: string) => `p${page}${k}`;
    for (const op of ops) {
      if (op.op === "add") op.entry.key = key(op.entry.key);
      else if (op.op === "remove") op.keys = op.keys.map(key);
    }
    if (path === this.source.path) this.skipped = from;
    else this.baseSkipped = from;
    return { ops, more: this.more, bytes: end - from };
  }
}
