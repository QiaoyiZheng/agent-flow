// S1 bench: input→echo latency and high-throughput rendering through `herdr terminal session control`.
import { Terminal } from "@xterm/headless";

const target = process.argv[2];
const COLS = 120, ROWS = 36;
const proc = Bun.spawn(["herdr", "terminal", "session", "control", target, "--cols", `${COLS}`, "--rows", `${ROWS}`], {
  stdin: "pipe", stdout: "pipe", stderr: "inherit",
});
const term = new Terminal({ cols: COLS, rows: ROWS, scrollback: 5000, allowProposedApi: true });
type Frame = { t: number; text: string; full: boolean; width: number; height: number; n: number };
let listeners: ((f: Frame) => void)[] = [];
let frames = 0, bytes = 0, fullFrames = 0;
(async () => {
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const r = JSON.parse(line);
      if (r.type !== "terminal.frame") { console.log("REC", line); continue; }
      const raw = Buffer.from(r.bytes, "base64");
      frames++; bytes += raw.length; if (r.full) fullFrames++;
      term.write(raw);
      const f = { t: performance.now(), text: raw.toString("utf8"), full: r.full, width: r.width, height: r.height, n: raw.length };
      for (const l of listeners) l(f);
    }
  }
})();
const send = (s: string) => { proc.stdin.write(JSON.stringify({ type: "terminal.input", bytes: Buffer.from(s).toString("base64") }) + "\n"); proc.stdin.flush(); };
const waitFrame = (pred: (f: Frame) => boolean, ms = 3000) => new Promise<Frame | null>((res) => {
  const l = (f: Frame) => { if (pred(f)) { listeners = listeners.filter((x) => x !== l); clearTimeout(to); res(f); } };
  const to = setTimeout(() => { listeners = listeners.filter((x) => x !== l); res(null); }, ms);
  listeners.push(l);
});
const screenText = () => { const b = term.buffer.active; const out: string[] = []; for (let y = 0; y < b.length; y++) out.push(b.getLine(y)!.translateToString(true)); return out; };
const quiet = async (ms: number) => { let last = performance.now(); const l = () => { last = performance.now(); }; listeners.push(l); while (performance.now() - last < ms) await Bun.sleep(50); listeners = listeners.filter((x) => x !== l); };

await Bun.sleep(800);
send("clear\r"); await quiet(400);

// 1) keystroke echo latency
const lat: number[] = [];
const letters = "abcdefghijklmnopqrstuvwxyz";
for (let k = 0; k < 60; k++) {
  const ch = letters[k % 26];
  const t0 = performance.now();
  const p = waitFrame((f) => f.text.includes(ch));
  send(ch);
  const f = await p;
  if (f) lat.push(f.t - t0);
  const p2 = waitFrame(() => true, 1000); send("\x7f"); await p2;
  await Bun.sleep(15);
}
lat.sort((a, b) => a - b);
const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(1);
console.log(`latency n=${lat.length} p50=${q(0.5)}ms p90=${q(0.9)}ms p99=${q(0.99)}ms max=${lat[lat.length - 1].toFixed(1)}ms`);

// 2) throughput: seq 1 200000
send("clear\r"); await quiet(400);
frames = 0; bytes = 0; fullFrames = 0;
const t0 = performance.now();
send("seq 1 200000; echo SEQ_DONE\r");
await waitFrame((f) => f.text.includes("SEQ_DONE") && !f.text.includes("echo SEQ_DONE"), 60000);
const t1 = performance.now();
await quiet(500);
const lines = screenText().filter((l) => l.trim());
console.log(`throughput: ${(t1 - t0).toFixed(0)}ms to finish, frames=${frames} (full=${fullFrames}) bytes=${bytes}`);
console.log(`headless buffer length=${term.buffer.active.length} (rows=${ROWS})`);
console.log("last screen lines:", JSON.stringify(lines.slice(-4)));
console.log("contains 200000:", lines.some((l) => l.trim() === "200000"));

// 3) PTY size vs controller size
send("clear; stty size\r"); await quiet(500);
console.log("stty size under controller", `${COLS}x${ROWS}:`, JSON.stringify(screenText().filter((l) => /^\d+ \d+$/.test(l.trim()))));

proc.stdin.write(JSON.stringify({ type: "terminal.release" }) + "\n"); proc.stdin.flush();
await Bun.sleep(300); proc.kill(); process.exit(0);
