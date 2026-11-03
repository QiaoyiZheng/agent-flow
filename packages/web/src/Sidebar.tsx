import { useRef, useState } from "react";
import type { Attention, HerdrModel, RunState, RunSummary } from "@af/core";
import { api, failed, notify } from "./store";

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
  s === "working" ? "active" : s === "blocked" ? "blocked-dot" : s === "idle" || s === "done" ? "quiet" : s === "exited" ? "stopped" : "";

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
  onNew: (machine?: string) => void;
  onAttention: (a: Attention) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [adding, setAdding] = useState(false);
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
                  api("POST", "/attention/dismiss", { id: a.id }).catch(failed("That did not work"));
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
          <span style={{ display: "flex", gap: 2 }}>
            <button className="tab-add" style={{ margin: 0, padding: "0 6px" }} onClick={() => setAdding((v) => !v)} title="Add an SSH machine">
              + machine
            </button>
            <button className="tab-add" style={{ margin: 0, padding: "0 6px" }} onClick={() => onNew()} title="New run or workspace">
              + new
            </button>
          </span>
        </div>
        {adding && <AddMachine onDone={() => setAdding(false)} />}
        {herdr?.machines.map((m) => {
          // remote machines start collapsed and connect when expanded
          const open = !(collapsed[m.id] ?? !m.local);
          const workspaces = herdr.workspaces.filter((w) => w.machine === m.id && !hidden.has(w.id));
          const expand = () => {
            toggle(m.id, !m.local);
            if (!m.local && !open && m.state !== "online") api("POST", "/machine/connect", { machine: m.id }).catch(() => {});
          };
          return (
            <div key={m.id} className={m.local ? "" : "remote-machine"}>
              <div className={`tree-row machine ${m.local ? "" : "remote"}`} onClick={expand} title={m.local ? undefined : `${m.target}${m.error ? ` — ${m.error}` : ""}`}>
                <span className="caret">{open ? "▾" : "▸"}</span>
                {!m.local && <span className={`dot m-${m.state}`} />}
                <span className="name">{m.label}</span>
                {!m.local && <span className="meta">{m.state === "online" ? workspaces.length || "" : m.state === "connecting" ? (workspaces.length ? "reconnecting…" : "connecting…") : m.state === "error" ? "retrying" : ""}</span>}
                <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                  {(m.local || m.state === "online") && (
                    <button title={`New workspace on ${m.label}`} onClick={() => onNew(m.id)}>
                      +
                    </button>
                  )}
                  {!m.local && (
                    <RowMenu id={`m:${m.id}`} open={menu} setOpen={setMenu}>
                      {m.state !== "online" && <div className="item" onClick={() => api("POST", "/machine/connect", { machine: m.id }).catch(failed("That did not work"))}>{m.state === "offline" ? "Connect" : "Retry now"}</div>}
                      {m.state !== "offline" && (
                        <div className="item" onClick={() => api("POST", "/machine/disconnect", { machine: m.id }).catch(failed("That did not work"))}>
                          Disconnect
                        </div>
                      )}
                      <div
                        className="item danger"
                        onClick={() => {
                          if (confirm(`Remove ${m.label} (${m.target}) from the machine list?\n\nIt is removed from Herdr's list too. Its Herdr server and the agents running there keep running; add it again to get back to them.`))
                            api("POST", "/machine/remove", { machine: m.id }).catch(failed("That did not work"));
                        }}
                      >
                        Remove machine…
                      </div>
                    </RowMenu>
                  )}
                </span>
              </div>
              {!m.local && m.state === "error" && (
                <div className="tree-note err">
                  {m.error}
                  <button className="c-more" style={{ marginLeft: 6 }} onClick={() => api("POST", "/machine/connect", { machine: m.id }).catch(() => {})}>
                    retry
                  </button>
                </div>
              )}
              {open && !m.local && m.state === "connecting" && <div className="tree-note">connecting over SSH…</div>}
              {open &&
                !m.local &&
                m.state !== "online" &&
                workspaces.length > 0 && <div className="tree-note">Last known workspaces; reconnecting{m.error ? `: ${m.error}` : "…"}</div>}
              {open &&
                workspaces.map((w) => {
                  const r = runOf.get(w.id);
                  const panes = herdr.panes.filter((p) => p.workspaceId === w.id);
                  const agents = panes.filter((p) => p.agent);
                  return (
                    <div key={w.id} className={!m.local && m.state !== "online" ? "stale" : ""}>
                      <div className={`tree-row ws ${w.id === selectedWs ? "active" : ""}`} onClick={() => onSelectWs(w.id)}>
                        <span className={`dot ${statusDot(w.agentStatus)}`} title={`${agents.length} agent${agents.length === 1 ? "" : "s"} · ${w.agentStatus}`} />
                        {renaming === w.id ? (
                          <RenameInput
                            value={w.label}
                            onDone={(label) => {
                              setRenaming(undefined);
                              if (label !== undefined && label.trim() && label.trim() !== w.label)
                                api("POST", "/workspace/rename", { workspace: w.id, label }).catch(failed("Could not rename the workspace"));
                            }}
                          />
                        ) : (
                          <span
                            className="name"
                            title="Double-click to rename"
                            onDoubleClick={(e) => {
                              e.stopPropagation();
                              if (m.local || m.state === "online") setRenaming(w.id);
                            }}
                          >
                            {w.label}
                          </span>
                        )}
                        {r && <span className="run-tag" title={`agent-flow run ${r.id}`}>◆ {r.id}</span>}
                        {r && r.attention > 0 ? <span className="count">{r.attention}</span> : <span className="meta">{agents.length || ""}</span>}
                        <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                          <RowMenu id={`w:${w.id}`} open={menu} setOpen={setMenu}>
                            {(m.local || m.state === "online") && (
                              <div className="item" onClick={() => setRenaming(w.id)}>
                                Rename…
                              </div>
                            )}
                            <div
                              className="item danger"
                              onClick={() => {
                                const what = [agents.length ? `${agents.length} agent${agents.length > 1 ? "s" : ""}` : "", `${panes.length} pane${panes.length > 1 ? "s" : ""}`].filter(Boolean).join(", ");
                                if (confirm(`Close workspace "${w.label}" on ${m.label}?\n\nThis stops everything running in it (${what})${r ? `, and stops run ${r.id}` : ""}.`))
                                  api("POST", "/workspace/close", { workspace: w.id }).catch(failed("That did not work"));
                              }}
                            >
                              Close workspace…
                            </div>
                          </RowMenu>
                        </span>
                      </div>

                    </div>
                  );
                })}
            </div>
          );
        })}
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

function RowMenu({ id, open, setOpen, children }: { id: string; open?: string; setOpen: (id?: string) => void; children: React.ReactNode }) {
  const on = open === id;
  return (
    <span className="menu-wrap">
      <button title="More" onClick={() => setOpen(on ? undefined : id)}>
        ⋯
      </button>
      {on && (
        <div className="menu" onMouseLeave={() => setOpen(undefined)} onClick={() => setOpen(undefined)}>
          {children}
        </div>
      )}
    </span>
  );
}

function AddMachine({ onDone }: { onDone: () => void }) {
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    api("POST", "/machine/add", { target, label: label || undefined })
      .then(onDone)
      .catch((err) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return (
    <form className="add-machine" onSubmit={submit}>
      <input className="text" autoFocus placeholder="SSH target: myhost or user@host" value={target} onChange={(e) => setTarget(e.target.value)} />
      <input className="text" placeholder="Name (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn primary" disabled={busy || !target.trim()}>
          {busy ? "Adding…" : "Add"}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      <div className="hint">Saved in Herdr's machine list. SSH must work without a password prompt.</div>
      {error && (
        <div className="hint err">
          {error}
          {/approv|install|interactive|confirm/i.test(error) && (
            <>
              {" "}
              <button
                type="button"
                className="c-more"
                onClick={() =>
                  api("POST", "/machine/setup-in-shell", { target, label: label || undefined })
                    .then(() => notify("info", "The setup command is waiting in the persistent shell (ctrl+` to open it). Answer its questions there."))
                    .catch(failed("That did not work"))
                }
              >
                Run the setup in the persistent shell
              </button>
            </>
          )}
        </div>
      )}
    </form>
  );
}

/** Edit a name in place: Enter or leaving the field saves, Esc cancels. */
function RenameInput({ value, onDone }: { value: string; onDone: (label: string | undefined) => void }) {
  const [text, setText] = useState(value);
  const done = useRef(false);
  const finish = (label: string | undefined) => {
    if (done.current) return;
    done.current = true;
    onDone(label);
  };
  return (
    <input
      className="rename-input"
      autoFocus
      value={text}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => finish(text)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) finish(text);
        else if (e.key === "Escape") finish(undefined);
      }}
    />
  );
}
