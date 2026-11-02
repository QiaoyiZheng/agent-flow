// Client state: one WebSocket to the af server. Run state is rebuilt with the same reducer the server uses.

import { useSyncExternalStore } from "react";
import { type ClientPush, type HerdrModel, type RunState, type RunSummary, type ServerPush, type ViewRec, applyRun } from "@af/core";

const params = new URLSearchParams(location.search);
export const TOKEN = params.get("token") ?? localStorage.getItem("af-token") ?? "";
if (params.get("token")) localStorage.setItem("af-token", TOKEN);

type TermListener = (m: Extract<ServerPush, { type: "term.frame" | "term.closed" }>) => void;

interface State {
  connected: boolean;
  runs: RunSummary[];
  runId?: string;
  run?: RunState;
  /** bumps on every applied event so components re-render */
  version: number;
  herdr?: HerdrModel;
  views: Record<string, ViewRec>;
}

let state: State = { connected: false, runs: [], version: 0, views: {} };
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

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${TOKEN}`);
  ws.onopen = () => {
    set({ connected: true });
    if (state.runId) send({ type: "watch", run: state.runId });
    queue.forEach((m) => ws!.send(m));
    queue = [];
  };
  ws.onclose = () => {
    set({ connected: false });
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data) as ServerPush;
    switch (m.type) {
      case "hello": {
        set({ runs: m.runs });
        if (state.runId && !m.runs.some((r) => r.id === state.runId)) watch(undefined);
        break;
      }
      case "herdr":
        set({ herdr: m.model, views: m.views });
        break;
      case "snapshot":
        if (m.run === state.runId) set({ run: m.state });
        break;
      case "event":
        if (m.run === state.runId && state.run) {
          applyRun(state.run, m.event);
          set({});
        }
        break;
      case "term.frame":
      case "term.closed":
        termSubs.get(m.id)?.(m);
        break;
    }
  };
}

/** Follow one run's events (its graph, mail, attention). undefined stops following. */
export function watch(runId: string | undefined) {
  if (runId === state.runId) return;
  set({ runId, run: undefined });
  if (runId) send({ type: "watch", run: runId });
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

/** Call the HTTP API as the user. */
export async function api<T = any>(method: "GET" | "POST", path: string, body: Record<string, unknown> = {}): Promise<T> {
  const payload = { run: state.runId, ...body };
  const url = method === "GET" ? `/api${path}?${new URLSearchParams(Object.entries(payload).filter(([, v]) => v !== undefined) as [string, string][])}` : `/api${path}`;
  const r = await fetch(url, { method, headers: { "content-type": "application/json", "x-af-token": TOKEN }, body: method === "POST" ? JSON.stringify(payload) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.message ?? `HTTP ${r.status}`);
  return data as T;
}

export const fileUrl = (path: string) => `/api/file?token=${TOKEN}&path=${encodeURIComponent(path)}`;

connect();
