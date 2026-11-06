// Browsing local files: the Open dialog (a file, a folder, or a web page next to a pane) and folder panes.
// Start where the pane is, click through folders, or type to filter this folder and search everything under it.

import { useEffect, useMemo, useRef, useState } from "react";
import { api, failed } from "./store";

interface FsEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
  /** Path relative to the folder searched (search results only). */
  rel?: string;
}
interface Listing {
  path: string;
  parent?: string;
  home: string;
  entries: FsEntry[];
  more: number;
  hiddenCount: number;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`);
const when = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString();
};
const ICONS: [RegExp, string][] = [
  [/\.(md|markdown|mdx|txt|rst)$/i, "📝"],
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i, "🖼"],
  [/\.pdf$/i, "📕"],
  [/\.(tex|bib|sty|cls)$/i, "∑"],
  [/\.(json|ya?ml|toml|ini|env|lock)$/i, "⚙"],
  [/\.(ts|tsx|js|jsx|mjs|py|rs|go|java|c|cpp|h|rb|swift|kt|sh|zsh|css|html|sql)$/i, "‹›"],
];
const iconOf = (e: FsEntry) => (e.dir ? "📁" : (ICONS.find(([r]) => r.test(e.name))?.[1] ?? "📄"));

/** The folders on the way to `path`, for the clickable path bar. ~ stands for the home folder. */
function crumbs(path: string, home: string) {
  const inHome = path === home || path.startsWith(`${home}/`);
  const rest = (inHome ? path.slice(home.length) : path).split("/").filter(Boolean);
  const out: { label: string; path: string }[] = [{ label: inHome ? "~" : "/", path: inHome ? home : "/" }];
  let acc = inHome ? home : "";
  for (const r of rest) {
    acc = `${acc}/${r}`;
    out.push({ label: r, path: acc });
  }
  return out;
}

export function FileBrowser({
  start,
  machine,
  onOpenFile,
  onCancel,
  onDirChange,
  autoFocus = true,
}: {
  start: string;
  /** A remote machine's files (over SSH); absent: this Mac. */
  machine?: string;
  onOpenFile: (path: string) => void;
  onCancel?: () => void;
  onDirChange?: (dir: string) => void;
  autoFocus?: boolean;
}) {
  const [dir, setDir] = useState(start);
  const [listing, setListing] = useState<Listing>();
  const [error, setError] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; results: FsEntry[]; truncated: boolean }>();
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setError(undefined);
    api<Listing>("GET", "/fs/list", { path: dir, hidden: hidden ? "1" : undefined, run: undefined, machine })
      .then((l) => {
        if (!alive) return;
        setListing(l);
        if (l.path !== dir) setDir(l.path); // a file was given: its folder
        onDirChange?.(l.path);
      })
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [dir, hidden]);
  useEffect(() => {
    setQuery("");
    setFound(undefined);
    setHi(0);
  }, [dir]);

  // typing a path goes there; other text filters this folder and, from 2 characters, searches below it
  const typedPath = /^(\/|~)/.test(query.trim());
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2 || typedPath) return setFound(undefined);
    const t = setTimeout(() => {
      api<{ results: FsEntry[]; truncated: boolean }>("GET", "/fs/find", { root: dir, q, run: undefined, machine })
        .then((r) => setFound({ q, results: r.results, truncated: r.truncated }))
        .catch(() => {});
    }, 180);
    return () => clearTimeout(t);
  }, [query, dir]);

  const here = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = listing?.entries ?? [];
    return q && !typedPath ? all.filter((e) => e.name.toLowerCase().includes(q)) : all;
  }, [listing, query]);
  const deeper = useMemo(() => {
    if (!found || found.q !== query.trim()) return [];
    const shown = new Set(here.map((e) => e.path));
    return found.results.filter((r) => !shown.has(r.path) && r.rel?.includes("/"));
  }, [found, here, query]);
  const rows = [...here, ...deeper];
  useEffect(() => setHi(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".fb-row.hi")?.scrollIntoView({ block: "nearest" });
  }, [hi]);

  const open = (e: FsEntry) => (e.dir ? setDir(e.path) : onOpenFile(e.path));
  const goTyped = () => {
    const raw = query.trim();
    const p = raw === "~" || raw.startsWith("~/") ? `${listing?.home ?? ""}${raw.slice(1)}` : raw;
    api<{ dir: boolean; path: string }>("GET", "/fs/stat", { path: p, run: undefined, machine })
      .then((s) => (s.dir ? setDir(s.path) : onOpenFile(s.path)))
      .catch(failed("Cannot open that path"));
  };

  return (
    <div className="fb">
      <div className="fb-top">
        <button className="fb-up" title="Up one folder (Backspace)" disabled={!listing?.parent} onClick={() => listing?.parent && setDir(listing.parent)}>
          ↑
        </button>
        <div className="fb-crumbs">
          {listing &&
            crumbs(listing.path, listing.home).map((c, i, all) => (
              <span key={c.path}>
                <button className={i === all.length - 1 ? "cur" : ""} onClick={() => setDir(c.path)}>
                  {c.label}
                </button>
                {i < all.length - 1 && <span className="sep">/</span>}
              </span>
            ))}
        </div>
        <label className="fb-hidden" title="Show files whose name starts with a dot">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> hidden
        </label>
      </div>
      <input
        ref={input}
        className="text fb-q"
        autoFocus={autoFocus}
        placeholder="Filter this folder — or search everything under it, or type a path (~/…, /…)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(rows.length - 1, h + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(0, h - 1)));
          else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (typedPath) goTyped();
            else if (rows[hi]) open(rows[hi]!);
          } else if (e.key === "Backspace" && !query && listing?.parent) (e.preventDefault(), setDir(listing.parent));
          else if (e.key === "Escape") (e.preventDefault(), query ? setQuery("") : onCancel?.());
        }}
      />
      <div className="fb-list" ref={listRef}>
        {error && <div className="fb-empty err">{error}</div>}
        {!error && !listing && <div className="fb-empty">Loading…</div>}
        {typedPath && <div className="fb-empty">Enter to open {query.trim()}</div>}
        {!typedPath && listing && !rows.length && <div className="fb-empty">{query ? (found || query.trim().length < 2 ? "Nothing matches." : "Searching…") : "This folder is empty."}</div>}
        {!typedPath &&
          rows.map((e, i) => (
            <div key={e.path} className={`fb-row ${i === hi ? "hi" : ""} ${e.dir ? "dir" : ""}`} onMouseEnter={() => setHi(i)} onClick={() => open(e)} title={e.path}>
              <span className="fb-ic">{iconOf(e)}</span>
              <span className="fb-name">
                {e.rel && e.rel.includes("/") ? (
                  <>
                    <span className="fb-reldir">{e.rel.slice(0, e.rel.length - e.name.length)}</span>
                    {e.name}
                  </>
                ) : (
                  e.name
                )}
              </span>
              <span className="fb-size">{e.dir ? "" : size(e.size)}</span>
              <span className="fb-time">{when(e.mtime)}</span>
            </div>
          ))}
        {deeper.length > 0 && i18nNote(found?.truncated)}
        {listing && listing.more > 0 && !query && <div className="fb-empty">… and {listing.more} more; type to filter</div>}
      </div>
    </div>
  );
}

const i18nNote = (truncated?: boolean) => (truncated ? <div className="fb-empty">Search stopped early in this big folder; go into a subfolder to search deeper.</div> : null);

/** Open a file, folder or web page next to a pane (or in a viewer pane, replacing what it shows). */
export function OpenDialog({ start, title, onOpen, onClose }: { start: string; title: string; onOpen: (target: string) => void; onClose: () => void }) {
  const [dir, setDir] = useState(start);
  const [url, setUrl] = useState("");
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const go = (t: string) => (onOpen(t), onClose());
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal open-dialog">
        <div className="modal-title">{title}</div>
        <FileBrowser start={start} onOpenFile={go} onCancel={onClose} onDirChange={setDir} />
        <div className="open-foot">
          <form
            className="open-url"
            onSubmit={(e) => {
              e.preventDefault();
              const u = url.trim();
              if (u) go(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`);
            }}
          >
            <input className="text" placeholder="…or a web page: https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn" disabled={!url.trim()}>
              Open page
            </button>
          </form>
          <span className="spacer" />
          <button className="btn" onClick={() => go(dir)} title={dir}>
            Show this folder
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
