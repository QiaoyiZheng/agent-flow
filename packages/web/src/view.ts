// Presentation helpers shared by components.

import type { GraphNode, Instance, RunState } from "@af/core";
import { latestInstance, liveEdges } from "@af/core";

export type NodeLook = { key: string; label: string; color: string };

export function nodeLook(n: GraphNode): NodeLook {
  const i = latestInstance(n);
  if (!i) return { key: "waiting", label: "waiting", color: "var(--s-waiting)" };
  switch (i.state) {
    case "ready":
      return i.held ? { key: "held", label: "on hold", color: "var(--s-ready)" } : { key: "ready", label: "ready", color: "var(--s-ready)" };
    case "running":
      // every rejection follows a submission, so "running with as many rejections as submissions" means rework
      return i.rejections.length > 0 && i.rejections.length === i.submissions.length
        ? { key: "running", label: "reworking", color: "var(--s-rejected)" }
        : { key: "running", label: "running", color: "var(--s-running)" };
    case "submitted":
      return { key: "submitted", label: "to check", color: "var(--s-submitted)" };
    case "accepted": {
      const o = i.submissions.at(-1)?.outcome;
      return { key: "accepted", label: o ? `accepted · ${o}` : "accepted", color: "var(--s-accepted)" };
    }
    case "cancelled":
      return { key: "cancelled", label: "cancelled", color: "var(--s-cancelled)" };
  }
}

export const kindColor = (kind: string) => `var(--kind-${kind}, var(--text-2))`;

export const executorLabel = (n: GraphNode) => ("kind" in n.spec.executor ? n.spec.executor.kind : `@${n.spec.executor.agent}`);

export function executorKind(run: RunState, n: GraphNode) {
  if ("kind" in n.spec.executor) return n.spec.executor.kind;
  return run.agents[n.spec.executor.agent]?.kind ?? "claude";
}

export const label = (i: Instance) => `${i.node}#${i.n}`;

/** "⟳ 1/3" for nodes that are the target of a loop. */
export function loopBadge(run: RunState, nodeId: string) {
  const back = liveEdges(run.graph).filter((e) => e.back && e.to === nodeId);
  if (!back.length) return undefined;
  const fired = back.reduce((a, e) => a + e.fired, 0);
  const max = back.reduce((a, e) => a + e.max, 0);
  return { text: `⟳ ${fired}/${max}`, limited: back.some((e) => e.blocked) };
}

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const basename = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;
