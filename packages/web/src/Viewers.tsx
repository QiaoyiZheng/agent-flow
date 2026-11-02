import { useEffect, useState } from "react";
import { renderMarkdown } from "./markdown";
import type { Mail, RunState } from "@af/core";
import { api, fileUrl } from "./store";
import { ago } from "./view";

const LANG: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", json: "json", py: "python", rs: "rust", go: "go",
  sh: "bash", zsh: "bash", yml: "yaml", yaml: "yaml", toml: "toml", css: "css", html: "html", sql: "sql", java: "java", c: "c", h: "c",
  cpp: "cpp", rb: "ruby", swift: "swift", kt: "kotlin", tex: "latex",
};

let highlighter: Promise<import("shiki").Highlighter> | undefined;
const getHighlighter = () =>
  (highlighter ??= import("shiki").then((s) => s.createHighlighter({ themes: ["github-dark-default"], langs: [...new Set(Object.values(LANG))] })));

function Bar({ path, children }: { path: string; children?: React.ReactNode }) {
  return (
    <div className="bar">
      <span className="path" title={path}>
        {path}
      </span>
      <span className="spacer" />
      {children}
    </div>
  );
}

export function FileView({ path }: { path: string }) {
  const ext = path.split(".").at(-1)?.toLowerCase() ?? "";
  const [html, setHtml] = useState<string>();
  const [err, setErr] = useState<string>();
  const isImage = ["png", "jpg", "jpeg", "gif", "svg", "webp"].includes(ext);
  const isPdf = ext === "pdf";

  useEffect(() => {
    if (isImage || isPdf) return;
    let alive = true;
    setHtml(undefined);
    setErr(undefined);
    fetch(fileUrl(path))
      .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error((await r.json()).error?.message ?? r.statusText))))
      .then(async (text) => {
        if (ext === "md" || ext === "markdown") return `<div class="md doc">${renderMarkdown(text)}</div>`;
        const lang = LANG[ext];
        if (!lang || text.length > 400_000) return `<div class="code"><pre>${text.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!)}</pre></div>`;
        const h = await getHighlighter();
        return `<div class="code">${h.codeToHtml(text, { lang, theme: "github-dark-default" })}</div>`;
      })
      .then((h) => alive && setHtml(h))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [path]);

  return (
    <div className="viewer">
      <Bar path={path}>
        <button className="btn" onClick={() => api("POST", "/edit", { path }).catch((e) => alert(e.message))}>
          Open in editor
        </button>
      </Bar>
      {err && <div className="empty" style={{ padding: 16 }}>{err}</div>}
      {isImage && (
        <div className="img-wrap">
          <img src={fileUrl(path)} alt={path} />
        </div>
      )}
      {isPdf && <iframe className="web" src={fileUrl(path)} title={path} />}
      {html && <div dangerouslySetInnerHTML={{ __html: html }} />}
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
            api("POST", "/send", { to: agent, body: text }).then(() => setText(""), (err) => alert(err.message));
          }}
        >
          <input className="text" placeholder={`Message ${agent} (delivered when it is idle)`} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn">Send</button>
        </form>
      )}
    </div>
  );
}
