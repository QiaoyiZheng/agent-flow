// Transcript parser for Gemini CLI. See common.ts for the shared pieces and the ChatOps a parser returns.
import type { ChatBlock, ChatMeta, ChatOp, ToolBlock } from "@af/core";
import { MAX_IMAGE, type ParseCtx, add, clip, oneLine, str, userOrNotice } from "./common.ts";

// Gemini CLI 0.66: ~/.gemini/tmp/<project>/chats/session-<YYYY-MM-DDTHH-MM>-<first 8 of the session id>.jsonl
// (<project>: a short name for the folder, from ~/.gemini/projects.json). Subagents write chats/<parent id>/<id>.jsonl.
// The file is written when the session starts (before the first prompt), one record per line:
//   {sessionId, projectHash, startTime, lastUpdated, kind: main|subagent, directories?, summary?}   header
//   {id, timestamp, type, content, displayContent?, ...}       a message; type user | gemini | info | warning | error
//       user     content: parts [{text} | {inlineData} | {functionResponse: {id, name, response: {output|error}}}];
//                displayContent: what was typed, when an "@file" reference read files into the message; the first
//                message is injected context ("<session_context>…"); tool results come back as user messages
//       gemini   content: text (or parts with functionCall when re-recorded), thoughts: [{subject, description}],
//                tokens: {input, output, cached, thoughts, tool, total}, model,
//                toolCalls: [{id, name, args, result: [functionResponse and inlineData parts],
//                             status: success|error|cancelled, resultDisplay, description, displayName}]
//                (tool calls are recorded once they have finished)
//       info | warning | error   what the CLI showed (content: text): "Request cancelled.", API errors, …
//     The SAME id is written again whenever the message changes (tokens, tool calls added): the later copy replaces it.
//   {$set: {lastUpdated | summary | directories | sessionId (a resumed session) | messages}}   header updates
//   {$patch: {updates: [{id, content}], removeIds, orderIds}}   the history written again: Gemini CLI syncs the file
//     with its in-memory history, so every message not in it (info/warning/error notices, a turn whose tool calls
//     were declined, turns a compression replaced) is "removed", although its own screen keeps showing them
//   {$rewindTo: id}   that message and everything after it are gone: /rewind, or a turn taken back after Esc or an error
// Compression (/compress, or automatic) writes {$set: {sessionId}}, a summary ("<state_snapshot>…") as a user message,
// "Got it. Thanks for the additional context!", copies of the turns it keeps (new ids), then removes the old ids.

const MAX_REPORT = 20_000;
/** Messages and tool calls remembered (for repeated copies, results, patches and rewinds). */
const MAX_MSGS = 20_000;
const MAX_TOOLS = 20_000;
/** Context window of Gemini CLI's models (tokenLimit in its source): Gemma 4 has 256k, every other model 1M. */
const windowOf = (model: string) => (/gemma-4/i.test(model) ? 256_000 : 1_048_576);

const INTERRUPTED = "[The previous response was interrupted before it completed.]";
const INTERRUPTED_TOOL = "Response was lost or interrupted.";
const CANCELLED = "Request cancelled.";
const GOT_IT = "Got it. Thanks for the additional context!";
const BINARY_ACK = "Binary content received. Proceeding with analysis.";
const BINARY_KEY = "__binary_injection__";
const REF_START = "--- Content from referenced files ---";
const REF_END = "--- End of content ---";

/** Gemini CLI's names for its tools (displayName), for calls recorded without one. */
const DISPLAY: Record<string, string> = {
  run_shell_command: "Shell",
  read_file: "ReadFile",
  read_many_files: "ReadManyFiles",
  write_file: "WriteFile",
  replace: "Edit",
  glob: "FindFiles",
  grep_search: "SearchText",
  list_directory: "ReadFolder",
  web_fetch: "WebFetch",
  google_web_search: "GoogleSearch",
  write_todos: "WriteTodos",
  invoke_agent: "Agent",
  ask_user: "AskUser",
  activate_skill: "Skill",
  enter_plan_mode: "EnterPlanMode",
  exit_plan_mode: "ExitPlanMode",
  complete_task: "Complete Task",
};

interface Msg {
  type: string;
  /** Entries shown for its text, thinking and notices (its tool blocks are in `tools`). */
  keys: string[];
  /** What those entries show, block by block (JSON), to tell what a later copy changed. */
  sigs: string[];
  /** Tool call ids of this message. */
  tools: string[];
  /** Kept for a content patch: what the patch does not carry. */
  thoughts?: unknown;
  displayContent?: unknown;
  /** Never shown (a compression's copy of a turn that is shown already). */
  hidden?: boolean;
  /** Gemini's "ready" to agent-flow's instructions: not shown (its later copies neither). */
  introReply?: boolean;
  /** No longer in Gemini's history, but still shown (as on its screen): only a rewind past it takes it out. */
  detached?: boolean;
}

interface Tool {
  key: string;
  /** What the block shows (JSON), to send only real changes. */
  sig: string;
  done: boolean;
}

interface GState {
  /** Message id → what it shows, in the order first seen. */
  msgs: Map<string, Msg>;
  tools: Map<string, Tool>;
  meta: ChatMeta;
  /** Tool calls the last results answered: images a tool returns may come in an info message right after. */
  lastResults: string[];
  /** Calls shown as something else (update_topic as a notice): their results are not shown. */
  quiet: Set<string>;
  /** The agent-flow instructions were just shown: Gemini's "ready" to them is not. */
  intro?: boolean;
  /** The last message was "Request cancelled.": what the next removal takes out stays shown (Gemini's screen keeps it). */
  cancel?: { id: string; key: string };
  /** A turn taken back that may have failed (an error notice comes next) or been rewound by the user (removed). */
  undecided?: string[];
  /** {$set: {sessionId}} was written: a resumed session (or a compression) starts here. */
  resumed?: boolean;
  /**
   * A compression is being written: the turns it keeps are copied (with new ids) before the old ones are removed.
   * The copies are held back: shown only if the old turns are not (the file was opened after them).
   */
  compact?: { at: number; ops: ChatOp[]; ids: Set<string> };
}

function stateOf(ctx: ParseCtx): GState {
  const bag = (ctx.state ??= {});
  return (bag.gemini ??= { msgs: new Map(), tools: new Map(), meta: {}, lastResults: [], quiet: new Set() } satisfies GState);
}

function cap<K, V>(m: Map<K, V>, max: number) {
  while (m.size > max) m.delete(m.keys().next().value as K);
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const s = (v: unknown) => (typeof v === "string" ? v : "");
const addKey = (o: ChatOp) => (o as Extract<ChatOp, { op: "add" }>).entry.key;

export function parseGemini(line: any, ctx: ParseCtx): ChatOp[] {
  try {
    return parseGeminiLine(line, ctx);
  } catch {
    return [];
  }
}

/** parseGemini without the safety net (tests check it does not throw on real lines). */
export function parseGeminiLine(line: any, ctx: ParseCtx): ChatOp[] {
  if (!line || typeof line !== "object" || Array.isArray(line)) return [];
  const st = stateOf(ctx);
  if (typeof line.$rewindTo === "string") {
    const ops = [...endCompaction(st), ...decide(st, false)];
    ops.push(...rewindOps(line.$rewindTo, ctx, st));
    st.cancel = undefined;
    return ops;
  }
  if (line.$patch && typeof line.$patch === "object") return patchOps(obj(line.$patch), ctx, st);
  if (line.$set && typeof line.$set === "object") {
    const set = obj(line.$set);
    if (typeof set.sessionId === "string") st.resumed = true;
    if (!Array.isArray(set.messages)) return [];
    return [...endCompaction(st), ...decide(st, false), ...replaceAll(set.messages, ctx, st)];
  }
  if (typeof line.id === "string") {
    const ops: ChatOp[] = [];
    if (st.compact && !(Date.parse(s(line.timestamp)) - st.compact.at < 10_000)) ops.push(...endCompaction(st));
    // a turn taken back without "Request cancelled." before it: an error notice next means it failed (Gemini's
    // screen keeps it); anything else means the user rewound it
    if (st.undecided) ops.push(...decide(st, line.type === "error" || line.type === "warning"));
    ops.push(...messageOps(line, ctx, st));
    return ops;
  }
  // the header (an old file converted may carry its messages)
  if (typeof line.sessionId === "string" && Array.isArray(line.messages)) return replaceAll(line.messages, ctx, st);
  return [];
}

// ---------------------------------------------------------------------------------------------
// Messages.

interface Result {
  id: string;
  name: string;
  output: string;
  error: boolean;
  images: string[];
}

interface Rendered {
  blocks: ChatBlock[];
  /** Tool blocks this message holds (from toolCalls, or functionCall parts of a re-recorded turn). */
  calls: ToolBlock[];
  /** Tool results it carries (a user message of functionResponse parts). */
  results: Result[];
  meta: ChatMeta;
  /** A compression summary: what the compressed turns are replaced with. */
  summary?: boolean;
  /** The model's "ready" to agent-flow's instructions. */
  introReply?: boolean;
}

function messageOps(m: Record<string, any>, ctx: ParseCtx, st: GState): ChatOp[] {
  const id: string = m.id;
  const at = s(m.timestamp) || undefined;
  const type = s(m.type);
  const known = st.msgs.get(id);
  const r = render(m, st, known);
  const ops: ChatOp[] = [];
  if (!known) {
    // the next message shown after a resume: a divider (a compression writes the same record: its summary is one)
    if (st.resumed && (r.summary || r.blocks.length || r.calls.length)) {
      st.resumed = false;
      if (!r.summary && st.msgs.size) ops.push(...add(ctx, { kind: "notice", text: "Session resumed", divider: true }, at));
    }
    // the summary starts a compression: what comes next until the old turns are removed are copies of kept turns
    if (r.summary) {
      ops.push(...endCompaction(st));
      st.compact = { at: Date.parse(at ?? "") || 0, ops: [], ids: new Set() };
    }
  }
  const held = st.compact && !r.summary ? st.compact : undefined;
  const out: ChatOp[] = [];
  let msg = known;
  if (!msg) {
    msg = { type, keys: [], sigs: [], tools: [] };
    st.msgs.set(id, msg);
    cap(st.msgs, MAX_MSGS);
    held?.ids.add(id);
  }
  if (r.introReply) msg.introReply = true;
  if (m.thoughts !== undefined) msg.thoughts = m.thoughts;
  if (m.displayContent !== undefined) msg.displayContent = m.displayContent;
  if (!msg.hidden) out.push(...blockOps(msg, r.blocks, at, ctx));
  for (const call of r.calls) out.push(...toolOps(call, msg, at, ctx, st));
  if (r.results.length) {
    st.lastResults = [];
    for (const res of r.results) out.push(...resultOps(res, msg, at, ctx, st));
  }
  out.push(...metaOps(st, r.meta));
  // "Request cancelled." is followed by the removal of what it cancelled
  if (!known) st.cancel = type === "info" && s(textOf(partsOf(m.content))).trim() === CANCELLED && msg.keys.length ? { id, key: msg.keys[0]! } : undefined;
  if (held) {
    held.ops.push(...out.filter((o) => o.op !== "meta"));
    ops.push(...out.filter((o) => o.op === "meta"));
  } else ops.push(...out);
  return ops;
}

/** The entries of a message's text, thinking and notices: added, or (a later copy) what changed of them. */
function blockOps(msg: Msg, blocks: ChatBlock[], at: string | undefined, ctx: ParseCtx): ChatOp[] {
  const sigs = blocks.map((b) => JSON.stringify(b));
  if (sigs.length === msg.sigs.length && sigs.every((x, i) => x === msg.sigs[i])) return [];
  const ops: ChatOp[] = [];
  // a copy that only adds entries (a topic notice with the tool calls) keeps the ones shown
  const prefix = msg.sigs.length <= sigs.length && msg.sigs.every((x, i) => x === sigs[i]);
  const from = prefix ? msg.sigs.length : 0;
  if (!prefix && msg.keys.length) {
    ops.push({ op: "remove", keys: msg.keys });
    msg.keys = [];
  }
  for (const b of blocks.slice(from)) {
    const o = add(ctx, b, at);
    msg.keys.push(...o.map(addKey));
    ops.push(...o);
  }
  msg.sigs = sigs;
  return ops;
}

/** A tool call (new, or a later copy of it): an add, or an update with what changed. */
function toolOps(call: ToolBlock, msg: Msg, at: string | undefined, ctx: ParseCtx, st: GState): ChatOp[] {
  const { kind: _k, id, ...rest } = call;
  const sig = JSON.stringify(rest);
  const known = st.tools.get(id);
  if (!known) {
    if (msg.hidden) return [];
    const o = add(ctx, call, at);
    st.tools.set(id, { key: addKey(o[0]!), sig, done: call.done });
    cap(st.tools, MAX_TOOLS);
    if (!msg.tools.includes(id)) msg.tools.push(id);
    return o;
  }
  if (known.sig === sig) return [];
  // a copy without the result (a turn re-recorded as functionCall parts) does not undo a result already shown
  if (known.done && !call.done) return [];
  known.sig = sig;
  known.done = call.done;
  return [{ op: "update", id, set: rest }];
}

/** A tool result that came as a functionResponse: the call it answers is done (or shown now, if it was not). */
function resultOps(res: Result, msg: Msg, at: string | undefined, ctx: ParseCtx, st: GState): ChatOp[] {
  if (st.quiet.has(res.id)) return [];
  st.lastResults.push(res.id);
  const known = st.tools.get(res.id);
  if (known?.done) return [];
  const aborted = res.output === INTERRUPTED_TOOL;
  if (known) {
    const set: Partial<ToolBlock> = aborted ? { aborted: true, done: true } : { output: clip(res.output), done: true, ...(res.error ? { error: true } : {}), ...(res.images.length ? { images: res.images } : {}) };
    known.done = true;
    known.sig = JSON.stringify({ ...JSON.parse(known.sig), ...set });
    if (aborted) return [{ op: "update", id: res.id, set }];
    return [{ op: "result", id: res.id, output: clip(res.output), error: res.error, ...(res.images.length ? { images: res.images } : {}) }];
  }
  // a result without a recorded call (an interrupted turn, a re-recorded one): shown on its own
  const block: ToolBlock = {
    kind: "tool",
    id: res.id,
    name: DISPLAY[res.name] ?? (res.name || "tool"),
    summary: "",
    ...(aborted ? { aborted: true } : { ...(res.output ? { output: clip(res.output) } : {}), ...(res.error ? { error: true } : {}) }),
    ...(res.images.length ? { images: res.images } : {}),
    done: true,
  };
  return toolOps(block, msg, at, ctx, st);
}

function render(m: Record<string, any>, st: GState, known: Msg | undefined): Rendered {
  const r: Rendered = { blocks: [], calls: [], results: [], meta: {} };
  const type = s(m.type);
  const parts = partsOf(m.content);
  if (type === "user") renderUser(m, parts, r, st);
  else if (type === "gemini") renderGemini(m, parts, r, st, known);
  else if (type === "info" || type === "warning" || type === "error") renderNotice(type, parts, r, st);
  if (type === "user" || type === "gemini") st.intro = type === "user" && !r.results.length ? st.intro : false;
  return r;
}

function renderUser(m: Record<string, any>, parts: any[], r: Rendered, st: GState) {
  for (const p of parts) if (p?.functionResponse) r.results.push(resultOf(obj(p.functionResponse)));
  const images = imagesOf(parts);
  if (r.results.length) {
    // images next to tool results are what the tools read (read_file on a picture)
    if (images.length) r.results.at(-1)!.images.push(...images);
    return;
  }
  // what the user typed, when it differs from what was sent (an @file reference read into the message)
  const typed = m.displayContent !== undefined && m.displayContent !== null;
  const raw = textOf(typed ? partsOf(m.displayContent) : parts);
  const text = (typed ? raw : stripReferences(raw)).trim();
  st.intro = false;
  if (!text) {
    if (images.length) r.blocks.push({ kind: "user", text: "", images });
    return;
  }
  // context Gemini CLI injects: the session context, hook output, the workspace's folders, the editor's state
  if (/^<(session_context|hook_context)>/.test(text) || text.startsWith("- **Workspace Directories:**") || text.startsWith("Here is the user's editor context")) return;
  if (text.includes("<state_snapshot>")) {
    r.summary = true;
    r.blocks.push({ kind: "notice", text: "Context compressed", divider: true, detail: clip(text, MAX_REPORT) });
    return;
  }
  // Gemini CLI's nudges after an empty answer ("[System: You successfully executed a tool but returned an empty …")
  if (/^\[System: You (successfully executed a tool but returned an empty|previously generated thoughts but|previously returned an empty)/.test(text)) {
    r.blocks.push({ kind: "notice", text: "Empty answer: Gemini CLI asked the model to go on", detail: text });
    return;
  }
  if (text.startsWith("System: Potential loop detected.")) {
    r.blocks.push({ kind: "notice", text: "Loop detected: Gemini CLI asked the model to step back", tone: "warn", detail: text });
    return;
  }
  // agent-flow's first message to an agent it started: the protocol file, read in with "@"
  const intro = text.match(/^@(\S+)\s+These are your agent-flow instructions\b/);
  if (intro) {
    st.intro = true;
    r.blocks.push({ kind: "notice", text: "agent-flow instructions loaded", detail: intro[1] });
    return;
  }
  // a "!" shell-mode command: Gemini CLI puts it and its output into the conversation as a message
  const bang = text.match(/^I ran the following shell command:\n```sh\n([\s\S]*?)\n```\n\nThis produced the following result:\n```\n([\s\S]*?)\n?```$/);
  if (bang) {
    const unescape = (t: string) => t.replace(/\\`/g, "`").replace(/\\\\/g, "\\");
    const cmd = unescape(bang[1]!);
    r.calls.push({ kind: "tool", id: `sh-${m.id}`, name: "!", summary: oneLine(cmd), ...(cmd.length > 160 || cmd.includes("\n") ? { input: cmd } : {}), output: clip(unescape(bang[2]!)), done: true });
    return;
  }
  const b = userOrNotice(text);
  if (b?.kind === "user" && images.length) b.images = images;
  if (b) r.blocks.push(b);
}

function renderGemini(m: Record<string, any>, parts: any[], r: Rendered, st: GState, known: Msg | undefined) {
  const thoughts = arr(m.thoughts)
    .map((t) => {
      const subject = s(t?.subject).trim();
      const description = s(t?.description).trim();
      return subject && description ? `**${subject}**\n${description}` : subject || description;
    })
    .filter(Boolean);
  const thoughtParts = parts.filter((p) => p?.thought && typeof p.text === "string" && p.text.trim() && p.text.trim() !== BINARY_ACK).map((p) => p.text.trim());
  if (thoughts.length || thoughtParts.length) r.blocks.push({ kind: "thinking", text: [...thoughts, ...thoughtParts].join("\n\n") });
  const text = textOf(parts).trim();
  if (text === INTERRUPTED) r.blocks.push({ kind: "notice", text: "Interrupted", tone: "warn" });
  else if (text === GOT_IT) {
    // the model's answer to a compression summary
  } else if ((known?.introReply || (!known && st.intro)) && /^ready[.!]?$/i.test(text)) {
    // its answer to agent-flow's instructions
    r.introReply = true;
  } else if (text) r.blocks.push({ kind: "text", text });
  const recorded = new Set<string>();
  for (const tc of arr(m.toolCalls)) {
    const t = obj(tc);
    // the model naming its current task (Gemini CLI shows it as a heading)
    if (s(t.name) === "update_topic" && s(t.status) === "success") {
      const a = obj(t.args);
      const title = oneLine(s(a.title), 120);
      if (title) {
        recorded.add(s(t.id));
        st.quiet.add(s(t.id));
        if (st.quiet.size > 1000) st.quiet.delete(st.quiet.values().next().value!);
        const detail = [s(a.summary).trim(), s(a.strategic_intent).trim()].filter(Boolean).join("\n\n");
        r.blocks.push({ kind: "notice", text: `Topic: ${title}`, ...(detail ? { detail } : {}) });
        continue;
      }
    }
    const call = callOf(t);
    if (!call) continue;
    recorded.add(call.id);
    r.calls.push(call);
  }
  // a re-recorded turn (compression keeps turns as copies) holds its calls as functionCall parts
  for (const p of parts) {
    const fc = obj(p?.functionCall);
    const id = s(fc.id);
    const name = s(fc.name);
    if (!id || !name || recorded.has(id) || name === "update_topic") continue;
    r.calls.push({ kind: "tool", id, name: DISPLAY[name] ?? name, ...describe(name, obj(fc.args)), done: false });
  }
  const model = s(m.model);
  if (model) r.meta.model = model;
  const tokens = obj(m.tokens);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const context = n(tokens.input) + n(tokens.output);
  if (context > 0) {
    r.meta.contextTokens = context;
    r.meta.contextWindow = windowOf(model || st.meta.model || "");
  }
}

function renderNotice(type: string, parts: any[], r: Rendered, st: GState) {
  const text = textOf(parts).trim();
  const images = imagesOf(parts);
  // an image a tool read: older versions send it on as an info message of its own
  if (images.length) {
    const target = st.lastResults.at(-1);
    const t = target ? st.tools.get(target) : undefined;
    if (t) r.calls.push({ kind: "tool", id: target!, ...JSON.parse(t.sig), images });
    else r.blocks.push({ kind: "user", text: "", images });
  }
  if (!text) return;
  if (text === CANCELLED) {
    r.blocks.push({ kind: "notice", text: "Request cancelled", tone: "warn" });
    return;
  }
  const tone = type === "error" ? "error" : type === "warning" ? "warn" : undefined;
  const first = apiMessage(text) ?? text.split("\n")[0]!.trim();
  const long = text !== first || first.length > 200;
  r.blocks.push({ kind: "notice", text: oneLine(first, 200), ...(tone ? { tone } : {}), ...(long ? { detail: clip(text, MAX_REPORT) } : {}) });
}

/** '[API Error: {"error":{"message":"{\"error\":{\"message\":\"Invalid request\"…' → "API Error: Invalid request". */
function apiMessage(text: string): string | undefined {
  if (!text.startsWith("[API Error: ")) return undefined;
  let msg = text;
  for (let i = 0; i < 5; i++) {
    const m = msg.match(/"message"\s*:\s*("(?:[^"\\]|\\.)*")/);
    if (!m) break;
    try {
      msg = JSON.parse(m[1]!);
    } catch {
      break;
    }
  }
  return msg !== text && msg.trim() ? `API Error: ${oneLine(msg, 180)}` : undefined;
}

// ---------------------------------------------------------------------------------------------
// Tool calls.

function callOf(tc: Record<string, any>): ToolBlock | undefined {
  const id = s(tc.id);
  const name = s(tc.name).trim();
  if (!id) return undefined;
  const args = obj(tc.args);
  const d = describe(name, args, tc);
  const parts = arr(tc.result);
  const res = parts.map((p) => obj(obj(p).functionResponse)).find((f) => Object.keys(f).length);
  const result = res ? resultOf(res) : undefined;
  const images = [...(result?.images ?? []), ...imagesOf(parts)];
  const status = s(tc.status);
  const display = displayOf(name, tc.resultDisplay);
  const aborted = status === "cancelled" || result?.output === INTERRUPTED_TOOL;
  const error = !aborted && (status === "error" || !!result?.error || !!display.error);
  const output = (display.output ?? result?.output ?? "").replace(/^\[Operation Cancelled\] Reason: /, "");
  const block: ToolBlock = {
    kind: "tool",
    id,
    name: s(tc.displayName).trim() || DISPLAY[name] || name || "tool",
    ...d,
    ...(display.patch ? { patch: display.patch, edit: undefined, input: undefined } : {}),
    ...(display.files ? { files: display.files } : {}),
    ...(display.report ? { report: display.report } : {}),
    ...(display.summary ? { summary: display.summary } : {}),
    ...(output && output !== "(empty)" ? { output: clip(output) } : {}),
    ...(images.length ? { images } : {}),
    ...(error ? { error: true } : {}),
    ...(aborted ? { aborted: true } : {}),
    done: true,
  };
  // undefined fields clear nothing in an update, and only make the block longer
  for (const k of Object.keys(block) as (keyof ToolBlock)[]) if (block[k] === undefined) delete block[k];
  return block;
}

type Described = Pick<ToolBlock, "summary" | "input" | "edit" | "report">;

const fileOf = (a: Record<string, any>) => s(a.file_path) || s(a.path) || s(a.absolute_path);
const where = (a: Record<string, any>) => s(a.dir_path) || s(a.path);

/** A tool call's one-line summary and the parts worth showing, from its name and arguments. */
export function describe(name: string, a: Record<string, any>, tc: Record<string, any> = {}): Described {
  // what Gemini CLI says the call does ("ls -la", "notes.md: a => b"); a call that failed its checks has the tool's
  // documentation instead (sentences: "Reads and returns the content of a specified file. …")
  const said = s(tc.description).trim();
  const fallback = said.length <= 100 && !said.includes("\n") && !/\.$/.test(said) ? said : "";
  switch (name) {
    case "run_shell_command": {
      const cmd = s(a.command);
      return { summary: oneLine(cmd) || fallback, ...(cmd.length > 160 || cmd.includes("\n") ? { input: cmd } : {}) };
    }
    case "read_file": {
      const f = fileOf(a);
      const range = a.start_line || a.end_line ? ` @${a.start_line ?? 1}${a.end_line ? `-${a.end_line}` : ""}` : "";
      return { summary: f ? `${f}${range}` : fallback };
    }
    case "write_file": {
      const f = fileOf(a);
      return f ? { summary: f, edit: { path: f, before: "", after: clip(str(a.content), MAX_REPORT) } } : { summary: fallback };
    }
    case "replace": {
      const f = fileOf(a);
      if (!f) return { summary: fallback };
      return { summary: f, ...(a.old_string !== undefined || a.new_string !== undefined ? { edit: { path: f, before: clip(str(a.old_string), MAX_REPORT), after: clip(str(a.new_string), MAX_REPORT) } } : {}) };
    }
    case "glob":
    case "grep_search": {
      const p = s(a.pattern);
      const inc = s(a.include_pattern);
      const dir = where(a);
      return { summary: p ? oneLine(`${p}${inc ? ` (${inc})` : ""}${dir ? ` in ${dir}` : ""}`) : fallback };
    }
    case "list_directory":
      return { summary: where(a) || fallback };
    case "read_many_files": {
      const files = [...arr(a.paths), ...arr(a.include)].map(str);
      return { summary: oneLine(files.join(", ")) || fallback };
    }
    case "web_fetch": {
      const prompt = s(a.prompt) || s(a.url);
      const url = prompt.match(/https?:\/\/[^\s"'<>)]+/)?.[0];
      return { summary: url ?? (oneLine(prompt) || fallback), ...(prompt && prompt !== url ? { input: prompt } : {}) };
    }
    case "google_web_search":
      return { summary: oneLine(s(a.query)) || fallback };
    case "write_todos": {
      const todos = arr(a.todos);
      const report = checklist(todos);
      const active = todos.find((t) => t?.status === "in_progress");
      return { summary: active ? oneLine(s(active.description), 120) : `${todos.length} todo${todos.length === 1 ? "" : "s"}`, ...(report ? { report } : {}) };
    }
    case "invoke_agent": {
      const agent = s(a.agent_name) || s(a.name) || "agent";
      const prompt = s(a.prompt) || s(a.task) || s(a.objective);
      return { summary: oneLine(prompt ? `${agent}: ${prompt}` : agent), ...(prompt.length > 100 ? { input: prompt } : {}) };
    }
    case "ask_user": {
      const qs = arr(a.questions);
      if (!qs.length) break;
      const input = qs.map((q: any) => [s(q?.question), ...arr(q?.options).map((o: any) => `- ${s(o?.label) || str(o)}`)].join("\n")).join("\n\n");
      return { summary: oneLine(qs.map((q: any) => s(q?.question)).join(" · ")), input };
    }
    case "activate_skill":
      return { summary: s(a.name) || fallback };
    case "enter_plan_mode":
      return { summary: oneLine(s(a.reason)) || fallback };
    case "exit_plan_mode":
      return { summary: s(a.plan_filename) || fallback };
    case "complete_task": {
      const result = a.result === undefined ? "" : str(a.result);
      return { summary: oneLine(result, 120) || fallback, ...(result.length > 120 ? { report: clip(result, MAX_REPORT) } : {}) };
    }
  }
  if (fallback) return { summary: fallback };
  const all = str(a);
  if (all === "{}" || !all) return { summary: "" };
  return { summary: oneLine(all), ...(all.length > 160 ? { input: all } : {}) };
}

interface Shown {
  output?: string;
  patch?: string;
  files?: string[];
  report?: string;
  summary?: string;
  error?: boolean;
}

/** What Gemini CLI shows for a finished call (resultDisplay): a diff, a shell's screen, a subagent's report, … */
function displayOf(name: string, d: unknown): Shown {
  if (typeof d === "string") {
    // the shell's output as shown (without the "Output: … Exit Code:" the model gets)
    if (name === "run_shell_command") return d.trim() ? { output: d } : {};
    // the answers ("**User answered:**\n  Format: Which output format?\n    → Plain text")
    if (name === "ask_user" && d.trim()) return { report: clip(d, MAX_REPORT) };
    return {};
  }
  // the shell's screen, as lines of styled tokens
  if (Array.isArray(d)) {
    const lines = d.map((line) => (Array.isArray(line) ? line.map((t: any) => s(t?.text)).join("") : s(line)).trimEnd());
    while (lines.length && !lines.at(-1)) lines.pop();
    while (lines.length && !lines[0]) lines.shift();
    return lines.length ? { output: lines.join("\n") } : {};
  }
  const o = obj(d);
  if (typeof o.fileDiff === "string") {
    const path = s(o.filePath) || s(o.fileName) || "file";
    const shown = s(o.fileName) || path;
    const patch = fileDiffToPatch(o.fileDiff, shown, !!o.isNewFile);
    const st = obj(o.diffStat);
    const counts = typeof st.model_added_lines === "number" && typeof st.model_removed_lines === "number" ? ` (+${st.model_added_lines} −${st.model_removed_lines})` : "";
    return { ...(patch ? { patch } : {}), files: [path], ...(counts ? { summary: `${shown}${counts}` } : {}) };
  }
  if (o.isSubagentProgress) {
    const result = typeof o.result === "string" ? o.result : o.result !== undefined ? str(o.result) : "";
    return { ...(result.trim() ? { report: clip(result, MAX_REPORT) } : {}), ...(o.state === "error" ? { error: true } : {}) };
  }
  if (Array.isArray(o.todos)) {
    const report = checklist(o.todos);
    return report ? { report } : {};
  }
  return {};
}

/** Gemini CLI's diff ("Index: …", "=====", "--- f\tCurrent", "+++ f\tProposed", hunks) as a unified diff. */
export function fileDiffToPatch(diff: string, path: string, isNew = false): string | undefined {
  const out: string[] = [];
  let hunks = false;
  for (const line of diff.split("\n")) {
    if (!hunks && (line.startsWith("Index: ") || /^=+$/.test(line))) continue;
    if (!hunks && line.startsWith("--- ")) out.push(isNew ? "--- /dev/null" : `--- a/${path}`);
    else if (!hunks && line.startsWith("+++ ")) out.push(`+++ b/${path}`);
    else if (line.startsWith("\\ No newline")) continue;
    else {
      if (line.startsWith("@@")) hunks = true;
      out.push(line);
    }
  }
  while (out.length && !out.at(-1)) out.pop();
  return hunks ? out.join("\n") : undefined;
}

function checklist(todos: any[]): string | undefined {
  const items = todos.filter((t) => s(t?.description).trim());
  if (!items.length) return undefined;
  return items
    .map((t) => {
      const d = oneLine(s(t.description), 300);
      if (t.status === "completed") return `- [x] ${d}`;
      if (t.status === "in_progress") return `- [ ] **${d}**`;
      if (t.status === "cancelled") return `- [ ] ~~${d}~~`;
      return `- [ ] ${d}`;
    })
    .join("\n");
}

/** A functionResponse: its text (output, or error), and images it carries. */
function resultOf(f: Record<string, any>): Result {
  const resp = obj(f.response);
  const error = resp.error !== undefined && resp.error !== null && resp.error !== "";
  const rest = Object.fromEntries(Object.entries(resp).filter(([k]) => k !== BINARY_KEY));
  let output = error ? str(resp.error) : resp.output !== undefined ? str(resp.output) : Object.keys(rest).length ? str(rest) : "";
  // the shell's answer to the model: "<untrusted_context>\nOutput: …\nExit Code: 1\nProcess Group PGID: …\n</untrusted_context>"
  const exit = output.match(/\nExit Code: (-?\d+)/);
  const shell = output.match(/^(?:<untrusted_context>\n)?Output: ([\s\S]*?)(?:\n(?:Error|Exit Code|Signal|Background PIDs|Process Group PGID): [\s\S]*)?$/);
  if (shell) output = shell[1]!.replace(/\n?<\/untrusted_context>$/, "");
  const images = [...imagesOf(arr(resp[BINARY_KEY])), ...imagesOf(arr(f.parts))];
  return { id: s(f.id), name: s(f.name), output, error: error || (!!exit && exit[1] !== "0"), images };
}

// ---------------------------------------------------------------------------------------------
// History rewritten: rewinds, patches, compression.

/** A message's entries (and its tool blocks), taken out of the view and forgotten. */
function dropMsg(id: string, st: GState): string[] {
  const msg = st.msgs.get(id);
  if (!msg) return [];
  st.msgs.delete(id);
  const keys = [...msg.keys];
  for (const t of msg.tools) {
    const tool = st.tools.get(t);
    if (tool) keys.push(tool.key);
    st.tools.delete(t);
  }
  return keys;
}

/**
 * {$rewindTo}: the message and everything after it left Gemini's history. Right after "Request cancelled." (Esc: the
 * whole turn is taken back) they stay shown, as on Gemini's screen. A single prompt taken back may have failed (an
 * error notice comes next, and Gemini's screen keeps it): decided on the next message. Otherwise the user rewound.
 */
function rewindOps(id: string, ctx: ParseCtx, st: GState): ChatOp[] {
  const ids = [...st.msgs.keys()];
  const i = ids.indexOf(id);
  // not known: the rewind reaches before what was read; everything read so far is gone
  const gone = i < 0 ? ids : ids.slice(i);
  if (st.cancel && gone.includes(st.cancel.id)) {
    const c = st.cancel;
    for (const g of gone) forget(g, st);
    // the notice says what happened to the turn
    return [
      { op: "remove", keys: [c.key] },
      ...add(ctx, { kind: "notice", text: "Request cancelled", tone: "warn", detail: "The interrupted turn was taken back: Gemini no longer has it in the conversation." }),
    ];
  }
  if (gone.length === 1 && st.msgs.get(gone[0]!)?.type === "user" && !st.msgs.get(gone[0]!)!.detached) {
    st.undecided = gone;
    return [];
  }
  const keys = gone.flatMap((g) => dropMsg(g, st));
  return keys.length ? [{ op: "remove", keys }] : [];
}

/** The pending rewind of one prompt: kept (it failed, `keep`) or removed (the user rewound it). */
function decide(st: GState, keep: boolean): ChatOp[] {
  const ids = st.undecided;
  st.undecided = undefined;
  if (!ids) return [];
  if (keep) {
    for (const id of ids) forget(id, st);
    return [];
  }
  const keys = ids.flatMap((id) => dropMsg(id, st));
  return keys.length ? [{ op: "remove", keys }] : [];
}

function patchOps(p: Record<string, any>, ctx: ParseCtx, st: GState): ChatOp[] {
  const ops: ChatOp[] = [...decide(st, false)];
  const compact = st.compact;
  const removeIds = arr(p.removeIds).filter((x): x is string => typeof x === "string");
  if (compact) {
    // the end of a compression: the old turns stay shown above the divider, unless they were not read (then the
    // copies of the kept turns are shown in their place)
    st.compact = undefined;
    const shown = removeIds.some((id) => !compact.ids.has(id) && st.msgs.get(id)?.type === "user" && st.msgs.get(id)!.keys.length);
    if (shown)
      for (const id of compact.ids) {
        const msg = st.msgs.get(id);
        if (msg) Object.assign(msg, { hidden: true, keys: [], sigs: [] });
      }
    else ops.push(...compact.ops);
    for (const id of removeIds) if (!compact.ids.has(id)) forget(id, st);
  } else if (removeIds.length) {
    // what Gemini CLI drops from its history stays on its screen: notices, declined calls, a cancelled turn; only
    // turns replaced by another history (/chat resume <tag>) go, unless "Request cancelled." came before
    const cancelled = !!st.cancel && removeIds.includes(st.cancel.id);
    const keys: string[] = [];
    for (const id of removeIds) {
      const msg = st.msgs.get(id);
      if (!msg) continue;
      if (cancelled || (msg.type !== "user" && msg.type !== "gemini")) forget(id, st);
      else keys.push(...dropMsg(id, st));
    }
    if (keys.length) ops.push({ op: "remove", keys });
  }
  st.cancel = undefined;
  // content written again: shown again when what it shows changed
  const updates = [...(typeof p.id === "string" ? [p] : []), ...arr(p.updates)].filter((u) => typeof u?.id === "string");
  for (const u of updates) {
    const msg = st.msgs.get(u.id);
    if (!msg || msg.detached) continue;
    if (u.content !== undefined) ops.push(...messageOps({ id: u.id, type: msg.type, content: u.content, thoughts: msg.thoughts, displayContent: msg.displayContent }, ctx, st));
    for (const tc of arr(u.toolCalls)) {
      const f = arr(tc?.result).map((x) => obj(obj(x).functionResponse)).find((x) => Object.keys(x).length);
      if (f) ops.push(...resultOps({ ...resultOf(f), id: s(tc.id) }, msg, undefined, ctx, st));
    }
  }
  return ops;
}

/** A message no longer in Gemini's history whose entries stay shown (in order: a rewind past it takes them out). */
function forget(id: string, st: GState) {
  const msg = st.msgs.get(id);
  if (msg) msg.detached = true;
}

/** A compression whose old turns were never removed (or a timeout): the held-back copies are shown after all. */
function endCompaction(st: GState): ChatOp[] {
  const c = st.compact;
  if (!c) return [];
  st.compact = undefined;
  return c.ops;
}

/** The whole history replaced ($set messages, an old single-JSON session converted). */
function replaceAll(messages: any[], ctx: ParseCtx, st: GState): ChatOp[] {
  const keys = [...st.msgs.keys()].flatMap((id) => dropMsg(id, st));
  const ops: ChatOp[] = keys.length ? [{ op: "remove", keys }] : [];
  for (const m of messages) if (m && typeof m === "object" && typeof m.id === "string") ops.push(...messageOps(m, ctx, st));
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Footer.

function metaOps(st: GState, patch: ChatMeta): ChatOp[] {
  const changed: ChatMeta = {};
  for (const [k, v] of Object.entries(patch) as [keyof ChatMeta, any][]) {
    if (v === undefined || st.meta[k] === v) continue;
    (changed as any)[k] = v;
    (st.meta as any)[k] = v;
  }
  return Object.keys(changed).length ? [{ op: "meta", meta: changed }] : [];
}

// ---------------------------------------------------------------------------------------------
// Content.

/** A message's content as parts: a string is one text part. */
function partsOf(content: unknown): any[] {
  if (typeof content === "string") return [{ text: content }];
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? { text: p } : p));
  return content && typeof content === "object" ? [content] : [];
}

/** The text of parts (not thoughts). */
const textOf = (parts: any[]) =>
  parts
    .filter((p) => !p?.thought && typeof p?.text === "string")
    .map((p) => p.text)
    .join("");

/** The text the user typed, without the files an "@path" reference read into the message. */
function stripReferences(text: string) {
  const i = text.indexOf(REF_START);
  if (i < 0) return text;
  const j = text.indexOf(REF_END, i);
  return (text.slice(0, i) + (j < 0 ? "" : text.slice(j + REF_END.length))).trim();
}

/** Images in parts ({inlineData: {mimeType, data}}), as data: URLs (too large ones are left out). */
function imagesOf(parts: any[]): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const d = obj(p?.inlineData);
    const mime = s(d.mimeType) || s(d.mime_type);
    if (!mime.startsWith("image/") || typeof d.data !== "string" || !d.data) continue;
    const url = `data:${mime};base64,${d.data}`;
    if (url.length <= MAX_IMAGE) out.push(url);
  }
  return out;
}
