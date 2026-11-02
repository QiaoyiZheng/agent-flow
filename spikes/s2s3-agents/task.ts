// usage: bun task.ts <agent-name> <workdir> <taskIdx>  — prepares fixtures, enqueues the task, wakes the agent, waits, grades.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const [name, wd, idxS] = process.argv.slice(2); const idx = +idxS;
const sh = (...a: string[]) => { const r = Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" }); return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() }; };
const node = `t${idx}#1`;
const tasks: { setup: () => void; body: string; outcomes: string[]; expect: (d: any) => string[] }[] = [
  { setup: () => {}, outcomes: ["pass"],
    body: "Create a file named greet.txt in your current directory containing exactly the line: hello agent-flow\nAllowed outcomes: pass",
    expect: (d) => [readFileSync(join(wd, "greet.txt"), "utf8").trim() === "hello agent-flow" ? "" : "greet.txt wrong"] },
  { setup: () => writeFileSync(join(wd, "data.txt"), "12\n30\n25\n30\n"), outcomes: ["pass", "fail"],
    body: "Check whether the numbers in data.txt sum to exactly 100. Submit outcome pass if they do, fail if they do not, and put the actual sum in the note.\nAllowed outcomes: pass | fail",
    expect: (d) => [d.outcome === "fail" ? "" : "expected fail (sum=97)"] },
  { setup: () => { mkdirSync(join(wd, "src/lib"), { recursive: true }); for (const f of ["a.ts", "b.ts", "lib/c.ts", "lib/d.js", "e.md"]) writeFileSync(join(wd, "src", f), "// x\n"); }, outcomes: ["pass"],
    body: "List every .ts file under src/ (recursively), one path per line, in a report file. Submit the report path as the result.\nAllowed outcomes: pass",
    expect: (d) => { if (!d.result) return ["no --result"]; const p = d.result.startsWith("/") ? d.result : join(wd, d.result); if (!existsSync(p)) return ["result path missing"]; const t = readFileSync(p, "utf8"); return [["a.ts", "b.ts", "c.ts"].every((x) => t.includes(x)) && !t.includes("d.js") ? "" : "report content wrong"]; } },
  { setup: () => {}, outcomes: ["pass", "error"],
    body: "Read the port field from config.json in your current directory and write it to port.txt.\nAllowed outcomes: pass | error",
    expect: (d) => [d.outcome === "error" ? "" : "expected error (config.json missing)"] },
  { setup: () => { writeFileSync(join(wd, "add.js"), "export function add(a, b) {\n  return a - b;\n}\n"); writeFileSync(join(wd, "test.js"), "import { add } from './add.js';\nif (add(2, 3) !== 5) { console.error('FAIL'); process.exit(1); }\nconsole.log('ok');\n"); writeFileSync(join(wd, "package.json"), '{"type":"module"}\n'); }, outcomes: ["pass", "fail"],
    body: "add.js has a bug. Fix it, then run `node test.js` to verify. Submit pass if the test passes, fail otherwise.\nAllowed outcomes: pass | fail",
    expect: (d) => [d.outcome === "pass" && sh("node", join(wd, "test.js")).ok ? "" : "test not passing"] },
];
const t = tasks[idx]; t.setup();
const ctl = (p: string, b?: unknown) => fetch(`http://af${p}`, { unix: "/tmp/afs/server.sock", method: b ? "POST" : "GET", headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined } as any).then((r) => r.json());
const m = await ctl("/enqueue", { from: "lead", to: name, node, body: t.body });
const doneRecs = () => readFileSync("/tmp/afs/events.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.type === "done" && e.agent === name && e.ts > m.ts);
const notice = `[agent-flow] New message ${m.id} from lead (node ${node}). Run: af inbox`;
const t0 = Date.now();
const wait = (args: string[]) => sh("herdr", "agent", "prompt", name, ...args, "--wait", "--timeout", "480000");
let r = wait([notice]);
let st = JSON.parse(sh("herdr", "agent", "get", name).out).result.agent.agent_status;
let reminded = false;
if (!doneRecs().length && st !== "blocked") { reminded = true; r = wait([`[agent-flow] Node ${node} has not been submitted. If the task is finished or impossible, run af done now.`]); st = JSON.parse(sh("herdr", "agent", "get", name).out).result.agent.agent_status; }
const d = doneRecs();
const problems: string[] = [];
if (!d.length) problems.push(`no af done (status=${st}${r.ok ? "" : ", wait err: " + r.err.slice(0, 120)})`);
else { if (d.length > 1) problems.push(`af done called ${d.length}x`); if (!t.outcomes.includes(d[0].outcome)) problems.push(`invalid outcome ${d[0].outcome}`); try { problems.push(...t.expect(d[0]).filter(Boolean)); } catch (e) { problems.push(`check threw: ${e}`); } }
const rec = { agent: name, task: idx, firstTry: !reminded && d.length > 0, afterReminder: reminded && d.length > 0, outcome: d[0]?.outcome, result: d[0]?.result, note: d[0]?.note, secs: Math.round((Date.now() - t0) / 1000), problems };
console.log(JSON.stringify(rec));
const { appendFileSync } = await import("node:fs"); appendFileSync(join(import.meta.dir, "results.jsonl"), JSON.stringify(rec) + "\n");
