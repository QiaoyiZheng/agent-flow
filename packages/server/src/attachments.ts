// Files pasted or dropped into the UI's composer. They are saved under ~/.agent-flow/attachments/<date>/
// (or the same path on a remote machine, for remote agents), and the prompt starts with a line asking the
// agent to read them. Agents read files by path, so nothing has to be pasted into the terminal.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AfError } from "./errors.ts";

export const MAX_ATTACHMENT = 50 * 1024 * 1024;

export function safeName(name: string | undefined, type: string | undefined) {
  const ext = type?.startsWith("image/") ? `.${type.slice(6).replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "")}` : "";
  const base = (name || `pasted-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}${ext || ".bin"}`).replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(-80);
  return base.startsWith(".") ? `file${base}` : base;
}

export function stamp() {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return { date, id: Math.random().toString(36).slice(2, 8) };
}

/** Save locally. Returns the absolute path. */
export function saveLocal(home: string, bytes: Uint8Array, name: string) {
  if (bytes.length > MAX_ATTACHMENT) throw new AfError("too_large", `attachments are limited to ${MAX_ATTACHMENT / 1024 / 1024} MB`);
  const { date, id } = stamp();
  const dir = join(home, "attachments", date);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}-${name}`);
  writeFileSync(path, bytes);
  return path;
}

/** The text sent to the agent: a request to read the attachments, then the user's message. */
export function composePrompt(text: string, attachments: string[]) {
  const body = text.trim();
  if (!attachments.length) return body;
  const list = attachments.map((p) => `- ${p}`).join("\n");
  return `Read these attached files first:\n${list}${body ? `\n\n${body}` : ""}`;
}
