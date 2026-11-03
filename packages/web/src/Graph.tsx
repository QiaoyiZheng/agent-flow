import { useEffect, useMemo } from "react";
import { type Edge, type EdgeProps, type Node, type NodeProps, BaseEdge, EdgeLabelRenderer, Handle, useReactFlow, useStore as useFlowStore, MarkerType, Position, ReactFlow, Controls, Background, BackgroundVariant } from "@xyflow/react";
import type { RunState } from "@af/core";
import { latestInstance, liveEdges, liveNodes } from "@af/core";
import { executorKind, executorLabel, kindColor, loopBadge, nodeLook } from "./view";

type CardData = { id: string; kind: string; exec: string; look: ReturnType<typeof nodeLook>; inst?: string; loop?: { text: string; limited: boolean }; opens: number; selected: boolean };

function Card({ data }: NodeProps<Node<CardData>>) {
  return (
    <div className={`gnode ${data.look.key} ${data.selected ? "selected" : ""}`} style={{ "--state": data.look.color } as React.CSSProperties}>
      <Handle type="target" position={Position.Top} />
      <Handle type="source" position={Position.Bottom} />
      <Handle type="source" id="rs" position={Position.Right} style={{ top: "65%" }} />
      <div className="top">
        <span className="id">{data.id}</span>
        <span className="kind" style={{ color: kindColor(data.kind) }}>
          {data.exec}
        </span>
      </div>
      <div className="bottom">
        <span className="state">{data.look.label}</span>
        {data.inst && <span style={{ fontFamily: "var(--mono)" }}>{data.inst}</span>}
        {data.loop && (
          <span className="loop" style={{ color: data.loop.limited ? "var(--s-needs)" : undefined }}>
            {data.loop.text}
          </span>
        )}
      </div>
      {data.opens > 0 && <span className="badge" title="files or pages this node opened">{data.opens}</span>}
    </div>
  );
}

const NODE_W = 168;

/** A loop edge: out of the source's right side, up a lane right of the whole graph, then down into the target's top. */
function BackEdge({ sourceX, sourceY, targetX, targetY, data, style, markerEnd, label }: EdgeProps<Edge<{ lane: number }>>) {
  const lane = data!.lane;
  const above = targetY - 16;
  const r = 6;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${lane - r} ${sourceY}`,
    `Q ${lane} ${sourceY} ${lane} ${sourceY - r}`,
    `L ${lane} ${above + r}`,
    `Q ${lane} ${above} ${lane - r} ${above}`,
    `L ${targetX + r} ${above}`,
    `Q ${targetX} ${above} ${targetX} ${above + r}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");
  return (
    <>
      <BaseEdge path={path} style={style} markerEnd={markerEnd} />
      {label && (
        <EdgeLabelRenderer>
          <div className="edge-label" style={{ transform: `translate(-100%, -50%) translate(${lane - 6}px, ${(sourceY + above) / 2}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Re-fit whenever the panel is resized (e.g. the node detail opens) or nodes are added. */
function AutoFit({ dep }: { dep: string }) {
  const { fitView } = useReactFlow();
  const w = useFlowStore((s) => s.width);
  const h = useFlowStore((s) => s.height);
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.22, maxZoom: 1.1, duration: 180 }), 60);
    return () => clearTimeout(t);
  }, [w, h, dep]);
  return null;
}

const nodeTypes = { card: Card };
const edgeTypes = { back: BackEdge };

/** Top-to-bottom layers by longest forward path; back edges are drawn around the right side. */
function layout(run: RunState) {
  const nodes = liveNodes(run.graph);
  const fwd = liveEdges(run.graph).filter((e) => !e.back);
  const rank = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of fwd) {
      const r = (rank.get(e.from) ?? 0) + 1;
      if (r > (rank.get(e.to) ?? 0)) {
        rank.set(e.to, r);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const layers = new Map<number, string[]>();
  for (const n of nodes) layers.set(rank.get(n.id)!, [...(layers.get(rank.get(n.id)!) ?? []), n.id]);
  const pos = new Map<string, { x: number; y: number }>();
  for (const [r, ids] of layers) ids.forEach((id, i) => pos.set(id, { x: (i - (ids.length - 1) / 2) * 196, y: r * 104 }));
  return pos;
}

export function Graph({ run, selected, onSelect }: { run: RunState; selected?: string; onSelect: (id?: string) => void }) {
  const { nodes, edges } = useMemo(() => {
    const pos = layout(run);
    const nodes: Node<CardData>[] = liveNodes(run.graph).map((n) => {
      const i = latestInstance(n);
      return {
        id: n.id,
        type: "card",
        position: pos.get(n.id)!,
        data: {
          id: n.id,
          kind: executorKind(run, n),
          exec: executorLabel(n),
          look: nodeLook(n),
          inst: i ? `#${i.n}` : undefined,
          loop: loopBadge(run, n.id),
          opens: (run.opens ?? []).filter((o) => o.node?.startsWith(`${n.id}#`)).length,
          selected: n.id === selected,
        },
      };
    });
    const right = Math.max(...[...pos.values()].map((p) => p.x + NODE_W));
    let lanes = 0;
    const edges: Edge[] = liveEdges(run.graph).map((e) => {
      const live = e.queue.length > 0;
      const back = e.back;
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        sourceHandle: back ? "rs" : undefined,
        type: back ? "back" : "smoothstep",
        data: back ? { lane: right + 22 + 14 * lanes++ } : undefined,
        label: back ? `${e.on} · ${e.fired}/${e.max}` : e.on,
        animated: live,
        style: {
          stroke: back ? (e.blocked ? "var(--s-needs)" : "var(--accent)") : live ? "var(--s-running)" : "#3a3e47",
          strokeWidth: 1.25,
          strokeDasharray: back ? "4 4" : undefined,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: back ? "#7c83f7" : "#4a4e57" },
      };
    });
    return { nodes, edges };
  }, [run, run.seq, selected]);

  if (!nodes.length)
    return (
      <div className="welcome" style={{ padding: 24, textAlign: "center" }}>
        <div>
          <div style={{ color: "var(--text-2)", marginBottom: 4 }}>No nodes yet</div>
          <div>Ask the lead for something; it will build the graph here.</div>
        </div>
      </div>
    );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: 0.25, maxZoom: 1.1 }}
      minZoom={0.3}
      maxZoom={1.6}
      nodesDraggable={false}
      nodesConnectable={false}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => onSelect(n.id === selected ? undefined : n.id)}
      onPaneClick={() => onSelect(undefined)}
      colorMode="dark"
    >
      <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#22252b" />
      <Controls showInteractive={false} position="bottom-left" />
      <AutoFit dep={nodes.map((n) => n.id).join(",")} />
    </ReactFlow>
  );
}
