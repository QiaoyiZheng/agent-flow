// Playbooks: what a router follows in an agent team (docs/design.md 4.4). A markdown file with a short header:
//
//   ---
//   name: Humanize loop
//   description: one writes, one reviews independently; back with the review until it passes or rounds run out.
//   ---
//   <the rules, in words: roles, the loop, when to report>
//
// From three places, later ones overriding earlier ones with the same id (the file name):
//   built-in    packages/skill/playbooks/*.md
//   yours       ~/.agent-flow/playbooks/*.md
//   project     <repo>/.agent-flow/playbooks/*.md

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { AfError } from "./errors.ts";

export interface PlaybookInfo {
  id: string;
  name: string;
  description: string;
  source: "built-in" | "yours" | "project";
  path: string;
  error?: string;
}

/** The header between the first two "---" lines, and the rest. */
export function parsePlaybook(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { body: text };
  const head = (Bun.YAML.parse(m[1]!) ?? {}) as { name?: unknown; description?: unknown };
  return { name: typeof head.name === "string" ? head.name : undefined, description: typeof head.description === "string" ? head.description : undefined, body: m[2]! };
}

export class PlaybookLibrary {
  constructor(
    private builtIn: string,
    private user: string,
  ) {}

  list(project?: string): PlaybookInfo[] {
    const dirs: [string, PlaybookInfo["source"]][] = [
      [this.builtIn, "built-in"],
      [this.user, "yours"],
      ...(project ? ([[join(project, ".agent-flow", "playbooks"), "project"]] as [string, PlaybookInfo["source"]][]) : []),
    ];
    const byId = new Map<string, PlaybookInfo>();
    for (const [dir, source] of dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
        const path = join(dir, f);
        const id = basename(f, ".md");
        try {
          const p = parsePlaybook(readFileSync(path, "utf8"));
          byId.set(id, { id, name: p.name ?? id, description: p.description ?? "", source, path });
        } catch (e) {
          byId.set(id, { id, name: id, description: "", source, path, error: (e as Error).message });
        }
      }
    }
    return [...byId.values()];
  }

  find(id: string, project?: string): PlaybookInfo {
    const p = this.list(project).find((x) => x.id === id);
    if (!p) throw new AfError("unknown_playbook", `no playbook "${id}". Playbooks: ${this.list(project).map((x) => x.id).join(", ")}`, 404);
    if (p.error) throw new AfError("bad_playbook", `${p.path}: ${p.error}`);
    return p;
  }
}
