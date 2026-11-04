// Loaded into Gemini CLI (node --import=<this file> gemini.js) when it talks to an API gateway set with
// GOOGLE_GEMINI_BASE_URL. It works around three bugs of new-api style gateways in Google's request format, seen with
// http://120.26.130.203:3001 on 2026-11-04:
//
//   1. a ":" before the method ("models/gemini-x:streamGenerateContent") is sometimes misread as part of the
//      model name ("No available channel for model gemini-xent"); "%3A" always works.
//   2. tool schemas sent as "parametersJsonSchema" (all of Gemini CLI's tools) are dropped, so the model calls tools
//      with made-up or empty arguments; the same schema sent as "parameters" works.
//   3. a streamed tool call comes back in two parts, {name, args: {}} then {name: "", args}, so Gemini CLI runs a
//      call without arguments and an unnamed one. The parts are joined again here.
//
// Only requests to the gateway are touched. When the gateway is fixed, each step finds nothing to do.

const BASE = (process.env.GOOGLE_GEMINI_BASE_URL || "").replace(/\/+$/, "");
const original = globalThis.fetch;

/** "parametersJsonSchema" → "parameters", in every function declaration of a request body. */
export function moveSchemas(body) {
  let changed = false;
  const visit = (tools) => {
    for (const t of Array.isArray(tools) ? tools : [])
      for (const d of Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : []) {
        if (d && d.parametersJsonSchema !== undefined && d.parameters === undefined) {
          d.parameters = d.parametersJsonSchema;
          delete d.parametersJsonSchema;
          changed = true;
        }
        if (d && d.responseJsonSchema !== undefined) {
          delete d.responseJsonSchema;
          changed = true;
        }
      }
  };
  visit(body?.tools);
  visit(body?.config?.tools);
  return changed;
}

/**
 * Joins tool calls split into {name, args: {}} + {name: "", args}. `pending` carries calls across streamed chunks;
 * returns the parts to send now. Calls are held until `final` (the chunk that ends the reply), so their arguments
 * are complete when Gemini CLI sees them.
 */
export function joinCalls(parts, pending, final) {
  const out = [];
  for (const p of Array.isArray(parts) ? parts : []) {
    const fc = p?.functionCall;
    if (!fc) {
      out.push(p);
      continue;
    }
    const last = pending.at(-1);
    if (!fc.name && last) {
      last.functionCall.args = { ...(last.functionCall.args || {}), ...(fc.args || {}) };
      for (const [k, v] of Object.entries(p)) if (k !== "functionCall" && last[k] === undefined) last[k] = v;
      if (fc.id && !last.functionCall.id) last.functionCall.id = fc.id;
    } else pending.push({ ...p, functionCall: { ...fc, args: { ...(fc.args || {}) } } });
  }
  if (final) out.push(...pending.splice(0));
  return out;
}

function fixChunk(obj, pending, final) {
  const c = obj?.candidates?.[0];
  if (!c) return obj;
  const done = final || !!c.finishReason;
  const content = c.content || { role: "model", parts: [] };
  return { ...obj, candidates: [{ ...c, content: { ...content, parts: joinCalls(content.parts, pending, done) } }, ...obj.candidates.slice(1)] };
}

/** The gateway's SSE stream with tool calls joined. */
function fixStream(body) {
  const pending = [];
  let buf = "";
  let last; // the last chunk sent, to carry calls still pending at the end
  // text here; TextEncoderStream below makes bytes of it
  const emit = (ctl, obj) => ctl.enqueue(`data: ${JSON.stringify(obj)}\r\n\r\n`);
  const handle = (ctl, event) => {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) return void (event.trim() && ctl.enqueue(`${event}\r\n\r\n`));
    let obj;
    try {
      obj = JSON.parse(data);
    } catch {
      return void ctl.enqueue(`${event}\r\n\r\n`);
    }
    last = obj;
    emit(ctl, fixChunk(obj, pending, false));
  };
  return body.pipeThrough(new TextDecoderStream()).pipeThrough(
    new TransformStream({
      transform(text, ctl) {
        buf += text;
        let i;
        while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
          const m = buf.slice(i).match(/^\r?\n\r?\n/);
          handle(ctl, buf.slice(0, i));
          buf = buf.slice(i + m[0].length);
        }
      },
      flush(ctl) {
        if (buf.trim()) handle(ctl, buf);
        if (pending.length && last) emit(ctl, fixChunk({ ...last, candidates: [{ ...last.candidates?.[0], content: { role: "model", parts: [] } }] }, pending, true));
      },
    }),
  ).pipeThrough(new TextEncoderStream());
}

const target = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input?.url);

if (BASE && typeof original === "function" && !globalThis.__afGatewayFix) {
  globalThis.__afGatewayFix = true;
  globalThis.fetch = async function (input, init) {
    const url = target(input);
    if (!url || !url.startsWith(`${BASE}/`) || typeof input !== "string" && !(input instanceof URL)) return original.call(this, input, init);
    const fixedUrl = url.replace(/(\/models\/[^/?#:]+):([A-Za-z]+)/, "$1%3A$2");
    let body = init?.body;
    if (typeof body === "string" && body.includes("JsonSchema")) {
      try {
        const j = JSON.parse(body);
        if (moveSchemas(j)) body = JSON.stringify(j);
      } catch {}
    }
    const res = await original.call(this, fixedUrl, { ...init, body });
    if (!res.ok || !res.body) return res;
    const headers = new Headers(res.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    if (/streamGenerateContent/.test(url)) return new Response(fixStream(res.body), { status: res.status, statusText: res.statusText, headers });
    if (/:generateContent/.test(url)) {
      const text = await res.text();
      try {
        const obj = JSON.parse(text);
        return new Response(JSON.stringify(fixChunk(obj, [], true)), { status: res.status, statusText: res.statusText, headers });
      } catch {
        return new Response(text, { status: res.status, statusText: res.statusText, headers });
      }
    }
    return res;
  };
}
