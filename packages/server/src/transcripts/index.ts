// Find the transcript file behind an agent pane and stream its entries to the UI as they are written.
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

export interface Roots {
  claude: string;
  codex: string;
}

export const defaultRoots = (): Roots => ({
  claude: join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects"),
  codex: join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions"),
});

export interface ResolveInput {
  pane: HPane;
  /** All panes, to tell when several claude agents share one folder. */
  panes: HPane[];
  /** Session id known to agent-flow for this pane (from launch). */
  knownSession?: string;
  /** argv of the pane's foreground processes, fetched lazily. */
  argv: () => Promise<string[][]>;
}

const isAgent = (a: string | undefined): a is Agent => a === "claude" || a === "codex" || a === "omp";

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

export class TranscriptFinder {
  /** claude transcript path -> cwd recorded inside it, cached by mtime */
  private cwdCache = new Map<string, { mtime: number; cwd?: string }>();

  constructor(readonly roots: Roots = defaultRoots()) {}

  claudeById(id: string): string | undefined {
    if (!existsSync(this.roots.claude)) return undefined;
    for (const dir of readdirSync(this.roots.claude)) {
      const f = join(this.roots.claude, dir, `${id}.jsonl`);
      if (existsSync(f)) return f;
    }
    return undefined;
  }

  codexById(id: string): string | undefined {
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

  /** Newest claude transcript whose recorded cwd is `cwd`, among files touched in the last two weeks. */
  claudeByFolder(cwd: string): string | undefined {
    if (!existsSync(this.roots.claude)) return undefined;
    const cutoff = Date.now() - 14 * 86400_000;
    let best: { path: string; mtime: number } | undefined;
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
        if (mtime < cutoff || (best && mtime <= best.mtime)) continue;
        let c = this.cwdCache.get(path);
        if (!c || c.mtime !== mtime) {
          const m = readHead(path).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
          c = { mtime, cwd: m ? JSON.parse(`"${m[1]}"`) : undefined };
          this.cwdCache.set(path, c);
        }
        if (c.cwd === cwd) best = { path, mtime };
      }
    }
    return best?.path;
  }

  async resolve({ pane, panes, knownSession, argv }: ResolveInput): Promise<{ source: ChatSource } | { reason: string }> {
    const agent = pane.agent;
    if (!isAgent(agent)) return { reason: pane.agent ? `rendering ${pane.agent} output is not supported yet` : "no agent in this pane" };
    const byId = (id: string) => (agent === "claude" ? this.claudeById(id) : agent === "codex" ? this.codexById(id) : undefined);
    const found = (path: string | undefined, how: ChatSource["how"]) => (path ? { source: { agent, path, how } } : undefined);

    if (knownSession) {
      const r = found(byId(knownSession), "session");
      if (r) return r;
    }
    if (pane.session?.kind === "path" && existsSync(pane.session.value)) return { source: { agent, path: pane.session.value, how: "session" } };
    if (pane.session?.kind === "id") {
      const r = found(byId(pane.session.value), "session");
      if (r) return r;
    }
    if (agent === "claude") {
      for (const args of await argv()) {
        const i = args.findIndex((a) => a === "--resume" || a === "-r" || a === "--session-id");
        const id = i >= 0 ? args[i + 1] : args.find((a) => /^--(resume|session-id)=/.test(a))?.split("=")[1];
        if (id && /^[0-9a-f-]{36}$/i.test(id)) {
          const r = found(this.claudeById(id), "session");
          if (r) return r;
        }
      }
      const sharing = panes.filter((p) => p.agent === "claude" && p.cwd === pane.cwd).length;
      if (sharing > 1) return { reason: `${sharing} claude agents run in ${pane.cwd}; cannot tell which transcript is this one` };
      const r = found(this.claudeByFolder(pane.cwd), "folder");
      if (r) return r;
      return { reason: "no claude transcript for this folder yet" };
    }
    return { reason: knownSession || pane.session ? "the transcript file has not been written yet" : `${agent} has not reported its session to Herdr yet` };
  }
}

/** Follows one transcript file: parses what is there, then whatever gets appended. */
export class TranscriptTail {
  private offset = 0;
  private partial = "";
  private ctx: ParseCtx = { n: 0 };

  constructor(readonly source: ChatSource) {}

  /** New ops since the last call. Restarts from scratch if the file shrank (rewritten). */
  read(): { ops: ChatOp[]; reset: boolean } {
    let size: number;
    try {
      size = statSync(this.source.path).size;
    } catch {
      return { ops: [], reset: false };
    }
    let reset = false;
    if (size < this.offset) {
      this.offset = 0;
      this.partial = "";
      this.ctx = { n: 0 };
      reset = true;
    }
    if (size === this.offset) return { ops: [], reset };
    const fd = openSync(this.source.path, "r");
    let chunk: string;
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      chunk = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
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
