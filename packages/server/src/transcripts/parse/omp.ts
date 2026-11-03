// Transcript parser for omp (oh-my-pi). See common.ts for the shared pieces and the ChatOps a parser returns.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatBlock, ChatMeta, ChatOp, ToolBlock } from "@af/core";
import { MAX_IMAGE, type ParseCtx, add, clip, describeTool, oneLine, str, textOf, userOrNotice } from "./common.ts";

// omp: ~/.omp/agent/sessions/<slug>/<time>_<id>.jsonl, one entry per line:
//   {type:"title", title, pad}                      fixed-width first line, rewritten in place (hidden)
//   {type:"session", id, cwd}                       header
//   {type, id, parentId, timestamp, ...}            tree entries: the active branch is the path from the last entry
//                                                   back to the root; /tree and rewinds move the leaf, so an entry's
//                                                   parentId that is not the previous entry starts a new branch
//   type "message": message.role user | assistant | toolResult | developer | bashExecution | pythonExecution |
//                   fileMention | custom; assistant content [{type:text|thinking|toolCall|image}], stopReason,
//                   errorMessage, retryRecovery, usage, contextSnapshot; toolResult details per tool
//   type "custom_message" (display, customType: skill-prompt | async-result | …), "custom" (hidden state:
//   tool_execution_start, session_exit, todo_hud_state), "compaction", "branch_summary", "model_change",
//   "thinking_level_change", "mode_change", "reset_boundary", "model_usage", "title_change", "label", …
// Images are stored as {type:image, data:"blob:sha256:<hex>"} with the bytes in ~/.omp/agent/blobs/<hex>.

/** Entry ids remembered for the session tree (id → parent and the chat entries it produced). */
const MAX_NODES = 50_000;
/** Tool calls remembered (for results, background jobs and aborts). */
const MAX_CALLS = 5_000;
const MAX_REPORT = 20_000;

interface Node {
  parent: string | null;
  keys: string[];
  /** Its chat entries were removed (it is on an abandoned branch). */
  gone?: boolean;
}

interface Call {
  name: string;
  /** Files an edit call names in its input ("[path#hash]" headers), to show the result's absolute paths short. */
  targets?: string[];
}

interface OmpState {
  /** The last tree entry: the leaf of the active branch. undefined until the first entry is seen. */
  leaf?: string | null;
  nodes: Map<string, Node>;
  calls: Map<string, Call>;
  /** Calls without a result yet. */
  running: Set<string>;
  /** Calls that went to the background and have not reported back. */
  background: Set<string>;
  /** Background job id ("bg_5") → its tool call id. */
  jobs: Map<string, string>;
  meta: ChatMeta;
  cost: number;
  cwd?: string;
}

function stateOf(ctx: ParseCtx): OmpState {
  const bag = (ctx.state ??= {});
  return (bag.omp ??= {
    nodes: new Map(),
    calls: new Map(),
    running: new Set(),
    background: new Set(),
    jobs: new Map(),
    meta: {},
    cost: 0,
  } satisfies OmpState);
}

/** Keep a map at most `max` long, dropping the oldest entries. */
function cap<K, V>(m: Map<K, V>, max: number) {
  while (m.size > max) m.delete(m.keys().next().value as K);
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const s = (v: unknown) => (typeof v === "string" ? v : "");

export function parseOmp(line: any, ctx: ParseCtx): ChatOp[] {
  try {
    return parseOmpLine(line, ctx);
  } catch {
    return [];
  }
}

/** parseOmp without the safety net (tests check it does not throw on real lines). */
export function parseOmpLine(line: any, ctx: ParseCtx): ChatOp[] {
  if (!line || typeof line !== "object") return [];
  const st = stateOf(ctx);
  if (line.type === "session") {
    if (typeof line.cwd === "string") st.cwd = line.cwd;
    return [];
  }
  const inTree = typeof line.id === "string" && "parentId" in line;
  const ops: ChatOp[] = [];
  if (inTree) ops.push(...branchOps(line, ctx, st));
  ops.push(...entryOps(line, ctx, st));
  if (inTree) {
    const keys = ops.flatMap((o) => (o.op === "add" ? [o.entry.key] : []));
    st.nodes.set(line.id, { parent: typeof line.parentId === "string" ? line.parentId : null, keys });
    cap(st.nodes, MAX_NODES);
    st.leaf = line.id;
  }
  return ops;
}

// ---------------------------------------------------------------------------------------------
// The session tree: show only the active branch.

/**
 * An entry whose parent is not the current leaf starts a new branch (a rewind, /tree, a re-sent prompt). The entries
 * shown for the old leaf's path after the point where the new branch leaves it are taken out again.
 */
function branchOps(e: any, ctx: ParseCtx, st: OmpState): ChatOp[] {
  const parent: string | null = typeof e.parentId === "string" ? e.parentId : null;
  const prev = st.leaf;
  if (prev === undefined || parent === prev) return [];
  const onPath = new Set<string>();
  const path: string[] = [];
  for (let id = prev; id && !onPath.has(id); ) {
    const n = st.nodes.get(id);
    if (!n) break;
    onPath.add(id);
    path.push(id);
    id = n.parent;
  }
  // where the new branch leaves the shown path; null: before everything we know (a new root, or before the window)
  let fork: string | null = null;
  let reentered = false;
  const seen = new Set<string>();
  for (let id = parent; id && !seen.has(id); ) {
    if (onPath.has(id)) {
      fork = id;
      break;
    }
    seen.add(id);
    const n = st.nodes.get(id);
    if (!n) break;
    if (n.gone) reentered = true;
    id = n.parent;
  }
  const keys: string[] = [];
  for (const id of path) {
    if (id === fork) break;
    const n = st.nodes.get(id)!;
    if (!n.keys.length) continue;
    keys.push(...n.keys);
    n.keys = [];
    n.gone = true;
  }
  const ops: ChatOp[] = keys.length ? [{ op: "remove", keys }] : [];
  const at = e.timestamp;
  // a branch summary says it better (entryOps shows it)
  if (keys.length && !(e.type === "branch_summary" && s(e.summary).trim())) ops.push(...add(ctx, branchedNotice(keys.length), at));
  if (reentered)
    ops.push(...add(ctx, { kind: "notice", text: "continued on a branch left earlier", detail: "Its messages from before were taken out when the conversation left it, and are not shown again here." }, at));
  return ops;
}

const branchedNotice = (n: number): ChatBlock => ({
  kind: "notice",
  text: "branched here",
  detail: `The conversation went back to this point. ${n} ${n === 1 ? "entry" : "entries"} of the branch it left ${n === 1 ? "is" : "are"} hidden.`,
});

// ---------------------------------------------------------------------------------------------
// Entries.

function entryOps(e: any, ctx: ParseCtx, st: OmpState): ChatOp[] {
  const at: string | undefined = typeof e.timestamp === "string" ? e.timestamp : undefined;
  switch (e.type) {
    case "message":
      return messageOps(obj(e.message), e, at, ctx, st);
    case "custom_message":
      return customMessageOps(e, at, ctx, st);
    case "custom":
      return customOps(e, at, ctx, st);
    case "compaction":
      return add(ctx, compactionNotice(e), at);
    case "branch_summary": {
      // written when the conversation goes back to an earlier point; empty ones are omp's own markers
      const summary = s(e.summary).trim();
      if (!summary) return [];
      const switched = st.leaf !== undefined && (e.parentId ?? null) !== st.leaf;
      return add(ctx, { kind: "notice", text: switched ? "branched here · summary of the branch left" : "branch summary", detail: clip(summary, MAX_REPORT) }, at);
    }
    case "reset_boundary":
      return add(ctx, { kind: "notice", text: "context cleared", divider: true }, at);
    case "model_change":
      return modelChangeOps(e, at, ctx, st);
    case "thinking_level_change": {
      const level = e.configured === "auto" ? `auto${e.thinkingLevel ? ` (${e.thinkingLevel})` : ""}` : s(e.thinkingLevel) || "off";
      return metaOps(st, { effort: level });
    }
    case "mode_change":
      return metaOps(st, { mode: !e.mode || e.mode === "none" ? "default" : String(e.mode) });
    case "model_usage":
      return costOps(st, e.usage);
  }
  return [];
}

function messageOps(m: Record<string, any>, e: any, at: string | undefined, ctx: ParseCtx, st: OmpState): ChatOp[] {
  switch (m.role) {
    case "user":
      return userOps(m, at, ctx);
    case "assistant":
      return assistantOps(m, at, ctx, st);
    case "toolResult":
      return toolResultOps(m, ctx, st);
    case "bashExecution":
    case "pythonExecution": {
      const py = m.role === "pythonExecution";
      const cmd = s(py ? m.code : m.command);
      const { images, missing } = imagesOf(m.images);
      const exit = typeof m.exitCode === "number" ? m.exitCode : undefined;
      const output = s(m.output) + (missing ? "\n[image not available]" : "");
      const block: ToolBlock = {
        kind: "tool",
        id: `${py ? "py" : "sh"}-${e.id ?? ctx.n + 1}`,
        name: py ? "$" : "!",
        summary: oneLine(cmd),
        ...(cmd.length > 160 || cmd.includes("\n") ? { input: cmd } : {}),
        output: clip(output + (exit ? `\n(exit ${exit})` : "")),
        ...(images.length ? { images } : {}),
        ...(exit ? { error: true } : {}),
        ...(m.cancelled ? { aborted: true } : {}),
        done: true,
      };
      return add(ctx, block, at);
    }
    case "fileMention": {
      const files = arr(m.files).filter((f) => typeof f?.path === "string");
      if (!files.length) return [];
      const what = (f: any) =>
        f.skippedReason ? `skipped: ${f.skippedReason}` : f.image ? "image" : typeof f.lineCount === "number" ? `${f.lineCount} line${f.lineCount === 1 ? "" : "s"}` : "";
      return add(ctx, { kind: "notice", text: `read ${files.map((f) => `@${f.path}${what(f) ? ` (${what(f)})` : ""}`).join(", ")}` }, at);
    }
    case "custom":
    case "hookMessage":
      return customMessageOps(m, at, ctx, st);
    case "branchSummary":
      return s(m.summary).trim() ? add(ctx, { kind: "notice", text: "branch summary", detail: clip(s(m.summary), MAX_REPORT) }, at) : [];
    case "compactionSummary":
      return add(ctx, compactionNotice(m), at);
    // developer: plan/todo reminders omp injects for the model; omp does not show them either
  }
  return [];
}

function userOps(m: Record<string, any>, at: string | undefined, ctx: ParseCtx): ChatOp[] {
  const { text, images, missing } = contentOf(m.content);
  // agent-written input (an advisor's session update): omp folds it
  if (m.synthetic) return text.trim() ? add(ctx, { kind: "notice", text: oneLine(text, 120), detail: clip(text, MAX_REPORT) }, at) : [];
  const placeholder = missing ? `${text ? "\n" : ""}${"[image] ".repeat(missing).trim()}` : "";
  const block = userOrNotice(text + placeholder);
  if (block?.kind === "user" && images.length) block.images = images;
  if (!block && images.length) return add(ctx, { kind: "user", text: "", images }, at);
  return add(ctx, block, at);
}

// ---------------------------------------------------------------------------------------------
// Assistant turns: prose, thinking, tool calls, how the turn ended, and the footer.

/** abort messages that carry no reason of their own */
const GENERIC_ABORT = new Set(["", "Request was aborted", "Operation aborted", "Interrupted by user"]);
const SILENT_ABORT = "__omp.silent_abort__";

function assistantOps(m: Record<string, any>, at: string | undefined, ctx: ParseCtx, st: OmpState): ChatOp[] {
  const ops: ChatOp[] = [];
  for (const p of arr(m.content)) {
    if (p?.type === "thinking" && s(p.thinking).trim()) ops.push(...add(ctx, { kind: "thinking", text: s(p.thinking).trim() }, at));
    else if (p?.type === "text" && s(p.text).trim()) ops.push(...add(ctx, { kind: "text", text: s(p.text) }, at));
    else if (p?.type === "toolCall") ops.push(...toolCallOps(p.id, p.name, argsOf(p.arguments, p.partialArgs), s(p.intent), at, ctx, st));
  }
  const err = s(m.errorMessage);
  const recovery = obj(m.retryRecovery);
  if (recovery.status === "superseded") {
    // a failed attempt that a later retry replaced: omp hides it
  } else if (recovery.status === "recovered") {
    ops.push(...add(ctx, { kind: "notice", text: oneLine(s(recovery.note) || "retried", 120), ...(err ? { detail: clip(err) } : {}) }, at));
  } else if (m.stopReason === "aborted") {
    if (err !== SILENT_ABORT) {
      ops.push(...add(ctx, { kind: "notice", text: GENERIC_ABORT.has(err.trim()) ? "Interrupted" : oneLine(err, 200), tone: "warn" }, at));
      ops.push(...abortRunning(st, false));
    }
  } else if (m.stopReason === "error") {
    const first = err.split("\n")[0]!.trim();
    ops.push(...add(ctx, { kind: "notice", text: oneLine(first || "Error", 200), tone: "error", ...(err.trim() !== first || first.length > 200 ? { detail: clip(err) } : {}) }, at));
  }
  if (m.stopReason !== "error" && m.stopReason !== "aborted") {
    const model = typeof m.model === "string" && m.model ? m.model : undefined;
    ops.push(...metaOps(st, { model, contextTokens: contextTokensOf(m) }));
  }
  ops.push(...costOps(st, m.usage));
  return ops;
}

function contextTokensOf(m: Record<string, any>): number | undefined {
  const u = obj(m.usage);
  const snap = obj(m.contextSnapshot);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const prompt = typeof snap.promptTokens === "number" ? snap.promptTokens : num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
  const total = prompt - num(snap.historyRewriteTokensRemoved) + num(u.output);
  return total > 0 ? total : undefined;
}

function costOps(st: OmpState, usage: unknown): ChatOp[] {
  const c = obj(obj(usage).cost).total;
  if (typeof c !== "number" || !(c > 0)) return [];
  st.cost += c;
  return metaOps(st, { cost: Math.round(st.cost * 1e6) / 1e6 });
}

/** The footer: only what changed. */
function metaOps(st: OmpState, patch: ChatMeta): ChatOp[] {
  const changed: ChatMeta = {};
  for (const [k, v] of Object.entries(patch) as [keyof ChatMeta, any][]) {
    if (v === undefined || st.meta[k] === v) continue;
    (changed as any)[k] = v;
    (st.meta as any)[k] = v;
  }
  return Object.keys(changed).length ? [{ op: "meta", meta: changed }] : [];
}

/** model_change: roles default/temporary (the user picked a model) and fallback (a retry switched) change the active model. */
function modelChangeOps(e: any, at: string | undefined, ctx: ParseCtx, st: OmpState): ChatOp[] {
  const full = s(e.model);
  if (!full) return [];
  const role = s(e.role) || "default";
  if (role !== "default" && role !== "temporary" && role !== "fallback") return []; // another role's model (smol, slow, …)
  const model = full.includes("/") ? full.slice(full.indexOf("/") + 1) : full;
  const before = st.meta.model;
  const ops = metaOps(st, { model });
  if (role !== "fallback" && before && before !== model) ops.unshift(...add(ctx, { kind: "notice", text: `model: ${model}` }, at));
  return ops;
}

function compactionNotice(e: any): ChatBlock {
  const k = (n: unknown) => (typeof n === "number" ? (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)) : undefined);
  const before = k(e.tokensBefore);
  const after = k(e.tokensAfter);
  const text = before && after ? `Compacted ${before} → ${after} tokens` : before ? `Compacted ${before} tokens` : "Compacted";
  const summary = s(e.summary).trim();
  return { kind: "notice", text, divider: true, ...(summary ? { detail: clip(summary, MAX_REPORT) } : {}) };
}

/** Interrupted turn: tools still running stop (background jobs keep running unless the process exits). */
function abortRunning(st: OmpState, withBackground: boolean): ChatOp[] {
  const ops: ChatOp[] = [];
  for (const id of st.running) ops.push({ op: "update", id, set: { aborted: true, done: true } });
  st.running.clear();
  if (withBackground) {
    for (const id of st.background) ops.push({ op: "update", id, set: { aborted: true, done: true } });
    st.background.clear();
  }
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Tool calls.

function argsOf(args: unknown, partial: unknown): Record<string, any> {
  const a = obj(args);
  if (Object.keys(a).length || typeof partial !== "string" || !partial.trim()) return a;
  try {
    return obj(JSON.parse(partial));
  } catch {
    return a;
  }
}

function toolCallOps(rawId: unknown, rawName: unknown, args: Record<string, any>, intent: string, at: string | undefined, ctx: ParseCtx, st: OmpState): ChatOp[] {
  const id = typeof rawId === "string" && rawId ? rawId : `tool-${ctx.n + 1}`;
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : "tool";
  const d = describeOmp(name, args, intent);
  const known = st.calls.get(id);
  st.calls.set(id, { name, targets: d.targets });
  cap(st.calls, MAX_CALLS);
  const { targets: _t, ...shown } = d;
  if (known) return [{ op: "update", id, set: { name, ...shown } }]; // shown already from tool_execution_start
  st.running.add(id);
  return add(ctx, { kind: "tool", id, name, done: false, ...shown }, at);
}

type Described = Pick<ToolBlock, "summary" | "input" | "patch" | "edit" | "report"> & { targets?: string[] };

/** "[calc.js#6F9B]" headers in omp's edit input: the files it edits. */
const EDIT_TARGET = /^\[([^\]#\n]+)(?:#[^\]\n]*)?\]\s*$/gm;
const LANG: Record<string, string> = { py: "python", js: "javascript", ts: "typescript", sh: "bash" };
const fence = (code: string, lang = "") => {
  const ticks = code.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${code.replace(/\n$/, "")}\n${ticks}`;
};

/** A tool call's summary and the parts worth showing, for omp's tools (args carry an intent "i"). */
function describeOmp(name: string, args: Record<string, any>, intentArg = ""): Described {
  const intent = oneLine(s(args.i) || intentArg, 100);
  const { i: _i, ...rest } = args;
  const withIntent = (core: string) => (core ? `${core}${intent ? ` — ${intent}` : ""}` : intent);
  switch (name) {
    case "grep":
      // common describeTool looks at path before pattern
      if (rest.pattern) return { summary: oneLine(`${str(rest.pattern)}${rest.path ? ` in ${str(rest.path)}` : ""}`) };
      break;
    case "glob":
      if (rest.pattern) return { summary: oneLine(`${str(rest.pattern)}${rest.path ? ` in ${str(rest.path)}` : ""}`) };
      if (rest.path) return { summary: oneLine(str(rest.path)) };
      return { summary: intent };
    case "edit": {
      const input = s(rest.input);
      const targets = [...input.matchAll(EDIT_TARGET)].map((x) => x[1]!.trim());
      if (targets.length) return { summary: withIntent([...new Set(targets)].join(", ")), input, targets: [...new Set(targets)] };
      const path = s(rest.path);
      if (path) return { summary: withIntent(path), input: str(rest.edits ?? rest) || undefined, targets: [path] };
      break;
    }
    case "todo": {
      const phases = arr(rest.list).map((p: any) => ({ name: s(p?.phase), tasks: arr(p?.items).map((c: any) => ({ content: str(c), status: "pending" })) }));
      if (!phases.length && arr(rest.items).length) phases.push({ name: s(rest.phase), tasks: arr(rest.items).map((c: any) => ({ content: str(c), status: "pending" })) });
      const op = s(rest.op);
      const report = op === "init" || op === "" ? checklist(phases) : undefined;
      return { summary: intent || [op, s(rest.task) || s(rest.phase)].filter(Boolean).join(" ") || "todo", ...(report ? { report } : {}) };
    }
    case "hub": {
      const op = s(rest.op) || "hub";
      const ids = arr(rest.ids).map(str).join(", ");
      const target = s(rest.to) ? ` → ${s(rest.to)}` : s(rest.name) ? ` ${s(rest.name)}` : "";
      const msg = s(rest.message) || s(rest.text);
      return { summary: oneLine(`${op}${ids ? ` ${ids}` : ""}${target}${msg ? `: ${msg}` : ""}`), ...(msg.length > 120 ? { input: msg } : {}) };
    }
    case "eval": {
      const code = s(rest.code);
      const lang = LANG[s(rest.language)] ?? s(rest.language);
      const title = s(rest.title);
      const first = code.split("\n").find((l) => l.trim()) ?? "";
      return { summary: oneLine(title || `${lang || "eval"}: ${first}`), ...(code ? { report: fence(clip(code, MAX_REPORT), lang) } : {}) };
    }
    case "task": {
      const tasks = arr(rest.tasks);
      if (tasks.length) {
        const who = tasks.map((t: any) => s(t?.name) || s(t?.agent) || "task").join(", ");
        const input = [s(rest.context), ...tasks.map((t: any) => `## ${s(t?.name) || s(t?.agent) || "task"}\n${str(t?.task)}`)].filter(Boolean).join("\n\n");
        return { summary: oneLine(`${tasks.length} subagents: ${who}`), input };
      }
      const agent = s(rest.agent) || "task";
      const task = str(rest.task);
      return { summary: oneLine(`${agent}${s(rest.name) ? ` (${s(rest.name)})` : ""}: ${task}`), ...(task.length > 100 ? { input: task } : {}) };
    }
    case "ask": {
      const qs = arr(rest.questions);
      if (!qs.length) break;
      const input = qs.map((q: any) => [str(q?.question), ...arr(q?.options).map((o: any) => `- ${s(o?.label) || str(o)}`)].join("\n")).join("\n\n");
      return { summary: oneLine(qs.map((q: any) => str(q?.question)).join(" · ")), input };
    }
  }
  const d = describeTool(name, rest);
  return { ...d, summary: d.summary || intent };
}

interface Task {
  content: string;
  status: string;
  note?: string;
}

/** A todo list as markdown checkboxes. */
function checklist(phases: { name: string; tasks: Task[] }[]): string | undefined {
  const named = phases.filter((p) => p.tasks.length);
  if (!named.length) return undefined;
  const heads = named.length > 1 || named.some((p) => p.name);
  const item = (t: Task) => {
    const c = oneLine(t.content, 300);
    if (t.status === "completed") return `- [x] ${c}`;
    if (t.status === "in_progress") return `- [ ] **${c}**`;
    if (t.status === "abandoned") return `- [ ] ~~${c}~~`;
    if (t.status === "blocked") return `- [ ] ${c} *(blocked${t.note ? `: ${oneLine(t.note, 100)}` : ""})*`;
    return `- [ ] ${c}`;
  };
  return named.map((p) => [heads && p.name ? `**${p.name}**\n` : "", ...p.tasks.map(item)].filter(Boolean).join("\n")).join("\n\n");
}

// ---------------------------------------------------------------------------------------------
// Tool results.

function toolResultOps(m: Record<string, any>, ctx: ParseCtx, st: OmpState): ChatOp[] {
  const id = s(m.toolCallId);
  if (!id) return [];
  const call = st.calls.get(id);
  const name = s(m.toolName) || call?.name || "";
  const d = obj(m.details);
  const { text, images, missing } = contentOf(m.content);
  const async = obj(d.async);
  const bg = async.state === "running";
  st.running.delete(id);
  if (bg) {
    st.background.add(id);
    if (typeof async.jobId === "string") {
      st.jobs.set(async.jobId, id);
      cap(st.jobs, 1000);
    }
  }
  const output = text + (missing ? `${text ? "\n" : ""}[image not available]` : "");
  const ops: ChatOp[] = [{ op: "result", id, output: clip(output), error: !!m.isError, ...(images.length ? { images } : {}), ...(bg ? { background: true } : {}) }];
  const set: Partial<Omit<ToolBlock, "kind" | "id">> = {};
  if (name === "edit" && !m.isError) Object.assign(set, editResult(d, st, call?.targets));
  else if (name === "todo") {
    // the list after the call (an empty one clears what the call's arguments suggested)
    if (Array.isArray(d.phases))
      set.report = checklist(d.phases.map((p: any) => ({ name: s(p?.name), tasks: arr(p?.tasks).map((t: any) => ({ content: str(t?.content), status: s(t?.status), note: s(t?.note) || undefined })) }))) ?? "";
  } else if (name === "hub") {
    const jobs = arr(d.jobs).filter((j) => typeof j?.id === "string");
    if (jobs.length)
      set.report = jobs
        .map((j: any) => `- \`${j.id}\`${j.type ? ` ${j.type}` : ""} · **${s(j.status) || "?"}**${typeof j.durationMs === "number" ? ` (${secs(j.durationMs)})` : ""}${j.label ? ` · ${oneLine(str(j.label), 120)}` : ""}`)
        .join("\n");
    // a wait that collected a job's result: the backgrounded call is done
    for (const j of jobs) if (["completed", "failed", "cancelled"].includes(j.status)) ops.push(...jobDone(st, j.id, str(j.resultText ?? ""), j.status));
  } else if (name === "eval") {
    const cells = arr(d.cells);
    if (cells.length) {
      const many = cells.length > 1;
      set.report = clip(cells.map((c: any) => `${many && c?.title ? `**${s(c.title)}**\n\n` : ""}${fence(s(c?.code), LANG[s(c?.language)] ?? s(c?.language))}`).join("\n\n"), MAX_REPORT);
      const outs = cells.map((c: any) => s(c?.output)).filter(Boolean);
      if (outs.length && !text.trim()) ops[0] = { ...(ops[0] as any), output: clip(outs.join("\n")) };
    }
  } else if (name === "task") {
    const results = arr(d.results);
    if (results.length) {
      const one = (r: any) => [s(r?.output).trim(), s(r?.error) ? `**Error:** ${s(r.error)}` : ""].filter(Boolean).join("\n\n") || "(no output)";
      set.report = clip(
        results.length === 1 ? one(results[0]) : results.map((r: any) => `### ${s(r?.name) || s(r?.agent) || "task"}${s(r?.description) ? ` · ${oneLine(s(r.description), 80)}` : ""}\n\n${one(r)}`).join("\n\n"),
        MAX_REPORT,
      );
    }
  } else if (name === "ask") {
    const report = askReport(d);
    if (report) set.report = report;
  }
  if (Object.keys(set).length) ops.push({ op: "update", id, set });
  return ops;
}

const secs = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);

function askReport(d: Record<string, any>): string | undefined {
  if (d.chatRedirect) return `The user chose to chat about it${arr(d.questions).length ? `:\n\n${arr(d.questions).map((q) => `- ${str(q)}`).join("\n")}` : "."}`;
  const qs = arr(d.results).length ? arr(d.results) : d.question ? [d] : [];
  if (!qs.length) return undefined;
  return qs
    .map((q: any) => {
      const answers = [...arr(q?.selectedOptions).map(str), ...(s(q?.customInput) ? [`“${s(q.customInput)}”`] : [])];
      return `**${oneLine(str(q?.question), 300)}**\n→ ${answers.join(", ") || "(no answer)"}${s(q?.note) ? ` — ${s(q.note)}` : ""}${q?.timedOut ? " *(timed out)*" : ""}`;
    })
    .join("\n\n");
}

/** A background job reported back: the call that started it gets its output. */
function jobDone(st: OmpState, jobId: string, output: string, status = "completed"): ChatOp[] {
  const id = st.jobs.get(jobId);
  if (!id) return [];
  st.jobs.delete(jobId);
  st.background.delete(id);
  const kind = st.calls.get(id)?.name;
  const set: Partial<Omit<ToolBlock, "kind" | "id">> = { done: true, ...(kind === "task" ? { report: clip(output, MAX_REPORT) } : { output: clip(output) }) };
  if (status === "failed") set.error = true;
  if (status === "cancelled") set.aborted = true;
  return [{ op: "update", id, set }];
}

// ---------------------------------------------------------------------------------------------
// Edits: omp records the real diff per file in the result's details.

/** A file's path as the user knows it: relative to the session folder, or as the edit call named it. */
function shortPath(path: string, st: OmpState, targets?: string[]) {
  if (st.cwd && path.startsWith(`${st.cwd}/`)) return path.slice(st.cwd.length + 1);
  return targets?.find((t) => path === t || path.endsWith(`/${t}`)) ?? path;
}

function editResult(d: Record<string, any>, st: OmpState, targets?: string[]): Partial<ToolBlock> {
  const files = arr(d.perFileResults).length ? arr(d.perFileResults) : d.path || d.diff ? [d] : [];
  if (!files.length) return {};
  const out: string[] = [];
  const names: string[] = [];
  let added = 0;
  let removed = 0;
  let edit: ToolBlock["edit"];
  for (const f of files) {
    const path = shortPath(s(f?.path) || targets?.[0] || "file", st, targets);
    const from = s(f?.sourcePath) ? shortPath(s(f.sourcePath), st, targets) : path;
    names.push(path);
    const h = s(f?.diff) ? unifiedFromOmp(s(f.diff)) : undefined;
    if (h?.lines.length) {
      out.push(f?.op === "create" ? "--- /dev/null" : `--- a/${from}`, f?.op === "delete" ? "+++ /dev/null" : `+++ b/${path}`, ...h.lines);
      added += h.added;
      removed += h.removed;
    } else if (files.length === 1 && (typeof f?.oldText === "string" || typeof f?.newText === "string")) {
      edit = { path, before: clip(s(f.oldText), MAX_REPORT), after: clip(s(f.newText), MAX_REPORT) };
    }
  }
  const counts = out.length ? ` (+${added} −${removed})` : "";
  const summary = names.length === 1 ? `${names[0]}${counts}` : `${names.length} files${counts}`;
  return { summary, files: names, ...(out.length ? { patch: out.join("\n"), input: "" } : edit ? { edit, input: "" } : {}) };
}

/**
 * omp's diff lines are "<mark><line number>|<text>": "-" lines carry the old number, "+" lines the new one, context
 * lines one of the two. A row that is not such a line (blank, "...", "…") is a gap between regions. Turned into
 * unified-diff hunks with "@@ -old,n +new,m @@" headers.
 */
export function unifiedFromOmp(diff: string): { lines: string[]; added: number; removed: number } {
  const lines: string[] = [];
  let added = 0;
  let removed = 0;
  let hunk: string[] = [];
  let oldStart = 0;
  let newStart = 0;
  let oldN = 0;
  let newN = 0;
  let curOld = 0;
  let curNew = 0;
  let offset = 0; // new line number minus old line number after the changes so far
  const flush = () => {
    if (hunk.length) lines.push(`@@ -${oldStart},${oldN} +${newStart},${newN} @@`, ...hunk);
    hunk = [];
    oldN = newN = 0;
  };
  const begin = (o: number, n: number) => {
    flush();
    oldStart = curOld = o;
    newStart = curNew = n;
  };
  for (const raw of diff.split("\n")) {
    const m = raw.match(/^([+\- ])\s*(\d+)\|(.*)$/);
    if (!m) {
      flush();
      continue;
    }
    const mark = m[1]!;
    const n = Number(m[2]);
    const text = m[3]!;
    if (mark === "-") {
      if (!hunk.length || n !== curOld) begin(n, n + offset);
      hunk.push(`-${text}`);
      curOld++;
      oldN++;
      removed++;
      offset--;
    } else if (mark === "+") {
      if (!hunk.length || n !== curNew) begin(n - offset, n);
      hunk.push(`+${text}`);
      curNew++;
      newN++;
      added++;
      offset++;
    } else {
      if (!hunk.length || (n !== curOld && n !== curNew)) begin(n, n + offset);
      hunk.push(` ${text}`);
      curOld++;
      curNew++;
      oldN++;
      newN++;
    }
  }
  flush();
  return { lines, added, removed };
}

// ---------------------------------------------------------------------------------------------
// Messages from omp itself and its extensions (custom_message), and hidden state (custom).

function customMessageOps(e: Record<string, any>, at: string | undefined, ctx: ParseCtx, st: OmpState): ChatOp[] {
  if (!e.display) return [];
  const type = s(e.customType);
  const d = obj(e.details);
  if (type === "skill-prompt") {
    const name = s(d.name) || "skill";
    const command = `/skill:${name}`;
    if (e.attribution === "agent") return add(ctx, { kind: "notice", text: `loaded skill ${name}` }, at);
    const prompt = s(d.prompt).trim();
    const text = prompt && !prompt.startsWith(command) ? prompt : s(d.args).trim() || prompt.slice(command.length).trim();
    return add(ctx, { kind: "user", text, command }, at);
  }
  const { text, images } = contentOf(e.content);
  if (type === "async-result") return asyncResultOps(text, d, at, ctx, st);
  const body = text.trim() || (Object.keys(d).length ? str(d) : "");
  const label = type.replace(/[-_:]+/g, " ").trim() || "message";
  const first = text.trim().split("\n").find((l) => l.trim()) ?? "";
  const block: ChatBlock = { kind: "notice", text: oneLine(first ? `${label}: ${first}` : label, 160), ...(body ? { detail: clip(body, MAX_REPORT) } : {}) };
  return images.length ? [...add(ctx, block, at), ...add(ctx, { kind: "user", text: "", images }, at)] : add(ctx, block, at);
}

/**
 * A background job finished: omp delivers its output in a message ("<system-notice>Background job bg_5 has
 * completed…"). The call that started it gets the output; a job with no such call shows as a notice.
 */
function asyncResultOps(text: string, d: Record<string, any>, at: string | undefined, ctx: ParseCtx, st: OmpState): ChatOp[] {
  const jobs = arr(d.jobs).length ? arr(d.jobs) : d.jobId ? [d] : [];
  const body = text
    .replace(/^\s*<system-notice>\s*\n?/, "")
    .replace(/\n?\s*<\/system-notice>\s*$/, "")
    .replace(/^(Background job \S+ has completed|\d+ background jobs have completed)\.[^\n]*\n?/, "");
  // several jobs: "── Job bg_1 (label) ──" before each result
  const parts = new Map<string, string>();
  const marks = [...body.matchAll(/^── Job (\S+?)(?: \(.*\))? ──$/gm)];
  if (marks.length) marks.forEach((x, i) => parts.set(x[1]!, body.slice(x.index! + x[0].length + 1, marks[i + 1]?.index ?? body.length).replace(/\n$/, "")));
  const ops: ChatOp[] = [];
  for (const j of jobs) {
    const jobId = s(j?.jobId);
    const out = parts.get(jobId) ?? (jobs.length === 1 ? body : "");
    const done = jobId ? jobDone(st, jobId, out) : [];
    if (done.length) ops.push(...done);
    else
      ops.push(
        ...add(
          ctx,
          { kind: "notice", text: oneLine(`Background job ${jobId || "?"} completed${j?.label ? `: ${str(j.label)}` : ""}${typeof j?.durationMs === "number" ? ` (${secs(j.durationMs)})` : ""}`), ...(out.trim() ? { detail: clip(out) } : {}) },
          at,
        ),
      );
  }
  if (!jobs.length && body.trim()) ops.push(...add(ctx, { kind: "notice", text: "Background job completed", detail: clip(body) }, at));
  return ops;
}

function customOps(e: Record<string, any>, at: string | undefined, ctx: ParseCtx, st: OmpState): ChatOp[] {
  const data = obj(e.data);
  if (e.customType === "tool_execution_start") {
    // omp can start a tool while the assistant message that calls it is still streaming (written when it ends)
    const id = s(data.toolCallId);
    if (!id || st.calls.has(id)) return [];
    return toolCallOps(id, data.toolName, obj(data.args), s(data.intent), at, ctx, st);
  }
  if (e.customType === "session_exit") return abortRunning(st, true); // the process is gone, and its jobs with it
  return [];
}

// ---------------------------------------------------------------------------------------------
// Content and images.

/** Text and images of omp content. Images stored as blob references are read from omp's blob store. */
function contentOf(content: unknown): { text: string; images: string[]; missing: number } {
  const text = textOf(content);
  const { images, missing } = imagesOf(arr(content).filter((c) => c?.type === "image"));
  return { text, images, missing };
}

function imagesOf(parts: unknown): { images: string[]; missing: number } {
  const images: string[] = [];
  let missing = 0;
  for (const p of arr(parts)) {
    const url = imageUrl(p);
    if (url) images.push(url);
    else missing++;
  }
  return { images, missing };
}

const BLOB_REF = /^blob:sha256:([a-f0-9]{64})$/;

function blobDirs() {
  const dirs = [process.env.PI_CODING_AGENT_DIR && join(process.env.PI_CODING_AGENT_DIR, "blobs"), join(homedir(), ".omp", "agent", "blobs")];
  if (process.env.XDG_DATA_HOME) dirs.push(join(process.env.XDG_DATA_HOME, "omp", "blobs"));
  return dirs.filter((d): d is string => !!d);
}

/** An image part as a data: URL (at most MAX_IMAGE long), or undefined when it cannot be shown. */
function imageUrl(p: any): string | undefined {
  const data = p?.data;
  const mime = s(p?.mimeType) || s(p?.mime_type) || "image/png";
  if (typeof data !== "string" || !data) return undefined;
  const ref = data.match(BLOB_REF);
  if (!ref) {
    const url = data.startsWith("data:") ? data : `data:${mime};base64,${data}`;
    return url.length <= MAX_IMAGE ? url : undefined;
  }
  // content-addressed, so a local copy is the same image even for a session on another machine
  for (const dir of blobDirs()) {
    const file = join(dir, ref[1]!);
    try {
      const size = statSync(file).size;
      if (Math.ceil(size / 3) * 4 + mime.length + 13 > MAX_IMAGE) return undefined;
      const buf = readFileSync(file);
      // a provider image data URL is stored as its text; other images as their bytes
      if (buf.subarray(0, 11).toString() === "data:image/") return buf.toString("utf8");
      return `data:${mime};base64,${buf.toString("base64")}`;
    } catch {}
  }
  return undefined;
}
