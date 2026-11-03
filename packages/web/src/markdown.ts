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

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [
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
  ],
  renderer: {
    code({ text, lang }) {
      if (lang === "math" || lang === "latex" || lang === "tex") {
        if (lang === "math") return `<div class="math-block">${math(text, true)}</div>`;
      }
      return `<div class="code-block">${lang ? `<span class="code-lang">${esc(lang)}</span>` : ""}${highlight(text, lang)}</div>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${esc(title)}"` : ""}>${text}</a>`;
    },
    html({ text }) {
      return esc(text); // agent output is untrusted: show raw HTML as text
    },
  },
});

export function renderMarkdown(src: string): string {
  return marked.parse(src, { async: false }) as string;
}
