// Presentation helpers shared by components.

import type { StageKey } from "@af/core";
import { STAGE_LABEL } from "@af/core";

export const kindColor = (kind: string) => `var(--kind-${kind}, var(--text-2))`;

/** The colour of a ticket stage (docs/design.md 4.7): the same in the timeline, the lanes and Needs you. */
export const STAGE_COLOR: Record<StageKey, string> = {
  undelivered: "var(--s-needs)",
  asking: "var(--s-needs)",
  approval: "var(--s-needs)",
  review: "var(--s-submitted)",
  blocked: "var(--s-rejected)",
  failed: "var(--s-rejected)",
  queued: "var(--s-waiting)",
  working: "var(--s-running)",
  idle: "var(--s-ready)",
  done: "var(--s-accepted)",
  dropped: "var(--s-cancelled)",
  cancelled: "var(--s-cancelled)",
  exited: "var(--s-rejected)",
};

export const stageLook = (s: StageKey) => ({ key: s, label: STAGE_LABEL[s], color: STAGE_COLOR[s] });

export function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** How long from `from` to `to` (or now): "7m", "1h 5m". */
export function span(from: string, to?: string) {
  const s = Math.max(0, ((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const basename = (p: string) => p.split("/").filter(Boolean).at(-1) ?? p;
