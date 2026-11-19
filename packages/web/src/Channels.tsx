// The Channels tab of the right panel: the ways agents of this workspace send each other messages (server
// channels.ts), what waits on each, a message the user sends on one, and connecting or disconnecting agents.
//   parent: a session and one it handed work to. Disconnecting makes the child an independent session.
//   peer:   two agents the user connected (af send both ways). Deleting the channel drops what waits on it.

import { useEffect, useState } from "react";
import type { Channel, ChannelEnd, ChannelMessage, HPane } from "@af/core";
import { api, failed, notify, useStore } from "./store";
import { kindColor } from "./view";

export function ChannelsTab({ workspace, panes, onGoTo }: { workspace?: string; panes: Map<string, HPane>; onGoTo: (pane: string) => void }) {
  const { herdr } = useStore();
  const [list, setList] = useState<Channel[]>();
  const [open, setOpen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const load = () =>
    api<{ channels: Channel[] }>("GET", "/channels", { workspace })
      .then((r) => setList(r.channels))
      .catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [workspace]);
  const agentsHere = [...panes.values()].filter((p) => p.agent && p.workspaceId === workspace);
  const allAgents = (herdr?.panes ?? []).filter((p) => p.agent);
  const wsLabel = (p: HPane) => herdr?.workspaces.find((w) => w.id === p.workspaceId)?.label ?? p.workspaceId;
  return (
    <div className="channels">
      <div className="ch-intro">
        Each line is a way two agents send each other messages. A session and one it handed work to are connected by
        agent-flow; you can connect any two agents yourself. Messages wait here until the receiver's turn ends.
      </div>
      {!list && <div className="empty" style={{ padding: 12 }}>Looking…</div>}
      {list && !list.length && <div className="empty" style={{ padding: 12 }}>No channels in this workspace.</div>}
      {list?.map((c) => <ChannelRow key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? undefined : c.id)} onChanged={load} onGoTo={onGoTo} />)}
      {adding ? (
        <ConnectForm here={agentsHere} all={allAgents} wsLabel={wsLabel} onDone={() => (setAdding(false), load())} />
      ) : (
        <button className="c-more ch-add" onClick={() => setAdding(true)} disabled={!agentsHere.length}>
          + connect two agents…
        </button>
      )}
    </div>
  );
}

function End({ e, onGoTo }: { e: ChannelEnd; onGoTo: (pane: string) => void }) {
  return (
    <button className="link ch-end" onClick={(ev) => (ev.stopPropagation(), onGoTo(e.pane))} title={`${e.agent ?? "no agent"} · ${e.workspace ?? ""} · go to its pane`}>
      <i className="proc-dot" style={{ background: e.gone ? "var(--text-3)" : kindColor(e.agent ?? "") }} />
      {e.name}
      {e.gone && <span className="ch-gone"> (gone)</span>}
    </button>
  );
}

function ChannelRow({ c, open, onToggle, onChanged, onGoTo }: { c: Channel; open: boolean; onToggle: () => void; onChanged: () => void; onGoTo: (pane: string) => void }) {
  const [text, setText] = useState("");
  const [toB, setToB] = useState(true);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const n = c.toA.length + c.toB.length;
  const send = () => {
    if (!text.trim()) return;
    setBusy(true);
    const body = c.kind === "parent" ? { id: c.id, text, toChild: toB } : { id: c.id, text, to: toB ? c.b.pane : c.a.pane };
    api("POST", "/channels/send", body)
      .then(() => (setText(""), onChanged()))
      .catch(failed("Could not send it"))
      .finally(() => setBusy(false));
  };
  const cut = () => {
    if (!armed) return setArmed(true);
    setArmed(false);
    api<{ dropped?: number }>("POST", "/channels/disconnect", { id: c.id })
      .then((r) => {
        notify("info", c.kind === "parent" ? `${c.b.name} is an independent session now` : `${c.a.name} and ${c.b.name} are disconnected`, r.dropped ? `${r.dropped} waiting message(s) dropped` : undefined);
        onChanged();
      })
      .catch(failed("Could not disconnect them"));
  };
  const drop = (m: ChannelMessage) =>
    api("POST", "/channels/drop", { id: c.id, ref: m.ref })
      .then(onChanged)
      .catch(failed("Could not delete it"));
  const box = (title: string, ms: ChannelMessage[]) =>
    ms.length > 0 && (
      <div className="ch-box">
        <div className="ch-box-title">{title}</div>
        {ms.map((m) => (
          <div key={m.ref} className="ch-msg">
            <span className="ch-msg-text" title={m.text}>
              {m.text.replace(/\s+/g, " ").slice(0, 220)}
            </span>
            <button className="x" title="Delete this message: it is not delivered" onClick={() => drop(m)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    );
  return (
    <div className={`ch-row ${open ? "open" : ""}`}>
      <div className="ch-head" onClick={onToggle}>
        <span className="c-tool-caret">{open ? "▾" : "▸"}</span>
        <End e={c.a} onGoTo={onGoTo} />
        <span className="ch-line">{c.kind === "parent" ? "→" : "⇄"}</span>
        <End e={c.b} onGoTo={onGoTo} />
        <span className="spacer" />
        {n > 0 && <span className="ch-count" title="Messages waiting on this channel">{n}</span>}
        <span className="ch-kind">{c.kind === "parent" ? (c.ticket ? `${c.ticket.id} · ${c.ticket.stage}` : "handed out") : "connected by you"}</span>
      </div>
      {open && (
        <div className="ch-body">
          {c.ticket && <div className="ch-ticket">{c.ticket.title}</div>}
          {box(`waiting for ${c.b.name}`, c.toB)}
          {box(c.kind === "parent" ? `waiting in ${c.a.name}'s queue` : `waiting for ${c.a.name}`, c.toA)}
          {!n && <div className="ch-none">Nothing waiting.</div>}
          <div className="ch-send">
            <select value={toB ? "b" : "a"} onChange={(e) => setToB(e.target.value === "b")} title="Who gets it">
              <option value="b">to {c.b.name}</option>
              <option value="a">{c.kind === "parent" ? `into ${c.a.name}'s queue` : `to ${c.a.name}`}</option>
            </select>
            <input className="text" placeholder="A message on this channel (it arrives when the turn ends)" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && send()} />
            <button className="btn" disabled={busy || !text.trim()} onClick={send}>
              Send
            </button>
          </div>
          <div className="ch-actions">
            <button
              className={`btn ${armed ? "danger" : "subtle"}`}
              onClick={cut}
              title={c.kind === "parent" ? `${c.b.name} goes on as an independent session: its tickets close, its results stop going to ${c.a.name}, and what waits here is dropped. Its pane and conversation stay.` : "Delete this channel: neither can send to the other any more, and what waits on it is dropped. Both are told."}
            >
              {armed ? "click again to disconnect" : "Disconnect"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectForm({ here, all, wsLabel, onDone }: { here: HPane[]; all: HPane[]; wsLabel: (p: HPane) => string; onDone: () => void }) {
  const [a, setA] = useState(here[0]?.id ?? "");
  const [b, setB] = useState("");
  const name = (p: HPane) => `${p.agentName ?? p.agent} · ${wsLabel(p)}${p.machine !== "local" ? ` @${p.machine}` : ""}${p.title ? ` · ${p.title.slice(0, 30)}` : ""}`;
  const go = () =>
    api("POST", "/channels/connect", { a, b })
      .then(() => (notify("info", "Connected", "Each was told the other's name and how to send to it (af send <name>)."), onDone()))
      .catch(failed("Could not connect them"));
  return (
    <div className="ch-connect">
      <select value={a} onChange={(e) => setA(e.target.value)}>
        {here.map((p) => (
          <option key={p.id} value={p.id}>
            {name(p)}
          </option>
        ))}
      </select>
      <span className="ch-line">⇄</span>
      <select value={b} onChange={(e) => setB(e.target.value)}>
        <option value="">another agent…</option>
        {all
          .filter((p) => p.id !== a)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {name(p)}
            </option>
          ))}
      </select>
      <button className="btn primary" disabled={!a || !b} onClick={go}>
        Connect
      </button>
      <button className="c-more" onClick={onDone}>
        cancel
      </button>
    </div>
  );
}
