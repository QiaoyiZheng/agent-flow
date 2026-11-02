// Probe terminal.scroll shapes: does Herdr render a scrolled-back viewport into the stream?
const target = process.argv[2];
const proc = Bun.spawn(["herdr", "terminal", "session", "control", target, "--cols", "100", "--rows", "20"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
let last = ""; let recs: string[] = [];
(async () => { const dec = new TextDecoder(); let buf = ""; for await (const c of proc.stdout) { buf += dec.decode(c, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const r = JSON.parse(line); if (r.type === "terminal.frame") last += Buffer.from(r.bytes, "base64").toString(); else recs.push(line); } } })();
(async () => { for await (const c of proc.stderr) console.log("ERR", new TextDecoder().decode(c)); })();
const send = (o: unknown) => { proc.stdin.write(JSON.stringify(o) + "\n"); proc.stdin.flush(); };
const input = (s: string) => send({ type: "terminal.input", text: s });
await Bun.sleep(500);
input("clear; seq 1 500\r"); await Bun.sleep(800);
const shapes = [
  { type: "terminal.scroll", lines: -50 },
  { type: "terminal.scroll", delta: -50 },
  { type: "terminal.scroll", amount: -50 },
  { type: "terminal.scroll", direction: "up", lines: 50 },
  { type: "terminal.scroll", offset_from_bottom: 50 },
];
for (const s of shapes) {
  last = ""; recs = [];
  send(s); await Bun.sleep(500);
  const nums = [...last.matchAll(/\b(\d{3})\b/g)].map((m) => +m[1]);
  console.log(JSON.stringify(s), "-> frameBytes", last.length, "minNumberOnScreen", nums.length ? Math.min(...nums) : "-", recs.join(" "));
  input("\x1b"); // any input should jump back to bottom
  send({ type: "terminal.scroll", offset_from_bottom: 0 }); await Bun.sleep(300);
}
send({ type: "terminal.release" }); await Bun.sleep(200); proc.kill(); process.exit(0);
