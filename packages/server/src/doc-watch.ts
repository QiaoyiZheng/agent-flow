// Documents an agent wrote, found without the agent's help. The deliver-document skill asks agents to hand over
// what they write for the user, but they do not always do it (a claude that rewrote a report with its own Python
// script ended its turn without it). So when an agent's turn ends, agent-flow looks itself: which document files
// in the agent's folder changed during that turn. Each becomes a handed-over document, as if the agent had run
// af deliver: preview next to it, "Needs you" with the open buttons.
//
// Only files people read count (Markdown, LaTeX, text, slides, Word, PDF, HTML…), not code or data; files under
// build, cache and dependency folders and the agent's own memory or plan folders do not count.

import { readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

export const DOC_EXT = new Set([".md", ".markdown", ".mdx", ".tex", ".txt", ".rst", ".org", ".html", ".pptx", ".ppt", ".key", ".docx", ".doc", ".pages", ".xlsx", ".xls", ".numbers", ".pdf", ".odt", ".odp", ".ods", ".rtf", ".epub", ".ipynb"]);
/** Folders whose files are not documents for the user. */
export const SKIP_DIR = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", ".next", ".cache", "cache", "__pycache__", ".venv", "venv", ".tox", ".turbo", ".agent-flow", ".claude", ".codex", ".omp", "logs", "log", "tmp", ".tmp", "coverage", ".pytest_cache", ".mypy_cache", "site-packages"]);
/** File names that are not documents for the user (agents' instruction and memory files, changelogs written by tools). */
const SKIP_NAME = /^(AGENTS|CLAUDE|GEMINI|MEMORY|CHANGELOG|LICENSE|COPYING)(\.[a-z]+)?$|^\.|~$|\.(bak|orig|tmp)$/i;
/** LaTeX's own outputs next to the source: the PDF is the document, these are not. */
const LATEX_AUX = /\.(aux|log|out|toc|bbl|blg|synctex\.gz|fls|fdb_latexmk|nav|snm)$/i;

export function isDocument(path: string) {
  const name = path.split("/").at(-1) ?? "";
  if (SKIP_NAME.test(name) || LATEX_AUX.test(name)) return false;
  return DOC_EXT.has(extname(name).toLowerCase());
}

/**
 * Document files under `root` changed after `since` (ms), newest first, at most `limit`. Walks at most `budget`
 * entries and `depth` folders deep, so a big tree stays quick.
 */
export function changedDocuments(root: string, since: number, limit = 8, budget = 30_000, depth = 6): string[] {
  const hits: { path: string; mtime: number }[] = [];
  let seen = 0;
  const walk = (dir: string, d: number) => {
    if (d > depth || seen > budget) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (++seen > budget) return;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIR.has(n) && !n.startsWith(".")) walk(p, d + 1);
      } else if (st.mtimeMs > since && st.size > 0 && isDocument(p)) hits.push({ path: p, mtime: st.mtimeMs });
    }
  };
  walk(root, 0);
  return hits
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((h) => h.path);
}

/** A short label for a found document: its path below the agent's folder. */
export const docLabel = (root: string, path: string) => relative(root, path) || path;
