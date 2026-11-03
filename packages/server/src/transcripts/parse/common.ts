// Shared pieces for the transcript parsers (one file per agent next to this one).
// The formats are internal to each agent and undocumented, so every field is read defensively: an unknown line
// is skipped, never fatal. Each parser is fed one JSONL line at a time and returns ChatOps: "add" for a new
// entry, "result" when a tool call finishes (results arrive in a later line than their call), "update" for a
// later change to a tool call, "meta" for session settings and usage.

import type { ChatBlock, ChatOp, ToolBlock } from "@af/core";

export type Agent = "claude" | "codex" | "omp";

export const MAX_OUTPUT = 6000;
/** Images larger than this (as a data: URL) are left out: they would be sent to the browser on every reload. */
export const MAX_IMAGE = 1_500_000;
export const clip = (s: string, n = MAX_OUTPUT) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);
export const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v, null, 2));
export const oneLine = (s: string, n = 160) => {
  const l = s.replace(/\s+/g, " ").trim();
  return l.length > n ? `${l.slice(0, n - 1)}…` : l;
};

/** Text a human typed versus text an agent harness injected. */
export function userOrNotice(text: string): ChatBlock | undefined {
  const t = text.trim();
  if (!t) return undefined;
  const cmd = t.match(/<command-name>([^<]+)<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return { kind: "notice", text: `${cmd[1]!.trim()}${args ? ` ${args}` : ""}` };
  }
  if (/^<local-command-(stdout|stderr|caveat)>/.test(t)) return undefined;
  if (t.startsWith("[agent-flow]")) return { kind: "notice", text: t };
  if (/^\[Request interrupted/.test(t)) return { kind: "notice", text: "interrupted" };
  const cleaned = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  return cleaned ? { kind: "user", text: cleaned } : undefined;
}

/** A tool call's one-line summary and the parts worth showing, from its name and input. */
export function describeTool(name: string, input: any): Pick<ToolBlock, "summary" | "input" | "patch" | "edit"> {
  const n = name.toLowerCase();
  const i = input && typeof input === "object" ? input : {};
  const path = i.file_path ?? i.path ?? i.notebook_path ?? i.filePath;
  if (n === "bash" || n === "shell" || n === "exec" || n === "exec_command" || n === "local_shell") {
    const cmd = Array.isArray(i.command) ? i.command.join(" ") : (i.command ?? i.cmd ?? (typeof input === "string" ? input : ""));
    return { summary: oneLine(str(cmd)), input: str(cmd).length > 160 ? str(cmd) : undefined };
  }
  if ((n === "edit" || n === "str_replace" || n === "replace") && path && (i.old_string !== undefined || i.old_str !== undefined))
    return { summary: path, edit: { path, before: str(i.old_string ?? i.old_str), after: str(i.new_string ?? i.new_str) } };
  if (n === "multiedit" && path && Array.isArray(i.edits))
    return { summary: `${path} (${i.edits.length} edits)`, patch: i.edits.map((e: any) => `@@\n${diffLines(str(e.old_string), str(e.new_string))}`).join("\n") };
  if ((n === "write" || n === "create") && path) return { summary: path, edit: { path, before: "", after: clip(str(i.content ?? i.file_text ?? i.text), 20000) } };
  if (n === "apply_patch" || (typeof input === "string" && input.includes("*** Begin Patch"))) {
    const patch = typeof input === "string" ? input : str(i.patch ?? i.input);
    const files = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]);
    return { summary: files.join(", ") || "patch", patch };
  }
  // omp's edit tool: {i: "<intent>", input: "[path#hash]\n<ops>"}
  const ompTarget = typeof i.input === "string" ? i.input.match(/^\[([^\]#\n]+)(?:#[^\]]*)?\]/) : null;
  if (ompTarget) return { summary: `${ompTarget[1]}${i.i ? ` — ${oneLine(str(i.i), 80)}` : ""}`, patch: i.input };
  if (path) return { summary: `${path}${i.offset ? ` @${i.offset}` : ""}` };
  if (i.pattern) return { summary: `${i.pattern}${i.path ? ` in ${i.path}` : ""}` };
  if (i.url) return { summary: i.url };
  if (i.query) return { summary: oneLine(str(i.query)) };
  if (i.description) return { summary: oneLine(str(i.description)), input: str(i.prompt ?? "") || undefined };
  const s = str(input);
  if (s === "{}" || s === "") return { summary: "" };
  return { summary: oneLine(s), input: s.length > 160 ? s : undefined };
}

/** A minimal line diff for display: removed lines, then added lines. */
export function diffLines(before: string, after: string) {
  const a = before ? before.split("\n") : [];
  const b = after ? after.split("\n") : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  return [...a.slice(Math.max(0, start - 2), start).map((l) => ` ${l}`), ...a.slice(start, endA).map((l) => `-${l}`), ...b.slice(start, endB).map((l) => `+${l}`), ...a.slice(endA, endA + 2).map((l) => ` ${l}`)].join("\n");
}

export const tool = (id: string, name: string, input: unknown): ToolBlock => ({ kind: "tool", id, name, done: false, ...describeTool(name, input) });

/** The text of a message's content (a string, or parts of type text / input_text / output_text). */
export const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((c: any) => (typeof c === "string" ? c : c?.type === "text" || c?.type === "input_text" || c?.type === "output_text" ? (c.text ?? "") : "")).join("")
      : "";

/** Text and images of a message's content. Images: claude {type:image, source:{type:base64, media_type, data}},
 *  codex {type:input_image, image_url}, omp {type:image, data, mimeType}. Too large ones are counted, not kept. */
export function partsOf(content: unknown): { text: string; images: string[]; droppedImages: number } {
  const images: string[] = [];
  let droppedImages = 0;
  const keep = (url: string | undefined) => {
    if (!url) return;
    if (url.length > MAX_IMAGE) droppedImages++;
    else images.push(url);
  };
  for (const c of Array.isArray(content) ? (content as any[]) : []) {
    if (c?.type === "image" && c.source?.type === "base64" && c.source.data) keep(`data:${c.source.media_type ?? "image/png"};base64,${c.source.data}`);
    else if (c?.type === "image" && typeof c.data === "string") keep(`data:${c.mimeType ?? c.mime_type ?? "image/png"};base64,${c.data}`);
    else if (c?.type === "input_image" && typeof c.image_url === "string") keep(c.image_url);
  }
  return { text: textOf(content), images, droppedImages };
}

/** A unified diff from claude-style structured hunks ({oldStart, oldLines, newStart, newLines, lines}). */
export function hunksToPatch(hunks: unknown, path?: string): string | undefined {
  if (!Array.isArray(hunks) || !hunks.length) return undefined;
  const out: string[] = path ? [`--- a/${path}`, `+++ b/${path}`] : [];
  for (const h of hunks as any[]) {
    if (!Array.isArray(h?.lines)) continue;
    out.push(`@@ -${h.oldStart ?? 0},${h.oldLines ?? 0} +${h.newStart ?? 0},${h.newLines ?? 0} @@`, ...h.lines.map(String));
  }
  return out.length > (path ? 2 : 0) ? out.join("\n") : undefined;
}

export interface ParseCtx {
  n: number;
  /** claude: prompts already shown from a queued_command, so a later plain copy is not shown twice. */
  queued?: Set<string>;
  /** Free for each parser's own state between lines (open turns, call ids, …). */
  state?: Record<string, any>;
}

export const add = (ctx: ParseCtx, block: ChatBlock | undefined, at?: string): ChatOp[] => (block ? [{ op: "add", entry: { key: `e${++ctx.n}`, at, block } }] : []);
