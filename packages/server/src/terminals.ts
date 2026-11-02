// Bridges browser terminals to Herdr: one `herdr terminal session control|observe` process per open
// terminal, NDJSON frames out, input/resize/scroll in. Message shapes verified in spikes/s1-terminal.

import type { ClientPush, ServerPush } from "@af/core";
type ArgvFor = (paneId: string, mode: "control" | "observe", cols: number, rows: number) => string[];

type Session = { proc: ReturnType<typeof Bun.spawn>; stdin: import("bun").FileSink };

export class TerminalBridge {
  private sessions = new Map<string, Session>();

  constructor(
    private argvFor: ArgvFor,
    private send: (msg: ServerPush) => void,
  ) {}

  handle(msg: ClientPush) {
    switch (msg.type) {
      case "term.open":
        return this.open(msg.id, msg.paneId, msg.mode, msg.cols, msg.rows);
      case "term.input":
        return this.write(msg.id, { type: "terminal.input", text: msg.text });
      case "term.resize":
        return this.write(msg.id, { type: "terminal.resize", cols: msg.cols, rows: msg.rows });
      case "term.scroll":
        return this.write(msg.id, { type: "terminal.scroll", direction: msg.direction, lines: msg.lines });
      case "term.close":
        return this.close(msg.id);
    }
  }

  private open(id: string, paneId: string, mode: "control" | "observe", cols: number, rows: number) {
    this.close(id);
    let argv: string[];
    try {
      argv = this.argvFor(paneId, mode, cols, rows);
    } catch (e) {
      this.send({ type: "term.closed", id, reason: (e as Error).message });
      return;
    }
    const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.sessions.set(id, { proc, stdin: proc.stdin as import("bun").FileSink });
    void (async () => {
      const dec = new TextDecoder();
      let buf = "";
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        buf += dec.decode(chunk, { stream: true });
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let r: any;
          try {
            r = JSON.parse(line);
          } catch {
            continue;
          }
          if (r.type === "terminal.frame") this.send({ type: "term.frame", id, bytes: r.bytes, width: r.width, height: r.height, full: !!r.full });
          else if (r.type === "terminal.closed") this.send({ type: "term.closed", id, reason: r.reason });
        }
      }
      if (this.sessions.get(id)?.proc === proc) {
        this.sessions.delete(id);
        this.send({ type: "term.closed", id, reason: "ended" });
      }
    })();
  }

  private write(id: string, cmd: object) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.stdin.write(JSON.stringify(cmd) + "\n");
    s.stdin.flush();
  }

  close(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    try {
      s.stdin.write(JSON.stringify({ type: "terminal.release" }) + "\n");
      s.stdin.flush();
    } catch {}
    setTimeout(() => s.proc.kill(), 200);
  }

  closeAll() {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
