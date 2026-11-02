// Screenshot the UI with real waiting (headless Chrome over CDP). Dev tool for checking the look.
// usage: bun scripts/shot.ts <url> <out.png> [--wait ms] [--eval "js"]... [--w 1600 --h 960]
const args = process.argv.slice(2);
const [url, out] = args;
const opt = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1]! : d);
const evals = args.flatMap((a, i) => (a === "--eval" ? [args[i + 1]!] : []));
const W = +opt("--w", "1600"), H = +opt("--h", "960"), WAIT = +opt("--wait", "3500");
const port = 9333;
const chrome = Bun.spawn(["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", `--remote-debugging-port=${port}`, `--window-size=${W},${H}`, "--hide-scrollbars", "--user-data-dir=/tmp/af-chrome", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let target: any;
for (let i = 0; i < 50 && !target; i++) {
  await Bun.sleep(150);
  target = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).then((l: any[]) => l.find((t) => t.type === "page")).catch(() => undefined);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map<number, (v: any) => void>();
ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m.result ?? m.error); pending.delete(m.id); } };
const cdp = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await cdp("Page.navigate", { url });
await Bun.sleep(WAIT);
const wheel = args.flatMap((a, i) => (a === "--wheel" ? [args[i + 1]!.split(",").map(Number)] : []));
for (const [x, y, dy, times = 1] of wheel)
  for (let k = 0; k < times!; k++) {
    await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY: dy });
    await Bun.sleep(60);
  }
if (wheel.length) await Bun.sleep(800);
for (const [i, a] of args.entries())
  if (a === "--drag") {
    const [x1, y1, x2, y2] = args[i + 1]!.split(",").map(Number) as [number, number, number, number];
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", clickCount: 1 });
    for (let k = 1; k <= 10; k++) {
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * k) / 10, y: y1 + ((y2 - y1) * k) / 10, button: "left", buttons: 1 });
      await Bun.sleep(30);
    }
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", clickCount: 1 });
    await Bun.sleep(1500);
  }
for (const js of evals) { const r = await cdp("Runtime.evaluate", { expression: js, awaitPromise: true }); if (r?.exceptionDetails) console.error("eval error:", JSON.stringify(r.exceptionDetails).slice(0, 300)); await Bun.sleep(1200); }
const shot = await cdp("Page.captureScreenshot", { format: "png" });
await Bun.write(out, Buffer.from(shot.data, "base64"));
for (const [i, a] of args.entries()) if (a === "--print") console.log((await cdp("Runtime.evaluate", { expression: args[i + 1], returnByValue: true }))?.result?.value);
const logs = await cdp("Runtime.evaluate", { expression: "document.querySelectorAll('.term-overlay').length + ' overlays; ' + document.querySelectorAll('.xterm-rows > div').length + ' xterm rows'" });
console.log(out, "|", logs?.result?.value);
ws.close(); chrome.kill(); process.exit(0);
