// Probe the JSON shape `herdr terminal session control` accepts on stdin.
const target = process.argv[2];
const proc = Bun.spawn(["herdr", "terminal", "session", "control", target, "--cols", "100", "--rows", "30"], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe",
});
let screen = "";
(async () => {
  const dec = new TextDecoder(); let buf = "";
  for await (const chunk of proc.stdout) {
    buf += dec.decode(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try {
        const r = JSON.parse(line);
        if (r.type !== "terminal.frame") console.log("REC", line.slice(0, 200));
        else screen += Buffer.from(r.bytes, "base64").toString("utf8");
      } catch { console.log("RAW", line.slice(0, 200)); }
    }
  }
})();
(async () => { for await (const c of proc.stderr) console.log("ERR", new TextDecoder().decode(c)); })();
const send = (o: unknown) => { proc.stdin.write(JSON.stringify(o) + "\n"); proc.stdin.flush(); };
await Bun.sleep(500);
const shapes: Record<string, unknown> = {
  text: { type: "terminal.input", text: "echo MARK_text\r" },
  data: { type: "terminal.input", data: "echo MARK_data\r" },
  bytes: { type: "terminal.input", bytes: Buffer.from("echo MARK_bytes\r").toString("base64") },
};
for (const [k, v] of Object.entries(shapes)) {
  screen = "";
  send(v);
  await Bun.sleep(700);
  console.log(k, "-> echoed:", screen.includes(`MARK_${k}`));
}
send({ type: "terminal.release" });
await Bun.sleep(300);
proc.kill();
