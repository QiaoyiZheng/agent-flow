import { useState } from "react";
import type { Attention, HerdrModel, RunState, RunSummary } from "@af/core";
import { api } from "./store";
import { kindColor } from "./view";

const KIND_LABEL: Record<Attention["kind"], string> = {
  blocked: "waiting for an answer",
  startup_blocked: "stuck starting",
  merge_conflict: "merge conflict",
  loop_limit: "loop limit",
  agent_exited: "agent stopped",
  no_submit: "did not submit",
  lead: "message for you",
};

const statusDot = (s: string) =>
  s === "working" ? "active" : s === "blocked" ? "needs" : s === "idle" || s === "done" ? "quiet" : s === "exited" ? "stopped" : "";

export function Sidebar({
  herdr,
  runs,
  run,
  hidden,
  selectedWs,
  onSelectWs,
  onSelectPane,
  onSelectRun,
  onNew,
  onAttention,
}: {
  herdr?: HerdrModel;
  runs: RunSummary[];
  run?: RunState;
  hidden: Set<string>;
  selectedWs?: string;
  onSelectWs: (id: string) => void;
  onSelectPane: (workspaceId: string, tabId: string, paneId: string) => void;
  onSelectRun: (runId: string) => void;
  onNew: () => void;
  onAttention: (a: Attention) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const attention = run ? Object.values(run.attention).sort((a, b) => b.at.localeCompare(a.at)) : [];
  const runOf = new Map(runs.filter((r) => r.workspace).map((r) => [r.workspace!, r]));
  const liveWs = new Set(herdr?.workspaces.map((w) => w.id));
  const pastRuns = runs.filter((r) => !r.workspace || !liveWs.has(r.workspace));
  const toggle = (id: string, def: boolean) => setCollapsed((c) => ({ ...c, [id]: !(c[id] ?? def) }));

  return (
    <aside className="side">
      <div className="section">
        <div className="section-title">
          <span>Needs you{run?.meta ? ` · ${run.meta.id}` : ""}</span>
          <span className={`count ${attention.length ? "" : "zero"}`}>{attention.length}</span>
        </div>
        {!attention.length && <div className="empty">{run ? "Nothing waiting on you." : "Select a run to see what it needs."}</div>}
        {attention.map((a) => (
          <div key={a.id} className="needs" onClick={() => onAttention(a)}>
            <div className="k">
              <span>
                {KIND_LABEL[a.kind]}
                {a.agent ? ` · ${a.agent}` : a.node ? ` · ${a.node}` : ""}
              </span>
              <button
                className="x"
                title="Dismiss"
                onClick={(e) => {
                  e.stopPropagation();
                  api("POST", "/attention/dismiss", { id: a.id }).catch((err) => alert(err.message));
                }}
              >
                ✕
              </button>
            </div>
            <div className="t">{a.text}</div>
          </div>
        ))}
      </div>

      <div className="tree">
        <div className="section-title" style={{ padding: "10px 14px 6px" }}>
          <span>Machines</span>
          <button className="tab-add" style={{ margin: 0, padding: "0 6px" }} onClick={onNew} title="New run or workspace">
            +
          </button>
        </div>
        {herdr?.machines.filter((m) => m.available).map((m) => {
          const open = !(collapsed[m.id] ?? false);
          return (
            <div key={m.id}>
              <div className="tree-row machine" onClick={() => toggle(m.id, false)}>
                <span className="caret">{open ? "▾" : "▸"}</span>
                <span>{m.label}</span>
              </div>
              {open &&
                herdr.workspaces
                  .filter((w) => !hidden.has(w.id))
                  .map((w) => {
                    const r = runOf.get(w.id);
                    const panes = herdr.panes.filter((p) => p.workspaceId === w.id);
                    const agents = panes.filter((p) => p.agent);
                    const wsOpen = !(collapsed[w.id] ?? w.id !== selectedWs);
                    return (
                      <div key={w.id}>
                        <div className={`tree-row ws ${w.id === selectedWs ? "active" : ""}`} onClick={() => onSelectWs(w.id)}>
                          <span
                            className="caret"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(w.id, w.id !== selectedWs);
                            }}
                          >
                            {wsOpen ? "▾" : "▸"}
                          </span>
                          <span className={`dot ${statusDot(w.agentStatus)}`} />
                          <span className="name">{w.label}</span>
                          {r && <span className="run-tag" title={`agent-flow run ${r.id}`}>◆ {r.id}</span>}
                          {r && r.attention > 0 ? <span className="count">{r.attention}</span> : <span className="meta">{agents.length || ""}</span>}
                        </div>
                        {wsOpen &&
                          agents.map((p) => (
                            <div key={p.id} className="tree-row agent" onClick={() => onSelectPane(w.id, p.tabId, p.id)}>
                              <span className={`dot ${statusDot(p.agentStatus)}`} />
                              <span className="name mono">{p.agentName?.replace(r ? `${r.id}-` : "\u0000", "") ?? p.label ?? p.agent}</span>
                              <span className="meta" style={{ color: kindColor(p.agent!) }}>
                                {p.agent}
                              </span>
                            </div>
                          ))}
                      </div>
                    );
                  })}
            </div>
          );
        })}
        {(() => {
          const remote = herdr?.machines.filter((m) => !m.available) ?? [];
          if (!remote.length) return null;
          const open = collapsed["ssh"] === false;
          return (
            <>
              <div className="tree-row machine off" style={{ marginTop: 6, cursor: "pointer" }} onClick={() => setCollapsed((c) => ({ ...c, ssh: open }))}>
                <span className="caret">{open ? "▾" : "▸"}</span>
                <span>SSH machines</span>
                <span className="meta">{remote.length}</span>
              </div>
              {open && (
                <>
                  <div className="tree-note">{remote[0]!.note}</div>
                  {remote.map((m) => (
                    <div key={m.id} className="tree-row ws off" title={m.target}>
                      <span className="caret">·</span>
                      <span className="name" style={{ color: "var(--text-3)" }}>
                        {m.label}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </>
          );
        })()}
        {pastRuns.length > 0 && (
          <>
            <div className="section-title" style={{ padding: "14px 14px 6px" }}>
              <span>Past runs</span>
            </div>
            {pastRuns.map((r) => (
              <div key={r.id} className={`tree-row ws ${run?.meta?.id === r.id ? "active" : ""}`} onClick={() => onSelectRun(r.id)}>
                <span className="caret">·</span>
                <span className="dot stopped" />
                <span className="name mono">{r.id}</span>
                <span className="meta">{r.cwd.split("/").at(-1)}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
