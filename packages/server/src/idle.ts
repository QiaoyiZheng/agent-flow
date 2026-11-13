// The "close idle" button: close the sessions that wait for nothing, on every connected machine.
//   - sessions started for a task or a team (af task, a team's members) with nothing left to do: their results taken,
//     no ticket or message waiting, not working, not being talked with (Teams.keepReason; the same rule as a handoff)
//   - shells left alone in a tab with nothing running in them (what an agent that exited leaves behind)
// Not closed: sessions the user started (main sessions and their own agents), viewers, the persistent shell, a tab
// that would leave its workspace empty, and anything with text typed in its box. Sessions the user has talked with
// directly are listed but not ticked: the user decides.

import { basename } from "node:path";
import { inputText } from "./controls.ts";
import type { Teams } from "./teams.ts";
import type { Workspaces } from "./workspaces.ts";

export interface IdleSession {
  pane: string;
  kind: "agent" | "shell";
  /** "writer3 (codex)", or "shell in iad-evidence". */
  label: string;
  /** What it last did (its last ticket), for agents. */
  title?: string;
  workspace: string;
  workspaceLabel: string;
  machine: string;
  machineLabel: string;
  /** For a team's session: its team and member name. */
  team?: string;
  member?: string;
  /** The user has talked with it directly: listed, but not ticked by default (it may be a conversation they keep). */
  talked?: boolean;
}

const SHELLS = new Set(["zsh", "bash", "sh", "dash", "fish", "ksh", "tcsh", "csh", "nu", "login"]);
/** Nothing runs in the pane but its shell. */
export const onlyShell = (procs: { argv: string[] }[]) => procs.length > 0 && procs.every((p) => SHELLS.has(basename((p.argv[0] ?? "").replace(/^-/, ""))));

export async function idleSessions(o: Teams, w: Workspaces, hiddenWorkspace?: string): Promise<IdleSession[]> {
  const m = w.model;
  const online = new Set(m.machines.filter((x) => (x.local || x.state === "online") && !x.aliasOf).map((x) => x.id));
  const wsOf = (id: string) => m.workspaces.find((x) => x.id === id);
  const machineLabel = (id: string) => m.machines.find((x) => x.id === id)?.label ?? id;
  const panesInTab = (tab: string) => m.panes.filter((p) => p.tabId === tab).length;
  const base = (p: (typeof m.panes)[number]) => ({ pane: p.id, workspace: p.workspaceId, workspaceLabel: wsOf(p.workspaceId)?.label ?? p.workspaceId, machine: p.machine, machineLabel: machineLabel(p.machine) });
  const out: IdleSession[] = [];
  for (const x of await o.idleMembers()) {
    const p = m.panes.find((q) => q.id === x.pane);
    if (!p || !online.has(p.machine) || p.workspaceId === hiddenWorkspace) continue;
    out.push({ ...base(p), kind: "agent", label: `${x.member} (${x.agent})`, title: x.title, team: x.team, member: x.member, ...(x.talked ? { talked: true } : {}) });
  }
  // shells alone in their tab, with nothing running
  const shells = m.panes.filter((p) => !p.agent && !w.view(p.id) && online.has(p.machine) && p.workspaceId !== hiddenWorkspace && panesInTab(p.tabId) === 1);
  const checked: (typeof shells)[number][] = [];
  for (let i = 0; i < shells.length; i += 8)
    await Promise.all(
      shells.slice(i, i + 8).map(async (p) => {
        if (onlyShell(await w.processes(p.id).catch(() => []))) checked.push(p);
      }),
    );
  for (const p of checked.sort((a, b) => a.id.localeCompare(b.id))) out.push({ ...base(p), kind: "shell", label: `shell in ${basename(p.cwd) || p.cwd}` });
  // a workspace keeps one tab: when every tab would go, its first stays
  const closing = new Set(out.filter((x) => panesInTab(m.panes.find((p) => p.id === x.pane)!.tabId) === 1).map((x) => m.panes.find((p) => p.id === x.pane)!.tabId));
  for (const ws of new Set(out.map((x) => x.workspace))) {
    const tabs = m.tabs.filter((t) => t.workspaceId === ws).sort((a, b) => a.number - b.number);
    if (tabs.length && tabs.every((t) => closing.has(t.id))) {
      const keep = m.panes.find((p) => p.tabId === tabs[0]!.id)?.id;
      const i = out.findIndex((x) => x.pane === keep);
      if (i >= 0) out.splice(i, 1);
    }
  }
  return out;
}

/** Close the given sessions that are still idle now (looked at again: things change between the list and the click). */
export async function closeIdle(o: Teams, w: Workspaces, panes: string[], hiddenWorkspace?: string) {
  const want = new Set(panes);
  const now = (await idleSessions(o, w, hiddenWorkspace)).filter((x) => want.has(x.pane));
  const closed: string[] = [];
  const skipped: { pane: string; why: string }[] = panes.filter((p) => !now.some((x) => x.pane === p)).map((pane) => ({ pane, why: "not idle any more" }));
  for (const x of now) {
    try {
      if (x.kind === "agent") {
        const p = w.model.panes.find((q) => q.id === x.pane);
        // text typed in its box: the user is about to say something to it
        if (p && !p.asleep && inputText(p.agent, await w.visible(x.pane, true).catch(() => ""))) {
          skipped.push({ pane: x.pane, why: "text is typed in its box" });
          continue;
        }
        await o.closeIdleMember(x.team!, x.member!);
      } else await w.close(x.pane);
      closed.push(x.pane);
    } catch (e) {
      skipped.push({ pane: x.pane, why: (e as Error).message });
    }
  }
  return { closed, skipped };
}
