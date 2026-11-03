import { useEffect, useRef, useState } from "react";
import { type DocHeading, drawMermaid, onHighlighterReady, renderDoc } from "./markdown";
import { FileBrowser } from "./Files";
import type { Mail, RunState } from "@af/core";
import { TOKEN, api, fileUrl, failed } from "./store";
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

function Bar({ path, children }: { path: string; children?: React.ReactNode }) {
  return (
    <div className="bar">
      <span className="path" title={path}>
        <bdi>{/^[a-z]+:\/\//i.test(path) ? path : tidy(path)}</bdi>
      </span>
      <span className="spacer" />
      {children}
    </div>
  );
}

const show = (paneId: string | undefined, target: string) => paneId && api("POST", "/show", { target, in: paneId, run: undefined }).catch(failed("Could not open it"));
const parentOf = (p: string) => p.replace(/\/[^/]+\/?$/, "") || "/";

/** A file or folder in a viewer pane. Files reload by themselves when they change on disk. */
export function FileView({ path, paneId }: { path: string; paneId?: string }) {
  const [kind, setKind] = useState<"dir" | "file">();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setKind(undefined);
    setErr(undefined);
    api<{ dir: boolean }>("GET", "/fs/stat", { path, run: undefined })
      .then((s) => setKind(s.dir ? "dir" : "file"))
      .catch((e) => setErr(e.message));
  }, [path]);
  if (err)
    return (
      <div className="viewer">
        <Bar path={path} />
        <div className="empty" style={{ padding: 16 }}>
          {err}
        </div>
      </div>
    );
  if (kind === "dir")
    return (
      <div className="viewer folder-view">
        <FileBrowser key={path} start={path} autoFocus={false} onOpenFile={(f) => show(paneId, f)} />
      </div>
    );
  if (kind === "file") return <FileContent path={path} paneId={paneId} />;
  return <div className="viewer" />;
}

function FileContent({ path, paneId }: { path: string; paneId?: string }) {
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
  useEffect(() => (isMd ? onHighlighterReady(() => setHl((n) => n + 1)) : undefined), [isMd]);

  // the file's change time, every 2 s: a change reloads the view (keeping the scroll position)
  useEffect(() => {
    let alive = true;
    const check = () =>
      api<{ mtime: number }>("GET", "/fs/stat", { path, run: undefined })
        .then((s) => alive && setStamp((old) => (old !== s.mtime ? s.mtime : old)))
        .catch(() => {});
    void check();
    const t = setInterval(check, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [path]);

  useEffect(() => {
    if (isImage || isPdf || stamp === undefined) return;
    let alive = true;
    const scroll = box.current?.scrollTop ?? 0;
    fetch(fileUrl(path))
      .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error((await r.json()).error?.message ?? r.statusText))))
      .then(async (text) => {
        if (isMd) {
          const d = renderDoc(text, path, TOKEN);
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
  }, [path, stamp, hl]);

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
      <Bar path={path}>
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
        <button className="btn" onClick={() => api("POST", "/edit", { path }).catch(failed("That did not work"))}>
          Open in editor
        </button>
      </Bar>
      {err && <div className="empty" style={{ padding: 16 }}>{err}</div>}
      {isImage && (
        <div className="img-wrap">
          <img src={`${fileUrl(path)}&v=${stamp ?? 0}`} alt={path} />
        </div>
      )}
      {isPdf && <iframe className="web" src={fileUrl(path)} title={path} />}
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

export function DiffView({ node }: { node: string }) {
  const [diff, setDiff] = useState<string>();
  const [err, setErr] = useState<string>();
  useEffect(() => {
    setDiff(undefined);
    setErr(undefined);
    api<{ diff: string }>("GET", "/diff", { node })
      .then((r) => setDiff(r.diff))
      .catch((e) => setErr(e.message));
  }, [node]);
  if (err) return <div className="empty" style={{ padding: 12 }}>{err}</div>;
  if (diff === undefined) return <div className="empty" style={{ padding: 12 }}>loading…</div>;
  if (!diff) return <div className="empty" style={{ padding: 12 }}>No changes on this node's branch since the integration branch (already merged, or nothing written yet).</div>;
  return (
    <div className="diff">
      {diff.split("\n").map((l, i) => (
        <div key={i} className={l.startsWith("diff --git") ? "file" : l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>
          {l || " "}
        </div>
      ))}
    </div>
  );
}

export function Messages({ run, agent, node }: { run: RunState; agent?: string; node?: string }) {
  const [text, setText] = useState("");
  const mail: Mail[] = run.mail.filter((m) => (agent ? m.to === agent || m.from === agent : true) && (node ? m.node?.startsWith(`${node}#`) : true));
  return (
    <div className="msgs">
      {!mail.length && <div className="empty" style={{ padding: 12 }}>No messages yet.</div>}
      {mail.map((m) => (
        <div key={m.id} className={`msg ${m.from === "agent-flow" ? "system" : ""}`}>
          <div className="h">
            <b>{m.from}</b>→<span>{m.to}</span>
            <span>· {m.kind}</span>
            {m.node && <span>· {m.node}</span>}
            <span style={{ marginLeft: "auto" }}>{ago(m.at)}</span>
          </div>
          <div className="b">{m.body}</div>
        </div>
      ))}
      {agent && (
        <form
          style={{ display: "flex", gap: 6, padding: "8px 12px" }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            api("POST", "/send", { to: agent, body: text }).then(() => setText(""), failed("That did not work"));
          }}
        >
          <input className="text" placeholder={`Message ${agent} (delivered when it is idle)`} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn">Send</button>
        </form>
      )}
    </div>
  );
}
