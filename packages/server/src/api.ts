// HTTP API. The same routes are served on the Unix socket (for the af CLI and agents) and on
// 127.0.0.1 (for the web UI, behind a token). WebSocket pushes run events and terminal frames.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { AgentKind, Caller, ClientPush, ServerPush, ShowRequest } from "@af/core";
import { AGENT_KINDS } from "@af/core";
import { AfError, type Orchestrator } from "./orchestrator.ts";
import type { Workspaces } from "./workspaces.ts";
import type { TerminalBackend } from "./herdr.ts";
import { TerminalBridge } from "./terminals.ts";
import { ChatBridge } from "./transcripts/bridge.ts";
import { TranscriptFinder } from "./transcripts/index.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (code: string, message: string, status = 400) => json({ error: { code, message } }, status);

export function makeHandler(o: Orchestrator, w: Workspaces, backend: TerminalBackend) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "");
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : Object.fromEntries(url.searchParams);
    const caller: Caller = { run: body.run || undefined, agent: body.agent || undefined };
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
          return json(await w.newWorkspace(body.label || "workspace", body.cwd));
        case "POST /layout/ratio":
          await w.setRatio(body.tab, body.path, Number(body.ratio));
          return json({ ok: true });
        case "POST /spawn":
          return json(await o.spawn(caller, body));
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
  const run = o.runByWorkspace(base.workspaceId);
  if (run && !o.getRun(run).stopped) {
    const a = await o.spawn({ run }, { name: "", kind, place: { split: pane, direction } });
    await w.refresh();
    return { paneId: a.paneId, agent: a.name, run };
  }
  const { paneId } = await w.split(pane, direction);
  const name = `${kind}-${paneId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`.slice(0, 32);
  const session = kind === "claude" ? crypto.randomUUID() : undefined;
  if (session) w.rememberSession(paneId, session);
  const r = await backend.startAgent(name, kind, paneId, session ? ["--session-id", session] : kind === "codex" ? ["--no-alt-screen"] : []);
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

export function serve(o: Orchestrator, w: Workspaces, opts: { sock: string; port: number; token: string; home: string; backend: TerminalBackend; webDir: string }) {
  const handler = makeHandler(o, w, opts.backend);
  const finder = new TranscriptFinder();
  const clients = new Set<import("bun").ServerWebSocket<WsData>>();
  const herdrPush = () => JSON.stringify({ type: "herdr", model: w.model, views: w.views } satisfies ServerPush);
  w.onChange(() => {
    const msg = herdrPush();
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
        ws.data.bridge = new TerminalBridge(opts.backend, send);
        ws.data.chat = new ChatBridge({ finder, send, panes: () => w.model.panes, knownSession: (p) => o.sessionForPane(p) ?? w.sessions[p], argv: (p) => opts.backend.processArgv(p) });
        send({ type: "hello", runs: o.listRuns() });
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
