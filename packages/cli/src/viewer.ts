// `af viewer`: the process inside a viewer pane. The web UI draws a rich file/web view for the pane; this
// draws a plain one for the Herdr TUI, and follows the pane's target as agents change it with `af open --in`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

/** Ask the server what this pane shows. Never exits: while the server restarts, keep the last view. */
async function currentTarget(sock: string, pane: string): Promise<string | undefined> {
  try {
    const r = await fetch(`http://af/view?pane=${encodeURIComponent(pane)}`, { unix: sock } as RequestInit);
    if (!r.ok) return undefined;
    return ((await r.json()) as { target?: string } | null)?.target;
  } catch {
    return undefined;
  }
}

const isUrl = (s: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
const MAX_LINES = 3000;

function render(target: string): string {
  const head = `\x1b[2m≡ agent-flow viewer · shown in full in the web UI · q closes this pane\x1b[0m\r\n\x1b[1m${target}\x1b[0m\r\n\r\n`;
  if (isUrl(target)) return head + "Web page. Open the agent-flow web UI to see it.\r\n";
  if (!existsSync(target)) return head + "\x1b[31mThis path does not exist (any more).\x1b[0m\r\n";
  const st = statSync(target);
  if (st.isDirectory()) {
    const entries = readdirSync(target, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return head + entries.map((e) => (e.isDirectory() ? `\x1b[34m${e.name}/\x1b[0m` : e.name)).join("\r\n") + "\r\n";
  }
  if (st.size > 5_000_000) return head + `Large file (${(st.size / 1e6).toFixed(1)} MB). Open it in the web UI or an editor.\r\n`;
  const bat = Bun.which("bat");
  if (bat) {
    const r = Bun.spawnSync([bat, "--paging=never", "--color=always", "--style=numbers", "--line-range", `:${MAX_LINES}`, target], { stdout: "pipe", stderr: "ignore", env: { ...process.env, COLUMNS: String(process.stdout.columns ?? 100) } });
    if (r.exitCode === 0) return head + r.stdout.toString().replace(/\r?\n/g, "\r\n");
  }
  const text = readFileSync(target, "utf8");
  if (text.includes("\u0000")) return head + "Binary file. Open it in the web UI or an editor.\r\n";
  const lines = text.split("\n").slice(0, MAX_LINES);
  const w = String(lines.length).length;
  return head + lines.map((l, i) => `\x1b[2m${String(i + 1).padStart(w)}\x1b[0m  ${l}`).join("\r\n") + "\r\n";
}

export async function runViewer(sock: string, pane: string | undefined) {
  if (!pane) {
    console.error("af viewer runs inside a Herdr pane (HERDR_PANE_ID is not set)");
    process.exit(2);
  }
  process.stdout.write("\x1b[?25l");
  const bye = () => {
    process.stdout.write("\x1b[?25h");
    process.exit(0);
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on("data", (d) => {
      const k = d.toString();
      if (k === "q" || k === "\u0003") bye();
    });
  }
  process.on("SIGTERM", bye);
  let shown = "";
  for (;;) {
    const target = await currentTarget(sock, pane);
    if (target) {
      let stamp = target;
      try {
        if (!isUrl(target)) stamp += `@${statSync(target).mtimeMs}`;
      } catch {}
      if (stamp !== shown) {
        shown = stamp;
        process.stdout.write("\x1b[2J\x1b[3J\x1b[H" + render(target));
      }
    }
    await Bun.sleep(1000);
  }
}
