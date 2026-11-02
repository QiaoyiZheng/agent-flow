import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentKind, Attention } from "@af/core";
import { api, useStore, watch } from "./store";
import { Terminal } from "./Terminal";
import { Graph } from "./Graph";
import { NodeDetail } from "./NodeDetail";
import { Sidebar } from "./Sidebar";
import { FileView, Messages, WebView } from "./Viewers";
import { basename, kindColor } from "./view";

type Tab =
  | { id: string; kind: "agent"; agent: string }
  | { id: string; kind: "shell"; paneId: string; title: string }
  | { id: string; kind: "file"; path: string }
  | { id: string; kind: "web"; url: string }
  | { id: string; kind: "inbox" };

const isUrl = (s: string) => /^[a-z]+:\/\//i.test(s);
const tabFor = (target: string): Tab => (isUrl(target) ? { id: `web:${target}`, kind: "web", url: target } : { id: `file:${target}`, kind: "file", path: target });

export function App() {
  const { connected, runs, runId, run } = useStore();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [drawer, setDrawer] = useState(false);
  const [shellPane, setShellPane] = useState<string>();
  const [newRun, setNewRun] = useState(false);
  const seenOpens = useRef<Record<string, number>>({});

  const openTab = useCallback((t: Tab) => {
    setTabs((ts) => (ts.some((x) => x.id === t.id) ? ts : [...ts, t]));
    setActive(t.id);
    setNewRun(false);
  }, []);

  // a new run: start with the lead's terminal
  useEffect(() => {
    setTabs([]);
    setSelected(undefined);
    setActive(undefined);
  }, [runId]);
  useEffect(() => {
    if (!run?.meta) return;
    const lead = run.meta.lead;
    if (run.agents[lead]?.paneId && !tabs.length) openTab({ id: `agent:${lead}`, kind: "agent", agent: lead });
  }, [run, run?.seq]);

  // af open by the lead or the user becomes a tab; workers' opens stay on their node
  useEffect(() => {
    if (!run?.meta) return;
    const seen = seenOpens.current[run.meta.id];
    if (seen === undefined) {
      seenOpens.current[run.meta.id] = run.opens.length;
      return;
    }
    for (const o of run.opens.slice(seen)) if (!o.node) openTab(tabFor(o.target));
    seenOpens.current[run.meta.id] = run.opens.length;
  }, [run?.opens.length]);

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
  useEffect(() => {
    if (drawer && !shellPane) api<{ paneId: string }>("GET", "/shell").then((r) => setShellPane(r.paneId), (e) => alert(e.message));
  }, [drawer]);

  const onAttention = (a: Attention) => {
    const node = a.node?.split("#")[0];
    if (node && run?.graph.nodes[node]) setSelected(node);
    if (a.agent && run?.agents[a.agent]) openTab({ id: `agent:${a.agent}`, kind: "agent", agent: a.agent });
  };

  const closeTab = (id: string) => {
    setTabs((ts) => {
      const next = ts.filter((t) => t.id !== id);
      if (active === id) setActive(next.at(-1)?.id);
      return next;
    });
  };

  const current = tabs.find((t) => t.id === active);
  const showWelcome = newRun || (!runs.length && connected);

  return (
    <div className="app" style={{ "--right-w": selected ? "460px" : "380px" } as React.CSSProperties}>
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
        {run?.meta && (
          <span className="crumb">
            / <b>{run.meta.id}</b> · {run.meta.cwd}
            {run.meta.branch && <> · {run.meta.branch}</>}
          </span>
        )}
        <span className="spacer" />
        <span className={`conn ${connected ? "" : "off"}`}>
          <i /> {connected ? "connected" : "reconnecting…"}
        </span>
      </header>

      <Sidebar runs={runs} runId={runId} run={run} onNewRun={() => setNewRun(true)} onAttention={onAttention} onAgent={(a) => openTab({ id: `agent:${a}`, kind: "agent", agent: a })} />

      <main className="main">
        <div className="tabs">
          {tabs.map((t) => {
            const a = t.kind === "agent" ? run?.agents[t.agent] : undefined;
            return (
              <div key={t.id} className={`tab ${t.id === active && !newRun ? "active" : ""}`} onClick={() => (setActive(t.id), setNewRun(false))}>
                <span className="ic" style={a ? { color: kindColor(a.kind) } : undefined}>
                  {t.kind === "agent" ? "●" : t.kind === "shell" ? "$" : t.kind === "web" ? "◎" : t.kind === "inbox" ? "✉" : "≡"}
                </span>
                <span className="label">
                  {t.kind === "agent" ? `${t.agent}${t.agent === run?.meta?.lead && t.agent !== "lead" ? " · lead" : ""}` : t.kind === "shell" ? t.title : t.kind === "file" ? basename(t.path) : t.kind === "web" ? t.url.replace(/^https?:\/\//, "") : "messages"}
                </span>
                <button className="close" onClick={(e) => (e.stopPropagation(), closeTab(t.id))}>
                  ✕
                </button>
              </div>
            );
          })}
          {run && (
            <>
              <button
                className="tab-add"
                title="New terminal in this run"
                onClick={() => api<{ paneId: string }>("POST", "/terminal").then((r) => openTab({ id: `shell:${r.paneId}`, kind: "shell", paneId: r.paneId, title: "shell" }), (e) => alert(e.message))}
              >
                + terminal
              </button>
              <button
                className="tab-add"
                title="Open a URL or a file path"
                onClick={() => {
                  const target = prompt("URL or absolute file path");
                  if (target) openTab(tabFor(target.trim()));
                }}
              >
                + open
              </button>
              <button className="tab-add" title="All messages in this run" onClick={() => openTab({ id: "inbox", kind: "inbox" })}>
                messages
              </button>
            </>
          )}
        </div>
        <div className="tab-body">
          {showWelcome ? (
            <Welcome onDone={() => setNewRun(false)} />
          ) : !run ? (
            <div className="welcome">{connected ? "Loading…" : "Connecting to the agent-flow server…"}</div>
          ) : (
            tabs.map((t) => (
              <div key={t.id} style={{ position: "absolute", inset: 0, display: t.id === active ? "block" : "none" }}>
                {t.kind === "agent" && run.agents[t.agent]?.paneId && <Terminal paneId={run.agents[t.agent]!.paneId!} autoFocus={t.id === active} />}
                {t.kind === "shell" && <Terminal paneId={t.paneId} autoFocus />}
                {t.kind === "file" && <FileView path={t.path} />}
                {t.kind === "web" && <WebView url={t.url} />}
                {t.kind === "inbox" && (
                  <div className="viewer">
                    <Messages run={run} />
                  </div>
                )}
              </div>
            ))
          )}
          {run && !showWelcome && !current && <div className="welcome">Pick an agent on the left, or open a terminal.</div>}
        </div>
      </main>

      <section className="right">
        <div className="panel-head">
          Graph
          {run && (
            <span className="sub">
              {Object.values(run.graph.nodes).filter((n) => !n.removed).length} nodes · {run.stopped ? "stopped" : run.graph.quiescent ? "quiescent" : "running"}
            </span>
          )}
        </div>
        <div className="graph">{run && <Graph run={run} selected={selected} onSelect={setSelected} />}</div>
        {run && selected && <NodeDetail key={selected} run={run} nodeId={selected} onClose={() => setSelected(undefined)} onOpen={(t) => openTab(tabFor(t))} />}
      </section>

      <footer className="drawer">
        <div className="drawer-head" onClick={() => setDrawer((d) => !d)}>
          <span>{drawer ? "▾" : "▸"} Persistent shell</span>
          <kbd>ctrl `</kbd>
          <span style={{ marginLeft: "auto" }}>survives browser and server restarts</span>
        </div>
        {drawer && <div className="drawer-body">{shellPane ? <Terminal paneId={shellPane} autoFocus /> : <div className="term-overlay">starting…</div>}</div>}
      </footer>
    </div>
  );
}

function Welcome({ onDone }: { onDone: () => void }) {
  const [cwd, setCwd] = useState("");
  const [kind, setKind] = useState<AgentKind>("claude");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="welcome">
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          api("POST", "/runs", { cwd, leadKind: kind, prompt: prompt || undefined })
            .then((meta) => (watch(meta.id), onDone()))
            .catch((err) => alert(err.message))
            .finally(() => setBusy(false));
        }}
      >
        <h2>Start a run</h2>
        <p>A lead agent starts in the directory. Tell it what you want; it builds a graph of workers.</p>
        <div className="field">
          <label>Directory (a git repository gives each node its own worktree)</label>
          <input className="text" required placeholder="/path/to/repo" value={cwd} onChange={(e) => setCwd(e.target.value)} />
        </div>
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
        <button className="btn primary" disabled={busy}>
          {busy ? "Starting…" : "Start"}
        </button>
      </form>
    </div>
  );
}
