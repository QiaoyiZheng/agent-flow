// Open a file in an app on this Mac: VS Code, Obsidian, the system's default app, or Finder. Files on a remote
// machine open only in VS Code, over its Remote-SSH extension (the original file: edits go to the remote machine).
//
//   VS Code    local: open -a "Visual Studio Code" <path>
//              remote: its bundled CLI, code --file-uri vscode-remote://ssh-remote+<host><path>
//   Obsidian   a file inside one of its vaults: obsidian://open?path=<path> (opens it in that vault);
//              any other file: open -a Obsidian <path> (Obsidian registers itself for Markdown)
//   default    open <path> (PowerPoint for .pptx, Preview for .pdf, …)
//   finder     open -R <path> (shows it in its folder)

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { AfError } from "./errors.ts";

export type OpenApp = "vscode" | "obsidian" | "default" | "finder";
export const OPEN_APPS: readonly OpenApp[] = ["vscode", "obsidian", "default", "finder"];

/** What kind of file, for which app opens it by default. */
export type FileKind = "markdown" | "text" | "document";

const MARKDOWN = new Set([".md", ".markdown", ".mdx"]);
/** Files that are not text: opened by the system's default app, not previewed as text. */
const DOCUMENT = new Set([".pptx", ".ppt", ".key", ".docx", ".doc", ".pages", ".xlsx", ".xls", ".numbers", ".odt", ".odp", ".ods", ".rtf", ".pdf", ".epub", ".zip", ".mp4", ".mov", ".mp3", ".wav"]);

export function fileKind(path: string): FileKind {
  const e = extname(path).toLowerCase();
  return MARKDOWN.has(e) ? "markdown" : DOCUMENT.has(e) ? "document" : "text";
}

const APP_PATHS = {
  vscode: ["/Applications/Visual Studio Code.app", join(homedir(), "Applications/Visual Studio Code.app")],
  obsidian: ["/Applications/Obsidian.app", join(homedir(), "Applications/Obsidian.app")],
};
const appPath = (app: "vscode" | "obsidian") => APP_PATHS[app].find((p) => existsSync(p));

/** The apps on this Mac (VS Code and Obsidian are optional; the default app and Finder always work). */
export function installedApps() {
  const mac = process.platform === "darwin";
  return {
    vscode: !!appPath("vscode") || !!Bun.which("code"),
    obsidian: mac ? !!appPath("obsidian") : !!Bun.which("obsidian"),
    default: true,
    finder: mac,
  };
}

/** Obsidian's vault folders, from its own settings. */
export function obsidianVaults(): string[] {
  const file = process.platform === "darwin" ? join(homedir(), "Library/Application Support/obsidian/obsidian.json") : join(homedir(), ".config/obsidian/obsidian.json");
  try {
    const d = JSON.parse(readFileSync(file, "utf8"));
    return Object.values(d?.vaults ?? {})
      .map((v: any) => (typeof v?.path === "string" ? v.path : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** VS Code's command line tool (bundled in the app on a Mac), for remote files. */
function codeCli() {
  const app = appPath("vscode");
  const bundled = app ? join(app, "Contents/Resources/app/bin/code") : undefined;
  return bundled && existsSync(bundled) ? bundled : (Bun.which("code") ?? undefined);
}

export interface Remote {
  /** The SSH target VS Code's Remote-SSH connects to (the Herdr machine's target, a Host in ~/.ssh/config). */
  target: string;
  /** The home folder there, for paths starting with ~. */
  home?: string;
  label: string;
}

export interface OpenResult {
  app: OpenApp;
  path: string;
  /** The command run, for the log. */
  how: string;
}

/** How an app is started: the argv. Exposed for tests. */
export function openArgv(app: OpenApp, path: string, remote?: Remote, vaults = obsidianVaults()): string[] {
  const mac = process.platform === "darwin";
  if (remote) {
    if (app !== "vscode") throw new AfError("remote_file", `${path} is on ${remote.label}: only VS Code can open files on another machine (over Remote-SSH)`);
    const abs = path.startsWith("~/") && remote.home ? `${remote.home}${path.slice(1)}` : path;
    if (!abs.startsWith("/")) throw new AfError("bad_path", `not an absolute path: ${path}`);
    const uri = `vscode-remote://ssh-remote+${encodeURIComponent(remote.target)}${encodeURI(abs)}`;
    const cli = codeCli();
    if (cli) return [cli, "--file-uri", uri];
    return [mac ? "open" : "xdg-open", `vscode://vscode-remote/ssh-remote+${encodeURIComponent(remote.target)}${encodeURI(abs)}`];
  }
  switch (app) {
    case "vscode":
      if (mac && appPath("vscode")) return ["open", "-a", appPath("vscode")!, path];
      return [codeCli() ?? "code", path];
    case "obsidian": {
      const inVault = vaults.some((v) => path === v || path.startsWith(v.endsWith("/") ? v : `${v}/`));
      if (inVault || !mac) return [mac ? "open" : "xdg-open", `obsidian://open?path=${encodeURIComponent(path)}`];
      return ["open", "-a", appPath("obsidian") ?? "Obsidian", path];
    }
    case "default":
      return [mac ? "open" : "xdg-open", path];
    case "finder":
      if (!mac) return ["xdg-open", statSync(path).isDirectory() ? path : join(path, "..")];
      return ["open", "-R", path];
  }
}

export async function openWith(app: string, path: string, remote?: Remote): Promise<OpenResult> {
  if (!OPEN_APPS.includes(app as OpenApp)) throw new AfError("bad_app", `unknown app ${app}; one of ${OPEN_APPS.join(", ")}`);
  const a = app as OpenApp;
  if (!remote && !existsSync(path)) throw new AfError("not_found", `${path} does not exist`, 404);
  const have = installedApps();
  if (a === "vscode" && !have.vscode) throw new AfError("no_app", "VS Code is not installed");
  if (a === "obsidian" && !have.obsidian) throw new AfError("no_app", "Obsidian is not installed");
  const argv = openArgv(a, path, remote);
  const p = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  // the open command returns at once; VS Code's CLI may wait for the window: give it a few seconds
  const code = await Promise.race([p.exited, Bun.sleep(8000).then(() => 0)]);
  if (code !== 0) {
    const err = (await new Response(p.stderr).text()).trim();
    throw new AfError("open_failed", `could not open ${path}: ${err || `exit ${code}`}`);
  }
  return { app: a, path, how: argv.join(" ") };
}
