// Transcript parser for claude. See common.ts for the shared pieces and the ChatOps a parser returns.
import type { ChatBlock, ChatMeta, ChatOp, ToolBlock } from "@af/core";
import { type ParseCtx, add, clip, hunksToPatch, oneLine, partsOf, str, textOf, tool, userOrNotice } from "./common.ts";

// claude: ~/.claude/projects/<slug>/<session>.jsonl, one record per line. The records read here:
//   user        {message:{content: string | [text|image|tool_result]}, toolUseResult?, isMeta?, origin?:{kind}, isCompactSummary?, permissionMode?}
//               origin.kind "human" (typed), "task-notification" (<task-notification> XML: background shell, Monitor,
//               agent, workflow), "peer" (<agent-message from=…>: a subagent's report, another session's message)
//   assistant   {message:{model, usage, content:[text|thinking|tool_use]}, effort?, isApiErrorMessage?}
//   attachment  {attachment:{type: queued_command | file | task_status | …}}  (queued_command: sent while it worked)
//   system      {subtype: local_command | compact_boundary | scheduled_task_fire | turn_duration | away_summary | informational}
//   permission-mode {permissionMode}, cost-state {totalCostUSD}
// Subagent steps live in their own files; sidechain lines in this one are skipped.

/** What the parser keeps between lines (in ctx.state). Every map is bounded: a session can run for days. */
interface State {
  line: number;
  /** Tool calls waiting for their result: id → name, the file an edit tool writes, a label for background work. */
  calls: Map<string, { name: string; path?: string; label?: string }>;
  /** Background tasks (shell, Monitor, workflow): task id → its tool call and a label for TaskStop. */
  tasks: Map<string, { tool: string; label: string }>;
  /** Subagents: agent id → the tool call that gets its report (the Agent call, or a SendMessage that resumed it). */
  agents: Map<string, { tool: string; label: string }>;
  /** Monitor events so far, per Monitor call (its output). */
  events: Map<string, string>;
  /** Human prompts just shown from a queued_command, so a plain copy right after is not shown twice. */
  queued: { text: string; line: number }[];
  lastKey?: string;
  /** A local command's notice, replaced by one with its output when that comes next. */
  command?: { key: string; text: string };
  /** The compaction divider, replaced by one with the summary as detail when that comes next. */
  compact?: { key: string; text: string };
  /** A "!" bash-mode command waiting for its output. */
  bang?: string;
  meta: ChatMeta;
  /**
   * The conversation tree: claude records a rewind (Esc Esc, /rewind) by continuing from an earlier line
   * (parentUuid), leaving the rewound part in the file. uuid → its parent and the entries it added.
   */
  tree: Map<string, { parent?: string; keys: string[]; prompt?: string }>;
  /** The uuid of the newest line on the conversation's path. */
  leaf?: string;
}

const state = (ctx: ParseCtx): State => {
  const s = (ctx.state ??= {}) as Partial<State>;
  s.line ??= 0;
  s.tree ??= new Map();
  s.calls ??= new Map();
  s.tasks ??= new Map();
  s.agents ??= new Map();
  s.events ??= new Map();
  s.queued ??= [];
  s.meta ??= {};
  return s as State;
};

/** Map.set that drops the oldest entries past `max`. */
function keep<K, V>(m: Map<K, V>, k: K, v: V, max: number) {
  m.delete(k);
  m.set(k, v);
  while (m.size > max) m.delete(m.keys().next().value as K);
}

const TREE_MAX = 50_000;

/** A line the user typed (not a tool result, not a harness message). */
const isPrompt = (line: any) => {
  if (line.type !== "user" || line.isMeta || line.isCompactSummary || line.toolUseResult !== undefined) return false;
  const c = line.message?.content;
  if (typeof c === "string") return true;
  return Array.isArray(c) && !c.some((p: any) => p?.type === "tool_result");
};

/**
 * Keep the view on the conversation's path. claude records a rewind (Esc Esc, /rewind) by writing the next prompt
 * as a child of an earlier line, leaving the rewound part in the file. Lines often share a parent for other
 * reasons (a hook line and the tool result after the same reply, parallel tool calls), so only this counts as a
 * rewind: a prompt whose parent already has a prompt below it. The entries of the lines from that earlier prompt
 * onward, on the old path, are removed.
 */
function branch(line: any, s: State, ops: ChatOp[]): ChatOp[] {
  const uuid = typeof line.uuid === "string" ? line.uuid : undefined;
  if (!uuid) return ops;
  const parent = typeof line.parentUuid === "string" ? line.parentUuid : undefined;
  const keys = ops.flatMap((o) => (o.op === "add" ? [o.entry.key] : []));
  let out = ops;
  const prompt = isPrompt(line);
  const p = parent ? s.tree.get(parent) : undefined;
  if (prompt && p?.prompt && s.leaf) {
    // everything on the old path from that earlier prompt to the newest line goes
    const gone: string[] = [];
    const stop = parent;
    const seen = new Set<string>();
    for (let at: string | undefined = s.leaf; at && at !== stop && !seen.has(at); at = s.tree.get(at)?.parent) {
      seen.add(at);
      gone.push(...(s.tree.get(at)?.keys ?? []));
    }
    if (gone.length) out = [{ op: "remove", keys: gone }, ...ops];
  }
  if (prompt && p) p.prompt = uuid;
  s.tree.set(uuid, { parent, keys });
  if (s.tree.size > TREE_MAX) s.tree.delete(s.tree.keys().next().value!);
  if (line.type === "user" || line.type === "assistant" || line.type === "system" || line.type === "attachment") s.leaf = uuid;
  return out;
}

export function parseClaude(line: any, ctx: ParseCtx): ChatOp[] {
  if (!line || typeof line !== "object" || line.isSidechain) return [];
  try {
    const s = state(ctx);
    s.line++;
    return branch(line, s, parseLine(line, ctx, s));
  } catch {}
  return [];
}

function parseLine(line: any, ctx: ParseCtx, s: State): ChatOp[] {
  {
    switch (line.type) {
      case "user":
        return user(line, ctx, s);
      case "assistant":
        return assistant(line, ctx, s);
      case "attachment":
        return attachment(line, ctx, s);
      case "system":
        return system(line, ctx, s);
      case "permission-mode":
        return meta(s, { mode: typeof line.permissionMode === "string" ? line.permissionMode : undefined });
      case "cost-state":
        return meta(s, { cost: typeof line.totalCostUSD === "number" ? line.totalCostUSD : undefined });
    }
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function emit(ctx: ParseCtx, s: State, block: ChatBlock | undefined, at?: string): ChatOp[] {
  const ops = add(ctx, block, at);
  if (ops[0]?.op === "add") s.lastKey = ops[0].entry.key;
  return ops;
}

type Notice = Extract<ChatBlock, { kind: "notice" }>;
const notice = (text: string, more: { tone?: Notice["tone"]; detail?: string; divider?: boolean } = {}): Notice => {
  const b: Notice = { kind: "notice", text };
  if (more.tone && more.tone !== "info") b.tone = more.tone;
  if (more.detail?.trim()) b.detail = clip(more.detail.trim(), 30000);
  if (more.divider) b.divider = true;
  return b;
};

/** Changed footer values only (meta ops merge, so repeating a value is noise). */
function meta(s: State, m: ChatMeta): ChatOp[] {
  const changed: ChatMeta = {};
  for (const [k, v] of Object.entries(m) as [keyof ChatMeta, any][]) if (v !== undefined && v !== "" && s.meta[k] !== v) (changed as any)[k] = v;
  if (!Object.keys(changed).length) return [];
  Object.assign(s.meta, changed);
  return [{ op: "meta", meta: changed }];
}

const tag = (text: string, name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
const stripAnsi = (t: string) => t.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
const stripReminders = (t: string) => t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
const ONE_M = 1_000_000;

export function duration(ms: number) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return sec % 60 ? `${m}m ${sec % 60}s` : `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 60)}h`;
}
const tokens = (n: number) => (n >= ONE_M ? `${(n / ONE_M).toFixed(1).replace(/\.0$/, "")}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** Context window of a claude model id: 1M for current models (and any "[1m]" id), 200k for older ones. */
export function contextWindow(model: string): number {
  if (/\[1m\]/i.test(model)) return ONE_M;
  const m = model.match(/claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/);
  if (!m) return 200_000;
  const [family, major, minor] = [m[1]!, Number(m[2]), Number(m[3] ?? 0)];
  if (family === "fable" || family === "mythos" || major >= 5) return ONE_M;
  return major === 4 && minor >= 6 && family !== "haiku" ? ONE_M : 200_000;
}

/** "k: v, k2: v2" for an input with no better summary (instead of a JSON dump). */
function fields(input: any): string {
  if (!input || typeof input !== "object") return oneLine(str(input));
  const parts = Object.entries(input)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && typeof v !== "object")
    .map(([k, v]) => `${k}: ${v}`);
  return oneLine(parts.join(", "));
}

const todoList = (todos: any[]) =>
  todos.map((t: any) => `- [${t?.status === "completed" ? "x" : " "}] ${oneLine(str(t?.content ?? t?.subject ?? ""), 300)}${t?.status === "in_progress" ? " _(in progress)_" : ""}`).join("\n");

function questions(qs: any[], answers?: Record<string, unknown>, notes?: Record<string, any>): string {
  return qs
    .map((q: any) => {
      const head = `**${str(q?.question).trim()}**`;
      if (answers) {
        const a = answers[q?.question];
        const note = notes?.[q?.question]?.notes;
        return `${head}\n\n→ ${a === undefined ? "_(no answer)_" : str(a)}${note ? `\n\n> ${str(note)}` : ""}`;
      }
      const opts = Array.isArray(q?.options) ? q.options.map((o: any) => `- ${str(o?.label)}${o?.description ? ` — ${str(o.description)}` : ""}`).join("\n") : "";
      return `${head}${q?.multiSelect ? " _(several)_" : ""}\n${opts}`;
    })
    .join("\n\n");
}

/** A report that is JSON (a workflow's result) reads better as a code block. */
function asMarkdown(text: string): string {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return clip(t, 30000);
  try {
    const v = JSON.parse(t);
    // a list of {key, report}: one section per report
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === "object" && typeof x.report === "string"))
      return clip(v.map((x) => `### ${str(x.key ?? x.title ?? x.name ?? "")}\n\n${x.report}`).join("\n\n"), 30000);
    return "```json\n" + clip(JSON.stringify(v, null, 2), 30000) + "\n```";
  } catch {
    return "```\n" + clip(t, 30000) + "\n```"; // cut short by the harness: still code, not prose
  }
}

// ---------------------------------------------------------------------------------------------
// Tool calls

/** The card for a tool call: the shared description, with claude's own tools made readable. */
export function toolBlock(id: string, name: string, input: any): ToolBlock {
  const i = input && typeof input === "object" ? input : {};
  const b = tool(id, name, input);
  const set = (more: Partial<ToolBlock>) => Object.assign(b, more);
  const mcp = name.match(/^mcp__(.+?)__(.+)$/);
  switch (name) {
    case "AskUserQuestion":
      if (Array.isArray(i.questions)) set({ summary: oneLine(i.questions.map((q: any) => q?.header || q?.question).join(" · ")), input: undefined, report: questions(i.questions) });
      break;
    case "Skill":
      set({ summary: oneLine(`/${str(i.skill ?? i.command)}${i.args ? ` ${str(i.args)}` : ""}`), input: str(i.args).length > 160 ? str(i.args) : undefined });
      break;
    case "ScheduleWakeup":
      if (i.stop) set({ summary: "stop the loop", input: undefined });
      else set({ summary: oneLine(`wake in ${duration(Number(i.delaySeconds ?? 0) * 1000)}${i.reason || i.prompt ? `: ${str(i.reason || i.prompt)}` : ""}`), input: i.prompt ? str(i.prompt) : undefined });
      break;
    case "CronCreate":
      set({ summary: oneLine(`${i.recurring === false ? "once" : "repeat"} at "${str(i.cron)}": ${str(i.prompt)}`), input: i.prompt ? str(i.prompt) : undefined });
      break;
    case "CronDelete":
      set({ summary: `cancel ${str(i.id)}`, input: undefined });
      break;
    case "TaskStop":
    case "KillShell":
    case "KillBash":
      set({ summary: `stop ${str(i.task_id ?? i.shell_id ?? i.id)}`, input: undefined });
      break;
    case "TodoWrite":
      if (Array.isArray(i.todos)) set({ summary: `${i.todos.filter((t: any) => t?.status === "completed").length}/${i.todos.length} done`, input: undefined, report: todoList(i.todos) });
      break;
    case "ExitPlanMode":
      set({ summary: "plan", input: undefined, report: i.plan ? clip(str(i.plan), 30000) : undefined });
      break;
    case "NotebookEdit": {
      const path = str(i.notebook_path);
      set({ summary: `${path} (${str(i.edit_mode ?? "replace")} cell${i.cell_id ? ` ${str(i.cell_id)}` : ""})`, input: undefined, edit: { path, before: "", after: clip(str(i.new_source), 20000) } });
      break;
    }
    case "Monitor":
      set({ input: i.command ? str(i.command) : b.input, background: true });
      break;
    case "Workflow": {
      const script = str(i.script);
      const desc = script.match(/description:\s*(['"`])((?:(?!\1)[^\\]|\\.)*)\1/)?.[2] ?? script.match(/name:\s*(['"`])([^'"`]*)\1/)?.[2];
      set({ summary: oneLine(desc ?? i.scriptPath ?? i.resumeFromRunId ?? "workflow"), input: script ? clip(script) : undefined });
      break;
    }
    case "SendMessage":
      set({ summary: oneLine(`→ ${str(i.to ?? i.recipient)}: ${str(i.summary || i.message || i.content)}`), input: str(i.message ?? i.content).length > 120 ? str(i.message ?? i.content) : undefined });
      break;
    case "TaskCreate":
    case "TaskUpdate":
      set({ summary: oneLine([i.taskId ?? i.id, i.subject, i.status].filter(Boolean).map(str).join(" · ")), input: undefined });
      break;
  }
  if (mcp) set({ name: `${mcp[1]} · ${mcp[2]}` });
  if ((name === "Bash" || name === "Agent" || name === "Task") && i.run_in_background) b.background = true;
  if (b.summary.startsWith("{")) set({ summary: fields(input), input: b.input ?? (str(input).length > 160 ? str(input) : undefined) });
  return b;
}

/** Text of a tool result: text parts, and something for loaded tools and documents. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return textOf(content);
  const out: string[] = [];
  const loaded: string[] = [];
  for (const c of content as any[]) {
    if (c?.type === "text") out.push(str(c.text));
    else if (c?.type === "tool_reference") loaded.push(str(c.tool_name));
    else if (c?.type === "document") out.push(`(${c.source?.media_type ?? "document"} attached)`);
    else if (typeof c === "string") out.push(c);
  }
  if (loaded.length) out.push(`Loaded ${loaded.join(", ")}`);
  return out.join("\n");
}

function toolResult(p: any, tur: any, s: State): ChatOp[] {
  const id = str(p.tool_use_id);
  const call = s.calls.get(id);
  const name = call?.name;
  s.calls.delete(id);
  const parts = partsOf(p.content);
  let output = resultText(p.content)
    .replace(/^<tool_use_error>([\s\S]*)<\/tool_use_error>$/, "$1")
    .trim();
  if (parts.droppedImages) output += `${output ? "\n" : ""}(${parts.droppedImages} image${parts.droppedImages > 1 ? "s" : ""} too large to show)`;
  const r = typeof tur === "object" && tur ? tur : {};
  const set: Partial<ToolBlock> = {};
  let background = false;

  // background work: the result only says it started; a task-notification or the subagent's report finishes it
  if (typeof r.backgroundTaskId === "string") {
    keep(s.tasks, r.backgroundTaskId, { tool: id, label: call?.label || r.backgroundTaskId }, 300);
    output = `Running in the background (task ${r.backgroundTaskId})`;
    background = true;
  } else if (typeof r.taskId === "string" && (name === "Monitor" || r.timeoutMs !== undefined)) {
    keep(s.tasks, r.taskId, { tool: id, label: call?.label || `Monitor ${r.taskId}` }, 300);
    output = `Watching (task ${r.taskId}${r.timeoutMs ? `, up to ${duration(r.timeoutMs)}` : ""})`;
    background = true;
  } else if (r.status === "async_launched" && typeof r.agentId === "string") {
    keep(s.agents, r.agentId, { tool: id, label: oneLine(str(r.description), 80) || r.agentId }, 100);
    output = "Working in the background";
    background = true;
  } else if (r.status === "async_launched" && typeof r.taskId === "string") {
    keep(s.tasks, r.taskId, { tool: id, label: oneLine(str(r.summary ?? r.workflowName), 80) || r.taskId }, 300);
    output = `Workflow ${r.workflowName ?? ""} running in the background`.replace(/\s+/g, " ");
    background = true;
    if (r.summary) set.summary = oneLine(str(r.summary));
  } else if (typeof (r.resumedAgentId ?? r.revivedAgentId) === "string") {
    const agent = r.resumedAgentId ?? r.revivedAgentId;
    keep(s.agents, agent, { tool: id, label: s.agents.get(agent)?.label ?? agent }, 100);
    output = str(r.message) || "Resumed the agent";
    background = true;
  } else if (r.status === "completed" && Array.isArray(r.content) && (name === "Agent" || name === "Task" || r.agentId)) {
    set.report = clip(textOf(r.content).trim(), 30000); // a subagent that ran in the foreground (older claude)
    output = "Done";
  }

  // diffs: Edit/Write report real hunks; Bash reports the files it changed
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
    const patch = hunksToPatch(r.structuredPatch);
    if (patch) set.patch = patch;
  }
  if (typeof r.filePath === "string" && (r.structuredPatch || r.type === "create" || r.type === "update")) set.files = [r.filePath];
  else if (call?.path && !p.is_error) set.files = [call.path];
  const bash = r.bashEditDiff;
  if (bash && Array.isArray(bash.files) && bash.files.length) {
    const patch = bash.files
      .map((f: any) => hunksToPatch(f?.hunks, str(f?.filePath)) ?? (f?.created ? `--- /dev/null\n+++ b/${str(f.filePath)}` : ""))
      .filter(Boolean)
      .join("\n");
    if (patch) set.patch = patch;
    set.files = (Array.isArray(bash.changedFiles) ? bash.changedFiles : bash.files.map((f: any) => f?.filePath)).filter((f: unknown) => typeof f === "string");
  }

  // answers, and stopping a background task
  if (Array.isArray(r.questions) && r.answers && typeof r.answers === "object") set.report = questions(r.questions, r.answers, r.annotations);
  const stopped = typeof r.task_id === "string" && /stopped/i.test(str(r.message)) ? r.task_id : undefined;
  const aborted = /^The user doesn't want to proceed with this tool use/.test(output) || tur === "User rejected tool use" || r.interrupted === true;
  if (aborted) set.aborted = true;
  output = output
    .replace(/^The user doesn't want to proceed with this tool use\. The tool use was rejected \([^)]*\)\.\s*/, "Rejected by the user. ")
    .replace(/^Rejected by the user\. STOP what you are doing and wait for the user to tell you how to proceed\.$/, "Rejected by the user.")
    .trim();

  const ops: ChatOp[] = [{ op: "result", id, output: clip(output), error: !!p.is_error, ...(parts.images.length ? { images: parts.images } : {}), ...(background ? { background: true } : {}) }];
  if (Object.keys(set).length) ops.push({ op: "update", id, set });
  if (stopped) {
    const t = s.tasks.get(stopped);
    if (t) {
      s.tasks.delete(stopped);
      s.events.delete(t.tool);
      ops.push({ op: "update", id: t.tool, set: { done: true, aborted: true, output: "Stopped" } });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Background work reporting back

/** A <task-notification>: a background shell finished, a Monitor saw an event, an agent or workflow ended. */
function taskNotification(text: string, at: string | undefined, ctx: ParseCtx, s: State): ChatOp[] {
  const fork = tag(text, "fork-source");
  if (fork !== undefined) {
    const from = fork.match(/self-reported name is '([^']+)'/)?.[1];
    return emit(ctx, s, notice(from ? `Forked from “${from}”` : "Forked from another session", { divider: true, detail: fork }), at);
  }
  const ids = [...text.matchAll(/<task-id>([^<]*)<\/task-id>/g)].map((m) => m[1]!.trim()).filter((t) => !t.startsWith("__"));
  const toolId = tag(text, "tool-use-id")?.trim();
  const status = tag(text, "status")?.trim();
  const summary = tag(text, "summary")?.trim() ?? "";
  const event = tag(text, "event")?.trim();
  // an agent that handed its report back as a message: the result only points there (and was shown already)
  const raw = tag(text, "result")?.trim();
  const pointer = !!raw && /^This agent's report was delivered to you as a message/.test(raw);
  const result = pointer ? undefined : raw;
  const outputFile = tag(text, "output-file")?.trim();
  const reminder = text.match(/<system-reminder>([\s\S]*?)<\/system-reminder>/)?.[1]?.trim();
  const usage = tag(text, "usage");
  const used = usage
    ? [
        tag(usage, "tool_uses") && `${tag(usage, "tool_uses")} tool uses`,
        tag(usage, "subagent_tokens") && `${tokens(Number(tag(usage, "subagent_tokens")))} tokens`,
        tag(usage, "duration_ms") && duration(Number(tag(usage, "duration_ms"))),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const ended = !!status || /^\[Monitor (expired|stopped|ended)/.test(event ?? "");
  const failed = status === "failed" || /exit code [1-9]/.test(summary);
  const ops: ChatOp[] = [];

  const targets = new Set<string>();
  if (toolId) targets.add(toolId);
  for (const t of ids) {
    const known = s.tasks.get(t);
    if (known) targets.add(known.tool);
    if (ended) s.tasks.delete(t);
  }
  let shown = false; // the report went to a card
  for (const target of targets) {
    const set: Partial<ToolBlock> = {};
    const before = s.events.get(target) ?? "";
    if (event !== undefined) {
      const so_far = `${before}${event}\n`;
      set.output = so_far.length > 6000 ? `…\n${so_far.slice(-6000)}` : so_far;
      if (!ended) keep(s.events, target, set.output, 50);
    }
    if (ended) s.events.delete(target);
    if (result !== undefined) {
      set.report = asMarkdown(result);
      shown = true;
    }
    if (ended) {
      set.done = true;
      if (event === undefined) set.output = [before.trimEnd(), summary, used, outputFile ? `Output: ${outputFile}` : ""].filter(Boolean).join("\n");
      if (failed) set.error = true;
      if (status === "stopped") set.aborted = true;
    }
    if (Object.keys(set).length) ops.push({ op: "update", id: target, set });
  }
  if (pointer && !failed) return ops;
  const tone = status === "failed" ? "error" : status === "stopped" ? "warn" : "info";
  const detail = event ?? (shown ? undefined : result) ?? reminder;
  ops.unshift(...emit(ctx, s, notice(oneLine(summary || "Background task update", 200), { tone, detail: detail && detail !== summary ? detail : undefined }), at));
  return ops;
}

/** The report of a subagent, from its hand-back: the text, without the harness's framing and indentation. */
function handbackReport(body: string, origin: any): string {
  // the harness may put a "[harness: …]" note about neutralized tags first: it is not part of the report
  const clean = (t: string) => t.replace(/^\[harness:[^\]]*\]\s*/, "").trim();
  if (typeof origin?.handbackReportText === "string" && origin.handbackReportText.trim()) return clean(origin.handbackReportText);
  const i = body.indexOf("The report follows:\n");
  if (i < 0) return clean(body);
  return clean(
    body
      .slice(i + "The report follows:\n".length)
      .split("\n")
      .map((l) => l.replace(/^ {2}/, ""))
      .join("\n"),
  );
}

/** A message from another claude: a subagent's report (to its Agent card), or another session talking. */
function peerMessage(text: string, origin: any, at: string | undefined, ctx: ParseCtx, s: State): ChatOp[] {
  const cross = text.match(/<cross-session-message[^>]*?from-name="([^"]*)"[^>]*>([\s\S]*?)<\/cross-session-message>/);
  const am = text.match(/<agent-message from="([^"]*)"[^>]*>([\s\S]*?)<\/agent-message>/);
  const from = str(origin?.from) || am?.[1] || "";
  const body = typeof origin?.body === "string" ? origin.body : (am?.[2] ?? cross?.[2] ?? text);
  const handback = origin?.handback === true || /^\s*\[Subagent hand-back\]/.test(body);
  if (!handback) {
    const name = cross?.[1] || origin?.name || from || "another session";
    return emit(ctx, s, notice(`Message from ${name}`, { detail: body.trim() }), at);
  }
  const report = handbackReport(body, origin);
  const agent = s.agents.get(from);
  const ops: ChatOp[] = [];
  if (agent) {
    // kept: a SendMessage that resumes this agent takes its label
    ops.push(...emit(ctx, s, notice(`Agent “${agent.label}” reported back`), at));
    ops.push({ op: "update", id: agent.tool, set: { report: clip(report, 30000), output: "Reported back", done: true } });
  } else ops.push(...emit(ctx, s, notice(`Report from ${origin?.name ?? "a subagent"}`, { detail: report }), at));
  if (origin?.flagged && typeof origin.handbackNote === "string") ops.push(...emit(ctx, s, notice("Auto mode flagged this report", { tone: "warn", detail: origin.handbackNote }), at));
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Lines

function user(line: any, ctx: ParseCtx, s: State): ChatOp[] {
  const at = line.timestamp;
  const content = line.message?.content;
  const ops: ChatOp[] = typeof line.permissionMode === "string" ? meta(s, { mode: line.permissionMode }) : [];
  const results = Array.isArray(content) ? content.filter((p: any) => p?.type === "tool_result") : [];
  for (const p of results) ops.push(...toolResult(p, results.length === 1 ? line.toolUseResult : undefined, s));
  const rest = Array.isArray(content) ? content.filter((p: any) => p?.type !== "tool_result") : content;
  if (results.length && (!Array.isArray(rest) || !rest.length)) return ops;
  const { text, images, droppedImages } = typeof rest === "string" ? { text: rest, images: [], droppedImages: 0 } : partsOf(rest);
  const t = text.trim();
  const kind = line.origin?.kind;

  if (line.isCompactSummary) return [...ops, ...compactSummary(t, at, ctx, s)];
  if (kind === "task-notification" || (!kind && t.startsWith("<task-notification>"))) return [...ops, ...taskNotification(t, at, ctx, s)];
  if (kind === "peer" || /^Another Claude session sent a message:/.test(t)) return [...ops, ...peerMessage(t, line.origin, at, ctx, s)];
  if (line.isMeta) return ops;
  return [...ops, ...typed(t, images, droppedImages, at, ctx, s)];
}

/** Text from the user's own prompt box: a prompt, a slash command and its output, a "!" shell command. */
function typed(t: string, images: string[], droppedImages: number, at: string | undefined, ctx: ParseCtx, s: State, queued = false): ChatOp[] {
  if (!t && !images.length) return [];
  // "!" bash mode
  const bangIn = tag(t, "bash-input");
  if (bangIn !== undefined && t.startsWith("<bash-input>")) {
    const id = `bash-mode-${ctx.n + 1}`;
    s.bang = id;
    return emit(ctx, s, { kind: "tool", id, name: "!", summary: oneLine(bangIn), input: bangIn.length > 160 ? bangIn : undefined, done: false }, at);
  }
  if (/^<bash-(stdout|stderr)>/.test(t)) {
    const out = stripAnsi(tag(t, "bash-stdout") ?? "").replace(/^\s*\n/, "").trimEnd();
    const err = stripAnsi(tag(t, "bash-stderr") ?? "").replace(/^\s*\n/, "").trimEnd();
    const output = clip([out, err].filter(Boolean).join("\n"));
    const id = s.bang;
    s.bang = undefined;
    if (id) return [{ op: "result", id, output, error: !out && !!err }];
    return emit(ctx, s, { kind: "tool", id: `bash-mode-${ctx.n + 1}`, name: "!", summary: "(shell output)", output, done: true }, at);
  }
  // slash commands: built-in ones log their output next; skills and custom commands are the user's prompt
  if (/^<local-command-(stdout|stderr)>/.test(t)) return commandOutput(t, undefined, at, ctx, s);
  if (t.startsWith("<local-command-caveat>")) return [];
  const name = tag(t, "command-name")?.trim();
  if (name !== undefined && /^<command-(name|message|args)>/.test(t)) {
    const args = (tag(t, "command-args") ?? "").trim();
    const cmd = name.startsWith("/") ? name : `/${name}`;
    if (t.startsWith("<command-message>")) return emit(ctx, s, { kind: "user", text: args, command: cmd, ...(images.length ? { images } : {}) }, at);
    return commandNotice(`${cmd}${args ? ` ${args}` : ""}`, at, ctx, s);
  }
  // a typed prompt, unless it was already shown when it was queued
  s.queued = s.queued.filter((q) => s.line - q.line <= 50);
  if (queued) s.queued.push({ text: t, line: s.line });
  else {
    const i = s.queued.findIndex((q) => q.text === t);
    if (i >= 0) {
      s.queued.splice(i, 1);
      return [];
    }
  }
  const b = userOrNotice(t.replace(/<(ide_opened_file|ide_selection)>[\s\S]*?<\/\1>/g, ""));
  const note = droppedImages ? `(${droppedImages} image${droppedImages > 1 ? "s" : ""} too large to show)` : "";
  if (b?.kind === "user") return emit(ctx, s, { ...b, text: [b.text, note].filter(Boolean).join("\n"), ...(images.length ? { images } : {}) }, at);
  if (!b && images.length) return emit(ctx, s, { kind: "user", text: note, images }, at);
  return emit(ctx, s, b, at);
}

function commandNotice(text: string, at: string | undefined, ctx: ParseCtx, s: State): ChatOp[] {
  const ops = emit(ctx, s, notice(text), at);
  if (s.lastKey) s.command = { key: s.lastKey, text };
  return ops;
}

/** Model names as /model prints them ("Sonnet 5.5"), as the footer shows them (the id's form). */
const modelId = (name: string) => `claude-${name.trim().toLowerCase().replace(/\s+/g, "-").replace(/\./g, "-")}`;

/**
 * What /model and /effort changed, from their output: the footer follows at once (the transcript records the
 * model only with the next reply). "Set model to `Sonnet 5.5` for this session only with `xhigh` effort",
 * "Set model to Opus 5.5", "Kept model as `Sonnet 5.5`", "Set effort level to max (this session only): …".
 */
function settingChange(out: string, s: State): { ops: ChatOp[]; line?: string } {
  const plain = out.replace(/`/g, "");
  const m = plain.match(/^(?:Set model to|Kept model as) ([^\n]+?)(?: and saved as your default.*| for this session only.*)?(?: with (\S+) effort)?$/m);
  if (m) {
    const effort = plain.match(/with (\S+) effort/)?.[1];
    return { ops: meta(s, { model: modelId(m[1]!), effort }), line: plain.split("\n")[0] };
  }
  const e = plain.match(/^Set effort level to (\S+)/m);
  if (e) return { ops: meta(s, { effort: e[1]! }), line: plain.split(":")[0] };
  return { ops: [] };
}

/** A command's output: folded under the command's own notice when that came just before. */
function commandOutput(t: string, run: any, at: string | undefined, ctx: ParseCtx, s: State): ChatOp[] {
  const out = stripAnsi(tag(t, "local-command-stdout") ?? tag(t, "local-command-stderr") ?? t).trim();
  const tone = t.startsWith("<local-command-stderr>") ? "error" : undefined;
  const prev = s.command;
  s.command = undefined;
  if (!out) return [];
  // /model, /effort: the change itself is the line (not a folded "/model"), and the footer follows
  const change = tone ? { ops: [] as ChatOp[] } : settingChange(out, s);
  if (change.line) {
    const cut = prev && prev.key === s.lastKey ? [{ op: "remove" as const, keys: [prev.key] }] : [];
    return [...cut, ...change.ops, ...emit(ctx, s, notice(change.line), at)];
  }
  if (prev && prev.key === s.lastKey) return [{ op: "remove", keys: [prev.key] }, ...emit(ctx, s, notice(prev.text, { tone, detail: out }), at)];
  const cmd = run && typeof run.command === "string" ? `/${run.command}${run.args ? ` ${str(run.args)}` : ""}` : "Command output";
  return emit(ctx, s, notice(cmd, { tone, detail: out }), at);
}

function compactSummary(t: string, at: string | undefined, ctx: ParseCtx, s: State): ChatOp[] {
  const summary = stripReminders(t);
  const prev = s.compact;
  s.compact = undefined;
  if (prev && prev.key === s.lastKey) return [{ op: "remove", keys: [prev.key] }, ...emit(ctx, s, notice(prev.text, { divider: true, detail: summary }), at)];
  return emit(ctx, s, notice("Conversation compacted", { divider: true, detail: summary }), at);
}

function assistant(line: any, ctx: ParseCtx, s: State): ChatOp[] {
  const at = line.timestamp;
  const m = line.message ?? {};
  const content = m.content;
  if (line.isApiErrorMessage) {
    const text = textOf(content).trim() || str(line.error) || "API error";
    return emit(ctx, s, notice(oneLine(text, 200), { tone: "error", detail: text.length > 200 ? text : undefined }), at);
  }
  const ops: ChatOp[] = [];
  const model = typeof m.model === "string" && m.model.startsWith("claude") ? m.model : undefined;
  if (model) {
    const u = m.usage ?? {};
    const used = (Number(u.input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0);
    // a model id says its window; a session already past 200k (or seen at 1M with this model) has the 1M one
    const big = used > 200_000 || (s.meta.model === model && (s.meta.contextWindow ?? 0) >= ONE_M);
    const window = big ? ONE_M : contextWindow(model);
    const effort = [line.effort, line.perTurnEffort].find((e) => typeof e === "string");
    ops.push(...meta(s, { model, effort, contextTokens: used || undefined, contextWindow: window }));
  } else if (m.model === "<synthetic>" && /^No response requested\.?$/.test(textOf(content).trim())) return [];
  if (typeof content === "string") return [...ops, ...emit(ctx, s, content.trim() ? { kind: "text", text: content } : undefined, at)];
  for (const p of Array.isArray(content) ? content : []) {
    if (p?.type === "text" && typeof p.text === "string" && p.text.trim()) ops.push(...emit(ctx, s, { kind: "text", text: p.text }, at));
    else if (p?.type === "thinking" && typeof p.thinking === "string" && p.thinking.trim()) ops.push(...emit(ctx, s, { kind: "thinking", text: p.thinking }, at));
    else if (p?.type === "tool_use" && p.id) {
      const name = str(p.name) || "tool";
      const path = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(name) ? (p.input?.file_path ?? p.input?.notebook_path) : undefined;
      const b = toolBlock(p.id, name, p.input);
      keep(s.calls, p.id, { name, path: typeof path === "string" ? path : undefined, label: oneLine(str(p.input?.description), 80) || b.summary.slice(0, 80) }, 200);
      // stopping a background task: name what it was
      const stops = /^(TaskStop|KillShell|KillBash)$/.test(name) ? s.tasks.get(str(p.input?.task_id ?? p.input?.shell_id)) : undefined;
      if (stops) b.summary = oneLine(`stop ${stops.label}`);
      ops.push(...emit(ctx, s, b, at));
    }
  }
  return ops;
}

function attachment(line: any, ctx: ParseCtx, s: State): ChatOp[] {
  const a = line.attachment ?? {};
  const at = a.timestamp ?? line.timestamp;
  switch (a.type) {
    case "queued_command": {
      // a message that arrived while the agent worked: the user's, a background task's, or a subagent's
      const { text, images, droppedImages } = typeof a.prompt === "string" ? { text: a.prompt, images: [], droppedImages: 0 } : partsOf(a.prompt);
      const t = text.trim();
      const kind = a.origin?.kind;
      if (kind === "task-notification" || a.commandMode === "task-notification") return taskNotification(t, at, ctx, s);
      if (kind === "peer") return peerMessage(t, a.origin, at, ctx, s);
      if ((kind && kind !== "human") || (a.commandMode && a.commandMode !== "prompt")) return [];
      return typed(t, images, droppedImages, at, ctx, s, true);
    }
    case "file": {
      // an @-mentioned file, or one read again after compaction
      const f = a.content?.file ?? {};
      const path = str(a.displayPath || a.filename || f.filePath);
      if (!path) return [];
      const n = Number(f.numLines ?? f.totalLines);
      return emit(ctx, s, notice(`Read ${path}${n ? ` (${n} line${n === 1 ? "" : "s"})` : ""}`), at);
    }
    case "task_status": {
      // what is still running (repeated after compaction): lets later notifications find their card
      const toolId = a.toolUseId ?? a.shell?.toolUseId;
      if (typeof a.taskId === "string" && typeof toolId === "string" && a.status === "running") keep(s.tasks, a.taskId, { tool: toolId, label: oneLine(str(a.description), 80) || a.taskId }, 300);
      return [];
    }
  }
  return [];
}

function system(line: any, ctx: ParseCtx, s: State): ChatOp[] {
  const at = line.timestamp;
  const content = typeof line.content === "string" ? line.content : "";
  switch (line.subtype) {
    case "local_command": {
      const t = content.trim();
      if (/^<local-command-(stdout|stderr)>/.test(t)) return commandOutput(t, line.commandRun, at, ctx, s);
      const name = tag(t, "command-name")?.trim();
      if (!name) return [];
      const args = (tag(t, "command-args") ?? "").trim();
      return commandNotice(`${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}`, at, ctx, s);
    }
    case "compact_boundary": {
      const m = line.compactMetadata ?? {};
      const how = [m.trigger, m.preTokens && m.postTokens ? `${tokens(m.preTokens)} → ${tokens(m.postTokens)} tokens` : ""].filter(Boolean).join(" · ");
      const text = `Conversation compacted${how ? ` (${how})` : ""}`;
      const ops = emit(ctx, s, notice(text, { divider: true }), at);
      if (s.lastKey) s.compact = { key: s.lastKey, text };
      if (typeof m.postTokens === "number") ops.push(...meta(s, { contextTokens: m.postTokens }));
      return ops;
    }
    case "scheduled_task_fire": {
      const prompt = str(line.prompt).trim();
      const head = line.taskKind === "loop" || line.cronKind === "loop" || /\/loop/.test(content) ? "Resumed by /loop" : "Scheduled task";
      const short = oneLine(prompt, 140);
      return emit(ctx, s, notice(prompt ? `${head}: ${short}` : content || head, { detail: prompt.length > short.length ? prompt : undefined }), at);
    }
    case "turn_duration": {
      const ms = Number(line.durationMs);
      return ms >= 30_000 ? emit(ctx, s, notice(`Worked for ${duration(ms)}`), at) : [];
    }
    case "away_summary": {
      const recap = content.replace(/\s*\(disable recaps in \/config\)\s*$/, "").trim();
      const short = oneLine(recap, 120);
      return recap ? emit(ctx, s, notice(`Recap: ${short}`, { detail: short.length < recap.length ? recap : undefined }), at) : [];
    }
    case "informational": {
      const t = stripAnsi(content).trim();
      const tone = line.level === "warning" ? "warn" : line.level === "error" ? "error" : "info";
      return t ? emit(ctx, s, notice(oneLine(t, 200), { tone, detail: t.length > 200 ? t : undefined }), at) : [];
    }
  }
  return [];
}
