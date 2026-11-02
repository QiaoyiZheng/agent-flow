// Herdr's split layout for one tab: a binary tree of splits and panes. Dividers drag to resize; the new
// ratio is written back to Herdr, so the Herdr TUI shows the same layout.

import { useRef, useState } from "react";
import type { AgentKind, HPane, LayoutNode, ViewRec } from "@af/core";
import { api } from "./store";
import { Terminal } from "./Terminal";
import { FileView, WebView } from "./Viewers";
import { basename, kindColor } from "./view";

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

export interface PaneCtx {
  panes: Map<string, HPane>;
  views: Record<string, ViewRec>;
  focused?: string;
  onFocus: (paneId: string) => void;
  /** Run agent names by pane, for nicer titles. */
  runAgents: Map<string, { name: string; kind: string; role?: string }>;
  leadPane?: string;
}

export function LayoutView({ tabId, root, zoomed, ctx }: { tabId: string; root: LayoutNode; zoomed: boolean; ctx: PaneCtx }) {
  if (zoomed && ctx.focused) return <PaneView paneId={ctx.focused} ctx={ctx} />;
  return <Node node={root} path={[]} tabId={tabId} ctx={ctx} />;
}

function Node({ node, path, tabId, ctx }: { node: LayoutNode; path: boolean[]; tabId: string; ctx: PaneCtx }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number>();
  if (node.type === "pane") return <PaneView paneId={node.paneId} ctx={ctx} />;
  const row = node.direction === "right";
  const ratio = drag ?? node.ratio;
  const onDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const rect = box.current!.getBoundingClientRect();
    let last = node.ratio;
    const move = (ev: MouseEvent) => {
      const r = row ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      last = Math.min(0.9, Math.max(0.1, r));
      setDrag(last);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove(row ? "resizing-x" : "resizing-y");
      api("POST", "/layout/ratio", { tab: tabId, path, ratio: last })
        .catch((err) => alert(err.message))
        .finally(() => setDrag(undefined));
    };
    document.body.classList.add(row ? "resizing-x" : "resizing-y");
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  return (
    <div ref={box} className={`split ${row ? "split-x" : "split-y"}`}>
      <div className="split-part" style={{ flexBasis: `${ratio * 100}%` }}>
        <Node node={node.first} path={[...path, false]} tabId={tabId} ctx={ctx} />
      </div>
      <div className={`divider ${row ? "v" : "h"} ${drag !== undefined ? "on" : ""}`} onMouseDown={onDown} />
      <div className="split-part" style={{ flexBasis: `${(1 - ratio) * 100}%` }}>
        <Node node={node.second} path={[...path, true]} tabId={tabId} ctx={ctx} />
      </div>
    </div>
  );
}

function PaneView({ paneId, ctx }: { paneId: string; ctx: PaneCtx }) {
  const p = ctx.panes.get(paneId);
  const view = ctx.views[paneId];
  const runAgent = ctx.runAgents.get(paneId);
  const [menu, setMenu] = useState(false);
  const focused = ctx.focused === paneId;
  const split = (direction: "right" | "down", extra: Record<string, unknown> = {}) =>
    api("POST", "/pane/split", { pane: paneId, direction, ...extra }).then((r) => r?.paneId && ctx.onFocus(r.paneId), (e) => alert(e.message));
  const show = () => {
    const target = prompt("File path, folder or URL to show next to this pane")?.trim();
    if (target) api("POST", "/show", { target, of: paneId }).then((r) => ctx.onFocus(r.paneId), (e) => alert(e.message));
  };

  let icon = "$";
  let title = p ? basename(p.cwd) : paneId;
  let color: string | undefined;
  let status: string | undefined;
  if (view) {
    icon = isUrl(view.target) ? "◎" : "≡";
    title = isUrl(view.target) ? view.target.replace(/^https?:\/\//, "") : basename(view.target);
  } else if (runAgent) {
    icon = "●";
    title = `${runAgent.name}${paneId === ctx.leadPane && runAgent.name !== "lead" ? " · lead" : ""}`;
    color = kindColor(runAgent.kind);
    status = p?.agentStatus;
  } else if (p?.agent) {
    icon = "●";
    title = p.agentName ?? p.label ?? p.agent;
    color = kindColor(p.agent);
    status = p.agentStatus;
  } else if (p?.label) title = p.label;

  return (
    <div className={`pane ${focused ? "focused" : ""}`} onMouseDown={() => ctx.onFocus(paneId)}>
      <div className="pane-head">
        <span className="ic" style={color ? { color } : undefined}>
          {icon}
        </span>
        <span className="title" title={view?.target ?? p?.cwd}>
          {title}
        </span>
        {(runAgent || p?.agent) && <span className="kind" style={{ color }}>{runAgent?.kind ?? p?.agent}</span>}
        {status && <span className={`st st-${status}`}>{status}</span>}
        <span className="spacer" />
        <span className="pane-id">{paneId}</span>
        <button title="Split right (shell)" onClick={() => split("right")}>
          ◫
        </button>
        <button title="Split down (shell)" onClick={() => split("down")}>
          ⊟
        </button>
        <span className="menu-wrap">
          <button title="Open an agent or file next to this pane" onClick={() => setMenu((m) => !m)}>
            ＋
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              {(["claude", "codex", "omp"] as AgentKind[]).map((k) => (
                <div key={k} className="item" onClick={() => (setMenu(false), split("right", { kind: "agent", agentKind: k }))}>
                  <span style={{ color: kindColor(k) }}>●</span> {k} agent, right
                </div>
              ))}
              <div className="item" onClick={() => (setMenu(false), show())}>
                ≡ file, folder or URL, right
              </div>
              {view && (
                <div
                  className="item"
                  onClick={() => {
                    setMenu(false);
                    const target = prompt("Show something else in this viewer", view.target)?.trim();
                    if (target) api("POST", "/show", { target, in: paneId }).catch((e) => alert(e.message));
                  }}
                >
                  ↺ change what this viewer shows
                </div>
              )}
            </div>
          )}
        </span>
        <button title="Close pane" onClick={() => confirm(`Close pane ${paneId}${p?.agent ? ` (${p.agent} is running in it)` : ""}?`) && api("POST", "/pane/close", { pane: paneId }).catch((e) => alert(e.message))}>
          ✕
        </button>
      </div>
      <div className="pane-body">{view ? isUrl(view.target) ? <WebView url={view.target} /> : <FileView path={view.target} /> : <Terminal paneId={paneId} autoFocus={focused} />}</div>
    </div>
  );
}
