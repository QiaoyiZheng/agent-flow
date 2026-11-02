// Errors and warnings: toasts in the corner for new ones, and a list behind the badge in the bottom line.

import { useEffect, useRef, useState } from "react";
import type { Notice } from "@af/core";
import { clearNotices, markNoticesSeen, useStore } from "./store";
import { ago } from "./view";

const LIFE = { info: 5000, warn: 9000, error: 15000 };
const ICON = { info: "●", warn: "▲", error: "✕" };

export function Toasts() {
  const { notices } = useStore();
  const born = useRef(Date.now());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const now = Date.now();
  // new or repeated since this page opened, not dismissed, not expired
  const show = notices
    .filter((n) => Date.parse(n.at) >= born.current - 1000 && !gone.has(`${n.id}:${n.count}`) && now - Date.parse(n.at) < LIFE[n.level])
    .slice(-4);
  if (!show.length) return null;
  return (
    <div className="toasts">
      {show.map((n) => (
        <div key={n.id} className={`toast ${n.level}`} onClick={() => setGone((g) => new Set(g).add(`${n.id}:${n.count}`))} title="Click to dismiss">
          <span className="toast-ic">{ICON[n.level]}</span>
          <div className="toast-body">
            <div className="toast-text">
              {n.text}
              {n.count > 1 && <span className="toast-count">×{n.count}</span>}
            </div>
            {n.detail && <div className="toast-detail">{n.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function NoticesButton() {
  const { notices, seenNotices } = useStore();
  const [open, setOpen] = useState(false);
  const unread = notices.slice(seenNotices).filter((n) => n.level !== "info");
  const worst = unread.some((n) => n.level === "error") ? "error" : unread.length ? "warn" : "";
  return (
    <span className="notices-wrap">
      <button
        className={`notices-btn ${worst}`}
        title="Errors and warnings"
        onClick={() => {
          setOpen((o) => !o);
          markNoticesSeen();
        }}
      >
        {unread.length ? `${worst === "error" ? "✕" : "▲"} ${unread.length}` : "notices"}
      </button>
      {open && <NoticesPanel list={notices} onClose={() => setOpen(false)} />}
    </span>
  );
}

function NoticesPanel({ list, onClose }: { list: Notice[]; onClose: () => void }) {
  return (
    <div className="notices-panel">
      <div className="notices-head">
        <b>Notices</b>
        <span className="spacer" />
        <button className="c-more" onClick={clearNotices}>
          clear
        </button>
        <button className="c-more" onClick={onClose}>
          close
        </button>
      </div>
      <div className="notices-list">
        {!list.length && <div className="empty" style={{ padding: 12 }}>No errors or warnings.</div>}
        {[...list].reverse().map((n) => (
          <div key={n.id} className={`notice-row ${n.level}`}>
            <span className="toast-ic">{ICON[n.level]}</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="toast-text">
                {n.text}
                {n.count > 1 && <span className="toast-count">×{n.count}</span>}
              </div>
              {n.detail && <div className="toast-detail">{n.detail}</div>}
              <div className="notice-meta">
                {n.source} · {ago(n.at)} ago
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
