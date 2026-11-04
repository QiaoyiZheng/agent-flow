// Browsing local files for the UI: list a folder, find files by name, and tell when a file changed (so a preview
// can reload). The server only listens on 127.0.0.1 with a token, and its terminals already run anything the user
// can; the path rules here keep reads to the user's own files (home, run folders, temp) rather than guard secrets.

import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { AfError } from "./errors.ts";

export interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

/** Folders not worth walking when searching by name. */
const SKIP = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", ".cache", "__pycache__", ".venv", "venv", "target", ".turbo", ".agent-flow"]);

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** Absolute path from what the user typed: "~" and "~/x" are the home folder. */
export function expandPath(p: string) {
  const t = p.trim();
  if (t === "~") return homedir();
  if (t.startsWith("~/")) return join(homedir(), t.slice(2));
  return t;
}

/** The folders files may be read from: home, temp, and whatever else the caller adds (run folders, agent-flow's home). */
export function readableRoots(extra: string[] = []) {
  return [...new Set([homedir(), tmpdir(), "/tmp", "/private/tmp", ...extra].flatMap((r) => [r, real(r)]))];
}

export function checkReadable(path: string, roots: string[]) {
  const p = expandPath(path);
  if (!p.startsWith("/")) throw new AfError("bad_path", `not an absolute path: ${path}`);
  const abs = resolve(p);
  const r = real(abs);
  if (!roots.some((root) => r === root || r.startsWith(root.endsWith("/") ? root : `${root}/`)) && !roots.some((root) => abs === root || abs.startsWith(`${root}/`)))
    throw new AfError("forbidden", `${abs} is outside your home folder and the run folders`, 403);
  return abs;
}

const entry = (dir: string, name: string): FsEntry | undefined => {
  const path = join(dir, name);
  try {
    const st = statSync(path);
    return { name, path, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  } catch {
    return undefined; // a broken link, or gone already
  }
};

const byName = (a: FsEntry, b: FsEntry) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

/** A folder's entries: folders first, then files, natural order. Dot files only when asked. */
export function listDir(path: string, roots: string[], hidden = false) {
  const abs = checkReadable(path, roots);
  if (!existsSync(abs)) throw new AfError("not_found", `${abs} does not exist`, 404);
  const st = statSync(abs);
  const dir = st.isDirectory() ? abs : dirname(abs);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    throw new AfError("unreadable", `cannot read ${dir}: ${(e as Error).message}`, 403);
  }
  const all = names.filter((n) => hidden || !n.startsWith("."));
  const entries = all
    .slice(0, 5000)
    .map((n) => entry(dir, n))
    .filter((e): e is FsEntry => !!e)
    .sort(byName);
  const parent = dirname(dir);
  return { path: dir, parent: parent !== dir ? parent : undefined, home: homedir(), entries, more: Math.max(0, all.length - 5000), hiddenCount: names.length - all.length };
}

/**
 * Files and folders under `root` whose path matches `query`: every word of the query appears in the relative path,
 * in order, case-insensitive ("ag view" finds packages/web/src/AgentView.tsx). Name matches rank first, then
 * shorter paths. Stops after visiting `budget` entries, so huge trees stay quick.
 */
export function findFiles(root: string, query: string, roots: string[], limit = 60, budget = 40_000) {
  const abs = checkReadable(root, roots);
  const words = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
  if (!words.length) return { root: abs, results: [] as (FsEntry & { rel: string })[], truncated: false };
  const hits: { e: FsEntry & { rel: string }; score: number }[] = [];
  let visited = 0;
  const queue: string[] = [abs];
  const matches = (rel: string) => {
    let i = 0;
    const low = rel.toLowerCase();
    for (const w of words) {
      const j = low.indexOf(w, i);
      if (j < 0) return false;
      i = j + w.length;
    }
    return true;
  };
  while (queue.length && visited < budget) {
    const dir = queue.shift()!;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (++visited > budget) break;
      if (n.startsWith(".") && !query.startsWith(".")) continue;
      const path = join(dir, n);
      const rel = relative(abs, path);
      let isDir = false;
      try {
        isDir = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDir && !SKIP.has(n)) queue.push(path);
      if (matches(rel)) {
        const e = entry(dir, n);
        if (!e) continue;
        const last = words.at(-1)!;
        const score = (n.toLowerCase().includes(last) ? 0 : 1000) + (n.toLowerCase().startsWith(last) ? 0 : 100) + rel.length + (isDir ? 5 : 0);
        hits.push({ e: { ...e, rel }, score });
      }
    }
  }
  hits.sort((a, b) => a.score - b.score);
  return { root: abs, results: hits.slice(0, limit).map((h) => h.e), truncated: visited >= budget };
}

export function statPath(path: string, roots: string[]) {
  const abs = checkReadable(path, roots);
  try {
    const st = statSync(abs);
    return { path: abs, name: basename(abs), dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
  } catch {
    throw new AfError("not_found", `${abs} does not exist`, 404);
  }
}
