import { useEffect, useMemo, useRef, useState } from "react";
import type { Attention, HPane, HerdrModel, RunState, RunSummary } from "@af/core";
import { api, failed, notify as notifyUser } from "./store";

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
  onNeed,
  seen,
  onSeen,
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
  onNeed: (n: Need) => void;
  /** When the user last saw each pane (statusAt of the "done" they saw). */
  seen: Record<string, string>;
  onSeen: (paneId: string, at: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<string>();
  const [renaming, setRenaming] = useState<string>();
  const [adding, setAdding] = useState(false);
  const runOf = new Map(runs.filter((r) => r.workspace).map((r) => [r.workspace!, r]));
  const liveWs = new Set(herdr?.workspaces.map((w) => w.id));
  const pastRuns = runs.filter((r) => !r.workspace || !liveWs.has(r.workspace));
  const toggle = (id: string, def: boolean) => setCollapsed((c) => ({ ...c, [id]: !(c[id] ?? def) }));

  return (
    <aside className="side">
      <NeedsYou herdr={herdr} runs={runs} hidden={hidden} seen={seen} onSeen={onSeen} onNeed={onNeed} />

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
                {!m.local && <span className="meta">{m.state === "connecting" ? (workspaces.length ? "reconnecting…" : "connecting…") : m.state === "error" ? "retrying" : ""}</span>}
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
                        <span className="row-gap" />
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
      <button className="kebab" title="More" onClick={() => setOpen(on ? undefined : id)}>
        ⋮
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
                    .then(() => notifyUser("info", "The setup command is waiting in the persistent shell (ctrl+` to open it). Answer its questions there."))
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

/** One thing waiting on the user, from any run, workspace or machine. */
export interface Need {
  key: string;
  kind: "attention" | "blocked" | "finished";
  label: string;
  where: string;
  text: string;
  at: string;
  paneId?: string;
  workspace?: string;
  runId?: string;
  node?: string;
  attentionId?: string;
  /** For "finished": the status time to mark seen. */
  statusAt?: string;
}

function NeedsYou({
  herdr,
  runs,
  hidden,
  seen,
  onSeen,
  onNeed,
}: {
  herdr?: HerdrModel;
  runs: RunSummary[];
  hidden: Set<string>;
  seen: Record<string, string>;
  onSeen: (paneId: string, at: string) => void;
  onNeed: (n: Need) => void;
}) {
  const [questions, setQuestions] = useState<Record<string, string>>({});
  const online = (p: HPane) => {
    const m = herdr?.machines.find((x) => x.id === p.machine);
    return !!m && (m.local || m.state === "online");
  };
  const wsLabel = (wsId?: string) => {
    const w = herdr?.workspaces.find((x) => x.id === wsId);
    const m = w && herdr?.machines.find((x) => x.id === w.machine);
    return w ? (m && !m.local ? `${m.label} / ${w.label}` : w.label) : "";
  };
  const blocked = useMemo(() => (herdr?.panes ?? []).filter((p) => p.agent && p.agentStatus === "blocked" && !hidden.has(p.workspaceId) && online(p)), [herdr, hidden]);
  const blockedKey = blocked.map((p) => `${p.id}@${p.statusAt ?? ""}`).join(",");

  // the question each waiting agent asks (what the rendered view's question card shows)
  useEffect(() => {
    for (const p of blocked) {
      const k = `${p.id}@${p.statusAt ?? ""}`;
      if (k in questions) continue;
      setQuestions((q) => ({ ...q, [k]: "" }));
      api<{ menu: { question: string[] } | null; overlay: { lines: string[] } | null }>("GET", "/pane/menu", { pane: p.id, run: undefined })
        .then((r) => {
          const text = (r.menu?.question.join(" ") || r.overlay?.lines.find((l) => l.trim()) || "").replace(/\s+/g, " ").trim();
          setQuestions((q) => ({ ...q, [k]: text }));
        })
        .catch(() => {});
    }
  }, [blockedKey]);

  const needs: Need[] = [];
  const covered = new Set<string>();
  for (const r of runs) {
    if (r.stopped) continue;
    for (const a of r.needs ?? []) {
      if (a.paneId && (a.kind === "blocked" || a.kind === "startup_blocked")) covered.add(a.paneId);
      needs.push({
        key: `a:${r.id}:${a.id}`,
        kind: "attention",
        label: `${KIND_LABEL[a.kind]}${a.agent ? ` · ${a.agent}` : a.node ? ` · ${a.node}` : ""}`,
        where: `${wsLabel(r.workspace) || r.cwd.split("/").at(-1)} · run ${r.id}`,
        text: a.text,
        at: a.at,
        paneId: a.paneId,
        workspace: r.workspace,
        runId: r.id,
        node: a.node?.split("#")[0],
        attentionId: a.id,
      });
    }
  }
  for (const p of blocked) {
    if (covered.has(p.id)) continue;
    const q = questions[`${p.id}@${p.statusAt ?? ""}`];
    needs.push({ key: `b:${p.id}`, kind: "blocked", label: `waiting for an answer · ${p.agentName ?? p.agent}`, where: wsLabel(p.workspaceId), text: q || p.title || "Open it to answer.", at: p.statusAt ?? "", paneId: p.id, workspace: p.workspaceId });
  }
  const runWorkspaces = new Map(runs.filter((r) => !r.stopped && r.workspace).map((r) => [r.workspace!, r]));
  for (const p of herdr?.panes ?? []) {
    if (!p.agent || p.agentStatus !== "done" || !p.statusAt || hidden.has(p.workspaceId) || !online(p)) continue;
    if ((seen[p.id] ?? "") >= p.statusAt) continue;
    const r = runWorkspaces.get(p.workspaceId);
    if (r && r.leadPane !== p.id) continue; // a run's workers report to its lead
    needs.push({ key: `f:${p.id}`, kind: "finished", label: `finished · ${p.agentName ?? p.agent}`, where: wsLabel(p.workspaceId), text: p.title ?? "", at: p.statusAt, paneId: p.id, workspace: p.workspaceId, statusAt: p.statusAt });
  }
  const rank = (n: Need) => (n.kind === "finished" ? 1 : 0);
  needs.sort((a, b) => rank(a) - rank(b) || b.at.localeCompare(a.at));

  // reminders: a desktop notification for each new item while you are elsewhere, and the count in the tab title
  const [notify, setNotify] = useState(() => (typeof Notification !== "undefined" && Notification.permission === "granted" ? localStorage.getItem("af-notify") !== "0" : false));
  const notified = useRef<Set<string> | undefined>(undefined);
  const needKey = (n: Need) => `${n.key}@${n.statusAt ?? n.at}`;
  useEffect(() => {
    document.title = needs.length ? `(${needs.length}) agent-flow` : "agent-flow";
    const keys = needs.map(needKey);
    if (!notified.current) {
      notified.current = new Set(keys); // what is waiting when the page opens is not news
      return;
    }
    for (const n of needs) {
      const k = needKey(n);
      if (notified.current.has(k)) continue;
      notified.current.add(k);
      if (!notify || typeof Notification === "undefined" || Notification.permission !== "granted" || document.hasFocus()) continue;
      try {
        const note = new Notification(n.kind === "finished" ? `${n.label.replace(/^finished · /, "")} finished` : n.label, { body: [n.where, n.text].filter(Boolean).join(" — ").slice(0, 180), tag: k, silent: false });
        note.onclick = () => (window.focus(), onNeed(n), note.close());
      } catch {}
    }
  }, [needs.map(needKey).join(",")]);
  const bell = () => {
    if (typeof Notification === "undefined") return notifyUser("warn", "This browser cannot show notifications");
    if (Notification.permission === "denied") return notifyUser("warn", "Notifications are blocked for this page", "Allow them in the browser's site settings, then click the bell again.");
    if (Notification.permission === "default")
      return void Notification.requestPermission().then((p) => {
        localStorage.setItem("af-notify", p === "granted" ? "1" : "0");
        setNotify(p === "granted");
      });
    localStorage.setItem("af-notify", notify ? "0" : "1");
    setNotify(!notify);
  };

  return (
    <div className="section needs-section">
      <div className="section-title">
        <span>Needs you</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button className={`bell ${notify ? "on" : ""}`} onClick={bell} title={notify ? "Desktop notifications are on: when an agent finishes or asks while you are elsewhere. Click to turn off." : "Turn on desktop notifications: when an agent finishes or asks while you are elsewhere"}>
            {notify ? "🔔" : "🔕"}
          </button>
          <span className={`count ${needs.length ? "" : "zero"}`}>{needs.length}</span>
        </span>
      </div>
      {!needs.length && <div className="empty">Nothing waiting on you.</div>}
      <div className="needs-list">
        {needs.map((n) => (
          <div key={n.key} className={`needs ${n.kind}`} onClick={() => onNeed(n)} title={n.text}>
            <div className="k">
              <span>{n.label}</span>
              {n.kind !== "blocked" && (
                <button
                  className="x"
                  title={n.kind === "finished" ? "Mark as seen" : "Dismiss"}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (n.kind === "finished") onSeen(n.paneId!, n.statusAt!);
                    else api("POST", "/attention/dismiss", { id: n.attentionId, run: n.runId }).catch(failed("That did not work"));
                  }}
                >
                  ✕
                </button>
              )}
            </div>
            {n.where && <div className="w">{n.where}</div>}
            {n.text && <div className="t">{n.text}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
