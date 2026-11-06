// The right panel for a workspace with a team (docs/design.md 10.1):
//   mode 1 (direct): the session's timeline — a vertical line for the session, a box per ticket where it was handed
//                    out, and a line back to the session where the result came back.
//   mode 2 (router): swim lanes — one line for the router and one per member; an arrow per ticket (router → member)
//                    and per thing a member handed back (member → router).
// Clicking a box or an arrow shows the ticket below: its task.md, its result.md, and a way to its pane.

import { useEffect, useMemo, useState } from "react";
import type { HPane, QueueItem, TeamState, TeamSummary, Ticket } from "@af/core";
import { paneLook, ticketList, ticketStage } from "@af/core";
import { renderDoc } from "./markdown";
import { TOKEN, api, failed, fileUrl } from "./store";
import { Terminal } from "./Terminal";
import { ago, basename, clock, kindColor, span, stageLook } from "./view";

export interface TeamPanelProps {
  team: TeamState;
  /** Every team (to find nested teams and parents). */
  teams: TeamSummary[];
  /** Other teams that live in this workspace, to switch between. */
  siblings: TeamSummary[];
  panes: Map<string, HPane>;
  onPickTeam: (id: string) => void;
  onGoTo: (paneId: string) => void;
  onOpen: (path: string) => void;
}

const look = (s: TeamState, k: Ticket, panes: Map<string, HPane>) => {
  const m = s.members[k.assignee];
  const p = m?.paneId ? panes.get(m.paneId) : undefined;
  return stageLook(ticketStage(k, m, p ? paneLook(p) : undefined));
};

export function TeamPanel(props: TeamPanelProps) {
  const { team: s, siblings, onPickTeam } = props;
  const [selected, setSelected] = useState<string>();
  const meta = s.meta!;
  useEffect(() => setSelected(undefined), [meta.id]);
  const waiting = s.queue.filter((q) => q.state !== "handled");
  const parent = meta.parent ? props.teams.find((t) => t.id === meta.parent!.team) : undefined;
  return (
    <>
      <div className="panel-head">
        {siblings.length > 1 ? (
          <select className="team-pick" value={meta.id} onChange={(e) => onPickTeam(e.target.value)} title="Teams in this workspace">
            {siblings.map((t) => (
              <option key={t.id} value={t.id}>
                {t.mode === "router" ? "◆ " : ""}
                {t.name} · {t.id}
              </option>
            ))}
          </select>
        ) : (
          <span>{meta.mode === "router" ? `◆ ${meta.name}` : "Handed out"}</span>
        )}
        <span className="sub">
          {s.order.length} ticket{s.order.length === 1 ? "" : "s"}
          {meta.playbook && <> · {meta.playbook}</>}
          {s.stopped && <> · stopped</>}
        </span>
        <span className="spacer" />
        {parent && (
          <button className="c-more" title={`This team is ticket ${meta.parent!.ticket} of ${parent.name}`} onClick={() => onPickTeam(parent.id)}>
            ↑ {parent.name}
          </button>
        )}
      </div>
      {meta.mode === "router" && meta.goal && <div className="team-goal">{meta.goal}</div>}
      {!s.stopped && (
        <label className="team-delegate" title="Folder-trust prompts, permission prompts and 'Enter to continue' notices of the sessions this team starts go to its manager to answer for you, instead of Needs you. What it leaves to you (or does not answer in 30 min) still comes to you.">
          <input type="checkbox" checked={!!meta.delegate} onChange={(e) => api("POST", "/team/delegate", { id: s.meta!.id, on: e.target.checked }).catch(failed("Could not change it"))} />
          {meta.mode === "router" ? "The router" : "This session"} answers trust and permission prompts and notices for me
        </label>
      )}
      {waiting.length > 0 && <QueueStrip items={waiting} manager={meta.mode === "router" ? "the router" : "the session"} />}
      <div className="team-body">{meta.mode === "direct" ? <Timeline {...props} selected={selected} onSelect={setSelected} /> : <Lanes {...props} selected={selected} onSelect={setSelected} />}</div>
      {selected && s.tickets[selected] && <TicketDetail key={selected} {...props} ticket={s.tickets[selected]!} onClose={() => setSelected(undefined)} />}
    </>
  );
}

function QueueStrip({ items, manager }: { items: QueueItem[]; manager: string }) {
  const queued = items.filter((q) => q.state === "queued").length;
  const taken = items.length - queued;
  return (
    <div className="queue-strip" title={items.map((q) => `#${q.seq} ${q.kind} ${q.ticket ?? ""} ${q.from ?? ""}: ${q.text.split("\n")[0]}`).join("\n")}>
      <b>Queue</b> {queued > 0 && <span>{queued} waiting for {manager}</span>}
      {taken > 0 && <span>{taken} taken, not acted on yet</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// mode 1: the timeline

type TlEvent = { at: string; kind: "out"; k: Ticket } | { at: string; kind: "back"; k: Ticket; text: string };

function Timeline({ team: s, teams, panes, selected, onSelect, onPickTeam, onGoTo }: TeamPanelProps & { selected?: string; onSelect: (id?: string) => void }) {
  const meta = s.meta!;
  const manager = meta.manager.pane ? panes.get(meta.manager.pane) : undefined;
  const events = useMemo(() => {
    const out: TlEvent[] = [];
    for (const k of ticketList(s)) out.push({ at: k.createdAt, kind: "out", k });
    // every result that came back (a member that went on by itself comes back more than once)
    for (const q of s.queue) {
      const k = q.ticket ? s.tickets[q.ticket] : undefined;
      if (k && (q.kind === "turn" || q.kind === "submit" || q.kind === "report")) out.push({ at: q.at, kind: "back", k, text: q.text.split("\n").find((l) => l.trim()) ?? q.kind });
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [s, s.seq]);
  if (!events.length)
    return (
      <div className="welcome" style={{ padding: 24, textAlign: "center" }}>
        <div>
          <div style={{ color: "var(--text-2)", marginBottom: 4 }}>Nothing handed out yet</div>
          <div>Ask this session to have other agents do things; each task shows up here.</div>
        </div>
      </div>
    );
  // a member's session that hands out work itself: its own team opens from its box
  const nestedOf = (paneId?: string) => (paneId ? teams.find((t) => t.mode === "direct" && t.managerPane === paneId && !t.stopped) : undefined);
  return (
    <div className="timeline">
      <div className="tl-head">
        <span className="tl-dot" style={{ background: kindColor(manager?.agent ?? "claude") }} />
        <span>{manager ? `${manager.agentName ?? manager.agent ?? "session"}` : "session"}</span>
        {manager && (
          <button className="link" onClick={() => onGoTo(manager.id)}>
            go to it
          </button>
        )}
      </div>
      {events.map((e, i) => {
        const k = e.k;
        const m = s.members[k.assignee];
        const lk = look(s, k, panes);
        if (e.kind === "back")
          return (
            <div key={`b${k.id}${i}`} className={`tl-row back ${selected === k.id ? "on" : ""}`} onClick={() => onSelect(k.id)}>
              <span className="tl-time">{clock(e.at)}</span>
              <span className="tl-return" style={{ "--state": lk.color } as React.CSSProperties}>
                ◀ <b>{k.id}</b> {k.assignee}: {e.text}
              </span>
            </div>
          );
        const nested = k.team ? teams.find((t) => t.id === k.team) : nestedOf(m?.paneId);
        return (
          <div key={`o${k.id}`} className="tl-row out" onClick={() => onSelect(selected === k.id ? undefined : k.id)}>
            <span className="tl-time">{clock(e.at)}</span>
            <span className="tl-arm" />
            <div className={`tl-box ${selected === k.id ? "selected" : ""} ${lk.key}`} style={{ "--state": lk.color } as React.CSSProperties}>
              <div className="top">
                <span className="id">{k.id}</span>
                <span className="who">{k.assignee}</span>
                <span className="kind" style={{ color: kindColor(m?.kind ?? "claude") }}>
                  {k.team ? "team" : m?.kind}
                </span>
              </div>
              <div className="title">{k.title}</div>
              <div className="bottom">
                <span className="state">{lk.label}</span>
                <span>{span(k.deliveredAt ?? k.createdAt, k.report?.at ?? k.closedAt)}</span>
                {k.round > 1 && <span className="mono">r{k.round}</span>}
                {k.branch && <span className="mono" title={k.branch}>⎇</span>}
              </div>
              {nested && (
                <button className="tl-nested" title={`${nested.mode === "router" ? "Its team" : "It hands out work too"}: ${nested.name}`} onClick={(ev) => (ev.stopPropagation(), onPickTeam(nested.id))}>
                  ⊕ {nested.mode === "router" ? nested.name : `${nested.tickets} handed out`}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <div className="tl-now">▼ now</div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// mode 2: swim lanes

type LaneEvent = { at: string; from: string; to: string; label: string; ticket?: string; tone?: "warn" | "back"; dashed?: boolean };

function Lanes({ team: s, panes, selected, onSelect, onGoTo }: TeamPanelProps & { selected?: string; onSelect: (id?: string) => void }) {
  const cols = useMemo(() => ["router", ...Object.keys(s.members).filter((n) => n !== "router")], [s, s.seq]);
  const events = useMemo(() => {
    const out: LaneEvent[] = [];
    for (const k of ticketList(s)) out.push({ at: k.createdAt, from: "router", to: k.assignee, label: `${k.id} ${k.title}${k.round > 1 ? ` · round ${k.round}` : ""}`, ticket: k.id });
    for (const q of s.queue) {
      if (!q.from || !s.members[q.from] || q.kind === "user" || q.kind === "report") continue;
      const verb = q.kind === "submit" ? q.text.split("\n")[0]! : q.kind === "turn" ? "stopped, no submit" : q.kind === "asking" ? `asking: ${q.text}` : q.kind === "ask" ? `asks: ${q.text}` : q.kind;
      out.push({ at: q.at, from: q.from, to: "router", label: `${q.ticket ?? ""} ${verb}`.trim(), ticket: q.ticket, tone: q.kind === "submit" ? "back" : "warn", dashed: q.kind !== "submit" });
    }
    for (const q of s.queue) if (q.kind === "user") out.push({ at: q.at, from: "you", to: "router", label: q.text.split("\n")[0]!, tone: "warn" });
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }, [s, s.seq]);
  const x = (name: string) => (name === "you" ? 0 : ((cols.indexOf(name) + 0.5) / cols.length) * 100);
  return (
    <div className="lanes" style={{ "--cols": cols.length } as React.CSSProperties}>
      <div className="lane-heads">
        {cols.map((c) => {
          const m = s.members[c];
          const p = m?.paneId ? panes.get(m.paneId) : undefined;
          return (
            <button key={c} className="lane-head" onClick={() => m?.paneId && onGoTo(m.paneId)} title={m ? `${m.kind} · ${p?.agentStatus ?? m.status} — go to its pane` : c}>
              <span className="tl-dot" style={{ background: kindColor(m?.kind ?? "claude"), opacity: p?.agentStatus === "working" ? 1 : 0.55 }} />
              {c}
              {m && <span className="kind" style={{ color: kindColor(m.kind) }}>{m.team ? "team" : m.kind}</span>}
            </button>
          );
        })}
      </div>
      <div className="lane-rows">
        <div className="lane-lines">
          {cols.map((c) => (
            <i key={c} style={{ left: `${x(c)}%` }} />
          ))}
        </div>
        {!events.length && <div className="empty" style={{ padding: 16 }}>The router has not opened any tickets yet.</div>}
        {events.map((e, i) => {
          const a = x(e.from);
          const b = x(e.to);
          const left = Math.min(a, b);
          const width = Math.max(Math.abs(b - a), 2);
          const k = e.ticket ? s.tickets[e.ticket] : undefined;
          const color = e.tone === "warn" ? "var(--s-needs)" : e.tone === "back" ? (k ? look(s, k, panes).color : "var(--s-submitted)") : "var(--accent)";
          return (
            <div key={i} className={`lane-row ${k && selected === k.id ? "on" : ""}`} onClick={() => k && onSelect(k.id)} title={`${clock(e.at)} · ${e.label}`}>
              <span className="lane-time">{clock(e.at)}</span>
              <div className={`lane-arrow ${b < a ? "rev" : ""} ${e.dashed ? "dashed" : ""}`} style={{ left: `${left}%`, width: `${width}%`, "--c": color } as React.CSSProperties}>
                <span className="lane-label">{e.label}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// one ticket

function useText(path: string | undefined, version: unknown) {
  const [text, setText] = useState<string | null>();
  useEffect(() => {
    if (!path) return setText(null);
    let gone = false;
    fetch(fileUrl(path))
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => !gone && setText(t), () => !gone && setText(null));
    return () => void (gone = true);
  }, [path, version]);
  return text;
}

function Doc({ path, text }: { path: string; text: string | null | undefined }) {
  if (text === undefined) return <div className="empty">loading…</div>;
  if (text === null) return <div className="empty">not written yet</div>;
  return <div className="doc ticket-doc" dangerouslySetInnerHTML={{ __html: renderDoc(text, path, TOKEN).html }} />;
}

function TicketDetail({ team: s, ticket: k, teams, panes, onClose, onGoTo, onOpen, onPickTeam }: TeamPanelProps & { ticket: Ticket; onClose: () => void }) {
  const [seg, setSeg] = useState<"result" | "task" | "terminal">(k.report || k.status === "closed" ? "result" : "task");
  const dir = `${teamDir(s)}/tickets/${k.id}`;
  const m = s.members[k.assignee];
  const lk = look(s, k, panes);
  const task = useText(`${dir}/task.md`, k.id);
  const result = useText(`${dir}/result.md`, k.report?.at ?? k.updatedAt);
  const child = k.team ? teams.find((t) => t.id === k.team) : undefined;
  return (
    <div className="detail">
      <div className="panel-head">
        <span style={{ fontFamily: "var(--mono)" }}>{k.id}</span>
        <span>{k.assignee}</span>
        <span className="pill" style={{ "--pc": kindColor(m?.kind ?? "claude") } as React.CSSProperties}>
          {k.team ? "team" : m?.kind}
        </span>
        <span className="pill" style={{ "--pc": lk.color } as React.CSSProperties}>
          {lk.label}
        </span>
        <span className="spacer" />
        <button className="close" onClick={onClose} title="Close">
          ✕
        </button>
      </div>
      <div className="seg">
        {(["result", "task", ...(m?.paneId && !k.team ? ["terminal"] : [])] as const).map((x) => (
          <button key={x} className={seg === x ? "on" : ""} onClick={() => setSeg(x as typeof seg)}>
            {x}
          </button>
        ))}
      </div>
      <div className="detail-body">
        <dl className="kv">
          <dt>title</dt>
          <dd>{k.title}</dd>
          {(k.from || k.round > 1) && (
            <>
              <dt>thread</dt>
              <dd>
                {k.thread} · round {k.round}
                {k.from && <> · follows {k.from}</>}
              </dd>
            </>
          )}
          <dt>time</dt>
          <dd>
            opened {ago(k.createdAt)} ago{k.report && <> · back after {span(k.deliveredAt ?? k.createdAt, k.report.at)}</>}
            {k.outcome && <> · closed {k.outcome}</>}
          </dd>
          {k.progress && (
            <>
              <dt>progress</dt>
              <dd>{k.progress}</dd>
            </>
          )}
          {k.branch && (
            <>
              <dt>branch</dt>
              <dd className="mono">{k.branch}</dd>
            </>
          )}
          {m && !k.team && (
            <>
              <dt>folder</dt>
              <dd className="mono" style={{ fontSize: 11 }}>
                {m.cwd}
              </dd>
            </>
          )}
        </dl>
        {seg === "result" && (
          <>
            {k.report?.note && <div className="task">{k.report.status !== "ready" ? `${k.report.status}: ` : ""}{k.report.note}</div>}
            <Doc path={`${dir}/result.md`} text={result} />
          </>
        )}
        {seg === "task" && (
          <>
            {k.note && <div className="task">router's note: {k.note}</div>}
            {k.inputs.length > 0 && (
              <div className="task">
                inputs:{" "}
                {k.inputs.map((p) => (
                  <a key={p} href="#" onClick={(e) => (e.preventDefault(), onOpen(p))}>
                    {basename(p.replace(/\/result\.md$/, "")) + "/" + basename(p)}{" "}
                  </a>
                ))}
              </div>
            )}
            <Doc path={`${dir}/task.md`} text={task} />
          </>
        )}
        {seg === "terminal" && m?.paneId && <Terminal key={m.paneId} paneId={m.paneId} mode="observe" />}
      </div>
      <div className="actions">
        {child ? (
          <button className="btn primary" onClick={() => onPickTeam(child.id)}>
            Open the team
          </button>
        ) : (
          m?.paneId && (
            <button className="btn primary" onClick={() => onGoTo(m.paneId!)}>
              Go to its pane ↗
            </button>
          )
        )}
        <button className="btn" onClick={() => onOpen(dir)}>
          Open the ticket folder
        </button>
      </div>
    </div>
  );
}

const teamDir = (s: TeamState) => s.meta!.dir;
