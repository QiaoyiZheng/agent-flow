// HTTP API. The same routes are served on the Unix socket (for the af CLI and agents) and on
// 127.0.0.1 (for the web UI, behind a token). WebSocket pushes run events and terminal frames.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { AgentKind, Caller, ClientPush, ServerPush, ShowRequest } from "@af/core";
import { AGENT_KINDS } from "@af/core";
import { AfError, type Orchestrator } from "./orchestrator.ts";
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
import { enrichFromTranscript } from "./menu.ts";
import type { Notices } from "./notices.ts";
import { checkReadable, findFiles, listDir, readableRoots, statPath } from "./files.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const repoRootOf = (cwd: string) => {
  const r = Bun.spawnSync(["git", "-C", cwd, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
};
const fail = (code: string, message: string, status = 400) => json({ error: { code, message } }, status);

export function makeHandler(o: Orchestrator, w: Workspaces, backend: TerminalBackend, access: TranscriptAccess = makeTranscriptAccess(o, w)) {
  const commandCache = new Map<string, { at: number; items: unknown[] }>();
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "");
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
    const caller: Caller = { run: body.run || undefined, agent: body.agent || undefined };
    // a session attached with `af here` has no AF_* env: its Herdr pane says who it is
    if (!caller.agent && body.callerPane) {
      const hit = o.agentByPane(String(body.callerPane));
      if (hit && (!caller.run || caller.run === hit.run)) Object.assign(caller, hit);
    }
    try {
      switch (`${req.method} ${path}`) {
        case "GET /health":
          return json({ ok: true });
        case "GET /runs":
          return json(o.listRuns());
        case "POST /runs":
          return json(await o.createRun(body));
        case "GET /run":
          return json(o.getRun(caller.run));
        case "GET /whoami":
          return json(caller.agent ? { run: caller.run, agent: caller.agent } : null);
        case "POST /runs/attach": {
          const p = w.model.panes.find((x) => x.id === String(body.pane ?? ""));
          if (!p) throw new AfError("unknown_pane", "af here must run inside a Herdr pane (HERDR_PANE_ID)", 400);
          if (p.machine !== "local") throw new AfError("remote_run", "runs on remote machines are not supported yet");
          if (!p.agent) throw new AfError("no_agent", `pane ${p.id} has no agent Herdr recognizes`);
          return json(await o.attachRun({ paneId: p.id, tabId: p.tabId, workspaceId: p.workspaceId, cwd: p.cwd, kind: p.agent as AgentKind }));
        }
        case "POST /graph/apply":
          return json(o.applyWorkflow(caller, String(body.workflow ?? ""), body.goal ? String(body.goal) : undefined));
        case "GET /workflows": {
          if (!o.opts.workflows) return json([]);
          const cwd = body.cwd ? String(body.cwd) : undefined;
          return json(o.opts.workflows.list(cwd ? (repoRootOf(cwd) ?? cwd) : undefined));
        }
        case "POST /workflows/save": {
          if (!o.opts.workflows) throw new AfError("no_workflows", "workflows are not available on this server");
          const name = String(body.name ?? "").trim();
          if (!name) throw new AfError("no_name", "give the workflow a name");
          return json(o.opts.workflows.saveFromRun(o.getRun(caller.run), name, body.description ? String(body.description) : undefined));
        }
        case "POST /run/stop":
          o.stopRun(caller);
          return json({ ok: true });
        case "POST /graph":
          return json({ events: o.graph(caller, body.command) });
        case "GET /diff":
          return json({ diff: o.diff(caller, body.node, body.stat === "1") });
        case "POST /done":
          return json(o.done(caller, body));
        case "POST /send":
          return json(o.send(caller, body));
        case "POST /reply":
          return json(o.reply(caller, body.id, body.body, body.attachments));
        case "POST /inbox":
          return json(o.inbox(caller, !!body.all));
        case "POST /open":
        case "POST /show": {
          const req = body as ShowRequest;
          const rec = await w.show(req, caller.agent ?? "user");
          o.recordOpen(caller, req.target);
          return json(rec);
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
          return json({ model: w.model, views: w.views, runs: o.workspaceRuns(), shellWorkspace: o.shellWorkspace() });
        case "POST /pane/read": {
          const pane = w.resolvePane(body.ref, o.agentPanes(caller.run));
          return json({ pane, text: await w.read(pane, Number(body.lines) || 120) });
        }
        case "POST /pane/split": {
          const direction = body.direction === "down" ? "down" : "right";
          if (body.kind === "agent") return json(await splitAgent(o, w, backend, body.pane, direction, body.agentKind));
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
          const shell = await o.shell();
          await backend.runInPane(shell.paneId, cmd);
          return json({ ok: true, command: cmd, pane: shell.paneId });
        }
        case "POST /workspace/rename":
          return json(await w.renameWorkspace(String(body.workspace ?? ""), String(body.label ?? "")));
        case "POST /workspace/close": {
          const id = String(body.workspace ?? "");
          const run = o.runByWorkspace(id);
          if (run && !o.getRun(run).stopped) o.stopRun({ run });
          await w.closeWorkspace(id);
          return json({ ok: true, stoppedRun: run });
        }
        case "POST /layout/ratio":
          await w.setRatio(body.tab, body.path, Number(body.ratio));
          return json({ ok: true });
        case "POST /spawn":
          return json(await o.spawn(caller, body));
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
          return json(await w.choose(String(body.pane ?? ""), Number(body.index), String(body.label ?? ""), body.text ? String(body.text) : undefined));
        // documents handed over by agents, and opening files in VS Code / Obsidian / their app
        case "POST /deliver": {
          const pane = String(body.pane ?? body.callerPane ?? "") || undefined;
          const p = pane ? w.model.panes.find((x) => x.id === pane) : undefined;
          const file = String(body.path ?? "");
          if (!file.startsWith("/")) throw new AfError("bad_path", "give the file's absolute path");
          if (!existsSync(file) || statSync(file).isDirectory()) throw new AfError("not_found", `${file} is not a file`, 404);
          const d = access.deliveries;
          // shown next to the agent that wrote it: in the viewer its last document went to, else a new one
          let viewer: string | undefined;
          if (p && p.machine === "local" && body.show !== false) {
            const last = [...d.list].reverse().find((x) => x.pane === pane && x.viewer && w.views[x.viewer]);
            const rec = last ? await w.show({ target: file, in: last.viewer }, caller.agent ?? "agent") : await w.show({ target: file, of: pane, split: "right" }, caller.agent ?? "agent");
            viewer = rec.paneId;
          }
          let opened: string | undefined;
          if (d.settings.auto) {
            const app = d.appFor(file);
            opened = (await openWith(app, file).catch(() => undefined))?.app;
          }
          const rec = d.add({
            path: file,
            machine: "local",
            pane,
            workspace: p?.workspaceId,
            agent: caller.agent,
            title: body.title ? String(body.title).slice(0, 200) : undefined,
            note: body.note ? String(body.note).slice(0, 1000) : undefined,
            viewer,
            opened,
            done: !!opened,
          });
          return json({ delivery: rec, kind: fileKind(file), app: d.appFor(file) });
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
        case "POST /attention/dismiss":
          o.dismiss(caller, body.id);
          return json({ ok: true });
        case "GET /shell":
          return json(await o.shell());
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

/** Split a pane and start an agent in the new half. Inside a run it joins the run (protocol, env, mail); elsewhere it is a plain agent. */
async function splitAgent(o: Orchestrator, w: Workspaces, backend: TerminalBackend, pane: string, direction: "right" | "down", kind: AgentKind) {
  if (!AGENT_KINDS.includes(kind)) throw new AfError("bad_kind", `kind must be one of ${AGENT_KINDS.join(", ")}`);
  const base = w.model.panes.find((p) => p.id === pane);
  if (!base) throw new AfError("unknown_pane", `no Herdr pane ${pane}`, 404);
  const run = base.machine === "local" ? o.runByWorkspace(base.workspaceId) : undefined;
  if (run && !o.getRun(run).stopped) {
    const a = await o.spawn({ run }, { name: "", kind, place: { split: pane, direction } });
    await w.refresh();
    return { paneId: a.paneId, agent: a.name, run };
  }
  const { paneId } = await w.split(pane, direction);
  const name = `${kind}-${paneId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`.slice(0, 32);
  const session = kind === "claude" ? crypto.randomUUID() : undefined;
  if (session) w.rememberSession(paneId, session);
  const route = w.route(paneId);
  const args = session
    ? route.local
      ? claudeExtraArgs(o.opts.config, session)
      : ["--session-id", session]
    : kind === "codex"
      ? ["-c", "check_for_update_on_startup=false", "--no-alt-screen"]
      : [];
  const r = await route.backend.startAgent(name, kind, route.raw, args);
  await w.refresh();
  return { paneId, agent: name, started: r.ok };
}

/** Open a file in the user's editor: VS Code when installed, else the system default. */
function openInEditor(path: string) {
  if (!path || !existsSync(path)) throw new AfError("not_found", `${path} does not exist`);
  return openWith("vscode", path).then(() => ({ ok: true }));
}

/** Run events that change the run list the UI shows (and its "Needs you" items). */
const RUN_LIST_EVENTS = new Set(["run.created", "run.stopped", "run.quiescent", "attention.raised", "attention.resolved", "agent.placed"]);

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };

/** Serve a file the UI asked to preview. Only paths inside a run's directories or ~/.agent-flow are allowed. */
/** Folders the UI may read files from: home, temp, agent-flow's home, and every run's folders. */
function fileRoots(o: Orchestrator, home: string) {
  return readableRoots([
    home,
    ...o.listRuns().flatMap((r) => {
      const m = o.getRun(r.id).meta!;
      return [m.cwd, m.repo, m.integration].filter((x): x is string => !!x);
    }),
  ]);
}

function serveFile(o: Orchestrator, home: string, url: URL): Response {
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

export function serve(o: Orchestrator, w: Workspaces, opts: { sock: string; port: number; token: string; home: string; backend: TerminalBackend; webDir: string; notices: Notices }) {
  const access = makeTranscriptAccess(o, w);
  const handler = makeHandler(o, w, opts.backend, access);
  const clients = new Set<import("bun").ServerWebSocket<WsData>>();
  const herdrPush = () => JSON.stringify({ type: "herdr", model: w.model, views: w.views, queue: w.queue } satisfies ServerPush);
  w.onChange(() => {
    const msg = herdrPush();
    for (const c of clients) c.send(msg);
  });
  const deliveriesPush = (): ServerPush => ({ type: "deliveries", list: access.deliveries.list.slice(-100), settings: access.deliveries.settings, apps: installedApps() });
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
        send({ type: "hello", runs: o.listRuns() });
        // the run list (with every run's open attention items) for "Needs you", whichever run this client watches
        ws.data.runsUnsub = o.subscribe((_run, event) => {
          if (RUN_LIST_EVENTS.has(event.type)) send({ type: "hello", runs: o.listRuns() });
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
            ws.send(JSON.stringify({ type: "snapshot", run: msg.run, state: o.getRun(msg.run) } satisfies ServerPush));
          } catch {
            return;
          }
          ws.data.unsub = o.subscribe((run, event) => {
            if (run === msg.run) ws.send(JSON.stringify({ type: "event", run, event } satisfies ServerPush));
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

  return { unix, tcp, stop: () => (unix.stop(true), tcp.stop(true)) };
}
