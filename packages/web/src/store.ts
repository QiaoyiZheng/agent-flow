// Client state: one WebSocket to the af server. Team state is rebuilt with the same reducer the server uses.

import { useSyncExternalStore } from "react";
import { type ClientPush, type Delivery, type HerdrModel, type Notice, type OpenAppName, type OpenSettings, type QueuedMessage, type ServerPush, type TeamState, type TeamSummary, type ViewRec, applyTeam } from "@af/core";

const params = new URLSearchParams(location.search);
export const TOKEN = params.get("token") ?? localStorage.getItem("af-token") ?? "";
if (params.get("token")) localStorage.setItem("af-token", TOKEN);

type TermListener = (m: Extract<ServerPush, { type: "term.frame" | "term.closed" }>) => void;
type ChatListener = (m: Extract<ServerPush, { type: "chat.reset" | "chat.ops" | "chat.prepend" }>) => void;
const chatSubs = new Map<string, ChatListener>();
export function onChat(id: string, fn: ChatListener) {
  chatSubs.set(id, fn);
  return () => chatSubs.delete(id);
}

interface State {
  connected: boolean;
  teams: TeamSummary[];
  teamId?: string;
  team?: TeamState;
  /** bumps on every applied event so components re-render */
  version: number;
  herdr?: HerdrModel;
  views: Record<string, ViewRec>;
  /** Messages waiting for their agent's turn to end, by pane. */
  queue: Record<string, QueuedMessage[]>;
  /** Ids of teams and old runs: agents named "<id>-…" were dispatched by a session (see ServerPush herdr). */
  dispatchers: string[];
  /** Documents agents handed over (af deliver), how they open, and which apps this Mac has. */
  deliveries: Delivery[];
  openSettings?: OpenSettings;
  apps: Partial<Record<OpenAppName, boolean>>;
  /** Errors and warnings from the server and from actions in this page, oldest first. */
  notices: Notice[];
  /** Notices seen in the list (for the unread badge). */
  seenNotices: number;
}

let state: State = { connected: false, teams: [], version: 0, views: {}, queue: {}, dispatchers: [], deliveries: [], apps: {}, notices: [], seenNotices: 0 };
const subs = new Set<() => void>();
const termSubs = new Map<string, TermListener>();
let ws: WebSocket | undefined;
let queue: string[] = [];

function set(patch: Partial<State>) {
  state = { ...state, ...patch, version: state.version + 1 };
  subs.forEach((f) => f());
}

export function send(msg: ClientPush) {
  const s = JSON.stringify(msg);
  if (ws?.readyState === WebSocket.OPEN) ws.send(s);
  else queue.push(s);
}

/**
 * Views with something open on the server (a chat, a terminal stream) re-open it when the connection comes back:
 * after a server restart the new connection has none of them, and a dead server never says the old ones ended.
 */
const reconnectSubs = new Set<() => void>();
export function onReconnect(fn: () => void) {
  reconnectSubs.add(fn);
  return () => reconnectSubs.delete(fn);
}
let everOpened = false;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${TOKEN}`);
  ws.onopen = () => {
    set({ connected: true });
    if (state.teamId) send({ type: "watch", team: state.teamId });
    // re-open chats and terminal streams first: keys typed during the outage need their terminal open again
    if (everOpened) for (const f of [...reconnectSubs]) f();
    everOpened = true;
    queue.forEach((m) => ws!.send(m));
    queue = [];
  };
  ws.onclose = () => {
    if (state.connected) notify("warn", "Lost the connection to the agent-flow server; reconnecting", undefined, "ui:server");
    set({ connected: false });
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data) as ServerPush;
    switch (m.type) {
      case "hello": {
        set({ teams: m.teams });
        if (state.teamId && !m.teams.some((r) => r.id === state.teamId)) watch(undefined);
        break;
      }
      case "notices":
        set({ notices: [...m.list, ...state.notices.filter((n) => n.source.startsWith("ui"))], seenNotices: m.list.length });
        break;
      case "notice":
        addNotice(m.notice);
        break;
      case "deliveries":
        set({ deliveries: m.list, openSettings: m.settings, apps: m.apps });
        break;
      case "herdr":
        set({ herdr: m.model, views: m.views, queue: m.queue ?? {}, dispatchers: m.dispatchers ?? state.dispatchers });
        break;
      case "snapshot":
        if (m.team === state.teamId) set({ team: m.state });
        break;
      case "event":
        if (m.team === state.teamId && state.team) {
          applyTeam(state.team, m.event);
          set({});
        }
        break;
      case "term.frame":
      case "term.closed":
        termSubs.get(m.id)?.(m);
        break;
      case "chat.reset":
      case "chat.ops":
      case "chat.prepend":
        chatSubs.get(m.id)?.(m);
        break;
    }
  };
}

/** Follow one team's events (its tickets, queue, attention). undefined stops following. */
export function watch(teamId: string | undefined) {
  if (teamId === state.teamId) return;
  set({ teamId, team: undefined });
  if (teamId) send({ type: "watch", team: teamId });
}

export function onTerm(id: string, fn: TermListener) {
  termSubs.set(id, fn);
  return () => termSubs.delete(id);
}

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));

/** The whole client state. `state` is replaced (never mutated in place) on every change, so this re-renders correctly. */
export function useStore(): State {
  return useSyncExternalStore(subscribe, () => state);
}

export const getState = () => state;

function addNotice(n: Notice) {
  set({ notices: [...state.notices.filter((x) => x.id !== n.id), n].slice(-300) });
}

let uiSeq = 0;
/** Show an error, warning or note to the user (toast + the notices list). */
export function notify(level: Notice["level"], text: string, detail?: string, source = "ui") {
  addNotice({ id: `ui${++uiSeq}`, level, source, text, detail, at: new Date().toISOString(), count: 1 });
}

/** For promise chains: `.catch(failed("Could not close the pane"))`. */
export const failed = (what: string) => (e: unknown) => notify("error", what, e instanceof Error ? e.message : String(e));

export function markNoticesSeen() {
  set({ seenNotices: state.notices.length });
}

export function clearNotices() {
  set({ notices: [], seenNotices: 0 });
}

/** Call the HTTP API as the user. */
export async function api<T = any>(method: "GET" | "POST", path: string, body: Record<string, unknown> = {}): Promise<T> {
  const payload = { ...body };
  const url = method === "GET" ? `/api${path}?${new URLSearchParams(Object.entries(payload).filter(([, v]) => v !== undefined) as [string, string][])}` : `/api${path}`;
  const r = await fetch(url, { method, headers: { "content-type": "application/json", "x-af-token": TOKEN }, body: method === "POST" ? JSON.stringify(payload) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message ?? `HTTP ${r.status}`);
  return data as T;
}

/** A file's bytes: this Mac's, or (machine) a remote machine's, read over SSH. */
export const fileUrl = (path: string, machine?: string) => `/api/file?token=${TOKEN}&path=${encodeURIComponent(path)}${machine && machine !== "local" ? `&machine=${encodeURIComponent(machine)}` : ""}`;

connect();

// ---------------------------------------------------------------------------------------------
// opening files in apps on this Mac

export const APP_LABEL: Record<OpenAppName, string> = { vscode: "VS Code", obsidian: "Obsidian", default: "Open", finder: "Finder" };
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const DOCUMENT = /\.(pptx?|key|docx?|pages|xlsx?|numbers|od[tps]|rtf|pdf|epub|zip|mp4|mov|mp3|wav)$/i;
export const fileKindOf = (path: string) => (MARKDOWN.test(path) ? "markdown" : DOCUMENT.test(path) ? "document" : "text");

/** The apps worth offering for a file, the default one first. Remote files: VS Code only. */
export function appsFor(path: string, remote = false): OpenAppName[] {
  if (remote) return state.apps.vscode === false ? [] : ["vscode"];
  const kind = fileKindOf(path);
  const preferred = state.openSettings?.[kind] ?? (kind === "markdown" ? "obsidian" : kind === "text" ? "vscode" : "default");
  const fit: OpenAppName[] = kind === "markdown" ? ["obsidian", "vscode", "default"] : kind === "text" ? ["vscode", "default"] : ["default", "vscode"];
  const list = [preferred, ...fit.filter((a) => a !== preferred)].filter((a) => state.apps[a] !== false);
  return ([...list, "finder"] as OpenAppName[]).filter((a, i, all) => all.indexOf(a) === i && (a !== "finder" || state.apps.finder !== false));
}

export function openIn(app: OpenAppName, path: string, opts: { pane?: string; delivery?: string } = {}) {
  return api("POST", "/open-with", { path, app, pane: opts.pane, delivery: opts.delivery, run: undefined }).catch(failed(`Could not open it in ${APP_LABEL[app]}`));
}
