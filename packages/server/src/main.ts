// af server entry point.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { loadConfig, writeClaudeSettings } from "./agents.ts";
import { Herdr } from "./herdr.ts";
import { Teams } from "./teams.ts";
import { makeTranscriptAccess } from "./access.ts";
import { serve } from "./api.ts";
import { Workspaces } from "./workspaces.ts";
import { RemoteMachine } from "./remote.ts";
import { Notices } from "./notices.ts";
import { PlaybookLibrary } from "./playbooks.ts";
import { installSkill } from "./skills.ts";

export const afHome = () => process.env.AF_HOME ?? join(homedir(), ".agent-flow");
const repoRoot = resolve(import.meta.dir, "../../..");

/** Write ~/.agent-flow/bin/af so agents (and the user) can call the CLI. */
function installShim(home: string) {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "af");
  // the server's socket is the default, so sessions started outside agent-flow (af here) reach this server
  writeFileSync(shim, `#!/bin/sh\nexport AF_SELF="$0"\nexport AF_SOCK="\${AF_SOCK:-${join(home, "server.sock")}}"\nexec "${process.execPath}" "${join(repoRoot, "packages/cli/src/main.ts")}" "$@"\n`);
  chmodSync(shim, 0o755);
  return bin;
}

const socketAlive = (path: string) =>
  new Promise<boolean>((res) => {
    const s = connect(path);
    s.on("connect", () => (s.end(), res(true)));
    s.on("error", () => res(false));
  });

export async function main(argv: string[]) {
  const home = afHome();
  mkdirSync(home, { recursive: true });
  const port = Number(argv[argv.indexOf("--port") + 1] || process.env.AF_PORT || 7477);
  const sock = process.env.AF_SOCK ?? join(home, "server.sock");
  if (existsSync(sock)) {
    if (await socketAlive(sock)) {
      console.error(`af server is already running (${sock})`);
      process.exit(1);
    }
    rmSync(sock);
  }
  const tokenFile = join(home, "token");
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, crypto.randomUUID().replace(/-/g, ""), { mode: 0o600 });
  const token = readFileSync(tokenFile, "utf8").trim();

  const backend = new Herdr();
  await backend.listAgents().catch((e) => {
    console.error(`${(e as Error).message}\nStart Herdr first (run \`herdr\` in a terminal).`);
    process.exit(1);
  });
  const binDir = installShim(home);
  const config = { ...loadConfig(home), claudeSettings: writeClaudeSettings(home, sock, join(binDir, "af")) };
  const playbooks = new PlaybookLibrary(join(repoRoot, "packages/skill/playbooks"), join(home, "playbooks"));
  const notices = new Notices();
  const w = new Workspaces({
    home,
    backend,
    notify: (level, source, text, detail) => notices.add(level, source, text, detail),
    paneEnv: () => ({ AF_SOCK: sock, PATH: `${binDir}:${process.env.PATH ?? ""}` }),
    remote: (spec, onChange) => {
      const remote = new RemoteMachine(spec, join(home, "ssh"), onChange);
      return { remote, backend: () => new Herdr(backend.bin, remote.sock, (p, mode, cols, rows) => remote.terminalArgv(p, mode, cols, rows)) };
    },
  });
  await w.start();
  let access: ReturnType<typeof makeTranscriptAccess> | undefined;
  const o = new Teams({ home, backend, w, sock, binDir, protocolDir: join(repoRoot, "packages/skill"), config, playbooks, peek: (pane) => access!.peek(pane) });
  access = makeTranscriptAccess(o, w);
  const n = o.load();
  o.start(1000);
  // AF_SECOND_SERVER=1: a server next to the main one (tests, trying a branch): it does not rewrite the skills in the
  // user's skill folders, and does not hand over documents agents change (the main server does both)
  const second = process.env.AF_SECOND_SERVER === "1";
  serve(o, w, { sock, port, token, home, backend, webDir: join(repoRoot, "packages/web/dist"), notices, access, watchDocs: !second });
  writeFileSync(join(home, "server.json"), JSON.stringify({ pid: process.pid, port, sock, url: `http://127.0.0.1:${port}/?token=${token}` }));
  console.log(`agent-flow server: ${n} team(s) loaded`);
  console.log(`  UI:     http://127.0.0.1:${port}/?token=${token}`);
  console.log(`  socket: ${sock}`);
  console.log(`  af CLI: ${join(binDir, "af")}  (add ${binDir} to PATH)`);
  if (!second) for (const f of installSkill(join(binDir, "af"))) console.log(`  skill:  ${f}`);
  const shutdown = () => {
    o.stop();
    w.stop();
    rmSync(sock, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) await main(process.argv.slice(2));
