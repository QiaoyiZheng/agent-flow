import { useEffect, useMemo, useState } from "react";
import type { AgentKind, HPane } from "@af/core";

interface PlaybookInfo {
  id: string;
  name: string;
  description: string;
  source: "built-in" | "yours" | "project";
  path: string;
  error?: string;
}
import { api, useStore, watch, failed } from "./store";
import { Terminal } from "./Terminal";
import { TeamPanel } from "./TeamPanel";
import { type Need, Sidebar } from "./Sidebar";
import { LayoutView, type PaneCtx } from "./Layout";
import { kindColor } from "./view";
import { NoticesButton, Toasts } from "./Notices";

const params = new URLSearchParams(location.search);

export function App() {
  const { connected, teams, team, herdr, views } = useStore();
  const [selectedWs, setSelectedWs] = useState<string | undefined>(params.get("ws") ?? undefined);
  const [pastTeam, setPastTeam] = useState<string>();
  /** A team picked in the panel (a nested team, a parent, another team in the workspace). */
  const [teamPick, setTeamPick] = useState<string>();
  const [activeTab, setActiveTab] = useState<Record<string, string>>({});
  const [focused, setFocused] = useState<Record<string, string>>({});
  const [drawer, setDrawer] = useState(false);
  const [shell, setShell] = useState<{ paneId: string; workspaceId?: string }>();
  const [shellWs, setShellWs] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [createOn, setCreateOn] = useState<string>();
  // when the user last saw each agent's pane: a "finished" newer than that shows in Needs you
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem("af.seen") ?? "{}");
    } catch {
      return {};
    }
  });
  const markSeen = (marks: [string, string][]) =>
    setSeen((old) => {
      const next = { ...old };
      for (const [id, at] of marks) next[id] = at;
      const live = new Set(herdr?.panes.map((p) => p.id));
      for (const id of Object.keys(next)) if (herdr && !live.has(id)) delete next[id];
      localStorage.setItem("af.seen", JSON.stringify(next));
      return next;
    });

  // the shell drawer's workspace is not listed in the tree
  useEffect(() => {
    api<{ shellWorkspace?: string }>("GET", "/ls").then((r) => setShellWs(r.shellWorkspace), () => {});
  }, []);
  useEffect(() => {
    if (drawer && !shell)
      api<{ paneId: string; workspaceId?: string }>("GET", "/shell").then(
        (r) => (setShell(r), r.workspaceId && setShellWs(r.workspaceId)),
        failed("That did not work"),
      );
  }, [drawer]);
  const hidden = useMemo(() => new Set(shellWs ? [shellWs] : []), [shellWs]);

  // pick a workspace on first load: the latest active team's, else the first one
  useEffect(() => {
    if (selectedWs || !herdr?.workspaces.length) return;
    const live = new Set(herdr.workspaces.map((w) => w.id));
    const r = teams.find((x) => !x.stopped && x.workspace && live.has(x.workspace));
    setSelectedWs(r?.workspace ?? herdr.workspaces.find((w) => !hidden.has(w.id))?.id);
  }, [herdr, teams]);
  useEffect(() => {
    if (!selectedWs) return;
    const u = new URL(location.href);
    u.searchParams.set("ws", selectedWs);
    u.searchParams.delete("run");
    history.replaceState(null, "", u);
  }, [selectedWs]);

  // the teams of the selected workspace: a router team, and the teams of sessions in it that hand out work
  const wsTeams = useMemo(() => {
    const here = teams.filter((t) => t.workspace === selectedWs && t.tickets + t.queued > 0);
    const live = here.filter((t) => !t.stopped);
    return live.length ? live : here.slice(0, 1);
  }, [teams, selectedWs]);

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
  const followTeam = (() => {
    if (pastTeam) return pastTeam;
    if (teamPick && (wsTeams.some((x) => x.id === teamPick) || teams.some((x) => x.id === teamPick && x.workspace === selectedWs))) return teamPick;
    return (wsTeams.find((x) => x.managerPane && x.managerPane === focused[selectedWs ?? ""]) ?? wsTeams[0])?.id;
  })();
  useEffect(() => {
    watch(followTeam);
  }, [followTeam]);
  const tabs = herdr?.tabs.filter((t) => t.workspaceId === selectedWs) ?? [];
  // default tab: the one picked here, else the lead's tab in a run workspace, else Herdr's active tab
  const routerTab = wsTeams.find((t) => t.mode === "router") ? herdr?.panes.find((p) => p.id === wsTeams.find((t) => t.mode === "router")!.managerPane)?.tabId : undefined;
  const pick = [selectedWs ? activeTab[selectedWs] : undefined, routerTab, ws?.activeTabId, tabs[0]?.id].find((id) => id && tabs.some((t) => t.id === id));
  const tabId = pick as string | undefined;
  const layout = tabId ? herdr?.layouts[tabId] : undefined;
  const panesById = useMemo(() => new Map<string, HPane>((herdr?.panes ?? []).map((p) => [p.id, p])), [herdr]);
  const runAgents = useMemo(
    () => new Map(Object.values(team?.members ?? {}).filter((a) => a.paneId && a.status !== "exited" && !a.team).map((a) => [a.paneId!, { name: a.name, kind: a.kind, role: a.role }])),
    [team, team?.seq],
  );
  const tabPanes = herdr && tabId ? herdr.panes.filter((p) => p.tabId === tabId) : [];
  const focusedPane = (selectedWs && focused[selectedWs] && tabPanes.some((p) => p.id === focused[selectedWs]) ? focused[selectedWs] : (layout?.focusedPaneId ?? tabPanes[0]?.id)) as string | undefined;
  // a finished agent counts as seen when you are actually here: this window has focus, and the pane is the one
  // you are in (or the only agent in the tab). On screen while you work in another app is not seen.
  const [present, setPresent] = useState(document.visibilityState === "visible" && document.hasFocus());
  useEffect(() => {
    const on = () => setPresent(document.visibilityState === "visible" && document.hasFocus());
    document.addEventListener("visibilitychange", on);
    window.addEventListener("focus", on);
    window.addEventListener("blur", on);
    return () => (document.removeEventListener("visibilitychange", on), window.removeEventListener("focus", on), window.removeEventListener("blur", on));
  }, []);
  const tabAgents = tabPanes.filter((p) => p.agent);
  const looking = present && !creating && !pastTeam ? tabAgents.filter((p) => p.id === focusedPane || tabAgents.length === 1) : [];
  const unseen = looking.filter((p) => p.agentStatus === "done" && !p.background && p.statusAt && (seen[p.id] ?? "") < p.statusAt);
  const unseenKey = unseen.map((p) => `${p.id}@${p.statusAt}`).join(",");
  useEffect(() => {
    if (unseen.length) markSeen(unseen.map((p) => [p.id, p.statusAt!]));
  }, [unseenKey]);

  const selectWs = (id: string) => {
    setPastTeam(undefined);
    setTeamPick(undefined);
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
  // Needs you: go to the pane (or workspace), and show the team the item is about
  const onNeed = (n: Need) => {
    if (n.paneId && panesById.has(n.paneId)) goToPane(n.paneId);
    else if (n.workspace && herdr?.workspaces.some((w) => w.id === n.workspace)) selectWs(n.workspace);
    else if (n.teamId) setPastTeam(n.teamId);
    if (n.teamId) setTeamPick(n.teamId);
  };
  const managerPane = team?.meta ? (team.meta.manager.pane ?? (team.meta.manager.member ? team.members[team.meta.manager.member]?.paneId : undefined)) : undefined;
  const down = useMemo(() => new Map((herdr?.machines ?? []).filter((m) => !m.local && m.state !== "online").map((m) => [m.id, { label: m.label, error: m.error }])), [herdr]);
  const ctx: PaneCtx = {
    down,
    panes: panesById,
    views,
    focused: focusedPane,
    onFocus: (p) => selectedWs && setFocused((f) => ({ ...f, [selectedWs]: p })),
    runAgents,
    leadPane: undefined, // routers are named router; a session that hands out work is not a member
  };
  const showFile = (target: string) => {
    const of = focusedPane ?? managerPane;
    if (of) api("POST", "/show", { target, of }).then((r) => goToPane(r.paneId), failed("That did not work"));
  };

  const tabTitle = (t: { id: string; label: string }) => {
    const ps = herdr?.panes.filter((p) => p.tabId === t.id) ?? [];
    // Herdr's numbers and our "shell" are default names: an agent running in the tab names it better
    if (!/^\d+$/.test(t.label) && !(t.label === "shell" && ps.some((p) => p.agent))) return t.label;
    const a = ps.find((p) => p.agent);
    return a ? (runAgents.get(a.id)?.name ?? a.agentName ?? a.agent!) : (ps[0]?.cwd.split("/").at(-1) ?? t.label);
  };
  const tabKind = (t: { id: string }) => herdr?.panes.find((p) => p.tabId === t.id && p.agent)?.agent;
  const showRight = !!team?.meta && !creating;

  return (
    <div className="app" style={{ "--right-w": showRight ? "420px" : "0px" } as React.CSSProperties}>
      <Sidebar
        herdr={herdr}
        teams={teams}
        team={team}
        hidden={hidden}
        selectedWs={pastTeam ? undefined : selectedWs}
        onSelectWs={selectWs}
        onSelectPane={selectPane}
        onSelectTeam={(id) => (setPastTeam(id), setTeamPick(id), setCreating(false))}
        onNew={(machine) => (setCreateOn(machine), setCreating(true))}
        onNeed={onNeed}
        seen={seen}
        onSeen={(id, at) => markSeen([[id, at]])}
      />

      <main className="main">
        {!creating && !pastTeam && ws && (
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
                    if (confirm(`Close tab "${tabTitle(t)}" and everything running in it?`)) api("POST", "/tab/close", { tab: t.id }).catch(failed("That did not work"));
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="tab-add" title="New tab with a shell" onClick={() => api("POST", "/tab/new", { workspace: ws.id }).then((r) => selectPane(ws.id, r.tabId, r.paneId), failed("That did not work"))}>
              + tab
            </button>
          </div>
        )}
        <div className="tab-body">
          {creating || (!herdr?.workspaces.length && connected) ? (
            <NewDialog
              key={createOn ?? "-"}
              start={createOn}
              machines={(herdr?.machines ?? []).filter((m) => m.local || m.state === "online").map((m) => ({ id: m.id, label: m.label }))}
              onDone={(wsId) => (setCreating(false), wsId && selectWs(wsId))}
            />
          ) : pastTeam ? (
            <div className="welcome">This team's workspace is closed. Its tickets are on the right.</div>
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
        {showRight && team?.meta && (
          <TeamPanel
            team={team}
            teams={teams}
            siblings={wsTeams.some((x) => x.id === team.meta!.id) ? wsTeams : [teams.find((x) => x.id === team.meta!.id)!].filter(Boolean)}
            panes={panesById}
            onPickTeam={(id) => {
              const t = teams.find((x) => x.id === id);
              if (t?.workspace && herdr?.workspaces.some((w) => w.id === t.workspace) && t.workspace !== selectedWs) {
                setSelectedWs(t.workspace);
                setPastTeam(undefined);
              } else if (!t?.workspace || !herdr?.workspaces.some((w) => w.id === t.workspace)) setPastTeam(id);
              setTeamPick(id);
            }}
            onGoTo={(paneId) => goToPane(paneId)}
            onOpen={showFile}
          />
        )}
      </section>

      <Toasts />
      <footer className="drawer">
        {/* one status line: shell toggle on the left, where you are in the middle, connection and brand on the right */}
        <div className="drawer-head">
          <button className="drawer-toggle" onClick={() => setDrawer((d) => !d)} title="Persistent shell: survives browser and server restarts (ctrl+`)">
            {drawer ? "▾" : "▸"} Persistent shell <kbd>ctrl `</kbd>
          </button>
          {ws && (
            <span className="crumb">
              <span className={ws.machine === "local" ? "" : "machine-tag"}>{herdr?.machines.find((m) => m.id === ws.machine)?.label ?? ws.machine}</span> / <b>{ws.label}</b>
              {team?.meta && <> · team {team.meta.id}</>}
            </span>
          )}
          <span className="spacer" />
          <NoticesButton />
          <span className={`conn ${connected ? "" : "off"}`} title={connected ? "connected to the agent-flow server" : "reconnecting to the agent-flow server"}>
            <i /> {connected ? "connected" : "reconnecting…"}
          </span>
          <span className="brand">
            <span className="brand-dots">
              <i />
              <i />
              <i />
              <i />
            </span>
            agent-flow
          </span>
        </div>
        {drawer && <div className="drawer-body">{shell ? <Terminal paneId={shell.paneId} autoFocus /> : <div className="term-overlay">starting…</div>}</div>}
      </footer>
    </div>
  );
}

function NewDialog({ onDone, machines, start }: { onDone: (workspaceId?: string) => void; machines: { id: string; label: string }[]; start?: string }) {
  // "+" on a remote machine opens straight into "new workspace" there; teams are local for now
  const [mode, setMode] = useState<"team" | "workspace">(start ? "workspace" : "team");
  const [machine, setMachine] = useState(start ?? "local");
  const [cwd, setCwd] = useState("");
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<AgentKind>("claude");
  const [busy, setBusy] = useState(false);
  const [playbooks, setPlaybooks] = useState<PlaybookInfo[]>([]);
  const [playbook, setPlaybook] = useState("humanize-loop");
  const [goal, setGoal] = useState("");
  // playbooks: built-in, yours, and the project's (.agent-flow/playbooks in the repo)
  useEffect(() => {
    if (mode !== "team") return;
    const t = setTimeout(() => api<PlaybookInfo[]>("GET", "/playbooks", { cwd: cwd || undefined }).then(setPlaybooks, () => {}), 300);
    return () => clearTimeout(t);
  }, [mode, cwd]);
  const pb = playbooks.find((w) => w.id === playbook);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const p =
      mode === "team"
        ? api("POST", "/team/new", { ui: true, cwd, router: kind, playbook: playbook || undefined, goal, name: label || undefined }).then((r) => r.workspace as string)
        : api("POST", "/workspace/new", { cwd: cwd || undefined, machine, label }).then((r) => r.workspaceId as string);
    p.then(onDone, failed("That did not work")).finally(() => setBusy(false));
  };
  return (
    <div className="welcome">
      <form className="card" onSubmit={submit}>
        <div className="seg" style={{ border: 0, padding: "0 0 12px" }}>
          <button type="button" className={mode === "team" ? "on" : ""} onClick={() => setMode("team")}>
            New team
          </button>
          <button type="button" className={mode === "workspace" ? "on" : ""} onClick={() => setMode("workspace")}>
            New workspace
          </button>
        </div>
        <h2>{mode === "team" ? "Start an agent team" : "New workspace"}</h2>
        <p>
          {mode === "team"
            ? "A router agent starts in its own workspace and runs the team by the playbook: it opens tickets for members and passes their results on. To hand out quick tasks yourself, just ask any session to (it uses af task)."
            : "A plain Herdr workspace with a shell. Split it into terminals, agents and files."}
        </p>
        <div className="field">
          <label>Directory</label>
          <input className="text" required={mode === "team"} placeholder={mode === "team" ? "/path/to/project" : "~ (home) if empty; ~/x works on remote machines"} value={cwd} onChange={(e) => setCwd(e.target.value)} />
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
        <div className="field">
          <label>Name</label>
          <input className="text" placeholder={mode === "team" ? "defaults to the playbook's id" : "defaults to the folder name"} value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        {mode === "team" && (
          <>
            <div className="field">
              <label>Playbook</label>
              <select value={playbook} onChange={(e) => setPlaybook(e.target.value)}>
                <option value="">None — the router decides the members and steps</option>
                {playbooks.map((w) => (
                  <option key={w.id} value={w.id} disabled={!!w.error}>
                    {w.name}
                    {w.source !== "built-in" ? ` (${w.source})` : ""}
                    {w.error ? " — invalid" : ""}
                  </option>
                ))}
              </select>
              {pb && (
                <div className="wf-card">
                  <div className="wf-desc">{pb.description}</div>
                  <div className="wf-path">{pb.path}</div>
                </div>
              )}
            </div>
            <div className="field">
              <label>Goal — the router passes it on in your words</label>
              <textarea className="text" rows={3} required placeholder="e.g. 给登录页加验证码" value={goal} onChange={(e) => setGoal(e.target.value)} />
            </div>
            <div className="field">
              <label>Router agent</label>
              <select value={kind} onChange={(e) => setKind(e.target.value as AgentKind)}>
                <option value="claude">claude</option>
                <option value="codex">codex</option>
                <option value="omp">omp</option>
                <option value="gemini">gemini</option>
              </select>
            </div>
          </>
        )}
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn primary" disabled={busy}>
            {busy ? "Starting…" : mode === "team" ? "Start" : "Create"}
          </button>
          <button type="button" className="btn" onClick={() => onDone()}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
