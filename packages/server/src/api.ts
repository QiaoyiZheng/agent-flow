// HTTP API. The same routes are served on the Unix socket (for the af CLI and agents) and on
// 127.0.0.1 (for the web UI, behind a token). WebSocket pushes run events and terminal frames.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { AgentKind, ClientPush, ServerPush, ShowRequest } from "@af/core";
import { AGENT_KINDS } from "@af/core";
import { AfError } from "./errors.ts";
import type { Teams, Who } from "./teams.ts";
import type { Workspaces } from "./workspaces.ts";
import { MAX_ATTACHMENT, composePrompt, safeName } from "./attachments.ts";
import { claudeExtraArgs } from "./agents.ts";
import type { TerminalBackend } from "./herdr.ts";
import { TerminalBridge } from "./terminals.ts";
import { ChatBridge } from "./transcripts/bridge.ts";
import { chatImage } from "./transcripts/index.ts";
import { type TranscriptAccess, makeTranscriptAccess } from "./access.ts";
import { commandsFor } from "./commands.ts";
import { prepareFork } from "./fork.ts";
import { rewindTo } from "./rewind.ts";
import { type Remote, fileKind, installedApps, openWith } from "./open-with.ts";
import { changedDocuments, docLabel } from "./doc-watch.ts";
import { enrichFromTranscript } from "./menu.ts";
import type { Notices } from "./notices.ts";
import { checkReadable, findFiles, listDir, readableRoots, statPath } from "./files.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const repoRootOf = (cwd: string) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
};
const fail = (code: string, message: string, status = 400) => json({ error: { code, message } }, status);

export function makeHandler(o: Teams, w: Workspaces, backend: TerminalBackend, access: TranscriptAccess = makeTranscriptAccess(o, w)) {
  const commandCache = new Map<string, { at: number; items: unknown[] }>();
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "");
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
    // members and routers carry AF_TEAM/AF_AGENT; any other session is known by its Herdr pane (callerPane)
    const who: Who = o.who({ team: body.team || undefined, agent: body.agent || undefined, pane: body.callerPane || undefined });
    const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
    // a yes/no the caller must give (worktree): absent stays undefined, so agent-flow can ask for it
    const bool = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : v === true || v === "true" || v === "1");
    try {
      switch (`${req.method} ${path}`) {
        case "GET /health":
          return json({ ok: true });
        case "GET /whoami":
          return json(who);
        // teams (docs/design.md section 4)
        case "GET /teams":
          return json(o.list());
        case "GET /team":
          return json(o.get(str(body.team) ?? (who.kind === "router" || who.kind === "member" ? who.team : who.kind === "pane" ? o.directTeamOf(who.pane)?.id : undefined)));
        case "POST /task":
          return json(
            await o.task(who, { kind: body.kind, task: String(body.task ?? ""), title: str(body.title), name: str(body.name), to: str(body.to), worktree: bool(body.worktree), machine: str(body.machine), cwd: str(body.cwd), prepare: str(body.prepare) }),
          );
        case "POST /team/new":
          return json(await o.newTeam(who, { goal: String(body.goal ?? ""), playbook: str(body.playbook), router: body.router, name: str(body.name), cwd: str(body.cwd), machine: str(body.machine) }, !!body.ui));
        case "POST /team/stop":
          return json(o.stopTeam(who, str(body.id)));
        case "GET /machines":
          return json(w.model.machines.map((m) => ({ id: m.id, label: m.label, state: m.state, error: m.error })));
        case "GET /playbooks": {
          const cwd = body.cwd ? String(body.cwd) : undefined;
          return json(o.opts.playbooks?.list(cwd ? (repoRootOf(cwd) ?? cwd) : undefined) ?? []);
        }
        case "GET /team/queue":
          return json(o.queue(who, body.all === "1"));
        case "POST /team/take":
          return json(o.take(who));
        case "POST /team/handled":
          return json(o.handled(who, body.all ? "all" : (Array.isArray(body.seqs) ? body.seqs : [body.seqs]).map(Number).filter(Number.isFinite)));
        case "POST /team/ticket":
          return json(
            await o.openForRouter(who, {
              member: String(body.member ?? ""),
              title: String(body.title ?? ""),
              task: String(body.task ?? ""),
              kind: body.kind,
              role: str(body.role),
              from: str(body.from),
              max: body.max === undefined ? undefined : Number(body.max),
              note: str(body.note),
              inputs: Array.isArray(body.inputs) ? body.inputs.map(String) : undefined,
              worktree: bool(body.worktree),
              machine: str(body.machine),
              cwd: str(body.cwd),
              prepare: str(body.prepare),
            }),
          );
        case "POST /team/close":
          return json(o.closeTicket(who, String(body.ticket ?? ""), body.outcome ?? "done", str(body.note)));
        case "GET /team/ticket":
          return json(o.ticketShow(who, String(body.ticket ?? "")));
        case "GET /team/tickets":
          return json(o.tickets(who));
        case "POST /team/max":
          return json(o.setMax(who, String(body.thread ?? ""), Number(body.max)));
        case "POST /team/tell":
          return json(o.tell(who, String(body.ref ?? ""), String(body.text ?? "")));
        case "POST /team/answer":
          return json(await o.answer(who, String(body.ref ?? ""), Number(body.option), str(body.text)));
        case "POST /team/reply":
          return json(o.reply(who, Number(body.seq), String(body.text ?? "")));
        case "GET /team/status":
          return json(await o.status(who, String(body.ref ?? "")));
        case "POST /team/report":
          return json(o.report(who, String(body.text ?? ""), !!body.done));
        case "POST /team/submit":
          return json(await o.submit(who, { status: body.status ?? "ready", note: str(body.note), to: str(body.to), ticket: str(body.ticket) }));
        case "POST /team/progress":
          return json(o.progress(who, String(body.text ?? "")));
        case "POST /team/ask":
          return json(o.ask(who, String(body.text ?? "")));
        case "POST /attention/dismiss":
          o.dismiss(String(body.team ?? ""), String(body.id ?? ""));
          return json({ ok: true });
        case "POST /open":
        case "POST /show": {
          const req = body as ShowRequest;
          return json(await w.show(req, who.kind === "member" || who.kind === "router" ? who.member : "user"));
        }
        case "GET /view":
          return json(w.view(body.pane) ?? null);
        // browsing local files (the Open dialog, folder panes, previews that reload when the file changes)
        case "GET /fs/list":
          return json(listDir(String(body.path || process.env.HOME || "/"), fileRoots(o, o.opts.home), body.hidden === "1" || body.hidden === true));
        case "GET /fs/find":
          return json(findFiles(String(body.root || process.env.HOME || "/"), String(body.q ?? ""), fileRoots(o, o.opts.home)));
        case "GET /fs/stat":
          return json(statPath(String(body.path ?? ""), fileRoots(o, o.opts.home)));
        case "GET /ls":
          return json({ model: w.model, views: w.views, teams: o.workspaceTeams(), shellWorkspace: shellWorkspace(o.opts.home) });
        case "POST /pane/read": {
          const pane = w.resolvePane(body.ref, o.memberPanes(who.kind === "member" || who.kind === "router" ? who.team : who.kind === "pane" ? o.directTeamOf(who.pane)?.id : undefined));
          return json({ pane, text: await w.read(pane, Number(body.lines) || 120) });
        }
        case "POST /pane/split": {
          const direction = body.direction === "down" ? "down" : "right";
          if (body.kind === "agent") return json(await splitAgent(o, w, body.pane, direction, body.agentKind));
          return json(await w.split(body.pane, direction, { cwd: body.cwd }));
        }
        case "POST /pane/close":
          await w.close(body.pane);
          return json({ ok: true });
        case "POST /tab/new":
          return json(await w.newTab(body.workspace, body.cwd));
        case "POST /tab/close":
          await w.closeTab(body.tab);
          return json({ ok: true });
        case "POST /workspace/new":
          return json(await w.newWorkspace(body.label || "workspace", body.cwd, body.machine || "local"));
        case "POST /machine/connect":
          return json(await w.connect(String(body.machine ?? "")));
        case "POST /machine/disconnect":
          return json(await w.disconnect(String(body.machine ?? "")));
        case "POST /machine/add":
          return json(await w.addMachine(String(body.target ?? ""), body.label, body.session));
        case "POST /machine/remove":
          await w.removeMachine(String(body.machine ?? ""));
          return json({ ok: true });
        case "POST /machine/setup-in-shell": {
          // Herdr asks before installing on a new machine; that needs a real terminal: type the command in the persistent shell
          const target = String(body.target ?? "").trim();
          if (!target || /\s/.test(target) || target.startsWith("-")) throw new AfError("bad_target", "give an SSH target such as myhost or user@host");
          const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`;
          const cmd = ["herdr", "machine", "add", q(target), ...(body.label ? ["--label", q(String(body.label))] : []), ...(body.session ? ["--remote-session", q(String(body.session))] : [])].join(" ");
          const shell = await persistentShell(o.opts.home, backend);
          await backend.runInPane(shell.paneId, cmd);
          return json({ ok: true, command: cmd, pane: shell.paneId });
        }
        case "POST /workspace/rename":
          return json(await w.renameWorkspace(String(body.workspace ?? ""), String(body.label ?? "")));
        case "POST /workspace/close": {
          const id = String(body.workspace ?? "");
          const stopped = o.teamsInWorkspace(id);
          for (const team of stopped) o.stopById(team);
          await w.closeWorkspace(id);
          return json({ ok: true, stoppedTeams: stopped });
        }
        case "POST /layout/ratio":
          await w.setRatio(body.tab, body.path, Number(body.ratio));
          return json({ ok: true });
        case "POST /prompt": {
          // mode auto (default): send now if the agent is free, else queue for the end of its turn; steer: now
          const mode = body.mode === "steer" || body.mode === "queue" ? body.mode : "auto";
          const files = Array.isArray(body.attachments) ? body.attachments.map(String) : [];
          return json({ ok: true, ...(await w.send(String(body.pane ?? ""), String(body.text ?? ""), files, mode)) });
        }
        case "POST /queue/steer":
          return json({ ok: true, ...(await w.steer(String(body.pane ?? ""), String(body.id ?? ""))) });
        case "POST /queue/remove":
          return json({ ok: true, item: w.unqueue(String(body.pane ?? ""), String(body.id ?? "")) });
        case "GET /pane/commands": {
          const pane = String(body.pane ?? "");
          const p = w.model.panes.find((x) => x.id === pane);
          if (!p?.agent) return json({ items: [] });
          const hit = commandCache.get(pane);
          if (hit && Date.now() - hit.at < 30_000) return json({ items: hit.items });
          const r = await access.resolve(pane).catch(() => undefined);
          const items = await commandsFor(p.agent, access.fsFor(pane).fs, r && "source" in r ? r.source.path : undefined, p.cwd);
          commandCache.set(pane, { at: Date.now(), items });
          return json({ items });
        }
        case "POST /pane/fork": {
          const pane = String(body.pane ?? "");
          const r = await access.resolve(pane);
          if ("reason" in r) throw new AfError("no_transcript", `cannot fork: ${r.reason}`);
          const before = body.before === undefined || body.before === null ? undefined : Number(body.before);
          const plan = await prepareFork(access.fsFor(pane).fs, r.source, before);
          const { paneId } = await w.split(pane, body.direction === "down" ? "down" : "right");
          if (plan.session) w.rememberSession(paneId, plan.session.id, plan.session.path);
          const route = w.route(paneId);
          const hook = r.source.agent === "claude" && route.local && o.opts.config.claudeSettings ? ["--settings", o.opts.config.claudeSettings] : [];
          const name = `${r.source.agent}-fork-${paneId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`.slice(0, 32);
          const started = await route.backend.startAgent(name, r.source.agent, route.raw, [...plan.args, ...hook]);
          await w.refresh();
          return json({ paneId, agent: name, started: started.ok, session: plan.session });
        }
        case "GET /pane/menu": {
          const pane = String(body.pane ?? "");
          const st = await w.screenState(pane);
          let menu = st.menu;
          if (menu && w.model.panes.find((p) => p.id === pane)?.agent === "claude") {
            const r = await access.resolve(pane).catch(() => undefined);
            if (r && "source" in r) {
              const fs = access.fsFor(pane).fs;
              const head = await fs.readFrom(r.source.path, 0, 0);
              const tail = head ? await fs.readFrom(r.source.path, Math.max(0, head.size - 512 * 1024), 512 * 1024) : undefined;
              if (tail) menu = enrichFromTranscript(menu, tail.data.toString("utf8"));
            }
          }
          return json({ menu: menu ?? null, overlay: st.overlay ?? null });
        }
        case "POST /pane/choose":
          return json(
            await w.choose(String(body.pane ?? ""), Number(body.index), String(body.label ?? ""), body.text ? String(body.text) : undefined, {
              key: body.key ? String(body.key) : undefined,
              setting: body.setting ? String(body.setting) : undefined,
            }),
          );
        // documents handed over by agents, and opening files in VS Code / Obsidian / their app
        case "POST /deliver": {
          const pane = String(body.pane ?? body.callerPane ?? "") || undefined;
          const file = String(body.path ?? "");
          if (!file.startsWith("/")) throw new AfError("bad_path", "give the file's absolute path");
          if (!existsSync(file) || statSync(file).isDirectory()) throw new AfError("not_found", `${file} is not a file`, 404);
          const rec = await handOver(w, access, { path: file, pane, agent: who.kind === "member" || who.kind === "router" ? who.member : undefined, title: body.title ? String(body.title) : undefined, note: body.note ? String(body.note) : undefined });
          return json({ delivery: rec, kind: fileKind(file), app: access.deliveries.appFor(file) });
        }
        case "POST /deliver/done":
          return json({ ok: !!access.deliveries.done(String(body.id ?? "")) });
        case "GET /open-settings":
          return json({ settings: access.deliveries.settings, apps: installedApps() });
        case "POST /open-settings":
          return json({ settings: access.deliveries.setSettings(body.settings ?? {}) });
        case "POST /open-with": {
          // a file on a remote machine (a pane there names it): only VS Code, over Remote-SSH
          const pane = body.pane ? String(body.pane) : undefined;
          const machine = pane ? w.model.panes.find((x) => x.id === pane)?.machine : body.machine ? String(body.machine) : undefined;
          const m = machine && machine !== "local" ? w.model.machines.find((x) => x.id === machine) : undefined;
          const remote: Remote | undefined = m ? { target: m.target, label: m.label, home: w.remoteOf(`${m.id}~x`)?.home } : undefined;
          const file = String(body.path ?? "");
          const app = String(body.app || (remote ? "vscode" : access.deliveries.appFor(file)));
          const r = await openWith(app, file, remote);
          if (body.delivery) access.deliveries.done(String(body.delivery));
          return json(r);
        }
        case "POST /pane/gemini-relaunch":
          return json(await relaunchGemini(w, backend, String(body.pane ?? "")));
        case "POST /pane/rewind":
          return json(
            await rewindTo(w, access, {
              pane: String(body.pane ?? ""),
              text: String(body.text ?? ""),
              back: Math.max(0, Number(body.back) || 0),
              occurrence: Math.max(1, Number(body.occurrence) || 1),
              ref: Number.isFinite(Number(body.ref)) && body.ref !== null && body.ref !== undefined ? Number(body.ref) : undefined,
              code: !!body.code,
            }),
          );
        case "POST /pane/control":
          return json(await w.control(String(body.pane ?? ""), String(body.action ?? "")));
        case "POST /keys":
          await w.sendKeys(body.pane, Array.isArray(body.keys) ? body.keys.map(String) : []);
          return json({ ok: true });
        case "POST /session": {
          // from claude's SessionStart hook (af hook claude-session)
          if (body.pane && body.id) w.rememberSession(String(body.pane), String(body.id), body.path ? String(body.path) : undefined);
          return json({ ok: true });
        }
        case "GET /shell":
          return json(await persistentShell(o.opts.home, backend));
        case "POST /edit":
          return json(await openInEditor(body.path));
        case "POST /flush":
          await o.flush();
          return json({ ok: true });
        default:
          return fail("not_found", `no route ${req.method} ${path}`, 404);
      }
    } catch (e) {
      if (e instanceof AfError) return fail(e.code, e.message, e.status);
      console.error(e);
      return fail("internal", (e as Error).message, 500);
    }
  };
}

/** Split a pane and start a plain agent in the new half. */
async function splitAgent(o: Teams, w: Workspaces, pane: string, direction: "right" | "down", kind: AgentKind) {
  if (!AGENT_KINDS.includes(kind)) throw new AfError("bad_kind", `kind must be one of ${AGENT_KINDS.join(", ")}`);
  if (!w.model.panes.some((p) => p.id === pane)) throw new AfError("unknown_pane", `no Herdr pane ${pane}`, 404);
  const { paneId } = await w.split(pane, direction);
  const name = `${kind}-${paneId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`.slice(0, 32);
  // claude takes a session id: agent-flow then knows which conversation file is this pane's. (gemini does too, but
  // restarts with the same arguments after its folder-trust dialog, and then fails on the id: it is found by folder.)
  const session = kind === "claude" ? crypto.randomUUID() : undefined;
  if (session) w.rememberSession(paneId, session);
  const route = w.route(paneId);
  const args =
    kind === "claude" && session
      ? route.local
        ? claudeExtraArgs(o.opts.config, session)
        : ["--session-id", session]
      : kind === "codex"
          ? ["-c", "check_for_update_on_startup=false", "--no-alt-screen"]
          : kind === "gemini"
            ? (o.opts.config.args.gemini ?? [])
            : [];
  const r = await route.backend.startAgent(name, kind, route.raw, args);
  await w.refresh();
  return { paneId, agent: name, started: r.ok };
}

/**
 * A gemini that shows "Enter Gemini API Key" was started in a shell without the gateway settings (a terminal opened
 * before ~/.gemini/gateway.env existed). Quit it — Esc goes from the key box to "Get started", where Ctrl+C twice
 * quits (Ctrl+C in the key box would clear a stored key) — and start it again with the settings loaded, with
 * the same arguments.
 */
async function relaunchGemini(w: Workspaces, backend: TerminalBackend, pane: string) {
  const p = w.model.panes.find((x) => x.id === pane);
  if (!p || p.agent !== "gemini") throw new AfError("not_gemini", "this pane has no gemini");
  const route = w.route(pane);
  const procs = await w.processes(pane).catch(() => [] as { pid: number; argv: string[] }[]);
  // its arguments, without node and the script (npm's link or our launcher)
  const cmd = procs.map((x) => x.argv).find((a) => a.some((s) => /gemini(\.js)?$/.test(s)));
  const args = cmd ? cmd.slice(cmd.findIndex((s) => /gemini(\.js)?$/.test(s)) + 1).filter((s) => !/^--max-old-space-size=/.test(s)) : [];
  const screen = () => route.backend.readScreen(route.raw);
  if (/Enter Gemini API Key/i.test(await screen())) {
    await route.backend.sendKeys(route.raw, ["esc"]);
    await Bun.sleep(600);
  }
  for (let i = 0; i < 2; i++) {
    await route.backend.sendKeys(route.raw, ["ctrl+c"]);
    await Bun.sleep(500);
  }
  // back at the shell: no gemini among the pane's processes
  for (let i = 0; i < 30; i++) {
    const now = await w.processes(pane).catch(() => []);
    if (!now.some((x) => x.argv.some((s) => /gemini/.test(s)))) break;
    await Bun.sleep(200);
    if (i === 29) throw new AfError("still_running", "gemini did not quit; look at its terminal");
  }
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // the Enter goes with the text: sendKeys addresses the agent, and there is none in the pane now, only the shell
  await route.backend.sendText(route.raw, `${`. "$HOME/.gemini/gateway.env" && gemini ${args.map(q).join(" ")}`.trim()}\r`);
  return { ok: true, args };
}

/** Open a file in the user's editor: VS Code when installed, else the system default. */
function openInEditor(path: string) {
  if (!path || !existsSync(path)) throw new AfError("not_found", `${path} does not exist`);
  return openWith("vscode", path).then(() => ({ ok: true }));
}

/** Team events that change the team list the UI shows (Needs you items, stages, queue counts). */
const TEAM_LIST_EVENTS = new Set([
  "team.created",
  "team.stopped",
  "member.placed",
  "member.status",
  "ticket.opened",
  "ticket.delivered",
  "ticket.submitted",
  "ticket.reopened",
  "ticket.closed",
  "queue.added",
  "queue.taken",
  "queue.handled",
  "attention.raised",
  "attention.resolved",
]);

/** The persistent shell shown in the UI's bottom drawer: one Herdr workspace that outlives teams. */
export function shellWorkspace(home: string): string | undefined {
  const file = join(home, "shell.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).workspaceId as string | undefined) : undefined;
}

async function persistentShell(home: string, backend: TerminalBackend): Promise<{ paneId: string; workspaceId?: string }> {
  const file = join(home, "shell.json");
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { paneId: string; workspaceId?: string };
    if (await backend.paneExists(saved.paneId)) return saved;
  }
  const ws = await backend.createWorkspace("af shell", process.env.HOME ?? "/");
  const saved = { paneId: ws.paneId, workspaceId: ws.workspaceId };
  writeFileSync(file, JSON.stringify(saved));
  return saved;
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };

/** Serve a file the UI asked to preview. Only paths inside a run's directories or ~/.agent-flow are allowed. */
/**
 * When an agent's turn ends, the documents it changed in its folder during the turn are handed over (see
 * doc-watch.ts), unless it handed them over itself. Local agents only: a remote folder would need a walk over SSH.
 */
export function watchDocuments(w: Workspaces, access: TranscriptAccess) {
  return w.onTurnEnd((t) => {
    if (t.machine !== "local" || !t.cwd || t.cwd === "/" || t.cwd === (process.env.HOME ?? "")) return;
    // the turn's start (when Herdr saw it), a little early for safety; at most an hour back
    const since = Math.max((t.started ?? t.ended - 3600_000) - 2000, t.ended - 3600_000);
    setTimeout(async () => {
      try {
        const found = changedDocuments(t.cwd, since);
        const recent = access.deliveries.list.filter((d) => d.pane === t.pane && Date.parse(d.at) >= since);
        for (const path of found.reverse()) {
          if (recent.some((d) => d.path === path)) continue; // handed over by the agent during this turn
          await handOver(w, access, { path, pane: t.pane, title: `${t.agent} changed ${docLabel(t.cwd, path)}`, found: true });
        }
      } catch {}
    }, 1500); // the agent's last writes may land just after Herdr shows it done
  });
}

/**
 * Hand a document over to the user: recorded for the agent's pane, where the chat view shows a row of open buttons
 * under the agent's reply (Obsidian / VS Code / its app / a preview pane, on a click). Nothing opens by itself and
 * nothing goes to "Needs you": with many agents at once, a viewer pane per document made everything slow. Only
 * the user's setting "open right away" opens the app at once.
 */
export async function handOver(w: Workspaces, access: TranscriptAccess, d: { path: string; pane?: string; agent?: string; title?: string; note?: string; found?: boolean }) {
  const p = d.pane ? w.model.panes.find((x) => x.id === d.pane) : undefined;
  const list = access.deliveries;
  const opened = list.settings.auto ? (await openWith(list.appFor(d.path), d.path).catch(() => undefined))?.app : undefined;
  return list.add({
    path: d.path,
    machine: p?.machine ?? "local",
    pane: d.pane,
    workspace: p?.workspaceId,
    agent: d.agent,
    title: d.title?.slice(0, 200),
    note: d.note?.slice(0, 1000),
    opened,
    done: !!opened,
    ...(d.found ? { found: true } : {}),
  });
}

/** Folders the UI may read files from: home, temp, agent-flow's home, and every team's folders. */
function fileRoots(o: Teams, home: string) {
  return readableRoots([home, ...o.folders()]);
}

function serveFile(o: Teams, home: string, url: URL): Response {
  let path: string;
  try {
    path = checkReadable(url.searchParams.get("path") ?? "", fileRoots(o, home));
  } catch (e) {
    return fail((e as AfError).code ?? "forbidden", (e as Error).message, (e as AfError).status ?? 403);
  }
  if (!existsSync(path) || !statSync(path).isFile()) return fail("not_found", `${path} is not a file`, 404);
  return new Response(Bun.file(path));
}

interface WsData {
  bridge?: TerminalBridge;
  chat?: ChatBridge;
  unsub?: () => void;
  runsUnsub?: () => void;
  cutsUnsub?: () => void;
}

export function serve(o: Teams, w: Workspaces, opts: { sock: string; port: number; token: string; home: string; backend: TerminalBackend; webDir: string; notices: Notices; access?: TranscriptAccess; watchDocs?: boolean }) {
  const access = opts.access ?? makeTranscriptAccess(o, w);
  const handler = makeHandler(o, w, opts.backend, access);
  if (opts.watchDocs !== false) watchDocuments(w, access);
  const clients = new Set<import("bun").ServerWebSocket<WsData>>();
  // ids of teams and of the runs before them: their agents' Herdr names start with "<id>-" (see ServerPush herdr)
  const dispatchers = () => {
    const ids = new Set(o.list().map((t) => t.id));
    for (const sub of ["teams", "runs"])
      try {
        for (const d of readdirSync(join(opts.home, sub))) if (/^[tr][0-9a-z]{4}$/.test(d)) ids.add(d);
      } catch {}
    return [...ids];
  };
  const herdrPush = () => JSON.stringify({ type: "herdr", model: w.model, views: w.views, queue: w.queue, dispatchers: dispatchers() } satisfies ServerPush);
  w.onChange(() => {
    const msg = herdrPush();
    for (const c of clients) c.send(msg);
  });
  const deliveriesPush = (): ServerPush => ({ type: "deliveries", list: access.deliveries.list.slice(-300), settings: access.deliveries.settings, apps: installedApps() });
  access.deliveries.onChange(() => {
    const msg = JSON.stringify(deliveriesPush());
    for (const c of clients) c.send(msg);
  });
  opts.notices.subscribe((notice) => {
    const msg = JSON.stringify({ type: "notice", notice } satisfies ServerPush);
    for (const c of clients) c.send(msg);
  });

  const unix = Bun.serve({ unix: opts.sock, fetch: handler });

  const tcp = Bun.serve<WsData>({
    hostname: "127.0.0.1",
    port: opts.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const sameOrigin = !origin || origin === `http://127.0.0.1:${opts.port}` || origin === `http://localhost:${opts.port}` || origin.startsWith("http://localhost:5173") || origin.startsWith("http://127.0.0.1:5173");
      const authed = url.searchParams.get("token") === opts.token || req.headers.get("x-af-token") === opts.token;
      if (url.pathname === "/ws") {
        if (!sameOrigin || !authed) return fail("forbidden", "bad origin or token", 403);
        return server.upgrade(req, { data: {} }) ? undefined : fail("upgrade_failed", "websocket upgrade failed");
      }
      if (url.pathname.startsWith("/api/")) {
        if (!sameOrigin || !authed) return fail("forbidden", "bad origin or token", 403);
        if (url.pathname === "/api/file") return serveFile(o, opts.home, url);
        if (url.pathname === "/api/chat-image") {
          const img = await chatImage(url.searchParams.get("id") ?? "");
          if (!img) return fail("not_found", "that image is gone (the conversation was reopened)", 404);
          return new Response(new Uint8Array(img.bytes), { headers: { "content-type": img.type, "cache-control": "private, max-age=86400, immutable" } });
        }
        if (url.pathname === "/api/upload" && req.method === "POST") {
          try {
            const len = Number(req.headers.get("content-length") ?? 0);
            if (len > MAX_ATTACHMENT) return fail("too_large", "attachments are limited to 50 MB", 413);
            const bytes = new Uint8Array(await req.arrayBuffer());
            const name = safeName(url.searchParams.get("name") ?? undefined, req.headers.get("content-type") ?? undefined);
            return Response.json(await w.saveAttachment(url.searchParams.get("pane") ?? "", bytes, name));
          } catch (e) {
            if (e instanceof AfError) return fail(e.code, e.message, e.status);
            return fail("internal", (e as Error).message, 500);
          }
        }
        return handler(req);
      }
      // static UI
      const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = join(opts.webDir, rel);
      if (!file.startsWith(opts.webDir) || !existsSync(file) || !statSync(file).isFile()) {
        const index = join(opts.webDir, "index.html");
        return existsSync(index) ? new Response(readFileSync(index), { headers: { "content-type": "text/html" } }) : new Response("web UI not built: run `bun run build` in packages/web", { status: 503 });
      }
      return new Response(Bun.file(file), { headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" } });
    },
    websocket: {
      open(ws) {
        const send = (m: ServerPush) => ws.send(JSON.stringify(m));
        ws.data.bridge = new TerminalBridge((p, mode, cols, rows) => w.terminalArgv(p, mode, cols, rows), send, (paneId, reason) => {
          // ssh exits with 255 when the connection itself broke: check the machine now (its own notice says so)
          const remote = w.remoteOf(paneId);
          if (remote && /\b255\b|connection|broken pipe|closed by remote/i.test(reason)) return void remote.verify?.();
          opts.notices.add("warn", `terminal:${paneId}`, `The terminal stream for ${paneId} stopped`, reason);
        });
        ws.data.chat = new ChatBridge({
          fsFor: access.fsFor,
          send,
          panes: () => w.model.panes,
          knownSession: access.known,
          argv: (p) => w.processArgv(p),
          pids: (p) => w.processes(p).then((ps) => ps.map((x) => x.pid)),
          cutsFor: (path) => access.cuts.for(path),
          screen: (p) => w.read(p, 400),
        });
        // a rewind: chat views of that pane read the conversation again
        ws.data.cutsUnsub = access.cuts.onChange((pane) => ws.data.chat?.reload(pane));
        send({ type: "hello", teams: o.list() });
        // the team list (with every team's open attention items) for "Needs you", whichever team this client watches
        let helloTimer: ReturnType<typeof setTimeout> | undefined;
        ws.data.runsUnsub = o.subscribe((_team, event) => {
          if (!TEAM_LIST_EVENTS.has(event.type) || helloTimer) return;
          helloTimer = setTimeout(() => {
            helloTimer = undefined;
            send({ type: "hello", teams: o.list() });
          }, 100);
        });
        send({ type: "notices", list: opts.notices.list });
        send(deliveriesPush());
        ws.send(herdrPush());
        clients.add(ws);
      },
      message(ws, raw) {
        let msg: ClientPush;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.type === "watch") {
          ws.data.unsub?.();
          try {
            ws.send(JSON.stringify({ type: "snapshot", team: msg.team, state: o.get(msg.team) } satisfies ServerPush));
          } catch {
            return;
          }
          ws.data.unsub = o.subscribe((team, event) => {
            if (team === msg.team) ws.send(JSON.stringify({ type: "event", team, event } satisfies ServerPush));
          });
          return;
        }
        if (msg.type === "chat.open" || msg.type === "chat.close" || msg.type === "chat.more") return ws.data.chat?.handle(msg);
        ws.data.bridge?.handle(msg);
      },
      close(ws) {
        clients.delete(ws);
        ws.data.unsub?.();
        ws.data.runsUnsub?.();
        ws.data.cutsUnsub?.();
        ws.data.bridge?.closeAll();
        ws.data.chat?.closeAll();
      },
    },
  });

  return { unix, tcp, handler, stop: () => (unix.stop(true), tcp.stop(true)) };
}
