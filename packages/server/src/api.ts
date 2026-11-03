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
import { type TranscriptAccess, makeTranscriptAccess } from "./access.ts";
import { commandsFor } from "./commands.ts";
import { prepareFork } from "./fork.ts";
import { enrichFromTranscript } from "./menu.ts";
import type { Notices } from "./notices.ts";

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
          const pane = w.model.panes.find((p) => p.id === body.pane);
          if (!pane?.agent) throw new AfError("no_agent", `pane ${body.pane} has no agent to prompt`);
          const text = composePrompt(String(body.text ?? ""), Array.isArray(body.attachments) ? body.attachments.map(String) : []);
          if (!text) throw new AfError("empty", "nothing to send");
          await w.prompt(body.pane, text);
          return json({ ok: true, sent: text });
        }
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
          return json(openInEditor(body.path));
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
  const code = Bun.which("code");
  const argv = code ? [code, path] : process.platform === "darwin" ? ["open", "-a", "Visual Studio Code", path] : ["xdg-open", path];
  const r = Bun.spawnSync(argv, { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0 && process.platform === "darwin") Bun.spawnSync(["open", "-t", path]);
  return { ok: true };
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json" };

/** Serve a file the UI asked to preview. Only paths inside a run's directories or ~/.agent-flow are allowed. */
function serveFile(o: Orchestrator, home: string, url: URL): Response {
  const path = url.searchParams.get("path") ?? "";
  const allowed = [home, ...o.listRuns().flatMap((r) => {
    const m = o.getRun(r.id).meta!;
    return [m.cwd, m.repo, m.integration].filter((x): x is string => !!x);
  })];
  if (!path.startsWith("/") || path.includes("/../") || !allowed.some((a) => path === a || path.startsWith(a + "/")))
    return fail("forbidden", "path is outside the run directories", 403);
  if (!existsSync(path) || !statSync(path).isFile()) return fail("not_found", `${path} is not a file`, 404);
  return new Response(Bun.file(path));
}

interface WsData {
  bridge?: TerminalBridge;
  chat?: ChatBridge;
  unsub?: () => void;
}

export function serve(o: Orchestrator, w: Workspaces, opts: { sock: string; port: number; token: string; home: string; backend: TerminalBackend; webDir: string; notices: Notices }) {
  const access = makeTranscriptAccess(o, w);
  const handler = makeHandler(o, w, opts.backend, access);
  const clients = new Set<import("bun").ServerWebSocket<WsData>>();
  const herdrPush = () => JSON.stringify({ type: "herdr", model: w.model, views: w.views } satisfies ServerPush);
  w.onChange(() => {
    const msg = herdrPush();
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
          screen: (p) => w.read(p, 400),
        });
        send({ type: "hello", runs: o.listRuns() });
        send({ type: "notices", list: opts.notices.list });
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
            if (run === msg.run && ["run.stopped", "run.quiescent", "attention.raised", "attention.resolved"].includes(event.type))
              ws.send(JSON.stringify({ type: "hello", runs: o.listRuns() } satisfies ServerPush));
            else if (["run.created", "run.stopped", "run.quiescent", "attention.raised", "attention.resolved"].includes(event.type))
              ws.send(JSON.stringify({ type: "hello", runs: o.listRuns() } satisfies ServerPush));
          });
          return;
        }
        if (msg.type === "chat.open" || msg.type === "chat.close") return ws.data.chat?.handle(msg);
        ws.data.bridge?.handle(msg);
      },
      close(ws) {
        clients.delete(ws);
        ws.data.unsub?.();
        ws.data.bridge?.closeAll();
        ws.data.chat?.closeAll();
      },
    },
  });

  return { unix, tcp, stop: () => (unix.stop(true), tcp.stop(true)) };
}
