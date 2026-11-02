import { useState } from "react";
import type { RunState } from "@af/core";
import { activeInstance, latestInstance } from "@af/core";
import { api } from "./store";
import { Terminal } from "./Terminal";
import { DiffView, Messages } from "./Viewers";
import { ago, basename, executorKind, executorLabel, kindColor, nodeLook } from "./view";

type Seg = "overview" | "terminal" | "messages" | "diff" | "opened";

export function NodeDetail({ run, nodeId, onClose, onOpen, onGoTo }: { run: RunState; nodeId: string; onClose: () => void; onOpen: (target: string) => void; onGoTo: (paneId: string) => void }) {
  const [seg, setSeg] = useState<Seg>("overview");
  const [reason, setReason] = useState("");
  const [rejecting, setRejecting] = useState(false);
  const node = run.graph.nodes[nodeId];
  if (!node || node.removed) return null;
  const inst = latestInstance(node);
  const active = activeInstance(node);
  const agent = inst?.agent ? run.agents[inst.agent] : undefined;
  const look = nodeLook(node);
  const opens = run.opens.filter((o) => o.node?.startsWith(`${nodeId}#`));
  const isolated = node.spec.isolation === "isolated" && !!run.meta?.repo;
  const cmd = (command: object) => api("POST", "/graph", { command }).catch((e) => alert(e.message));

  return (
    <div className="detail">
      <div className="panel-head">
        <span style={{ fontFamily: "var(--mono)" }}>{nodeId}</span>
        <span className="pill" style={{ "--pc": kindColor(executorKind(run, node)) } as React.CSSProperties}>
          {executorLabel(node)}
        </span>
        <span className="pill" style={{ "--pc": look.color } as React.CSSProperties}>
          {inst ? `#${inst.n} ` : ""}
          {look.label}
        </span>
        <span className="spacer" />
        <button className="close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="seg">
        {(["overview", "terminal", "messages", ...(isolated ? ["diff"] : []), "opened"] as Seg[]).map((s) => (
          <button key={s} className={seg === s ? "on" : ""} onClick={() => setSeg(s)}>
            {s === "opened" ? `opened${opens.length ? ` ${opens.length}` : ""}` : s}
          </button>
        ))}
      </div>
      <div className="detail-body">
        {seg === "overview" && (
          <>
            <dl className="kv">
              <dt>executor</dt>
              <dd>{executorLabel(node)}</dd>
              <dt>isolation</dt>
              <dd>{node.spec.isolation}</dd>
              <dt>verify</dt>
              <dd>{node.spec.autoAccept ? "auto-accept" : "lead checks"}{node.spec.hold ? " · hold" : ""}</dd>
              {agent && (
                <>
                  <dt>agent</dt>
                  <dd>
                    {agent.name} · {agent.status}
                    {agent.paneId && (
                      <a href="#" style={{ color: "var(--accent)", marginLeft: 8 }} onClick={(e) => (e.preventDefault(), onGoTo(agent.paneId!))}>
                        go to pane
                      </a>
                    )}
                  </dd>
                  <dt>directory</dt>
                  <dd style={{ fontFamily: "var(--mono)", fontSize: 11 }}>{agent.cwd}</dd>
                </>
              )}
            </dl>
            <div className="task">{node.spec.task}</div>
            {[...node.instances].reverse().map((i) => (
              <div className="inst" key={i.n}>
                <div className="h">
                  <span className="mono">
                    {nodeId}#{i.n}
                  </span>
                  <span className="pill">{i.state}</span>
                  <span style={{ color: "var(--text-3)" }}>{i.trigger.type === "back" ? `loop from ${i.inputs[0]?.node}#${i.inputs[0]?.n}` : i.trigger.type}</span>
                  <span style={{ marginLeft: "auto", color: "var(--text-3)" }}>{ago(i.updatedAt)}</span>
                </div>
                {i.submissions.map((s, k) => (
                  <div key={`s${k}`}>
                    <div className="note">
                      {s.outcome && <b>{s.outcome} · </b>}
                      {s.note}
                      {s.result && (
                        <>
                          {" "}
                          ·{" "}
                          <a href="#" onClick={(e) => (e.preventDefault(), onOpen(s.result!))} style={{ color: "var(--accent)" }}>
                            {basename(s.result)}
                          </a>
                        </>
                      )}
                    </div>
                    {i.rejections[k] && <div className="rej">rejected: {i.rejections[k]!.reason}</div>}
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
        {seg === "terminal" &&
          (agent?.paneId ? (
            <>
              <Terminal key={agent.paneId} paneId={agent.paneId} mode="observe" />
              <button className="btn goto" onClick={() => onGoTo(agent.paneId!)}>
                Go to pane ↗
              </button>
            </>
          ) : (
            <div className="empty" style={{ padding: 12 }}>No agent yet.</div>
          ))}
        {seg === "messages" && <Messages run={run} agent={agent?.name} node={nodeId} />}
        {seg === "diff" && <DiffView node={nodeId} />}
        {seg === "opened" && (
          <div className="msgs">
            {!opens.length && <div className="empty" style={{ padding: 12 }}>Nothing opened. Workers can show you files and pages with af open.</div>}
            {opens.map((o) => (
              <div key={o.id} className="row" onClick={() => onOpen(o.target)}>
                <span className="mono">{basename(o.target)}</span>
                <span className="meta">
                  {o.node} · {ago(o.at)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="actions">
        {active?.state === "submitted" && !rejecting && (
          <>
            <button className="btn primary" onClick={() => cmd({ type: "instance.accept", node: nodeId })}>
              Accept
            </button>
            <button className="btn danger" onClick={() => setRejecting(true)}>
              Reject…
            </button>
          </>
        )}
        {rejecting && (
          <form
            style={{ display: "flex", gap: 6, flex: 1 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (!reason.trim()) return;
              cmd({ type: "instance.reject", node: nodeId, reason }).then(() => (setRejecting(false), setReason("")));
            }}
          >
            <input className="text" autoFocus placeholder="What should the worker fix?" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn danger">Reject</button>
            <button type="button" className="btn" onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </form>
        )}
        {active?.state === "ready" && active.held && (
          <button className="btn primary" onClick={() => cmd({ type: "instance.start", node: nodeId })}>
            Start
          </button>
        )}
        {active && !rejecting && (
          <button className="btn" onClick={() => confirm(`Cancel ${nodeId}#${active.n}?`) && cmd({ type: "instance.cancel", node: nodeId })}>
            Cancel instance
          </button>
        )}
        {!active && inst?.state === "cancelled" && (
          <button className="btn" onClick={() => cmd({ type: "instance.retry", node: nodeId })}>
            Retry with a fresh agent
          </button>
        )}
      </div>
    </div>
  );
}
