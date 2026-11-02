// A live view of one Herdr pane. Herdr renders the screen and streams diffs, so xterm keeps no scrollback:
// the wheel asks Herdr to scroll instead (see spikes/s1-terminal/RESULT.md).

import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { onTerm, send } from "./store";

const THEME = {
  background: "#0b0c0e",
  foreground: "#e6e7ea",
  cursor: "#e6e7ea",
  cursorAccent: "#0b0c0e",
  selectionBackground: "rgba(124, 131, 247, 0.3)",
  black: "#1b1d22",
  red: "#e06c6c",
  green: "#4fb486",
  yellow: "#e0a947",
  blue: "#5e9cf2",
  magenta: "#b49af0",
  cyan: "#5fb3c4",
  white: "#c9cbd1",
  brightBlack: "#5d616b",
  brightRed: "#ef8a8a",
  brightGreen: "#74c9a2",
  brightYellow: "#ecc173",
  brightBlue: "#86b6f6",
  brightMagenta: "#c9b5f5",
  brightCyan: "#86c8d5",
  brightWhite: "#f2f3f5",
};

let seq = 0;

export function Terminal({ paneId, mode = "control", autoFocus = false }: { paneId: string; mode?: "control" | "observe"; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | undefined>(undefined);
  const [status, setStatus] = useState<"connecting" | "live" | "closed">("connecting");

  useEffect(() => {
    const el = host.current!;
    const id = `t${++seq}`;
    const term = new XTerm({
      fontFamily: '"JetBrains Mono Variable", "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.15,
      scrollback: 0,
      theme: THEME,
      cursorBlink: false,
      allowProposedApi: true,
      disableStdin: mode === "observe",
      macOptionIsMeta: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const off = onTerm(id, (m) => {
      if (m.type === "term.frame") {
        setStatus("live");
        const bin = atob(m.bytes);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        term.write(bytes);
      } else setStatus("closed");
    });
    send({ type: "term.open", id, paneId, mode, cols: term.cols, rows: term.rows });
    termRef.current = term;
    if (autoFocus && mode === "control") term.focus();

    const input = term.onData((text) => send({ type: "term.input", id, text }));
    // With scrollback 0, xterm would turn wheel events into Up/Down arrow keys and type them into the agent
    // (recalling old prompts). Herdr owns the history, so the wheel goes to Herdr instead.
    term.attachCustomWheelEventHandler(() => false);
    let wheelAcc = 0;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      wheelAcc += e.deltaY;
      const lines = Math.trunc(wheelAcc / 16);
      if (!lines) return;
      wheelAcc -= lines * 16;
      send({ type: "term.scroll", id, direction: lines < 0 ? "up" : "down", lines: Math.abs(lines) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });

    let last = `${term.cols}x${term.rows}`;
    const ro = new ResizeObserver(() => {
      if (!el.offsetWidth || !el.offsetHeight) return;
      fit.fit();
      const now = `${term.cols}x${term.rows}`;
      if (now !== last) {
        last = now;
        send({ type: "term.resize", id, cols: term.cols, rows: term.rows });
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", onWheel);
      input.dispose();
      off();
      send({ type: "term.close", id });
      term.dispose();
      termRef.current = undefined;
    };
  }, [paneId, mode]);

  useEffect(() => {
    if (autoFocus && mode === "control") termRef.current?.focus();
  }, [autoFocus, mode]);

  return (
    <div className="term">
      <div ref={host} style={{ height: "100%" }} />
      {status !== "live" && <div className="term-overlay">{status === "connecting" ? "connecting…" : "terminal closed"}</div>}
    </div>
  );
}
