// HTTP API. The same routes are served on the Unix socket (for the af CLI and agents) and on
// 127.0.0.1 (for the web UI, behind a token). WebSocket pushes run events and terminal frames.

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Caller, ClientPush, ServerPush } from "@af/core";
import { AfError, type Orchestrator } from "./orchestrator.ts";
import type { TerminalBackend } from "./herdr.ts";
import { TerminalBridge } from "./terminals.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (code: string, message: string, status = 400) => json({ error: { code, message } }, status);

export function makeHandler(o: Orchestrator) {
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
          return json(o.open(caller, body.target));
        case "POST /spawn":
          return json(await o.spawn(caller, body));
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
  unsub?: () => void;
}

export function serve(o: Orchestrator, opts: { sock: string; port: number; token: string; home: string; backend: TerminalBackend; webDir: string }) {
  const handler = makeHandler(o);

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
        send({ type: "hello", runs: o.listRuns() });
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
            else if (event.type === "run.created" || event.type === "attention.raised" || event.type === "attention.resolved")
              ws.send(JSON.stringify({ type: "hello", runs: o.listRuns() } satisfies ServerPush));
          });
          return;
        }
        ws.data.bridge?.handle(msg);
      },
      close(ws) {
        ws.data.unsub?.();
        ws.data.bridge?.closeAll();
      },
    },
  });

  return { unix, tcp, stop: () => (unix.stop(true), tcp.stop(true)) };
}
