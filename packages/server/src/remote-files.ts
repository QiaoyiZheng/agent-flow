// Files on a remote machine, for the UI's previews and folder views and for documents its agents write: read over the
// SSH connection agent-flow keeps to that machine (one command per request, about 50 ms with the shared connection).
// Linux machines (GNU find and stat); paths are absolute. The SSH user can read these files anyway, so any absolute
// path is allowed; nothing is written.

import { basename, extname } from "node:path";
import type { FsEntry } from "./files.ts";
import { DOC_EXT, SKIP_DIR, isDocument } from "./doc-watch.ts";
import { AfError } from "./errors.ts";
import { sq } from "./remote.ts";

export type Exec = (cmd: string, opts?: { stdin?: Uint8Array; timeoutMs?: number }) => Promise<{ code: number; out: Buffer; err: string }>;

/** An absolute path, with ~ and ~/ as the remote home. */
export function remotePath(path: string, home?: string) {
  let p = path.trim();
  if ((p === "~" || p.startsWith("~/")) && home) p = home + p.slice(1);
  if (!p.startsWith("/") || /[\0\n]/.test(p)) throw new AfError("bad_path", `not an absolute path: ${path}`);
  return p.replace(/\/+$/, "") || "/";
}

const parentOf = (p: string) => (p === "/" ? undefined : p.replace(/\/[^/]+$/, "") || "/");

/** stat: kind, size, change time (ms). */
export async function remoteStat(exec: Exec, path: string, home?: string) {
  const p = remotePath(path, home);
  const r = await exec(`p=${sq(p)}; if [ -d "$p" ]; then k=d; elif [ -e "$p" ]; then k=f; else echo none; exit 0; fi; echo "$k $(stat -c '%s %Y' -- "$p" 2>/dev/null || stat -f '%z %m' "$p")"`);
  const m = r.out.toString().trim().match(/^([df]) (\d+) (\d+)/);
  if (!m) throw new AfError("not_found", `${p} does not exist`, 404);
  return { path: p, name: basename(p), dir: m[1] === "d", size: Number(m[2]), mtime: Number(m[3]) * 1000 };
}

const byName = (a: FsEntry, b: FsEntry) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));

/** GNU find's "-printf '%y\t%s\t%T@\t%p\n'" lines: kind (d, f, l…), size, change time (s), path. */
export function parseFindLines(out: string): FsEntry[] {
  const list: FsEntry[] = [];
  for (const l of out.split("\n")) {
    const r = l.match(/^(\S)\t(\d+)\t([\d.]+)\t(.+)$/);
    if (r) list.push({ name: basename(r[4]!), path: r[4]!, dir: r[1] === "d", size: Number(r[2]), mtime: Math.round(Number(r[3]) * 1000) });
  }
  return list;
}

/** A folder's entries, as listDir (files.ts) gives them: folders first, natural order; dot files only when asked. */
export async function remoteList(exec: Exec, path: string, home?: string, hidden = false) {
  const st = await remoteStat(exec, path, home);
  const dir = st.dir ? st.path : (parentOf(st.path) ?? "/");
  // -L: a link to a folder lists as a folder
  const r = await exec(`find -L ${sq(dir)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%p\\n' 2>/dev/null | head -n 5001`, { timeoutMs: 20_000 });
  const all = parseFindLines(r.out.toString());
  const shown = all.filter((e) => hidden || !e.name.startsWith("."));
  return { path: dir, parent: parentOf(dir), home: home ?? "/", entries: shown.slice(0, 5000).sort(byName), more: Math.max(0, shown.length - 5000), hiddenCount: all.length - shown.length };
}

/** Up to `max` bytes of a file. */
export async function remoteRead(exec: Exec, path: string, home?: string, max = 50 * 1024 * 1024) {
  const p = remotePath(path, home);
  const r = await exec(`p=${sq(p)}; [ -f "$p" ] || { echo "not a file" >&2; exit 3; }; head -c ${Math.floor(max)} -- "$p"`, { timeoutMs: 60_000 });
  if (r.code === 3) throw new AfError("not_found", `${p} is not a file`, 404);
  if (r.code !== 0) throw new AfError("unreadable", `cannot read ${p}: ${r.err.trim() || `exit ${r.code}`}`, 403);
  return r.out;
}

/** Folders a search or a document scan does not go into (as findFiles and changedDocuments do). */
const pruneExpr = (names: Iterable<string>) => `\\( -name '.*' ${[...names].map((n) => `-o -name ${sq(n)}`).join(" ")} \\) -prune`;
const SEARCH_SKIP = ["node_modules", "dist", "build", "target", "__pycache__", ".venv", "venv", ".next", ".cache", ".turbo", ".agent-flow"];

/** Files and folders under `root` whose path below it has every word of `query` in order (as findFiles does). */
export async function remoteFind(exec: Exec, root: string, query: string, home?: string, limit = 60) {
  const r0 = remotePath(root, home);
  const words = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
  if (!words.length) return { root: r0, results: [] as (FsEntry & { rel: string })[], truncated: false };
  const glob = `*${words.map((w) => w.replace(/[*?[\]\\]/g, "\\$&")).join("*")}*`;
  const r = await exec(`find ${sq(r0)} -mindepth 1 -maxdepth 8 ${pruneExpr(SEARCH_SKIP)} -o -ipath ${sq(glob)} -printf '%y\\t%s\\t%T@\\t%p\\n' 2>/dev/null | head -n 400`, { timeoutMs: 20_000 });
  const last = words.at(-1)!;
  const hits = parseFindLines(r.out.toString()).map((e) => {
    const rel = e.path.slice(r0.length + 1);
    const n = e.name.toLowerCase();
    return { e: { ...e, rel }, score: (n.includes(last) ? 0 : 1000) + (n.startsWith(last) ? 0 : 100) + rel.length + (e.dir ? 5 : 0) };
  });
  hits.sort((a, b) => a.score - b.score);
  return { root: r0, results: hits.slice(0, limit).map((h) => h.e), truncated: hits.length >= 400 };
}

/**
 * Documents under `root` changed after `since` (ms), newest first, at most `limit`: changedDocuments (doc-watch.ts)
 * on another machine, with one find command.
 */
export async function remoteChangedDocuments(exec: Exec, root: string, since: number, limit = 8): Promise<string[]> {
  const r0 = remotePath(root);
  const names = [...DOC_EXT].map((e) => `-o -iname ${sq(`*${e}`)}`).join(" ").slice(3);
  const cmd = `find ${sq(r0)} -mindepth 1 -maxdepth 7 ${pruneExpr(SKIP_DIR)} -o -type f -size +0 -newermt @${Math.floor(since / 1000)} \\( ${names} \\) -printf '%T@\\t%p\\n' 2>/dev/null | sort -rn | head -n 200`;
  const r = await exec(cmd, { timeoutMs: 30_000 });
  return r.out
    .toString()
    .split("\n")
    .map((l) => l.split("\t")[1] ?? "")
    .filter((p) => p && isDocument(p))
    .slice(0, limit);
}

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};
/** The content type a preview needs (images, PDFs); anything else is shown as text. */
export const contentType = (path: string) => TYPES[extname(path).toLowerCase()] ?? "text/plain; charset=utf-8";
