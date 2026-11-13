// Documents an agent hands over to the user (af deliver, or found at the end of its turn): a report, a write-up,
// slides. The chat view shows each under the agent's reply with buttons to open it in Obsidian / VS Code / its app,
// or it opens at once when the user's settings say so. Kept on disk, so a restart keeps the list.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Delivery, OpenSettings } from "@af/core";
import { type FileKind, fileKind } from "./open-with.ts";

export const DEFAULT_OPEN_SETTINGS: OpenSettings = { auto: false, markdown: "obsidian", text: "vscode", document: "default" };

const MAX = 300;

export class Deliveries {
  list: Delivery[] = [];
  settings: OpenSettings = { ...DEFAULT_OPEN_SETTINGS };
  private listeners = new Set<() => void>();
  private file: string;
  private settingsFile: string;

  constructor(home: string) {
    this.file = join(home, "deliveries.json");
    this.settingsFile = join(home, "settings.json");
    try {
      if (existsSync(this.file)) this.list = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {}
    try {
      if (existsSync(this.settingsFile)) this.settings = { ...DEFAULT_OPEN_SETTINGS, ...(JSON.parse(readFileSync(this.settingsFile, "utf8")).open ?? {}) };
    } catch {}
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Machine `from` is another route to the Herdr of `to`: the documents keep their panes under `to`. */
  remap(from: string, to: string) {
    const pre = `${from}~`; // MACHINE_SEP
    const move = (id?: string) => (id?.startsWith(pre) ? `${to}~${id.slice(pre.length)}` : id);
    let n = 0;
    for (const d of this.list)
      if (d.machine === from || d.pane?.startsWith(pre) || d.workspace?.startsWith(pre) || d.viewer?.startsWith(pre)) {
        Object.assign(d, { machine: d.machine === from ? to : d.machine, pane: move(d.pane), workspace: move(d.workspace), viewer: move(d.viewer) });
        n++;
      }
    if (n) this.changed();
  }

  private changed() {
    if (this.list.length > MAX) this.list = this.list.slice(-MAX);
    writeFileSync(this.file, JSON.stringify(this.list, null, 2));
    for (const l of this.listeners) l();
  }

  /** The app a file of this kind opens in by default. */
  appFor(path: string) {
    const k: FileKind = fileKind(path);
    return this.settings[k];
  }

  add(d: Omit<Delivery, "id" | "at">): Delivery {
    // each hand-over is kept: the chat shows it under the reply of the turn it came in (one row per file per turn)
    const rec: Delivery = { ...d, id: Math.random().toString(36).slice(2, 10), at: new Date().toISOString() };
    this.list.push(rec);
    this.changed();
    return rec;
  }

  update(id: string, set: Partial<Delivery>) {
    const d = this.list.find((x) => x.id === id);
    if (!d) return undefined;
    Object.assign(d, set);
    this.changed();
    return d;
  }

  /** The user opened or dismissed it: it leaves "Needs you". */
  done(id: string) {
    return this.update(id, { done: true });
  }

  setSettings(s: Partial<OpenSettings>) {
    const apps = ["vscode", "obsidian", "default", "finder"];
    const next = { ...this.settings };
    if (typeof s.auto === "boolean") next.auto = s.auto;
    for (const k of ["markdown", "text", "document"] as const) if (typeof s[k] === "string" && apps.includes(s[k]!)) next[k] = s[k]! as OpenSettings[typeof k];
    this.settings = next;
    let all: any = {};
    try {
      if (existsSync(this.settingsFile)) all = JSON.parse(readFileSync(this.settingsFile, "utf8"));
    } catch {}
    writeFileSync(this.settingsFile, JSON.stringify({ ...all, open: next }, null, 2));
    for (const l of this.listeners) l();
    return next;
  }
}
