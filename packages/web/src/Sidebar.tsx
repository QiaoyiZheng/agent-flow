import type { Attention, RunState, RunSummary } from "@af/core";
import { api, watch } from "./store";
import { ago, basename, kindColor } from "./view";

const KIND_LABEL: Record<Attention["kind"], string> = {
  blocked: "waiting for an answer",
  startup_blocked: "stuck starting",
  merge_conflict: "merge conflict",
  loop_limit: "loop limit",
  agent_exited: "agent stopped",
  no_submit: "did not submit",
  lead: "message for you",
};

export function Sidebar({
  runs,
  runId,
  run,
  onNewRun,
  onAttention,
  onAgent,
}: {
  runs: RunSummary[];
  runId?: string;
  run?: RunState;
  onNewRun: () => void;
  onAttention: (a: Attention) => void;
  onAgent: (name: string) => void;
}) {
  const attention = run ? Object.values(run.attention).sort((a, b) => b.at.localeCompare(a.at)) : [];
  const agents = run ? Object.values(run.agents) : [];
  return (
    <aside className="side">
      <div className="section">
        <div className="section-title">
          <span>Needs you</span>
          <span className={`count ${attention.length ? "" : "zero"}`}>{attention.length}</span>
        </div>
        {!attention.length && <div className="empty">Nothing waiting on you.</div>}
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

      {run && (
        <div className="section">
          <div className="section-title">
            <span>Agents</span>
            <span className="count zero">{agents.filter((a) => a.status !== "exited").length}</span>
          </div>
          {agents.map((a) => (
            <div key={a.name} className="row" onClick={() => onAgent(a.name)} style={{ opacity: a.status === "exited" ? 0.45 : 1 }}>
              <span className={`dot ${a.status === "working" ? "active" : a.status === "blocked" ? "" : a.status === "exited" ? "stopped" : "quiet"}`} style={a.status === "blocked" ? { background: "var(--s-needs)" } : undefined} />
              <span className="mono">{a.name}</span>
              <span className="meta" style={{ color: kindColor(a.kind) }}>
                {a.kind}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="section" style={{ marginTop: "auto", borderTop: "1px solid var(--line)" }}>
        <div className="section-title">
          <span>Runs</span>
          <button className="tab-add" style={{ margin: 0, padding: "0 6px" }} onClick={onNewRun} title="New run">
            +
          </button>
        </div>
        {runs.map((r) => (
          <div key={r.id} className={`row ${r.id === runId ? "active" : ""}`} onClick={() => watch(r.id)}>
            <span className={`dot ${r.stopped ? "stopped" : r.quiescent ? "quiet" : "active"}`} />
            <span className="mono">{r.id}</span>
            <span style={{ color: "var(--text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{basename(r.cwd)}</span>
            <span className="meta">{r.attention ? <span className="count">{r.attention}</span> : ago(r.createdAt)}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
