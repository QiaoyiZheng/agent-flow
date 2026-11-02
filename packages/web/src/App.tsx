import { useEffect, useMemo, useState } from "react";
import type { AgentKind, Attention, HPane } from "@af/core";
import { api, useStore, watch } from "./store";
import { Terminal } from "./Terminal";
import { Graph } from "./Graph";
import { NodeDetail } from "./NodeDetail";
import { Sidebar } from "./Sidebar";
import { LayoutView, type PaneCtx } from "./Layout";
import { Messages } from "./Viewers";
import { kindColor } from "./view";

const params = new URLSearchParams(location.search);

export function App() {
  const { connected, runs, run, herdr, views } = useStore();
  const [selectedWs, setSelectedWs] = useState<string | undefined>(params.get("ws") ?? undefined);
  const [pastRun, setPastRun] = useState<string>();
  const [activeTab, setActiveTab] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState<Record<string, string>>({});
  const [selectedNode, setSelectedNode] = useState<string>();
  const [rightView, setRightView] = useState<"graph" | "messages">("graph");
  const [drawer, setDrawer] = useState(false);
  const [shell, setShell] = useState<{ paneId: string; workspaceId?: string }>();
  const [shellWs, setShellWs] = useState<string>();
  const [creating, setCreating] = useState(false);

  // the shell drawer's workspace is not listed in the tree
  useEffect(() => {
    api<{ shellWorkspace?: string }>("GET", "/ls").then((r) => setShellWs(r.shellWorkspace), () => {});
  }, []);
  useEffect(() => {
    if (drawer && !shell)
      api<{ paneId: string; workspaceId?: string }>("GET", "/shell").then(
        (r) => (setShell(r), r.workspaceId && setShellWs(r.workspaceId)),
        (e) => alert(e.message),
      );
  }, [drawer]);
  const hidden = useMemo(() => new Set(shellWs ? [shellWs] : []), [shellWs]);

  // pick a workspace on first load: the latest active run, else the first one
  useEffect(() => {
    if (selectedWs || !herdr?.workspaces.length) return;
    const live = new Set(herdr.workspaces.map((w) => w.id));
    const r = runs.find((x) => !x.stopped && x.workspace && live.has(x.workspace));
    setSelectedWs(r?.workspace ?? herdr.workspaces.find((w) => !hidden.has(w.id))?.id);
  }, [herdr, runs]);
  useEffect(() => {
    if (!selectedWs) return;
    const u = new URL(location.href);
    u.searchParams.set("ws", selectedWs);
    u.searchParams.delete("run");
    history.replaceState(null, "", u);
  }, [selectedWs]);

  // follow the run that owns the selected workspace (or a past run picked in the tree)
  const runIdForWs = selectedWs ? (runs.filter((r) => r.workspace === selectedWs).find((r) => !r.stopped) ?? runs.find((r) => r.workspace === selectedWs))?.id : undefined;
  const followRun = pastRun ?? runIdForWs;
  useEffect(() => {
    watch(followRun);
    setSelectedNode(undefined);
  }, [followRun]);

  // ctrl+` toggles the persistent shell
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        setDrawer((d) => !d);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const ws = herdr?.workspaces.find((w) => w.id === selectedWs);
  const tabs = herdr?.tabs.filter((t) => t.workspaceId === selectedWs) ?? [];
  // default tab: the one picked here, else the lead's tab in a run workspace, else Herdr's active tab
  const leadTab = run?.meta && run.meta.herdrWorkspace === selectedWs ? run.agents[run.meta.lead]?.tabId : undefined;
  const pick = [selectedWs ? activeTab[selectedWs] : undefined, leadTab, ws?.activeTabId, tabs[0]?.id].find((id) => id && tabs.some((t) => t.id === id));
  const tabId = pick as string | undefined;
  const layout = tabId ? herdr?.layouts[tabId] : undefined;
  const panesById = useMemo(() => new Map<string, HPane>((herdr?.panes ?? []).map((p) => [p.id, p])), [herdr]);
  const runAgents = useMemo(
    () => new Map(Object.values(run?.agents ?? {}).filter((a) => a.paneId && a.status !== "exited").map((a) => [a.paneId!, { name: a.name, kind: a.kind, role: a.role }])),
    [run, run?.seq],
  );
  const leadPane = run?.meta ? run.agents[run.meta.lead]?.paneId : undefined;
  const tabPanes = herdr && tabId ? herdr.panes.filter((p) => p.tabId === tabId) : [];
  const focusedPane = (selectedWs && focused[selectedWs] && tabPanes.some((p) => p.id === focused[selectedWs]) ? focused[selectedWs] : (layout?.focusedPaneId ?? tabPanes[0]?.id)) as string | undefined;

  const selectWs = (id: string) => {
    setPastRun(undefined);
    setCreating(false);
    setSelectedWs(id);
  };
  const selectPane = (workspaceId: string, tab: string, paneId: string) => {
    selectWs(workspaceId);
    setActiveTab((a) => ({ ...a, [workspaceId]: tab }));
    setFocused((f) => ({ ...f, [workspaceId]: paneId }));
  };
  const goToPane = (paneId?: string) => {
    const p = paneId ? panesById.get(paneId) : undefined;
    if (p) selectPane(p.workspaceId, p.tabId, p.id);
  };
  const onAttention = (a: Attention) => {
    const node = a.node?.split("#")[0];
    if (node && run?.graph.nodes[node]) setSelectedNode(node);
    if (a.agent) goToPane(run?.agents[a.agent]?.paneId);
  };
  const ctx: PaneCtx = {
    panes: panesById,
    views,
    focused: focusedPane,
    onFocus: (p) => selectedWs && setFocused((f) => ({ ...f, [selectedWs]: p })),
    runAgents,
    leadPane,
  };
  const showFile = (target: string) => {
    const of = focusedPane ?? leadPane;
    if (of) api("POST", "/show", { target, of }).then((r) => goToPane(r.paneId), (e) => alert(e.message));
  };

  const tabTitle = (t: { id: string; label: string }) => {
    const ps = herdr?.panes.filter((p) => p.tabId === t.id) ?? [];
    if (!/^\d+$/.test(t.label)) return t.label;
    const a = ps.find((p) => p.agent);
    return a ? (runAgents.get(a.id)?.name ?? a.agentName ?? a.agent!) : (ps[0]?.cwd.split("/").at(-1) ?? t.label);
  };
  const tabKind = (t: { id: string }) => herdr?.panes.find((p) => p.tabId === t.id && p.agent)?.agent;
  const showRight = !!run && !creating;

  return (
    <div className="app" style={{ "--right-w": showRight ? (selectedNode ? "460px" : "380px") : "0px" } as React.CSSProperties}>
      <header className="topbar">
        <span className="brand">
          <span className="brand-dots">
            <i />
            <i />
            <i />
            <i />
          </span>
          agent-flow
        </span>
        {ws && (
          <span className="crumb">
            / <span className={ws.machine === "local" ? "" : "machine-tag"}>{herdr?.machines.find((m) => m.id === ws.machine)?.label ?? ws.machine}</span> / <b>{ws.label}</b>
            {run?.meta && (
              <>
                {" "}· run {run.meta.id}
                {run.meta.branch && <> · {run.meta.branch}</>}
              </>
            )}
          </span>
        )}
        <span className="spacer" />
        <span className={`conn ${connected ? "" : "off"}`}>
          <i /> {connected ? "connected" : "reconnecting…"}
        </span>
      </header>

      <Sidebar
        herdr={herdr}
        runs={runs}
        run={run}
        hidden={hidden}
        selectedWs={pastRun ? undefined : selectedWs}
        onSelectWs={selectWs}
        onSelectPane={selectPane}
        onSelectRun={(id) => (setPastRun(id), setCreating(false))}
        onNew={() => setCreating(true)}
        onAttention={onAttention}
      />

      <main className="main">
        {!creating && !pastRun && ws && (
          <div className="tabs">
            {tabs.map((t) => (
              <div key={t.id} className={`tab ${t.id === tabId ? "active" : ""}`} onClick={() => setActiveTab((a) => ({ ...a, [ws.id]: t.id }))}>
                <span className="ic" style={tabKind(t) ? { color: kindColor(tabKind(t)!) } : undefined}>
                  {tabKind(t) ? "●" : "$"}
                </span>
                <span className="label">{tabTitle(t)}</span>
                <button
                  className="close"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Close tab "${tabTitle(t)}" and everything running in it?`)) api("POST", "/tab/close", { tab: t.id }).catch((err) => alert(err.message));
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="tab-add" title="New tab with a shell" onClick={() => api("POST", "/tab/new", { workspace: ws.id }).then((r) => selectPane(ws.id, r.tabId, r.paneId), (e) => alert(e.message))}>
              + tab
            </button>
          </div>
        )}
        <div className="tab-body">
          {creating || (!herdr?.workspaces.length && connected) ? (
            <NewDialog machines={(herdr?.machines ?? []).filter((m) => m.local || m.state === "online").map((m) => ({ id: m.id, label: m.label }))} onDone={(wsId) => (setCreating(false), wsId && selectWs(wsId))} />
          ) : pastRun ? (
            <div className="welcome">This run's workspace is closed. Its graph and messages are on the right.</div>
          ) : !herdr ? (
            <div className="welcome">{connected ? "Loading…" : "Connecting to the agent-flow server…"}</div>
          ) : layout && tabId ? (
            <LayoutView key={tabId} tabId={tabId} root={layout.root} zoomed={layout.zoomed} ctx={ctx} />
          ) : (
            <div className="welcome">{ws ? "This workspace has no tabs." : "Pick a workspace on the left."}</div>
          )}
        </div>
      </main>

      <section className="right">
        {showRight && run && (
          <>
            <div className="panel-head">
              <div className="seg" style={{ border: 0, padding: 0 }}>
                <button className={rightView === "graph" ? "on" : ""} onClick={() => setRightView("graph")}>
                  Graph
                </button>
                <button className={rightView === "messages" ? "on" : ""} onClick={() => setRightView("messages")}>
                  Messages
                </button>
              </div>
              <span className="sub">
                {Object.values(run.graph.nodes).filter((n) => !n.removed).length} nodes · {run.stopped ? "stopped" : run.graph.quiescent ? "quiescent" : "running"}
              </span>
            </div>
            {rightView === "graph" ? (
              <>
                <div className="graph">
                  <Graph run={run} selected={selectedNode} onSelect={setSelectedNode} />
                </div>
                {selectedNode && (
                  <NodeDetail
                    key={selectedNode}
                    run={run}
                    nodeId={selectedNode}
                    onClose={() => setSelectedNode(undefined)}
                    onOpen={showFile}
                    onGoTo={(paneId) => goToPane(paneId)}
                  />
                )}
              </>
            ) : (
              <div className="detail-body">
                <Messages run={run} />
              </div>
            )}
          </>
        )}
      </section>

      <footer className="drawer">
        <div className="drawer-head" onClick={() => setDrawer((d) => !d)}>
          <span>{drawer ? "▾" : "▸"} Persistent shell</span>
          <kbd>ctrl `</kbd>
          <span style={{ marginLeft: "auto" }}>survives browser and server restarts</span>
        </div>
        {drawer && <div className="drawer-body">{shell ? <Terminal paneId={shell.paneId} autoFocus /> : <div className="term-overlay">starting…</div>}</div>}
      </footer>
    </div>
  );
}

function NewDialog({ onDone, machines }: { onDone: (workspaceId?: string) => void; machines: { id: string; label: string }[] }) {
  const [mode, setMode] = useState<"run" | "workspace">("run");
  const [machine, setMachine] = useState("local");
  const [cwd, setCwd] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<AgentKind>("claude");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const p =
      mode === "run"
        ? api("POST", "/runs", { cwd, leadKind: kind, prompt: prompt || undefined }).then((meta) => meta.herdrWorkspace as string)
        : api("POST", "/workspace/new", { cwd, machine, label: label || cwd.split("/").filter(Boolean).at(-1) }).then((r) => r.workspaceId as string);
    p.then(onDone, (err) => alert(err.message)).finally(() => setBusy(false));
  };
  return (
    <div className="welcome">
      <form className="card" onSubmit={submit}>
        <div className="seg" style={{ border: 0, padding: "0 0 12px" }}>
          <button type="button" className={mode === "run" ? "on" : ""} onClick={() => setMode("run")}>
            New run
          </button>
          <button type="button" className={mode === "workspace" ? "on" : ""} onClick={() => setMode("workspace")}>
            New workspace
          </button>
        </div>
        <h2>{mode === "run" ? "Start a run" : "New workspace"}</h2>
        <p>{mode === "run" ? "A lead agent starts in the directory. Tell it what you want; it builds a graph of workers." : "A plain Herdr workspace with a shell. Split it into terminals, agents and files."}</p>
        <div className="field">
          <label>Directory{mode === "run" ? " (a git repository gives each node its own worktree)" : ""}</label>
          <input className="text" required placeholder="/path/to/project" value={cwd} onChange={(e) => setCwd(e.target.value)} />
        </div>
        {mode === "workspace" && machines.length > 1 && (
          <div className="field">
            <label>Machine (connected SSH machines are listed; expand one in the sidebar to connect it)</label>
            <select value={machine} onChange={(e) => setMachine(e.target.value)}>
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {mode === "workspace" && (
          <div className="field">
            <label>Name</label>
            <input className="text" placeholder="defaults to the folder name" value={label} onChange={(e) => setLabel(e.target.value)} />
          </div>
        )}
        {mode === "run" && (
          <>
            <div className="field">
              <label>Lead agent</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as AgentKind)}>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
                <option value="omp">omp</option>
              </select>
            </div>
            <div className="field">
              <label>First message to the lead (optional)</label>
              <textarea className="text" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" disabled={busy}>
            {busy ? "Starting…" : mode === "run" ? "Start" : "Create"}
          </button>
          <button type="button" className="btn" onClick={() => onDone()}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
