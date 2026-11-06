import { useEffect, useRef, useState } from "react";
import { type DocHeading, drawMermaid, onHighlighterReady, renderDoc } from "./markdown";
import { FileBrowser } from "./Files";
import { APP_LABEL, TOKEN, api, appsFor, fileUrl, failed, openIn, useStore } from "./store";
import { ago } from "./view";

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", json: "json", py: "python", rs: "rust", go: "go",
  sh: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "toml", css: "css", html: "html", sql: "sql", java: "java", c: "c", h: "c",
  cpp: "cpp", rb: "ruby", swift: "swift", kt: "kotlin", tex: "latex",
};

let highlighter: Promise<import("shiki").Highlighter> | undefined;
const getHighlighter = () =>
  (highlighter ??= import("shiki").then((s) => s.createHighlighter({ themes: ["github-dark-default"], langs: [...new Set(Object.values(LANG))] })));

/** A path for the bar: the home folder as ~, and when it does not fit, the start is cut, not the file name. */
const tidy = (p: string) => p.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, "~");

function Bar({ path, machine, children }: { path: string; machine?: string; children?: React.ReactNode }) {
  const { herdr } = useStore();
  const on = machine && machine !== "local" ? (herdr?.machines.find((m) => m.id === machine)?.label ?? machine) : undefined;
  return (
    <div className="bar">
      {on && <span className="machine-tag" title={`A file on ${on}, read over SSH`}>{on}</span>}
      <span className="path" title={path}>
        <bdi>{/^[a-z]+:\/\//i.test(path) ? path : on ? path : tidy(path)}</bdi>
      </span>
      <span className="spacer" />
      {children}
    </div>
  );
}

const show = (paneId: string | undefined, target: string) => paneId && api("POST", "/show", { target, in: paneId, run: undefined }).catch(failed("Could not open it"));
const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";

/**
 * A file or folder in a viewer pane: this Mac's, or (machine) a remote machine's, read over SSH. Files reload by
 * themselves when they change.
 */
export function FileView({ path, paneId, machine }: { path: string; paneId?: string; machine?: string }) {
  const [kind, setKind] = useState<"dir" | "file">();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setKind(undefined);
    setErr(undefined);
    api<{ dir: boolean }>("GET", "/fs/stat", { path, run: undefined, machine })
      .then((s) => setKind(s.dir ? "dir" : "file"))
      .catch((e) => setErr(e.message));
  }, [path, machine]);
  if (err)
    return (
      <div className="viewer">
        <Bar path={path} machine={machine} />
        <div className="empty" style={{ padding: 16 }}>
          {err}
        </div>
      </div>
    );
  if (kind === "dir")
    return (
      <div className="viewer folder-view">
        <FileBrowser key={`${machine ?? ""}:${path}`} start={path} machine={machine} autoFocus={false} onOpenFile={(f) => show(paneId, f)} />
      </div>
    );
  if (kind === "file") return <FileContent path={path} paneId={paneId} machine={machine} />;
  return <div className="viewer" />;
}

function FileContent({ path, paneId, machine }: { path: string; paneId?: string; machine?: string }) {
  const remote = !!machine && machine !== "local";
  const ext = path.split(".").at(-1)?.toLowerCase() ?? "";
  const [html, setHtml] = useState<string>();
  const [headings, setHeadings] = useState<DocHeading[]>([]);
  const [err, setErr] = useState<string>();
  const [stamp, setStamp] = useState<number>();
  const [changed, setChanged] = useState(false);
  const [outline, setOutline] = useState(() => localStorage.getItem("af-outline") !== "0");
  // narrow panes have no room for the outline beside the text: the button opens it over the page instead
  const [floating, setFloating] = useState(false);
  const [hl, setHl] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const isImage = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"].includes(ext);
  const isPdf = ext === "pdf";
  const isMd = ["md", "markdown", "mdx"].includes(ext);
  // slides, Word, Excel…: no preview here, the app opens them
  const isOffice = /^(pptx?|key|docx?|pages|xlsx?|numbers|od[tps]|rtf|epub|zip|mp4|mov|mp3|wav)$/.test(ext);
  useEffect(() => (isMd ? onHighlighterReady(() => setHl((n) => n + 1)) : undefined), [isMd]);

  // the file's change time, every 2 s (a remote file: every 4 s, over SSH): a change reloads the view (keeping the
  // scroll position)
  useEffect(() => {
    let alive = true;
    const check = () =>
      api<{ mtime: number }>("GET", "/fs/stat", { path, run: undefined, machine })
        .then((s) => alive && setStamp((old) => (old !== s.mtime ? s.mtime : old)))
        .catch(() => {});
    void check();
    const t = setInterval(check, remote ? 4000 : 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path, machine]);

  useEffect(() => {
    if (isImage || isPdf || isOffice || stamp === undefined) return;
    let alive = true;
    const scroll = box.current?.scrollTop ?? 0;
    fetch(fileUrl(path, machine))
      .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error((await r.json()).error?.message ?? r.statusText))))
      .then(async (text) => {
        if (isMd) {
          const d = renderDoc(text, path, TOKEN, machine);
          if (alive) setHeadings(d.headings);
          return `<div class="md doc">${d.html}</div>`;
        }
        const lang = LANG[ext];
        if (!lang || text.length > 400_000) return `<div class="code"><pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre></div>`;
        const h = await getHighlighter();
        return `<div class="code">${h.codeToHtml(text, { lang, theme: "github-dark-default" })}</div>`;
      })
      .then((h) => {
        if (!alive) return;
        setErr(undefined);
        setHtml((old) => {
          if (old !== undefined && old !== h) {
            setChanged(true);
            setTimeout(() => setChanged(false), 1500);
          }
          return h;
        });
        requestAnimationFrame(() => {
          if (box.current) box.current.scrollTop = scroll;
        });
      })
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [path, stamp, hl, machine]);

  // diagrams, after the HTML is in place
  useEffect(() => {
    if (html && box.current) void drawMermaid(box.current);
  }, [html]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a") as HTMLAnchorElement | null;
    if (!a) return;
    if (a.dataset.path) {
      e.preventDefault();
      show(paneId, a.dataset.path);
    } else if (a.dataset.anchor !== undefined) {
      e.preventDefault();
      box.current?.querySelector(`[id="${CSS.escape(a.dataset.anchor)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };
  const narrow = (box.current?.clientWidth ?? 1000) < 720;
  const showOutline = isMd && headings.length >= 3 && (narrow ? floating : outline);

  return (
    <div className="viewer" ref={box}>
      <Bar path={path} machine={machine}>
        {changed && <span className="reloaded">updated</span>}
        {isMd && headings.length >= 3 && (
          <button
            className={`btn ${(box.current?.clientWidth ?? 1000) < 720 ? (floating ? "on" : "") : outline ? "on" : ""}`}
            onClick={() => {
              if ((box.current?.clientWidth ?? 1000) < 720) return setFloating((f) => !f);
              localStorage.setItem("af-outline", outline ? "0" : "1");
              setOutline(!outline);
            }}
          >
            Outline
          </button>
        )}
        {paneId && (
          <button className="btn" title="Show the folder this file is in" onClick={() => show(paneId, parentOf(path))}>
            ↑ Folder
          </button>
        )}
        <OpenButtons path={path} remote={remote} pane={paneId} />
      </Bar>
      {err && <div className="empty" style={{ padding: 16 }}>{err}</div>}
      {isImage && (
        <div className="img-wrap">
          <img src={`${fileUrl(path, machine)}&v=${stamp ?? 0}`} alt={path} />
        </div>
      )}
      {isPdf && <iframe className="web" src={`${fileUrl(path, machine)}&v=${stamp ?? 0}`} title={path} />}
      {isOffice && (
        <div className="no-preview">
          <div className="np-icon">{/^pptx?|key$/.test(ext) ? "▤" : /^xlsx?|numbers$/.test(ext) ? "▦" : "▣"}</div>
          <div className="np-name">{path.split("/").at(-1)}</div>
          <div className="np-hint">There is no preview for .{ext} files here. Open it in its app:</div>
          <OpenButtons path={path} remote={remote} pane={paneId} big />
        </div>
      )}
      {html && (
        <div className={`doc-wrap ${showOutline ? "with-outline" : ""}`}>
          <div onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
          {showOutline && (
            <nav className={`outline ${narrow ? "floating" : ""}`}>
              <div className="outline-title">Outline</div>
              {headings.map((h) => (
                <a
                  key={h.id}
                  href="#"
                  className={`lv${h.level}`}
                  onClick={(e) => {
                    e.preventDefault();
                    box.current?.querySelector(`[id="${CSS.escape(h.id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                    if (narrow) setFloating(false);
                  }}
                >
                  {h.text}
                </a>
              ))}
            </nav>
          )}
        </div>
      )}
    </div>
  );
}

export function WebView({ url }: { url: string }) {
  return (
    <div className="viewer" style={{ overflow: "hidden" }}>
      <Bar path={url}>
        <span>Blank? The site may refuse to be embedded.</span>
        <button className="btn" onClick={() => window.open(url, "_blank", "noopener")}>
          Open in browser
        </button>
      </Bar>
      <iframe className="web" src={url} title={url} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" />
    </div>
  );
}

/** Open buttons for a file: its app first (from the settings), then the others that fit. */
export function OpenButtons({ path, remote, pane, delivery, big }: { path: string; remote?: boolean; pane?: string; delivery?: string; big?: boolean }) {
  useStore(); // re-render when the settings or the apps arrive
  const apps = appsFor(path, remote);
  return (
    <span className={`open-btns ${big ? "big" : ""}`}>
      {apps.map((a, i) => (
        <button key={a} className={`btn ${i === 0 ? "primary" : ""} ${a === "finder" ? "subtle" : ""}`} title={a === "finder" ? "Show it in Finder" : a === "default" ? "Open it in its default app" : `Open it in ${APP_LABEL[a]}`} onClick={(e) => (e.stopPropagation(), openIn(a, path, { pane, delivery }))}>
          {a === "default" ? "Open" : a === "finder" ? "Finder" : APP_LABEL[a]}
        </button>
      ))}
    </span>
  );
}
