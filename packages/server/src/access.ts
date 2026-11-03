// Where a pane's transcript is and how to read it: one place for the chat view, the "/" menu and fork.

import type { HPane } from "@af/core";
import type { Orchestrator } from "./orchestrator.ts";
import type { Workspaces } from "./workspaces.ts";
import { join } from "node:path";
import { LocalFS, SshFS, type TranscriptFS, resolveTranscript } from "./transcripts/index.ts";
import { Cuts } from "./rewind.ts";

export type TranscriptAccess = ReturnType<typeof makeTranscriptAccess>;

export function makeTranscriptAccess(o: Orchestrator, w: Workspaces) {
  const localFs = new LocalFS();
  const sshFs = new Map<string, SshFS>();
  const fsFor = (paneId: string): { fs: TranscriptFS; remote: boolean } => {
    const r = w.remoteOf(paneId);
    if (!r) return { fs: localFs, remote: false };
    const key = paneId.split("~")[0]!;
    let f = sshFs.get(key);
    if (!f) sshFs.set(key, (f = new SshFS((cmd, opts) => r.exec(cmd, opts))));
    return { fs: f, remote: true };
  };
  // the hook's report wins: it follows /clear and resumes
  const known = (p: string) => w.sessions[p] ?? (o.sessionForPane(p) ? { id: o.sessionForPane(p)! } : undefined);
  const resolve = async (paneId: string) => {
    const panes = w.model.panes;
    const pane = panes.find((p: HPane) => p.id === paneId);
    if (!pane) return { reason: "pane is gone" } as const;
    const k = known(paneId);
    return resolveTranscript(fsFor(paneId).fs, {
      pane,
      panes,
      knownSession: k?.id,
      knownPath: k?.path,
      argv: () => w.processArgv(paneId).catch(() => []),
      pids: () => w.processes(paneId).then((ps) => ps.map((x) => x.pid)),
      screen: () => w.read(paneId, 400),
    });
  };
  /** Turns rewound away that the transcript does not show yet (see rewind.ts). */
  const cuts = new Cuts(o.opts.home ? join(o.opts.home, "cuts.json") : undefined);
  return { fsFor, known, resolve, cuts };
}
