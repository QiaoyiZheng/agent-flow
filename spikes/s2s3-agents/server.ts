// Spike server: mailbox + done records over a Unix socket. Control API for the runner on the same socket.
import { mkdirSync, rmSync, appendFileSync } from "node:fs";
const DIR = "/tmp/afs"; mkdirSync(DIR, { recursive: true });
const SOCK = `${DIR}/server.sock`; rmSync(SOCK, { force: true });
type Msg = { id: string; from: string; to: string; node: string; body: string; ts: string; read?: boolean };
const mail: Record<string, Msg[]> = {}; const log = (o: object) => appendFileSync(`${DIR}/events.jsonl`, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
let n = 0;
Bun.serve({ unix: SOCK, async fetch(req) {
  const u = new URL(req.url); const body = req.method === "POST" ? await req.json() : {};
  switch (u.pathname) {
    case "/enqueue": { const m: Msg = { id: `m_${++n}`, ts: new Date().toISOString(), ...body }; (mail[m.to] ??= []).push(m); log({ type: "enqueue", ...m }); return Response.json(m); }
    case "/inbox": { const a = u.searchParams.get("agent")!; const unread = (mail[a] ?? []).filter((m) => !m.read); unread.forEach((m) => (m.read = true)); log({ type: "inbox", agent: a, n: unread.length });
      if (!unread.length) return new Response("(no new messages)\n");
      return new Response(unread.map((m) => `--- message ${m.id} from ${m.from} | node ${m.node} ---\n${m.body}\n`).join("\n")); }
    case "/done": log({ type: "done", ...body }); return new Response(`submitted: outcome=${body.outcome ?? "(none)"} result=${body.result ?? "(none)"}\n`);
    case "/send": log({ type: "send", ...body }); return new Response(`sent to ${body.to}\n`);
    default: return new Response("not found", { status: 404 });
  }
} });
console.log("spike server on", SOCK);
