// Client state: one WebSocket to the af server. Run state is rebuilt with the same reducer the server uses.

import { useSyncExternalStore } from "react";
import { type ClientPush, type RunState, type RunSummary, type ServerPush, applyRun } from "@af/core";

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
}

let state: State = { connected: false, runs: [], version: 0 };
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
        const pick = state.runId ?? params.get("run") ?? m.runs.find((r) => !r.stopped)?.id ?? m.runs[0]?.id;
        if (pick && pick !== state.runId) watch(pick);
        break;
      }
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

export function watch(runId: string) {
  set({ runId, run: undefined });
  send({ type: "watch", run: runId });
  const u = new URL(location.href);
  u.searchParams.set("run", runId);
  history.replaceState(null, "", u);
}

export function onTerm(id: string, fn: TermListener) {
  termSubs.set(id, fn);
  return () => termSubs.delete(id);
}

export function useStore<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => pick(state),
  );
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
