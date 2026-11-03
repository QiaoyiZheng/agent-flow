// Markdown with LaTeX math, as the Claude app renders it: GFM (tables, task lists, strikethrough), code
// blocks highlighted with Shiki, and math with KaTeX. Math delimiters: $$…$$ and \[…\] (display),
// $…$ and \(…\) (inline). "$5 and $10" stays text: an inline $ must hug its content and not be
// followed by a digit (the pandoc rule).

import katex from "katex";
import "katex/dist/katex.min.css";
import { Marked } from "marked";

const LANG_ALIAS: Record<string, string> = { js: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash", py: "python", yml: "yaml", md: "markdown", rs: "rust" };
const LANGS = ["typescript", "tsx", "javascript", "jsx", "json", "python", "rust", "go", "bash", "yaml", "toml", "css", "html", "sql", "java", "c", "cpp", "ruby", "swift", "kotlin", "latex", "markdown", "diff"];

let shiki: import("shiki").Highlighter | undefined;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
/** Load the highlighter once; components re-render when it arrives. */
export function onHighlighterReady(fn: () => void) {
  if (shiki) return () => {};
  listeners.add(fn);
  loading ??= import("shiki")
    .then((s) => s.createHighlighter({ themes: ["github-dark-default"], langs: LANGS }))
    .then((h) => {
      shiki = h;
      listeners.forEach((f) => f());
      listeners.clear();
    });
  return () => listeners.delete(fn);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function highlight(code: string, lang?: string): string {
  const l = LANG_ALIAS[lang ?? ""] ?? lang ?? "";
  if (shiki && LANGS.includes(l)) {
    try {
      return shiki.codeToHtml(code, { lang: l, theme: "github-dark-default" });
    } catch {}
  }
  return `<pre class="plain"><code>${esc(code)}</code></pre>`;
}

const math = (tex: string, display: boolean) => {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: "ignore", output: "html" });
  } catch {
    return `<code>${esc(tex)}</code>`;
  }
};

/** Extensions shared by agent output and documents: loose **bold** for CJK, and LaTeX math. */
const EXTENSIONS: import("marked").TokenizerAndRendererExtension[] = [
    {
      // CommonMark does not close **bold** when the closing ** follows punctuation and precedes a letter, which is
      // everywhere in Chinese ("**位置：**main.tex", "**扯皮案例墙**砍掉"). Agents' own apps render these as bold.
      name: "strongLoose",
      level: "inline",
      start: (src) => {
        const i = src.indexOf("**");
        return i < 0 ? undefined : i;
      },
      tokenizer(src) {
        const m = src.match(/^\*\*(?![\s*])((?:\\.|`[^`\n]*`|[^*\n]|\*(?!\*))+?)(?<![\s\\])\*\*(?!\*)/);
        if (m) return { type: "strongLoose", raw: m[0], text: m[1]!, tokens: this.lexer.inlineTokens(m[1]!) };
      },
      renderer(t) {
        return `<strong>${this.parser.parseInline(t.tokens!)}</strong>`;
      },
    },
    {
      name: "mathBlock",
      level: "block",
      start: (src) => src.match(/\$\$|\\\[/)?.index,
      tokenizer(src) {
        const m = src.match(/^\$\$([\s\S]+?)\$\$/) ?? src.match(/^\\\[([\s\S]+?)\\\]/);
        if (m) return { type: "mathBlock", raw: m[0], text: m[1]!.trim() };
      },
      renderer: (t) => `<div class="math-block">${math(t.text, true)}</div>`,
    },
    {
      name: "mathInline",
      level: "inline",
      start: (src) => src.match(/\$|\\\(/)?.index,
      tokenizer(src) {
        const d = src.match(/^\$\$([\s\S]+?)\$\$/) ?? src.match(/^\\\[([\s\S]+?)\\\]/);
        if (d) return { type: "mathInline", raw: d[0], text: d[1]!.trim(), display: true };
        const m = src.match(/^\$(?!\s)((?:[^$\\\n]|\\.)+?)(?<!\s)\$(?!\d)/) ?? src.match(/^\\\(([\s\S]+?)\\\)/);
        if (m) return { type: "mathInline", raw: m[0], text: m[1]!, display: false };
      },
      renderer: (t) => math(t.text, !!t.display),
    },
  ];

const codeBlock = (text: string, lang?: string) => {
  if (lang === "math") return `<div class="math-block">${math(text, true)}</div>`;
  return `<div class="code-block">${lang ? `<span class="code-lang">${esc(lang)}</span>` : ""}${highlight(text, lang)}</div>`;
};

// agent output: untrusted, so raw HTML is shown as text
const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: EXTENSIONS,
  renderer: {
    code({ text, lang }) {
      if (lang === "math" || lang === "latex" || lang === "tex") {
        if (lang === "math") return `<div class="math-block">${math(text, true)}</div>`;
      }
      return `<div class="code-block">${lang ? `<span class="code-lang">${esc(lang)}</span>` : ""}${highlight(text, lang)}</div>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      // a local file (codex writes [x.ts](/Users/me/x.ts:12)): opened in a viewer pane, not as a web page
      const local = href.match(/^(?:file:\/\/)?((?:\/|~\/)[^?#]*?)(?::\d+(?::\d+)?)?(?:#L\d+.*)?$/);
      if (local) {
        let path = local[1]!;
        try {
          path = decodeURI(path);
        } catch {}
        return `<a href="#" class="local-link" data-path="${esc(path)}" title="${esc(title || `Open ${path}`)}">${text}</a>`;
      }
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ""}>${text}</a>`;
    },
    html({ text }) {
      // agent output is untrusted: show raw HTML as text, except <br>, which agents use for line breaks in table cells
      if (/^<br\s*\/?>$/i.test(text.trim())) return "<br>";
      return esc(text);
    },
  },
});

export function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string;
}

// ---------------------------------------------------------------------------------------------
// Documents: a Markdown file shown in a viewer pane. Unlike agent output its own HTML is kept (sanitized), relative
// images and links point next to the file, front matter becomes a small table, headings get ids (for the outline),
// and ```mermaid blocks are marked for drawing.

import DOMPurify from "dompurify";

export interface DocHeading {
  level: number;
  text: string;
  id: string;
}

const isRemote = (u: string) => /^[a-z][a-z0-9+.-]*:/i.test(u) && !/^file:/i.test(u);
const dirOf = (p: string) => p.replace(/\/[^/]*$/, "") || "/";
/** A path relative to `dir` made absolute ("../a/./b" against /x/y → /x/a/b). */
export function resolvePath(dir: string, rel: string) {
  if (rel.startsWith("/")) return rel;
  const parts = dir.split("/").filter(Boolean);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

const slug = (t: string, used: Map<string, number>) => {
  const base =
    t
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n ? `${base}-${n}` : base;
};

let docBase = "/";
let docHeadings: DocHeading[] = [];
let docSlugs = new Map<string, number>();

/** Where a link or image in a document points: a web URL stays, a file becomes an absolute path. */
function docTarget(href: string): { url?: string; path?: string; anchor?: string } {
  if (href.startsWith("#")) return { anchor: href.slice(1) };
  if (isRemote(href)) return { url: href };
  let p = href.replace(/^file:\/\//i, "");
  const anchor = p.match(/#(.*)$/)?.[1];
  p = p.replace(/[?#].*$/, "");
  try {
    p = decodeURI(p);
  } catch {}
  if (p.startsWith("~/")) return { path: p, anchor };
  return { path: resolvePath(docBase, p), anchor };
}

const docMarked = new Marked({ gfm: true, breaks: false });
docMarked.use({
  extensions: EXTENSIONS,
  renderer: {
    code({ text, lang }) {
      // the diagram's source stays in the code element (an attribute would lose it: the sanitizer drops "-->")
      if (lang === "mermaid") return `<div class="mermaid-block"><pre class="plain"><code>${esc(text)}</code></pre></div>`;
      return codeBlock(text, lang);
    },
    heading({ tokens, depth }) {
      const inner = this.parser.parseInline(tokens);
      const id = slug(inner, docSlugs);
      docHeadings.push({ level: depth, text: inner.replace(/<[^>]+>/g, ""), id });
      return `<h${depth} id="${esc(id)}">${inner}</h${depth}>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const t = docTarget(href);
      const tip = title ? ` title="${esc(title)}"` : "";
      if (t.url) return `<a href="${esc(t.url)}" target="_blank" rel="noopener noreferrer"${tip}>${text}</a>`;
      if (t.path) return `<a href="#" class="local-link" data-path="${esc(t.path)}"${tip || ` title="${esc(t.path)}"`}>${text}</a>`;
      return `<a href="#" data-anchor="${esc(t.anchor ?? "")}"${tip}>${text}</a>`;
    },
    image({ href, title, text }) {
      const t = docTarget(href);
      const src = t.url ?? (t.path ? `/api/file?path=${encodeURIComponent(t.path)}&token=${encodeURIComponent(docToken)}` : "");
      return `<img src="${esc(src)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""}>`;
    },
  },
});

let docToken = "";

/** YAML-ish front matter ("---\nkey: value\n---") as rows, and the text after it. */
function frontMatter(src: string): { rows: [string, string][]; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { rows: [], body: src };
  const rows: [string, string][] = [];
  for (const l of m[1]!.split(/\r?\n/)) {
    const kv = l.match(/^([\w.-]+):\s*(.*)$/);
    if (kv) rows.push([kv[1]!, kv[2]!.replace(/^["']|["']$/g, "")]);
    else if (rows.length && l.trim()) rows[rows.length - 1]![1] += ` ${l.trim()}`;
  }
  return { rows, body: src.slice(m[0].length) };
}

/** HTML in a document is sanitized, but local images and the links we made keep working. */
function sanitize(html: string) {
  const base = docBase;
  const out = DOMPurify.sanitize(html, { ADD_ATTR: ["target", "data-path", "data-anchor"], FORBID_TAGS: ["style", "form", "button", "textarea", "select"] });
  // raw <img src="x.png"> and <a href="x.md"> written as HTML in the document: point them next to the file too
  const doc = new DOMParser().parseFromString(`<div>${out}</div>`, "text/html");
  // inputs: only the read-only checkboxes of task lists ("- [x] done")
  for (const i of Array.from(doc.querySelectorAll("input"))) {
    if (i.getAttribute("type") !== "checkbox") i.remove();
    else i.setAttribute("disabled", "");
  }
  for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
    const src = img.getAttribute("src")!;
    if (!isRemote(src) && !src.startsWith("/api/file") && !src.startsWith("data:")) {
      const p = src.startsWith("/") ? src : resolvePath(base, src.replace(/[?#].*$/, ""));
      img.setAttribute("src", `/api/file?path=${encodeURIComponent(p)}&token=${encodeURIComponent(docToken)}`);
    }
  }
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const href = a.getAttribute("href")!;
    if (a.hasAttribute("data-path") || a.hasAttribute("data-anchor") || href === "#") continue;
    const t = docTarget(href);
    if (t.url) (a.setAttribute("target", "_blank"), a.setAttribute("rel", "noopener noreferrer"));
    else if (t.path) (a.setAttribute("href", "#"), a.setAttribute("data-path", t.path), a.classList.add("local-link"));
    else if (t.anchor !== undefined) (a.setAttribute("href", "#"), a.setAttribute("data-anchor", t.anchor));
  }
  return doc.body.firstElementChild!.innerHTML;
}

/** A Markdown file as HTML, with its outline. `token` is the UI's API token, for local images. */
export function renderDoc(src: string, path: string, token: string): { html: string; headings: DocHeading[]; mermaid: boolean } {
  docBase = dirOf(path);
  docToken = token;
  docHeadings = [];
  docSlugs = new Map();
  const { rows, body } = frontMatter(src);
  const table = rows.length ? `<table class="front-matter"><tbody>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</tbody></table>` : "";
  const html = sanitize(table + (docMarked.parse(body, { async: false }) as string));
  return { html, headings: docHeadings, mermaid: html.includes("mermaid-block") };
}

let mermaidLib: Promise<typeof import("mermaid").default> | undefined;
let mermaidSeq = 0;
/** Draw the ```mermaid blocks inside `root` (Mermaid loads on first use). */
export async function drawMermaid(root: HTMLElement) {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>(".mermaid-block:not([data-drawn])"));
  if (!blocks.length) return;
  mermaidLib ??= import("mermaid").then((m) => {
    m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "inherit" });
    return m.default;
  });
  const mermaid = await mermaidLib;
  for (const b of blocks) {
    b.setAttribute("data-drawn", "1");
    try {
      const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, b.querySelector("code")?.textContent ?? "");
      b.innerHTML = svg;
      b.classList.add("drawn");
    } catch (e) {
      b.insertAdjacentHTML("beforeend", `<div class="mermaid-err">Could not draw this diagram: ${esc((e as Error).message.split("\n")[0] ?? "")}</div>`);
    }
  }
}
