/**
 * KnowledgeGraphStage — React Flow graph of the session's knowledge graph.
 *
 * Renders nodes colored by entityType; edge label = relationType; node title
 * (tooltip) = fact from the incoming edge.  Shows a graceful empty state when
 * the graph is unavailable (Mem0 offline or empty).
 *
 * Data source: GraphView passed in from ProcessTheater (fetched via /graph).
 */
import "@xyflow/react/dist/style.css";
import { useMemo } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  BackgroundVariant,
} from "@xyflow/react";
import type { Node, Edge } from "@xyflow/react";
import type { GraphView } from "../../../../../../sige/knowledge/graph-query";
import { graphViewToFlow } from "../transforms";
import type { KgNodeData, KgEdgeData } from "../transforms";
import type { StageStatus } from "../StagePanel";
import { cn } from "../../../../lib/cn";

// ─── Entity-type color map ─────────────────────────────────────────────────────

const ENTITY_COLORS: Record<string, string> = {
  Fact: "#6366f1",       // accent indigo
  Person: "#22c55e",     // green
  Organization: "#3b82f6", // blue
  Product: "#f97316",    // orange
  Technology: "#a855f7", // purple
  Concept: "#14b8a6",    // teal
  Event: "#eab308",      // yellow
  Location: "#f43f5e",   // red
};

function entityColor(entityType: string): string {
  return ENTITY_COLORS[entityType] ?? ENTITY_COLORS["Fact"] ?? "#6366f1";
}

// ─── Custom node style injected via style prop ─────────────────────────────────

function colorNodes(nodes: readonly Node<KgNodeData>[]): Node<KgNodeData>[] {
  return nodes.map((n) => {
    const color = entityColor(n.data.entityType);
    return {
      ...n,
      style: {
        background: `${color}18`,
        border: `1.5px solid ${color}55`,
        borderRadius: "8px",
        color: "#e2e8f0",
        fontSize: "11px",
        padding: "6px 10px",
        maxWidth: "160px",
        whiteSpace: "pre-wrap" as const,
      },
      // Title attribute shows on hover in supported browsers
      title: n.data.summary ?? n.data.label,
    };
  });
}

function styleEdges(edges: readonly Edge<KgEdgeData>[]): Edge<KgEdgeData>[] {
  return edges.map((e) => ({
    ...e,
    style: { stroke: "#475569", strokeWidth: 1.5 },
    labelStyle: { fill: "#94a3b8", fontSize: 10 },
    labelBgStyle: { fill: "transparent" },
  }));
}

// ─── Inner canvas (must be inside ReactFlowProvider) ──────────────────────────

interface CanvasProps {
  readonly nodes: Node<KgNodeData>[];
  readonly edges: Edge<KgEdgeData>[];
}

function KgCanvas({ nodes, edges }: CanvasProps) {
  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable={false}
      proOptions={{ hideAttribution: true }}
      className="bg-bg"
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={20}
        size={1}
        className="opacity-15"
      />
      <Controls
        showInteractive={false}
        style={{ left: 12, bottom: 12 }}
        className="!bg-bg-1 !border !border-border !rounded-lg [&>button]:!bg-bg-1 [&>button]:!border-border [&>button]:!fill-foreground [&>button:hover]:!bg-bg-2"
      />
    </ReactFlow>
  );
}

// ─── Public component ──────────────────────────────────────────────────────────

export interface KnowledgeGraphStageProps {
  readonly graphView: GraphView | null;
  readonly status: StageStatus;
}

export function KnowledgeGraphStage({
  graphView,
  status,
}: KnowledgeGraphStageProps) {
  const { nodes: rawNodes, edges: rawEdges } = useMemo(
    () => graphViewToFlow(graphView),
    [graphView],
  );

  const nodes = useMemo(() => colorNodes(rawNodes), [rawNodes]);
  const edges = useMemo(() => styleEdges(rawEdges), [rawEdges]);

  const isEmpty = nodes.length === 0;

  // While running and no data yet, show a loading shimmer inside the panel
  if (status === "running" && isEmpty) {
    return (
      <div className="px-5 py-6 text-sm text-muted italic">
        Building knowledge graph…
      </div>
    );
  }

  if (isEmpty) {
    return (
      <div className="px-5 py-8 text-center">
        <p className="text-sm text-muted italic">
          Knowledge graph unavailable (Mem0 offline or empty).
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative w-full",
        // Height scales with content: min 300px, reasonable max
        "h-[340px]",
      )}
    >
      <ReactFlowProvider>
        <KgCanvas nodes={nodes} edges={edges} />
      </ReactFlowProvider>

      {/* Legend */}
      <div className="absolute top-3 right-3 flex flex-col gap-1 pointer-events-none">
        {Object.entries(ENTITY_COLORS).map(([type, color]) => (
          <div key={type} className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ background: `${color}55`, border: `1px solid ${color}99` }}
            />
            <span className="text-[10px] text-faint">{type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
