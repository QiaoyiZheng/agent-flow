// Transcript parser for codex. See common.ts for the shared pieces and the ChatOps a parser returns.
import type { ChatMeta, ChatOp, ToolBlock } from "@af/core";
import { MAX_IMAGE, MAX_OUTPUT, type ParseCtx, add, clip, describeTool, oneLine, str, textOf, tool, userOrNotice } from "./common.ts";

// codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, one record per line:
//   session_meta   {id, cwd, originator, forked_from_id?, history_base?{thread_id, end_byte_offset}, source.subagent?}
//   turn_context   {model, effort, cwd, sandbox_policy, collaboration_mode}, once per turn
//   response_item  what the model saw and said: message (user / assistant {phase} / developer), reasoning {summary[]},
//                  function_call(+_output), custom_tool_call(+_output), agent_message (between subagents), web_search_call
//   event_msg      what happened: item_completed {item: CommandExecution | FileChange | ImageView | McpToolCall |
//                  SubAgentActivity | AgentMessage | UserMessage | Reasoning | ContextCompaction | …}, token_count,
//                  task_started, task_complete {error?}, turn_aborted, thread_settings_applied
//   compacted      {message: "<preamble>" + the model's handoff summary}, after a context compaction
//
// In code mode every tool call is one `exec` custom tool call: a JavaScript cell that calls tools.exec_command,
// tools.apply_patch, tools.view_image, tools.write_stdin, MCP tools… possibly several at once. What it really ran
// arrives as item_completed records between the call and its output (one per command, patch, viewed image), so:
// the call gets a row while it runs; each record gets a row of its own; when the call's output arrives, the call's
// row is removed if those rows tell the whole story, else it gets the output (a JS-only cell, a failed script).
// A command still running when the cell returns is a background terminal: it gets a row that write_stdin polls
// update, and that its item_completed record finishes later.

const CODEX_INJECTED =
  /^(# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>|<permissions instructions>|<turn_aborted>|<user_action>|<subagent_notification>|<skill>|<collaboration_mode>|<model_switch>|<codex_apps_client_time_context>|<in-app-browser-context|Another language model started to solve this problem)/;
/** codex's encrypted payloads (subagent messages and tasks, reasoning): never shown. */
const ENCRYPTED = /^gAAAA[\w-]{20,}/;
const isEncrypted = (s: string) => ENCRYPTED.test(s.trim());
const MAX_PATCH = 30000;

interface Call {
  /** Entry key of the call's own row. */
  key: string;
  kind: "exec" | "command" | "question" | "spawn" | "mcp" | "other";
  /** Its commands, edits and viewed images arrive as item_completed records that get rows of their own. */
  container: boolean;
  /** Shell commands it runs, in script order, and those whose records arrived. */
  cmds: string[];
  seen: string[];
  /** Rows added for its records, and the image rows among them (the pictures come with the call's output). */
  children: number;
  views: string[];
  /** Background terminal sessions whose records arrived while it ran. */
  pids: string[];
  /** Only polls background terminals (write_stdin): folded into the terminals' rows. */
  pollsOnly: boolean;
  polls: string[];
  /** The call's own row already shows its result (its record had the call's id). */
  self?: boolean;
  error?: boolean;
}

interface State {
  calls: Record<string, Call>;
  /** Background terminal session id → the row showing it, and its output so far. */
  procs: Record<string, string>;
  procOut: Record<string, string>;
  /** Subagent path ("/root/x") → its spawn_agent row. */
  agents: Record<string, string>;
  /** The newest assistant text while nothing else followed it: a handoff summary if a compaction comes next. */
  last?: { key: string; text: string };
  /** A compacted line was shown; the ContextCompaction record that follows is the same event. */
  compacted?: boolean;
  meta: ChatMeta;
  model?: string;
  effort?: string;
  /** The file records thread_settings_applied: the user's model and effort choices. */
  threadSettings?: boolean;
  cwd?: string;
  /** session_meta records already shown. */
  metas?: string[];
}

const stateOf = (ctx: ParseCtx): State => {
  const s = (ctx.state ??= {}) as State;
  s.calls ??= {};
  s.procs ??= {};
  s.procOut ??= {};
  s.agents ??= {};
  s.meta ??= {};
  return s;
};

export function parseCodex(line: any, ctx: ParseCtx): ChatOp[] {
  try {
    const st = stateOf(ctx);
    const last = st.last;
    const ops = parseLine(line, ctx, st);
    // anything shown after an assistant text means it was a reply, not a summary about to be compacted
    if (st.last === last && ops.some((o) => o.op !== "meta")) st.last = undefined;
    return ops;
  } catch {
    return [];
  }
}

function parseLine(line: any, ctx: ParseCtx, st: State): ChatOp[] {
  const p = line?.payload ?? {};
  const at = line?.timestamp;
  switch (line?.type) {
    case "session_meta":
      return sessionMeta(p, ctx, st, at);
    case "turn_context": {
      if (typeof p.cwd === "string") st.cwd = p.cwd;
      const collab = p.collaboration_mode;
      const mode = modeOf(collab?.mode, p.sandbox_policy);
      // turn_context restates the running turn's settings (also after a compaction): when the file has
      // thread_settings_applied (the user's latest choice, for the next turn), that one decides model and effort
      if (st.threadSettings) return setMeta(st, { mode });
      return settings(ctx, st, at, p.model ?? collab?.settings?.model, p.effort ?? p.reasoning_effort ?? collab?.settings?.reasoning_effort, mode);
    }
    case "compacted":
      return compacted(p, ctx, st, at);
    case "event_msg":
      return event(p, ctx, st, at);
    case "response_item":
      return responseItem(p, ctx, st, at);
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Session, settings, usage

function sessionMeta(p: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  if (typeof p.cwd === "string" && !st.cwd) st.cwd = p.cwd;
  // only a fork, a continuation or a subagent gets a divider (a subagent's file repeats its parent's plain
  // session_meta next; a parent file read before its fork would bring its own), each once
  const sig = JSON.stringify([p.id, p.history_base?.thread_id, p.history_base?.end_byte_offset, p.forked_from_id]);
  if ((st.metas ??= []).includes(sig)) return [];
  st.metas.push(sig);
  const spawn = p.source?.subagent?.thread_spawn;
  if (spawn || p.thread_source === "subagent") {
    const path = str(spawn?.agent_path ?? p.agent_path);
    const nick = str(spawn?.agent_nickname ?? p.agent_nickname);
    const parent = str(spawn?.parent_thread_id ?? p.parent_thread_id ?? p.forked_from_id);
    return add(ctx, { kind: "notice", text: `Subagent ${path || "thread"}${nick ? ` (${nick})` : ""}`, divider: true, detail: parent ? `spawned by thread ${parent}` : undefined }, at);
  }
  const base = p.history_base;
  const from = str(base?.thread_id ?? p.forked_from_id);
  if (!from) return [];
  const where = base?.end_byte_offset !== undefined ? ` (its first ${base.end_byte_offset} bytes)` : "";
  // a paginated thread continues its own earlier file (after a rewind); a fork starts from another thread's
  const same = from === str(p.id) || from === str(p.session_id);
  return add(
    ctx,
    { kind: "notice", text: same ? "Continued from an earlier file of this conversation" : `Forked from ${from}`, divider: true, detail: `The conversation before this point is in the rollout file of thread ${from}${where}.` },
    at,
  );
}

const SANDBOX: Record<string, string> = { "danger-full-access": "full access", "workspace-write": "workspace write", "read-only": "read only" };
function modeOf(collab: unknown, sandbox: any): string | undefined {
  if (typeof collab === "string" && collab && collab !== "default") return collab;
  const t = typeof sandbox === "string" ? sandbox : sandbox?.type;
  return typeof t === "string" ? (SANDBOX[t] ?? t) : undefined;
}

/** Footer values that changed. */
function setMeta(st: State, m: ChatMeta): ChatOp[] {
  const changed: ChatMeta = {};
  for (const [k, v] of Object.entries(m) as [keyof ChatMeta, any][]) if (v !== undefined && v !== null && v !== "" && st.meta[k] !== v) (changed as any)[k] = v;
  if (!Object.keys(changed).length) return [];
  Object.assign(st.meta, changed);
  return [{ op: "meta", meta: changed }];
}

/** Model and effort from turn_context / thread_settings_applied: the footer, and a line when they change mid-session. */
function settings(ctx: ParseCtx, st: State, at: string | undefined, model: unknown, effort: unknown, mode?: string): ChatOp[] {
  const m = typeof model === "string" && model ? model : undefined;
  const e = typeof effort === "string" && effort ? effort : undefined;
  const ops: ChatOp[] = [];
  if (m) {
    const changed = st.model !== undefined && (st.model !== m || (e !== undefined && st.effort !== undefined && st.effort !== e));
    st.model = m;
    if (e) st.effort = e;
    if (changed) ops.push(...add(ctx, { kind: "notice", text: `Model changed to ${m}${st.effort ? ` ${st.effort}` : ""}` }, at));
  } else if (e) st.effort = e;
  return [...ops, ...setMeta(st, { model: m, effort: e, mode })];
}

// ---------------------------------------------------------------------------------------------
// event_msg

function event(p: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  switch (p.type) {
    case "item_completed":
      return item(p.item ?? {}, ctx, st, at);
    case "token_count": {
      const info = p.info;
      const last = info?.last_token_usage;
      const tokens = typeof last?.total_tokens === "number" ? last.total_tokens : typeof last?.input_tokens === "number" ? last.input_tokens + (last.output_tokens ?? 0) : undefined;
      return setMeta(st, { contextTokens: tokens, contextWindow: typeof info?.model_context_window === "number" ? info.model_context_window : undefined });
    }
    case "task_started":
      st.last = undefined;
      return setMeta(st, { contextWindow: typeof p.model_context_window === "number" ? p.model_context_window : undefined });
    case "task_complete": {
      st.last = undefined;
      const msg = p.error ? str(p.error.message ?? p.error) : "";
      return msg ? add(ctx, { kind: "notice", tone: "error", text: oneLine(msg, 300), detail: msg.length > 300 ? msg : undefined }, at) : [];
    }
    case "error": {
      const msg = str(p.message);
      return msg ? add(ctx, { kind: "notice", tone: "error", text: oneLine(msg, 300), detail: msg.length > 300 ? msg : undefined }, at) : [];
    }
    case "warning":
      return p.message ? add(ctx, { kind: "notice", tone: "warn", text: oneLine(str(p.message), 300) }, at) : [];
    case "turn_aborted":
      return aborted(p, ctx, st, at);
    case "thread_settings_applied": {
      const s = p.thread_settings ?? {};
      st.threadSettings = true;
      return settings(ctx, st, at, s.model, s.reasoning_effort ?? s.collaboration_mode?.settings?.reasoning_effort);
    }
    case "context_compacted":
      return compactionItem(ctx, st, at);
    case "entered_review_mode":
      return reviewStart(p, ctx, at);
    case "exited_review_mode":
      return reviewEnd(p, ctx, at);
  }
  return [];
}

/** The user interrupted the turn: whatever was still running ends, marked as aborted. */
function aborted(p: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const ops: ChatOp[] = [];
  for (const id of Object.keys(st.calls)) ops.push({ op: "update", id, set: { aborted: true, done: true } });
  st.calls = {};
  st.last = undefined;
  const reason = str(p.reason);
  ops.push(...add(ctx, { kind: "notice", tone: "warn", text: !reason || reason === "interrupted" ? "Interrupted" : `Turn ended: ${reason}` }, at));
  return ops;
}

function compacted(p: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const msg = str(p.message);
  const summary = msg.replace(/^Another language model started to solve this problem[\s\S]*?use the information in this summary to assist with your own analysis:\s*/, "").trim();
  const ops: ChatOp[] = [];
  // the model's handoff summary arrived just before as an assistant message: it is the detail, not a reply
  const last = st.last;
  const t = last?.text.trim() ?? "";
  if (last && t && (msg.trimEnd().endsWith(t) || (t.length >= 200 && msg.includes(t.slice(0, 500))))) ops.push({ op: "remove", keys: [last.key] });
  st.last = undefined;
  st.compacted = true;
  const detail = summary || last?.text.trim();
  ops.push(...add(ctx, { kind: "notice", text: "Context compacted", divider: true, detail: detail ? clip(detail, 20000) : undefined }, at));
  return ops;
}

function compactionItem(ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  if (st.compacted) {
    st.compacted = false;
    return [];
  }
  return add(ctx, { kind: "notice", text: "Context compacted", divider: true }, at);
}

// Review mode (/review): built from codex's protocol (EnteredReviewMode, ExitedReviewMode{review_output}); not seen in real rollouts yet.
function reviewStart(p: any, ctx: ParseCtx, at?: string): ChatOp[] {
  const hint = str(p.user_facing_hint ?? p.review?.user_facing_hint ?? p.target?.instructions ?? "");
  return add(ctx, { kind: "notice", text: `Code review started${hint ? `: ${oneLine(hint, 120)}` : ""}`, divider: true }, at);
}

function reviewEnd(p: any, ctx: ParseCtx, at?: string): ChatOp[] {
  const r = p.review_output ?? p.review ?? p.output;
  const ops: ChatOp[] = [];
  if (r && typeof r === "object") {
    const lines: string[] = [];
    const verdict = str(r.overall_correctness);
    lines.push(`**Code review${verdict ? `: ${verdict}` : ""}**`);
    if (r.overall_explanation) lines.push("", str(r.overall_explanation));
    const findings = Array.isArray(r.findings) ? r.findings : [];
    findings.forEach((f: any, i: number) => {
      const loc = f?.code_location;
      const path = str(loc?.absolute_file_path);
      const range = loc?.line_range ? `:${loc.line_range.start}${loc.line_range.end && loc.line_range.end !== loc.line_range.start ? `-${loc.line_range.end}` : ""}` : "";
      const prio = typeof f?.priority === "number" ? `[P${f.priority}] ` : "";
      lines.push("", `${i + 1}. **${prio}${str(f?.title)}**${path ? ` — \`${path}${range}\`` : ""}`);
      if (f?.body) lines.push(`   ${str(f.body).replace(/\n/g, "\n   ")}`);
    });
    if (!findings.length && !r.overall_explanation) lines.push("", "No findings.");
    ops.push(...add(ctx, { kind: "text", text: lines.join("\n") }, at));
  }
  ops.push(...add(ctx, { kind: "notice", text: "Code review finished", divider: true }, at));
  return ops;
}

// ---------------------------------------------------------------------------------------------
// item_completed records

function item(it: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  switch (it.type) {
    case "CommandExecution":
      return commandItem(it, ctx, st, at);
    case "FileChange":
      return child(ctx, st, at, fileChangeBlock(it, st), undefined);
    case "ImageView": {
      const path = filePath(str(it.path));
      const id = str(it.id) || `view${ctx.n}`;
      const ops = child(ctx, st, at, { kind: "tool", id, name: "view_image", summary: rel(path, st), images: path ? [path] : undefined, done: true }, undefined);
      const own = owner(st);
      if (own) own[1].views.push(id);
      return ops;
    }
    case "McpToolCall":
      return mcpItem(it, ctx, st, at);
    case "SubAgentActivity": {
      const path = str(it.agent_path);
      if (it.kind === "started" && path && st.calls[it.id]) st.agents[path] = it.id;
      const row = st.agents[path];
      return it.kind === "completed" && row ? [{ op: "update", id: row, set: { done: true } }] : [];
    }
    case "ContextCompaction":
      return compactionItem(ctx, st, at);
    case "WebSearch": {
      // built from codex's protocol (TurnItem::WebSearch{query, action}); real rollouts have not shown one yet
      const q = webSearchSummary(it.action, it.query);
      return q ? add(ctx, { kind: "tool", id: str(it.id) || `ws${ctx.n}`, name: "web_search", summary: q, done: true }, at) : [];
    }
    case "EnteredReviewMode":
      return reviewStart(it, ctx, at);
    case "ExitedReviewMode":
      return reviewEnd(it, ctx, at);
  }
  return [];
}

/** The open call a record belongs to: one that runs this command, else the newest open call that runs tools. */
function owner(st: State, cmd?: string): [string, Call] | undefined {
  const open = Object.entries(st.calls).filter(([, c]) => c.container);
  if (cmd) {
    const hit = open.find(([, c]) => count(c.cmds, cmd) > count(c.seen, cmd));
    if (hit) return hit;
  }
  return open.at(-1);
}
const count = (list: string[], x: string) => list.reduce((n, y) => (y === x ? n + 1 : n), 0);

/** A row for a record, counted as one of its call's rows. */
function child(ctx: ParseCtx, st: State, at: string | undefined, block: ToolBlock, cmd: string | undefined, pid?: string): ChatOp[] {
  const own = owner(st, cmd);
  if (own) {
    own[1].children++;
    if (cmd !== undefined) own[1].seen.push(cmd);
    if (pid) own[1].pids.push(pid);
  }
  return add(ctx, block, at);
}

/** The shell command of a command array (["/bin/zsh", "-lc", "<script>"]). */
function shellText(cmd: unknown): string {
  if (!Array.isArray(cmd)) return str(cmd);
  const a = cmd.map(String);
  if (a.length >= 3 && /(^|\/)(ba|z|da|k|fi)?sh(\.exe)?$/.test(a[0]!) && /^-l?c$/.test(a[1]!)) return a.slice(2).join(" ");
  return a.join(" ");
}

/** One row per shell command: "read x" / "search y in z" / "list z" for exploring commands, else the command. */
function commandBlock(id: string, it: any, cmd: string): ToolBlock {
  const parsed: any[] = Array.isArray(it.parsed_cmd) ? it.parsed_cmd : [];
  const kinds = new Set(parsed.map((p) => p?.type));
  const exploring = parsed.length > 0 && [...kinds].every((k) => k === "read" || k === "search" || k === "list_files");
  const exit = typeof it.exit_code === "number" ? it.exit_code : undefined;
  const status = str(it.status);
  const noMatches = exploring && kinds.has("search") && exit === 1 && !str(it.aggregated_output).trim();
  const error = !noMatches && (status === "failed" || status === "declined" || (exit !== undefined && exit !== 0));
  const out = str(it.aggregated_output ?? it.formatted_output);
  const output = status === "declined" ? "declined" : clip(out.replace(/\s+$/, "")) + (exit && !noMatches ? `${out.trim() ? "\n" : ""}(exit ${exit})` : "");
  const base = { kind: "tool" as const, id, output: output || undefined, error, done: status !== "in_progress" };
  if (exploring) {
    const what = parsed.map((p) =>
      p.type === "read" ? str(p.name || p.path) : p.type === "search" ? `${str(p.query) || str(p.cmd)}${p.path ? ` in ${p.path}` : ""}` : str(p.path) || ".",
    );
    const name = kinds.size === 1 ? (kinds.has("read") ? "read" : kinds.has("search") ? "search" : "list") : "explore";
    return { ...base, name, summary: oneLine(what.join(", ")), input: cmd };
  }
  return { ...base, name: "bash", ...describeTool("bash", { command: cmd }) };
}

function commandItem(it: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const id = str(it.id) || `cmd${ctx.n}`;
  const cmd = shellText(it.command);
  const row = commandBlock(id, it, cmd);
  const pid = it.process_id !== undefined && it.process_id !== null ? String(it.process_id) : undefined;
  const { kind: _k, id: _i, ...fields } = row;
  // the record of a call made directly (not from a code-mode cell): the call's own row
  const call = st.calls[id];
  if (call) {
    call.self = true;
    return [{ op: "update", id, set: fields }];
  }
  // a background terminal that finished: the row it already has
  const bg = pid ? st.procs[pid] : undefined;
  if (pid && bg) {
    delete st.procs[pid];
    delete st.procOut[pid];
    return [{ op: "update", id: bg, set: { ...fields, done: true } }];
  }
  return child(ctx, st, at, row, cmd, pid);
}

const filePath = (p: string) => {
  if (!p.startsWith("file://")) return p;
  try {
    return decodeURIComponent(p.slice(7));
  } catch {
    return p.slice(7);
  }
};
/** A path as the user would say it: relative to the session's folder when inside it. */
const rel = (p: string, st: State) => (st.cwd && p.startsWith(`${st.cwd}/`) ? p.slice(st.cwd.length + 1) : p);

const contentLines = (s: string) => {
  const l = s.split("\n");
  if (l.at(-1) === "") l.pop();
  return l;
};

/** "Edited path (+N −M)": a unified diff per file, with ---/+++ headers. */
function fileChangeBlock(it: any, st: State): ToolBlock {
  const raw = it.changes;
  // {path: {type: add|update|delete, …}}; older codex: {path: {add: {content}} | {update: {unified_diff, move_path}} | {delete: {}}}
  const list: [string, any][] = Array.isArray(raw) ? raw.map((c: any) => [str(c?.path), c]) : Object.entries(raw && typeof raw === "object" ? raw : {});
  const parts: string[] = [];
  const files: string[] = [];
  let plus = 0;
  let minus = 0;
  const kinds = new Set<string>();
  for (const [path, ch] of list) {
    const kind = str(ch?.type ?? ch?.kind?.type ?? (ch?.add ? "add" : ch?.update ? "update" : ch?.delete ? "delete" : ""));
    const d = ch?.add ?? ch?.update ?? ch?.delete ?? ch ?? {};
    const name = rel(path, st);
    kinds.add(kind);
    if (kind === "add") {
      const lines = contentLines(str(d.content));
      plus += lines.length;
      parts.push(`--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@${lines.length ? `\n${lines.map((l) => `+${l}`).join("\n")}` : ""}`);
      files.push(name);
    } else if (kind === "delete") {
      const lines = contentLines(str(d.content));
      minus += lines.length;
      parts.push(`--- a/${name}\n+++ /dev/null${lines.length ? `\n@@ -1,${lines.length} +0,0 @@\n${lines.map((l) => `-${l}`).join("\n")}` : ""}`);
      files.push(name);
    } else {
      const diff = str(d.unified_diff ?? d.diff).replace(/\n$/, "");
      const to = d.move_path ? rel(str(d.move_path), st) : undefined;
      for (const l of diff.split("\n")) {
        if (l.startsWith("+") && !l.startsWith("+++")) plus++;
        else if (l.startsWith("-") && !l.startsWith("---")) minus++;
      }
      parts.push(/^--- /.test(diff) ? diff : `--- a/${name}\n+++ b/${to ?? name}${diff ? `\n${diff}` : ""}`);
      files.push(to ? `${name} → ${to}` : name);
    }
  }
  let patch = parts.join("\n");
  if (patch.length > MAX_PATCH) {
    const cut = patch.lastIndexOf("\n", MAX_PATCH);
    patch = `${patch.slice(0, cut > 0 ? cut : MAX_PATCH)}\n… (${patch.length - MAX_PATCH} more characters)`;
  }
  const counts = `(+${plus} −${minus})`;
  const names = files.length > 3 ? `${files.slice(0, 3).join(", ")} and ${files.length - 3} more` : files.join(", ");
  const status = str(it.status);
  const error = status === "failed" || status === "declined";
  const stderr = str(it.stderr).trim();
  const only = kinds.size === 1 ? [...kinds][0] : undefined;
  const verb = only === "add" ? "added" : only === "delete" ? "deleted" : "";
  return {
    kind: "tool",
    id: str(it.id) || `edit${files.join(",")}`,
    name: "edit",
    summary: `${names || "files"} ${verb && files.length === 1 ? `(${verb}, ${counts.slice(1)}` : counts}`,
    patch: patch || undefined,
    files: files.map((f) => f.split(" → ").at(-1)!),
    output: stderr || (error ? str(it.stdout).trim() || status : undefined),
    error,
    done: true,
  };
}

/** Text and images of an MCP result ({content: [{type: text|image, …}], isError}). */
function mcpContent(res: any): { text: string; images: string[] } {
  const content = Array.isArray(res?.content) ? res.content : [];
  const images: string[] = [];
  const texts: string[] = [];
  for (const c of content) {
    if (c?.type === "text") texts.push(str(c.text));
    else if (c?.type === "image" && typeof c.data === "string") keepImage(images, `data:${c.mimeType ?? c.mime_type ?? "image/png"};base64,${c.data}`);
  }
  return { text: texts.join("\n"), images };
}

function mcpItem(it: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const title = it.arguments && typeof it.arguments === "object" ? str(it.arguments.title) : "";
  const summary = `${str(it.server) || "mcp"} · ${str(it.tool)}${title ? ` — ${oneLine(title, 100)}` : ""}`;
  const error = it.status === "failed" || !!it.result?.isError;
  const call = st.calls[it.id];
  if (call) {
    // the record of a direct MCP call (cua_repl's js): its output comes as the call's output
    call.error = error;
    return [{ op: "update", id: it.id, set: { name: "mcp", summary } }];
  }
  const { text, images } = mcpContent(it.result);
  const input = it.arguments && typeof it.arguments === "object" ? str(it.arguments.code ?? (Object.keys(it.arguments).length ? it.arguments : "")) : "";
  return child(ctx, st, at, { kind: "tool", id: str(it.id) || `mcp${ctx.n}`, name: "mcp", summary, input: input || undefined, output: clip(text) || undefined, images: images.length ? images : undefined, error, done: true }, undefined);
}

// ---------------------------------------------------------------------------------------------
// response_item

function responseItem(p: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  switch (p.type) {
    case "message":
      if (p.role === "assistant") return assistantText(textOf(p.content), ctx, st, at);
      if (p.role === "user") return userMessage(p.content, ctx, st, at);
      return [];
    case "reasoning": {
      const summary = (Array.isArray(p.summary) ? p.summary : []).map((s: any) => str(s?.text)).filter((s: string) => s.trim() && !isEncrypted(s));
      const text = summary.length ? summary.join("\n\n") : (Array.isArray(p.content) ? p.content : []).map((c: any) => str(c?.text)).join("");
      return text.trim() && !isEncrypted(text) ? add(ctx, { kind: "thinking", text }, at) : [];
    }
    case "function_call":
      return functionCall(p, ctx, st, at);
    case "custom_tool_call":
      return customToolCall(p, ctx, st, at);
    case "local_shell_call": {
      const id = str(p.call_id ?? p.id);
      return open(ctx, st, at, id, tool(id, "bash", { command: p.action?.command }), { kind: "command", container: true, cmds: [shellText(p.action?.command)] });
    }
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output":
      return finish(str(p.call_id), p.output, ctx, st, at);
    case "agent_message":
      return agentMessage(p, ctx, st, at);
    case "web_search_call": {
      const q = webSearchSummary(p.action, p.query);
      return add(ctx, { kind: "tool", id: str(p.id ?? p.call_id) || `ws${ctx.n}`, name: "web_search", summary: q || "web search", done: p.status !== "in_progress" }, at);
    }
    case "image_generation_call": {
      // built from codex's protocol; not seen in real rollouts yet
      const images: string[] = [];
      if (typeof p.result === "string" && p.result) keepImage(images, p.result.startsWith("data:") ? p.result : `data:image/png;base64,${p.result}`);
      return add(ctx, { kind: "tool", id: str(p.id) || `img${ctx.n}`, name: "image_gen", summary: oneLine(str(p.revised_prompt)) || "image", images: images.length ? images : undefined, done: p.status !== "in_progress" }, at);
    }
  }
  return [];
}

function webSearchSummary(action: any, query?: unknown): string {
  if (action?.type === "open_page") return `open ${str(action.url)}`;
  if (action?.type === "find_in_page") return `find "${str(action.pattern)}" in ${str(action.url)}`;
  const qs = Array.isArray(action?.queries) && action.queries.length ? action.queries.map(String) : [str(action?.query ?? query)];
  return oneLine(qs.filter(Boolean).join(" · "));
}

/** Assistant prose; a `<proposed_plan>` block (Plan mode) is its own block, as the TUI's "Proposed Plan". */
function assistantText(text: string, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  if (!text.trim()) return [];
  const m = text.match(/<proposed_plan>\s*([\s\S]*?)\s*(?:<\/proposed_plan>|$)/);
  if (!m) {
    const ops = add(ctx, { kind: "text", text }, at);
    st.last = { key: (ops[0] as any).entry.key, text };
    return ops;
  }
  const before = text.slice(0, m.index).trim();
  const after = text.slice(m.index! + m[0].length).trim();
  return [
    ...(before ? add(ctx, { kind: "text", text: before }, at) : []),
    ...add(ctx, { kind: "text", text: `**Proposed plan**\n\n${m[1]}` }, at),
    ...(after ? add(ctx, { kind: "text", text: after }, at) : []),
  ];
}

function keepImage(list: string[], url: string | undefined) {
  if (url && url.length <= MAX_IMAGE) list.push(url);
}

function userMessage(content: unknown, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const parts: any[] = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "input_text", text: content }] : [];
  // images: <image name=[Image #1] path="…"> + input_image + </image>; one too large to keep is shown by its path
  const images: string[] = [];
  let path = "";
  let text = "";
  for (const c of parts) {
    if (c?.type === "input_image") {
      const url = typeof c.image_url === "string" ? c.image_url : "";
      if (url && url.length <= MAX_IMAGE) images.push(url);
      else if (path) images.push(path);
      path = "";
    } else if (typeof c?.text === "string" || typeof c === "string") {
      const t = typeof c === "string" ? c : c.text;
      if (/^\s*<image\b[^>]*>\s*$/.test(t)) path = t.match(/\bpath="([^"]*)"/)?.[1] ?? "";
      else if (!/^\s*<\/image>\s*$/.test(t)) text += t;
    }
  }
  text = text.replace(/<image\b[^>]*>|<\/image>/g, "");
  const t = text.trim();
  if (t.startsWith("<send_user_message_question_reply>")) return answers(t, ctx, at);
  // codex desktop wraps what the user typed: attached files, app state, then "## My request:"
  const req = text.match(/\n## My request(?: for Codex)?:\n([\s\S]*)$/);
  if (req) {
    const files = [...text.slice(0, req.index).matchAll(/^## ([^\n]+?): ([^\n]+)\n(?!Image attachment: true)/gm)].map((f) => f[1]!);
    text = req[1]!.trim() + (files.length ? `\n\nFiles: ${files.join(", ")}` : "");
  } else if (CODEX_INJECTED.test(t)) return [];
  const b = userOrNotice(text);
  if (b?.kind === "user") return add(ctx, images.length ? { ...b, images } : b, at);
  if (!b && images.length) return add(ctx, { kind: "user", text: "", images }, at);
  return add(ctx, b, at);
}

/** The user's answers to request_user_input_async questions: "answered: …", on the question's row and as their message. */
function answers(t: string, ctx: ParseCtx, at?: string): ChatOp[] {
  const inner = t.replace(/^<send_user_message_question_reply>\s*/, "").replace(/\s*<\/send_user_message_question_reply>\s*$/, "");
  let list: any[] = [];
  try {
    const v = JSON.parse(inner);
    list = Array.isArray(v) ? v : [v];
  } catch {}
  if (!list.length) return add(ctx, { kind: "user", text: `answered: ${inner}` }, at);
  const byCall = new Map<string, string[]>();
  const lines = list.map((a) => {
    const answer = Array.isArray(a?.answer) ? a.answer.map(String).join(", ") : str(a?.answer ?? a?.answers);
    const line = list.length > 1 && a?.question ? `answered “${oneLine(str(a.question), 80)}”: ${answer}` : `answered: ${answer}`;
    let call: unknown;
    try {
      call = JSON.parse(str(a?.questionItemId))[1];
    } catch {}
    if (typeof call === "string") byCall.set(call, [...(byCall.get(call) ?? []), line]);
    return line;
  });
  const ops: ChatOp[] = [...byCall].map(([id, l]) => ({ op: "update" as const, id, set: { output: l.join("\n"), done: true } }));
  return [...ops, ...add(ctx, { kind: "user", text: lines.join("\n") }, at)];
}

/** Strings that are encrypted payloads, replaced so they never show as a summary or input. */
const scrub = (v: any, d = 0): any =>
  typeof v === "string"
    ? isEncrypted(v)
      ? "(encrypted)"
      : v
    : Array.isArray(v)
      ? v.map((x) => scrub(x, d + 1))
      : v && typeof v === "object" && d < 6
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, d + 1)]))
        : v;
const plain = (v: unknown) => (typeof v === "string" && v.trim() && !isEncrypted(v) ? v : "");

/** Registers a call (it ends with its output) and adds its row. */
function open(ctx: ParseCtx, st: State, at: string | undefined, id: string, block: ToolBlock, c: Partial<Call> & Pick<Call, "kind">): ChatOp[] {
  const ops = add(ctx, block, at);
  st.calls[id] = { key: (ops[0] as any).entry.key, container: false, cmds: [], seen: [], children: 0, views: [], pids: [], pollsOnly: false, polls: [], ...c };
  return ops;
}

function questionsReport(qs: any[]): string {
  return qs
    .map((q) => {
      const title = str(q?.title ?? q?.question ?? q?.header ?? q?.prompt);
      const opts = Array.isArray(q?.options) ? q.options.map((o: any) => (typeof o === "string" ? o : `${str(o?.label ?? o?.title ?? o?.value)}${o?.description ? ` — ${o.description}` : ""}`)) : [];
      return [title, ...opts.map((o: string) => `- ${o}`)].join("\n");
    })
    .join("\n\n");
}

function planReport(plan: unknown): { report: string; summary: string } {
  const steps = Array.isArray(plan) ? plan : [];
  const report = steps.map((s: any) => (s?.status === "completed" ? `- [x] ${str(s?.step)}` : s?.status === "in_progress" ? `- [ ] **${str(s?.step)}**` : `- [ ] ${str(s?.step)}`)).join("\n");
  const done = steps.filter((s: any) => s?.status === "completed").length;
  const now = steps.find((s: any) => s?.status === "in_progress");
  return { report, summary: `${done}/${steps.length} done${now ? ` — ${oneLine(str(now.step), 100)}` : ""}` };
}

function functionCall(p: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const id = str(p.call_id ?? p.id);
  const name = str(p.name) || "tool";
  const ns = str(p.namespace);
  let args: any = p.arguments;
  try {
    args = JSON.parse(p.arguments);
  } catch {}
  const a = args && typeof args === "object" ? args : {};
  const row = (fields: Omit<ToolBlock, "kind" | "id" | "done"> & { done?: boolean }): ToolBlock => ({ kind: "tool", id, done: false, ...fields });
  switch (name) {
    case "request_user_input":
    case "request_user_input_async": {
      const qs = Array.isArray(a.questions) ? a.questions : [];
      const first = str(qs[0]?.title ?? qs[0]?.question ?? qs[0]?.header);
      return open(ctx, st, at, id, row({ name: "question", summary: `${oneLine(first, 140)}${qs.length > 1 ? ` (+${qs.length - 1} more)` : ""}`, report: questionsReport(qs) || undefined }), { kind: "question" });
    }
    case "spawn_agent": {
      const task = plain(a.message ?? a.prompt ?? a.task ?? a.instructions);
      const who = str(a.task_name ?? a.name ?? a.agent_type);
      const path = who && !who.startsWith("/") ? `/root/${who}` : who;
      return open(ctx, st, at, id, row({ name: "spawn_agent", summary: `${path || "subagent"}${task ? ` — ${oneLine(task, 100)}` : ""}`, input: task.length > 100 ? task : undefined, background: true }), { kind: "spawn" });
    }
    case "send_message":
    case "send_input":
    case "followup_task": {
      const msg = plain(a.message ?? a.input ?? a.prompt);
      const to = str(a.target ?? a.task_name ?? a.agent ?? a.id);
      return open(ctx, st, at, id, row({ name: "send_message", summary: `to ${to || "subagent"}${msg ? ` — ${oneLine(msg, 100)}` : ""}`, input: msg.length > 100 ? msg : undefined }), { kind: "other" });
    }
    case "update_plan": {
      const { report, summary } = planReport(a.plan);
      return open(ctx, st, at, id, row({ name: "plan", summary: a.explanation ? `${summary} · ${oneLine(str(a.explanation), 80)}` : summary, report: report || undefined }), { kind: "other" });
    }
    case "exec_command": {
      const cmd = str(a.cmd ?? a.command);
      return open(ctx, st, at, id, row({ name: "bash", ...describeTool("bash", { command: cmd }) }), { kind: "command", container: true, cmds: [cmd] });
    }
    case "shell":
    case "container.exec":
    case "local_shell":
      return open(ctx, st, at, id, tool(id, name, args), { kind: "command", container: true, cmds: [shellText(a.command)] });
    case "write_stdin": {
      const sid = a.session_id !== undefined ? String(a.session_id) : "";
      if (a.chars) return open(ctx, st, at, id, row({ name: "terminal", summary: `typed ${JSON.stringify(oneLine(str(a.chars), 60))}` }), { kind: "other", container: true, polls: [sid] });
      return open(ctx, st, at, id, row({ name: "terminal", summary: "waited for background terminal" }), { kind: "other", container: true, pollsOnly: true, polls: [sid] });
    }
    case "view_image":
    case "apply_patch":
      return open(ctx, st, at, id, tool(id, name, args), { kind: "other", container: true });
    case "sleep":
      if (typeof a.duration_ms === "number") return open(ctx, st, at, id, row({ name: "sleep", summary: `${Math.round(a.duration_ms / 100) / 10}s` }), { kind: "other" });
      break;
    case "wait":
      // waits on a code-mode cell that yielded; what the cell runs arrives as records meanwhile
      if (a.cell_id !== undefined) return open(ctx, st, at, id, row({ name: "wait", summary: `for cell ${str(a.cell_id)}` }), { kind: "other", container: true });
      break;
  }
  const server = ns.startsWith("mcp__") ? ns.slice(5) : name.startsWith("mcp__") ? name.slice(5).split("__")[0]! : "";
  if (server) {
    const toolName = name.startsWith("mcp__") ? name.slice(5).split("__").slice(1).join("__") || name : name;
    const title = str(a.title);
    const input = str(a.code ?? (Object.keys(a).length ? scrub(a) : ""));
    return open(ctx, st, at, id, row({ name: "mcp", summary: `${server} · ${toolName}${title ? ` — ${oneLine(title, 100)}` : ""}`, input: input || undefined }), { kind: "mcp" });
  }
  return open(ctx, st, at, id, tool(id, name, scrub(args)), { kind: "other" });
}

function customToolCall(p: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const id = str(p.call_id ?? p.id);
  const input = str(p.input);
  if (p.name === "exec") return execCall(id, input, ctx, st, at);
  if (p.name === "apply_patch") return open(ctx, st, at, id, tool(id, "apply_patch", input), { kind: "other", container: true });
  return open(ctx, st, at, id, tool(id, str(p.name) || "tool", isEncrypted(input) ? "" : input), { kind: "other" });
}

/** A code-mode cell: a row while it runs, named after what it calls. */
function execCall(id: string, script: string, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const calls = scriptCalls(script);
  const fns = calls.map((c) => c.fn);
  const argOf = (c: ScriptCall) => (c.arg && typeof c.arg === "object" ? (c.arg as any) : {});
  const cmds = calls.filter((c) => c.fn === "exec_command").map((c) => str(argOf(c).cmd ?? argOf(c).command));
  const polls = calls.filter((c) => c.fn === "write_stdin");
  let block: ToolBlock;
  if (cmds.length) {
    const first = cmds.find(Boolean) ?? "";
    const more = cmds.length > 1 ? ` (+${cmds.length - 1} more)` : "";
    const d = describeTool("bash", { command: first });
    block = { kind: "tool", id, name: "bash", done: false, summary: `${oneLine(first, 140)}${more}`, input: cmds.length > 1 ? cmds.join("\n\n") : d.input };
  } else if (fns.includes("apply_patch")) {
    const patch = calls.find((c) => c.fn === "apply_patch")!.arg;
    block = tool(id, "apply_patch", typeof patch === "string" ? patch : (argOf(calls.find((c) => c.fn === "apply_patch")!).input ?? script));
  } else if (fns.includes("view_image")) {
    const paths = calls.filter((c) => c.fn === "view_image").map((c) => rel(str(argOf(c).path), st));
    block = { kind: "tool", id, name: "view_image", done: false, summary: oneLine(paths.join(", ")) };
  } else if (polls.length && polls.length === fns.length) {
    block = { kind: "tool", id, name: "terminal", done: false, summary: "waited for background terminal" };
  } else if (fns.some((f) => f.startsWith("mcp__"))) {
    const f = fns.find((x) => x.startsWith("mcp__"))!.slice(5).split("__");
    block = { kind: "tool", id, name: "mcp", done: false, summary: `${f[0]} · ${f.slice(1).join("__")}` };
  } else if (fns.length) {
    const c = calls[0]!;
    block = { kind: "tool", id, done: false, name: c.fn, ...describeTool(c.fn, scrub(c.arg ?? {})) };
  } else {
    const first = script.split("\n").find((l) => l.trim() && !/^\s*\/\//.test(l)) ?? script;
    block = { kind: "tool", id, name: "js", done: false, summary: oneLine(first, 140), input: script };
  }
  const ops = open(ctx, st, at, id, block, {
    kind: "exec",
    container: true,
    cmds,
    pollsOnly: calls.length > 0 && calls.every((c) => c.fn === "write_stdin" && !argOf(c).chars),
    polls: polls.map((c) => str(argOf(c).session_id)).filter(Boolean),
  });
  const call = st.calls[id]!;
  // what the cell does that no record reports: typing into a background terminal, a plan update
  calls.forEach((c, i) => {
    const a = argOf(c);
    if (c.fn === "write_stdin" && a.chars) {
      call.children++;
      ops.push(...add(ctx, { kind: "tool", id: `${id}#in${i}`, name: "terminal", summary: `typed ${JSON.stringify(oneLine(str(a.chars), 60))}`, done: true }, at));
    } else if (c.fn === "update_plan" && Array.isArray(a.plan)) {
      call.children++;
      const { report, summary } = planReport(a.plan);
      ops.push(...add(ctx, { kind: "tool", id: `${id}#plan${i}`, name: "plan", summary, report, done: true }, at));
    }
  });
  return ops;
}

/** A subagent's message: its final answer is the report on the row that spawned it; encrypted payloads are not shown. */
function agentMessage(p: any, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const parts: any[] = Array.isArray(p.content) ? p.content : [];
  const text = parts
    .filter((c) => c?.type === "input_text" || c?.type === "output_text" || c?.type === "text")
    .map((c) => str(c.text))
    .join("");
  const type = text.match(/^Message Type: (\S+)/m)?.[1] ?? "";
  const sender = text.match(/^Sender: (\S+)/m)?.[1] ?? str(p.author);
  const pi = text.indexOf("Payload:\n");
  const payload = (pi >= 0 ? text.slice(pi + 9) : type ? "" : text).trim();
  const readable = payload && !isEncrypted(payload) ? payload : "";
  if (type === "FINAL_ANSWER" || type === "FINAL") {
    if (!readable) return [];
    const row = st.agents[sender];
    if (row) return [{ op: "update", id: row, set: { report: readable, done: true } }];
    return add(ctx, { kind: "tool", id: str(p.id) || `agent${ctx.n}`, name: "spawn_agent", summary: `${sender || "subagent"} — final answer`, report: readable, done: true }, at);
  }
  if (type === "NEW_TASK") return add(ctx, { kind: "notice", text: `Task from ${sender || "the parent agent"}`, detail: readable || undefined }, at);
  return readable ? add(ctx, { kind: "notice", text: `Message from ${sender || "a subagent"}`, detail: readable }, at) : [];
}

// ---------------------------------------------------------------------------------------------
// Tool outputs

interface Out {
  text: string;
  images: string[];
  /** A command record or MCP result failed, or the call reported failure. */
  error: boolean;
  /** The script itself failed ("Script failed", "Script error: …"). */
  failed: boolean;
  aborted: boolean;
  /** Commands still running when the cell returned: background terminal sessions. */
  running: { sid: string; output: string }[];
  exits: number[];
  json?: any;
}

/** Records codex wraps around a value: Promise.allSettled's {status, value}, the model's own {index, result}. */
const WRAP = new Set(["index", "i", "idx", "page", "label", "name", "key", "id", "path", "cmd"]);
function unwrap(r: any): any {
  for (let k = 0; k < 6; k++) {
    if (!r || typeof r !== "object" || Array.isArray(r)) break;
    const keys = Object.keys(r);
    if ("result" in r && keys.every((x) => x === "result" || WRAP.has(x))) r = r.result;
    else if ("value" in r && r.status === "fulfilled") r = r.value;
    else if (r.status === "fulfilled" && keys.every((x) => x === "status" || WRAP.has(x))) return "";
    else if (r.status === "rejected" && "reason" in r) return { rejected: str(r.reason) };
    else break;
  }
  return r;
}

const tryJson = (s: string): any => {
  const t = s.trim();
  if (!/^[[{]/.test(t)) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The text of one record the cell printed. */
function recordText(r: any, raw: string, o: Out, single: boolean): string {
  const v = unwrap(r);
  if (v === "") return "";
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if ("rejected" in v && Object.keys(v).length === 1) {
      o.error = true;
      return str(v.rejected);
    }
    const exit = typeof v.exit_code === "number" ? v.exit_code : typeof v.metadata?.exit_code === "number" ? v.metadata.exit_code : undefined;
    if (typeof v.output === "string" && (exit !== undefined || "session_id" in v || "chunk_id" in v || "wall_time_seconds" in v)) {
      const out = v.output.replace(/\s+$/, "");
      if (exit === undefined && v.session_id !== undefined && v.session_id !== null) {
        o.running.push({ sid: String(v.session_id), output: out });
        return out;
      }
      if (exit !== undefined) {
        o.exits.push(exit);
        if (exit !== 0) o.error = true;
      }
      return out + (exit ? `${out ? "\n" : ""}(exit ${exit})` : "");
    }
    if (Array.isArray(v.content) && ("isError" in v || v.content.every((c: any) => c && typeof c === "object" && "type" in c))) {
      const m = mcpContent(v);
      o.images.push(...m.images);
      if (v.isError) o.error = true;
      return m.text;
    }
    if (!Object.keys(v).length) return ""; // apply_patch's {}
  }
  if (single) o.json = v;
  return raw.trim();
}

const BANNER = /^Script (completed|failed|running)[^\n]*\n(?:Wall time[^\n]*\n)?(?:Output:\n?)?/;
const WALL = /^(?:Chunk ID: [^\n]*\n)?Wall time:? [\d.]+ seconds\n(?:Process exited with code (-?\d+)\n)?(?:Process running with session ID (\d+)\n)?(?:Original token count: \d+\n)?(?:Output:\n?)?/;
const TRUNCATED = /^Warning: truncated output \(original token count: \d+\)\n(?:Total output lines: \d+\n)?\n?/;

/** A tool output without codex's wrapping: banners, JSON records, Promise.allSettled results, images. */
function readOutput(raw: unknown): Out {
  const o: Out = { text: "", images: [], error: false, failed: false, aborted: false, running: [], exits: [] };
  let parts: any[];
  if (typeof raw === "string") parts = [raw];
  else if (Array.isArray(raw)) parts = raw;
  else if (raw && typeof raw === "object") {
    const r = raw as any;
    parts = Array.isArray(r.content) ? r.content : [str(r.content ?? r.output ?? "")];
    if (r.success === false) o.error = true;
  } else parts = [];
  const texts: string[] = [];
  let first = true;
  for (const c of parts) {
    if (c?.type === "input_image" || c?.type === "image") {
      keepImage(o.images, typeof c.image_url === "string" ? c.image_url : typeof c.data === "string" ? `data:${c.mimeType ?? c.mime_type ?? "image/png"};base64,${c.data}` : undefined);
      continue;
    }
    let t: string | undefined = typeof c === "string" ? c : typeof c?.text === "string" ? c.text : undefined;
    if (t === undefined) continue;
    if (first) {
      first = false;
      const b = t.match(BANNER);
      if (b) {
        if (b[1] === "failed") o.failed = o.error = true;
        t = t.slice(b[0].length);
      } else {
        const w = t.match(WALL);
        if (w) {
          if (w[1] !== undefined) {
            const exit = Number(w[1]);
            o.exits.push(exit);
            if (exit !== 0) o.error = true;
          }
          t = t.slice(w[0].length);
          if (w[2] !== undefined) o.running.push({ sid: w[2], output: t.replace(/\s+$/, "") });
        }
      }
      if (/^aborted by user\b/.test(t)) o.aborted = true;
    }
    if (/^Script error:/.test(t)) o.failed = o.error = true;
    t = t.replace(TRUNCATED, "");
    if (!t.trim()) continue;
    const whole = tryJson(t);
    if (whole !== undefined) {
      texts.push(recordText(whole, t, o, parts.length <= 2));
      continue;
    }
    const lines = t.split("\n").filter((l) => l.trim());
    const recs = lines.length > 1 ? lines.map(tryJson) : [];
    if (recs.length && recs.every((r) => r !== undefined)) recs.forEach((r, i) => texts.push(recordText(r, lines[i]!, o, false)));
    else texts.push(t.replace(/\s+$/, ""));
  }
  o.text = texts.filter((t) => t !== "").join("\n");
  return o;
}

/** A call's output: the result on its row, or the rows of its records instead of it. */
function finish(id: string, raw: unknown, ctx: ParseCtx, st: State, at?: string): ChatOp[] {
  const c = st.calls[id];
  delete st.calls[id];
  const o = readOutput(raw);
  const result = (over: Partial<Extract<ChatOp, { op: "result" }>> = {}): ChatOp => ({
    op: "result",
    id,
    output: clip(o.text),
    error: o.error,
    ...(o.images.length ? { images: o.images } : {}),
    ...over,
  });
  if (o.aborted) return [result({ error: false }), { op: "update", id, set: { aborted: true } }];
  if (!c) return [result()];
  if (c.self) return o.images.length ? [{ op: "update", id, set: { images: o.images } }] : [];
  switch (c.kind) {
    case "question": {
      // async: {"accepted":true}, the answer comes later as a user message; sync: the answers
      if (o.json?.accepted !== undefined) return [result({ output: "" })];
      const ans = o.json?.answers;
      if (ans && typeof ans === "object") {
        const list = Object.values(ans).map((x: any) => (Array.isArray(x?.answers) ? x.answers.join(", ") : str(x)));
        return [result({ output: list.map((x) => `answered: ${x}`).join("\n") })];
      }
      return [result()];
    }
    case "spawn": {
      const path = str(o.json?.task_name ?? o.json?.agent_path ?? o.json?.path);
      if (path) st.agents[path] = id;
      return [result({ output: o.json ? "" : o.text, background: true })];
    }
    case "mcp":
      return [result({ error: o.error || !!c.error })];
  }
  if (Array.isArray(o.json?.agents))
    return [result({ output: o.json.agents.map((x: any) => `${str(x?.agent_name ?? x?.name)}: ${str(x?.agent_status ?? x?.status)}`).join("\n") })];
  if (!c.container) return [result()];

  const ops: ChatOp[] = [];
  // background terminals this call polled: their new output
  for (const r of o.running) {
    const row = st.procs[r.sid];
    if (row && r.output) {
      // a running terminal's newest output matters most: keep the end
      const all = `${st.procOut[r.sid] ? `${st.procOut[r.sid]}\n` : ""}${r.output}`;
      st.procOut[r.sid] = all.length > MAX_OUTPUT ? `…${all.slice(-MAX_OUTPUT)}` : all;
      ops.push({ op: "update", id: row, set: { output: st.procOut[r.sid] } });
    }
  }
  // a direct poll whose terminal exited (no record will come in older codex)
  if (c.polls.length === 1 && o.exits.length && st.procs[c.polls[0]!]) {
    const row = st.procs[c.polls[0]!]!;
    delete st.procs[c.polls[0]!];
    ops.push({ op: "update", id: row, set: { output: clip(o.text), error: o.error, done: true } });
  }
  const fresh = o.running.filter((r) => !st.procs[r.sid] && !c.pids.includes(r.sid) && !c.polls.includes(r.sid));
  // one command that keeps running in the background: the call's row is its row
  if (!c.children && c.cmds.length <= 1 && fresh.length === 1 && !o.failed) {
    const r = fresh[0]!;
    st.procs[r.sid] = id;
    st.procOut[r.sid] = clip(r.output);
    return [...ops, result({ output: st.procOut[r.sid], error: false, background: true })];
  }
  // nothing reported its commands (older codex, or JS only): the call's row shows the output
  if (!c.children && !fresh.length && !c.pollsOnly) return [...ops, result()];
  const left = [...c.cmds];
  for (const s of c.seen) {
    const i = left.indexOf(s);
    if (i >= 0) left.splice(i, 1);
  }
  fresh.forEach((r, i) => {
    const row = `${id}#${r.sid}`;
    st.procs[r.sid] = row;
    st.procOut[r.sid] = clip(r.output);
    const cmd = left[i] ?? "";
    ops.push(
      ...add(ctx, { kind: "tool", id: row, name: "bash", ...(cmd ? describeTool("bash", { command: cmd }) : { summary: `background terminal ${r.sid}` }), output: r.output || undefined, background: true, done: false }, at),
    );
  });
  // viewed images: the pictures come in the cell's output, in order
  const imgs = [...o.images];
  for (const v of c.views) {
    const img = imgs.shift();
    if (!img) break;
    ops.push({ op: "update", id: v, set: { images: [img] } });
  }
  // a failed script, or pictures nobody else shows, keep the call's row
  if (o.failed || imgs.length) return [...ops, result({ images: imgs.length ? imgs : undefined })];
  return [...ops, { op: "remove", keys: [c.key] }];
}

// ---------------------------------------------------------------------------------------------
// Reading a code-mode cell: the tools.<fn>(…) calls in its JavaScript, with their arguments when those are literals

export interface ScriptCall {
  fn: string;
  /** The first argument when it is a plain literal (strings, numbers, objects, arrays); else undefined. */
  arg: unknown;
}

const IDENT = /[A-Za-z_$]/;

function skipString(s: string, i: number): number {
  const q = s[i];
  i++;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === q) return i + 1;
    else if (q === "`" && c === "$" && s[i + 1] === "{") i = skipBraces(s, i + 1);
    else if (c === "\n" && q !== "`") return i;
    else i++;
  }
  return i;
}

function skipBraces(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(s, i);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
    i++;
  }
  return i;
}

function skipRegex(s: string, i: number): number {
  let cls = false;
  for (i++; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "\n") return i;
    else if (cls) cls = c !== "]";
    else if (c === "[") cls = true;
    else if (c === "/") {
      i++;
      while (i < s.length && /[a-z]/i.test(s[i]!)) i++;
      return i;
    }
  }
  return i;
}

/** A JavaScript literal at a position, or a throw when it is not one. */
class Literal {
  constructor(
    private s: string,
    public i: number,
  ) {}
  private ws() {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
      if (this.s.startsWith("//", this.i)) this.i = this.s.indexOf("\n", this.i) < 0 ? this.s.length : this.s.indexOf("\n", this.i);
      else if (this.s.startsWith("/*", this.i)) this.i = this.s.indexOf("*/", this.i) < 0 ? this.s.length : this.s.indexOf("*/", this.i) + 2;
      else return;
    }
  }
  value(depth = 0): unknown {
    if (depth > 20) throw new Error("too deep");
    this.ws();
    const c = this.s[this.i];
    let v: unknown;
    if (c === "{") v = this.object(depth);
    else if (c === "[") v = this.array(depth);
    else if (c === '"' || c === "'" || c === "`") {
      let t = this.string();
      // "a" + "b"
      for (;;) {
        this.ws();
        if (this.s[this.i] !== "+") break;
        this.i++;
        this.ws();
        const n = this.s[this.i];
        if (n !== '"' && n !== "'" && n !== "`") throw new Error("not a literal");
        t += this.string();
      }
      v = t;
    } else {
      const m = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|true|false|null|undefined)(?![\w$])/i.exec(this.s.slice(this.i, this.i + 40));
      if (!m) throw new Error("not a literal");
      this.i += m[0].length;
      v = m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" || m[0] === "undefined" ? null : Number(m[0]);
    }
    return v;
  }
  /** A property's value; one that is not a literal (a variable, a call) is skipped and left undefined. */
  private member(depth: number): unknown {
    const start = this.i;
    try {
      const v = this.value(depth + 1);
      this.ws();
      const n = this.s[this.i];
      if (n === "," || n === "}" || n === "]") return v;
    } catch {}
    this.i = start;
    this.skipExpr();
    return undefined;
  }
  private skipExpr() {
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === '"' || c === "'" || c === "`") {
        this.i = skipString(this.s, this.i);
        continue;
      }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) return;
        depth--;
      } else if (c === "," && depth === 0) return;
      this.i++;
    }
  }
  private object(depth: number) {
    this.i++;
    const o: Record<string, unknown> = {};
    for (;;) {
      this.ws();
      if (this.s[this.i] === "}") {
        this.i++;
        return o;
      }
      const q = this.s[this.i];
      let key: string;
      if (q === '"' || q === "'") key = this.string();
      else {
        const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 200));
        if (!m) throw new Error("not a literal");
        key = m[0];
        this.i += key.length;
      }
      this.ws();
      if (this.s[this.i] !== ":") throw new Error("not a literal");
      this.i++;
      o[key] = this.member(depth);
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "}") throw new Error("not a literal");
    }
  }
  private array(depth: number) {
    this.i++;
    const a: unknown[] = [];
    for (;;) {
      this.ws();
      if (this.s[this.i] === "]") {
        this.i++;
        return a;
      }
      a.push(this.member(depth));
      this.ws();
      if (this.s[this.i] === ",") this.i++;
      else if (this.s[this.i] !== "]") throw new Error("not a literal");
    }
  }
  private string(): string {
    const q = this.s[this.i];
    this.i++;
    let out = "";
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) throw new Error("unterminated");
      if (c === q) {
        this.i++;
        return out;
      }
      if (c === "\\") {
        const e = this.s[this.i + 1];
        this.i += 2;
        if (e === "n") out += "\n";
        else if (e === "t") out += "\t";
        else if (e === "r") out += "\r";
        else if (e === "b") out += "\b";
        else if (e === "f") out += "\f";
        else if (e === "v") out += "\v";
        else if (e === "0") out += "\0";
        else if (e === "x") {
          out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16));
          this.i += 2;
        } else if (e === "u") {
          if (this.s[this.i] === "{") {
            const end = this.s.indexOf("}", this.i);
            out += String.fromCodePoint(parseInt(this.s.slice(this.i + 1, end), 16));
            this.i = end + 1;
          } else {
            out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16));
            this.i += 4;
          }
        } else if (e === "\r" && this.s[this.i] === "\n") this.i++;
        else if (e !== "\n" && e !== undefined) out += e;
        continue;
      }
      if (q === "`" && c === "$" && this.s[this.i + 1] === "{") throw new Error("template with values");
      if (c === "\n" && q !== "`") throw new Error("unterminated");
      out += c;
      this.i++;
    }
  }
}

/** The tools.<fn>(…) calls in a code-mode cell, in source order (strings, comments and regexes skipped). */
export function scriptCalls(src: string): ScriptCall[] {
  const out: ScriptCall[] = [];
  let prev = "";
  for (let i = 0; i < src.length && out.length < 200; ) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      prev = "a";
    } else if (c === "/" && (!prev || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
      i = skipRegex(src, i);
      prev = "a";
    } else if (IDENT.test(c)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80))![0];
      const call = word === "tools" && !/[\w$.]/.test(src[i - 1] ?? "") ? /^tools\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(["'])([^"'\n]+)\2\s*\])\s*\(/.exec(src.slice(i, i + 300)) : null;
      if (call) {
        const fn = call[1] ?? call[3]!;
        let arg: unknown;
        try {
          arg = new Literal(src, i + call[0].length).value();
        } catch {}
        out.push({ fn, arg });
        i += call[0].length;
        prev = "(";
      } else {
        i += word.length;
        prev = "a";
      }
    } else {
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  return out;
}

