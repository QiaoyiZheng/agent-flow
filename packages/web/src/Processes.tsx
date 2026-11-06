// Process management: every agent agent-flow can stop and resume, with its memory and why it keeps running. Agents
// idle a long time are stopped by the server (sleep.ts); their panes stay as they were, and a message starts them
// again. Here the user sees which ones, changes the limits, and stops or starts one by hand.

import { useEffect, useState } from "react";
import { api, failed, useStore } from "./store";
import { kindColor } from "./view";

interface Row {
  pane: string;
  machine: string;
  workspace: string;
  agent: string;
  name?: string;
  title?: string;
  status: string;
  idleSince?: string;
  memoryMb?: number;
  worker: boolean;
  asleep?: { since: string; reason: string };
  keep?: string;
  due?: string;
}
interface Settings {
  enabled: boolean;
  idleHours: number;
  workerMinutes: number;
  remote: boolean;
}

const KINDS = new Set(["claude", "codex", "omp", "gemini"]);

const span = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 6) / 10} h` : `${Math.round(m / 144) / 10} d`;
};
const ago = (iso?: string) => (Date.parse(iso ?? "") ? span(Date.now() - Date.parse(iso!)) : "");
const until = (iso: string) => span(Date.parse(iso) - Date.now());
const gb = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);

/** The footer button: how many agents run and how many are stopped; opens the list. */
export function ProcessesButton({ onGoTo }: { onGoTo: (paneId: string) => void }) {
  const { herdr } = useStore();
  const [open, setOpen] = useState(false);
  const agents = (herdr?.panes ?? []).filter((p) => p.agent && KINDS.has(p.agent));
  const asleep = agents.filter((p) => p.asleep).length;
  return (
    <span className="notices-wrap">
      <button className="notices-btn" title="Agent processes: memory, idle time; idle agents are stopped and resumed on your next message" onClick={() => setOpen((o) => !o)}>
        {agents.length - asleep} running{asleep ? ` · ${asleep} asleep` : ""}
      </button>
      {open && <ProcessesPanel onClose={() => setOpen(false)} onGoTo={onGoTo} />}
    </span>
  );
}

function ProcessesPanel({ onClose, onGoTo }: { onClose: () => void; onGoTo: (paneId: string) => void }) {
  const [rows, setRows] = useState<Row[]>();
  const [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState<string>();
  const load = () =>
    api<{ rows: Row[]; settings: Settings }>("GET", "/processes")
      .then((r) => {
        setRows(r.rows);
        setSettings((s) => s ?? r.settings);
      })
      .catch(failed("Could not list the agents"));
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const save = (s: Partial<Settings>) =>
    api<{ settings: Settings }>("POST", "/process-settings", s)
      .then((r) => setSettings(r.settings))
      .catch(failed("Could not save"));
  const act = (row: Row, what: "sleep" | "wake") => {
    setBusy(row.pane);
    api("POST", `/pane/${what}`, { pane: row.pane })
      .then(load)
      .catch(failed(what === "sleep" ? "Not stopped" : "Could not start it"))
      .finally(() => setBusy(undefined));
  };
  const running = (rows ?? []).filter((r) => !r.asleep).sort((a, b) => (b.memoryMb ?? 0) - (a.memoryMb ?? 0));
  const asleep = (rows ?? []).filter((r) => r.asleep);
  // what matters for this Mac's memory: its own agents (other machines' agents use theirs)
  const total = running.filter((r) => r.machine === "local").reduce((s, r) => s + (r.memoryMb ?? 0), 0);
  const item = (r: Row) => (
    <div key={r.pane} className={`proc-row ${r.asleep ? "asleep" : ""}`}>
      <i className="proc-dot" style={{ background: kindColor(r.agent) }} />
      <div className="proc-main">
        <div className="proc-name">
          <button className="link" onClick={() => onGoTo(r.pane)} title="Go to its pane">
            {r.name ?? r.agent}
          </button>
          <span className="proc-ws">
            {r.workspace}
            {r.machine !== "local" && ` · ${r.machine}`}
            {r.worker && " · worker"}
          </span>
        </div>
        {r.title && <div className="proc-title">{r.title}</div>}
        <div className="proc-why">
          {r.asleep
            ? `stopped ${ago(r.asleep.since)} ago (${r.asleep.reason}); your next message resumes it`
            : r.keep
              ? `${r.keep}${r.due ? ` · stopped in ${until(r.due)} if it stays idle` : ""}`
              : "will be stopped at the next check"}
        </div>
      </div>
      <span className="proc-mem">{r.memoryMb !== undefined && !r.asleep ? gb(r.memoryMb) : ""}</span>
      {r.asleep ? (
        <button className="c-more" disabled={busy === r.pane} onClick={() => act(r, "wake")} title="Start it again on its conversation now">
          {busy === r.pane ? "starting…" : "resume"}
        </button>
      ) : (
        <button className="c-more" disabled={busy === r.pane || r.status === "working"} onClick={() => act(r, "sleep")} title="Stop its process now; its pane stays, and your next message resumes it">
          {busy === r.pane ? "stopping…" : "stop"}
        </button>
      )}
    </div>
  );
  return (
    <div className="notices-panel proc-panel">
      <div className="notices-head">
        <b>Agents</b>
        <span className="proc-ws">
          {running.length} running{total ? ` · ${gb(total)} on this Mac` : ""}
          {asleep.length ? ` · ${asleep.length} asleep` : ""}
        </span>
        <span className="spacer" />
        <button className="c-more" onClick={onClose}>
          close
        </button>
      </div>
      {settings && (
        <div className="proc-settings">
          <label>
            <input type="checkbox" checked={settings.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> Stop idle agents after
          </label>
          <input type="number" min={1} value={settings.idleHours} onChange={(e) => setSettings({ ...settings, idleHours: Number(e.target.value) })} onBlur={() => save({ idleHours: settings.idleHours })} /> h; finished dispatched workers after
          <input type="number" min={1} value={settings.workerMinutes} onChange={(e) => setSettings({ ...settings, workerMinutes: Number(e.target.value) })} onBlur={() => save({ workerMinutes: settings.workerMinutes })} /> min.
          <label className="proc-remote">
            <input type="checkbox" checked={settings.remote} onChange={(e) => save({ remote: e.target.checked })} /> also on other machines
          </label>
          <div className="proc-note">Never while it runs a background task, a Monitor, a schedule or a process it started. Its page stays; a message resumes it.</div>
        </div>
      )}
      <div className="notices-list">
        {!rows && <div className="empty" style={{ padding: 12 }}>Looking…</div>}
        {rows && !rows.length && <div className="empty" style={{ padding: 12 }}>No agents.</div>}
        {running.map(item)}
        {asleep.length > 0 && <div className="proc-group">Asleep</div>}
        {asleep.map(item)}
      </div>
    </div>
  );
}
