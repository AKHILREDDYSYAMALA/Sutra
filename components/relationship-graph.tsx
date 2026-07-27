"use client";

import { useCallback, useEffect, useMemo } from "react";
import * as dagre from "@dagrejs/dagre";
import {
  Background,
  Controls,
  getViewportForBounds,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { getCorpusReportCount, type CorpusIndex } from "@/lib/domain/corpus";
import { edgeIdentity } from "@/lib/domain/graph";
import type { GraphData, GraphEdge, GraphNode } from "@/lib/graph-data";

type SutraNodeData = {
  label: string;
  entityType: GraphNode["type"];
  named: boolean;
  reportCount: number;
  highlighted: boolean;
};
type SutraFlowNode = Node<SutraNodeData, "sutra">;
type SutraFlowEdge = Edge<{ evidence: GraphEdge }>;

export type GraphPanelState = {
  leftPanelOpen: boolean;
  riskPanelOpen: boolean;
  evidencePanelOpen: boolean;
  entityPanelOpen: boolean;
};

const nodeTheme: Record<GraphNode["type"], { accent: string; dot: string; label: string }> = {
  target: { accent: "border-cyan-300/70 bg-cyan-400/10", dot: "bg-cyan-300", label: "Company" },
  customer: { accent: "border-emerald-300/55 bg-emerald-400/10", dot: "bg-emerald-300", label: "Customer" },
  supplier: { accent: "border-rose-300/55 bg-rose-400/10", dot: "bg-rose-300", label: "Supplier" },
  lender: { accent: "border-violet-300/55 bg-violet-400/10", dot: "bg-violet-300", label: "Lender" },
  subsidiary: { accent: "border-amber-300/55 bg-amber-400/10", dot: "bg-amber-300", label: "Subsidiary" },
  parent: { accent: "border-amber-300/55 bg-amber-400/10", dot: "bg-amber-300", label: "Parent" },
  group_company: { accent: "border-amber-300/55 bg-amber-400/10", dot: "bg-amber-300", label: "Group" },
  industry: { accent: "border-slate-300/45 bg-slate-400/10", dot: "bg-slate-300", label: "Industry" },
  unnamed_dependency: { accent: "border-slate-400/45 bg-slate-400/5", dot: "bg-slate-400", label: "Reported dependency" },
};

function SutraNode({ data }: NodeProps<SutraFlowNode>) {
  const theme = nodeTheme[data.entityType];
  const isUnnamed = data.named === false;

  return (
    <>
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-slate-500" />
      <div
        title={data.reportCount > 1 ? `Appears in ${data.reportCount} Sutra reports. Click to explore.` : "Click to explore this entity in Sutra's corpus."}
        className={`min-h-[96px] min-w-[188px] max-w-[230px] cursor-pointer rounded-xl border px-3.5 py-3 shadow-xl shadow-slate-950/50 backdrop-blur transition hover:-translate-y-0.5 hover:brightness-125 ${
          isUnnamed ? "border-dashed border-slate-400/55 bg-slate-400/5" : theme.accent
        } ${
          data.highlighted ? "ring-2 ring-cyan-300/80 ring-offset-2 ring-offset-slate-950" : ""
        }`}
      >
        <div className="mb-1.5 flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className={isUnnamed ? "h-2 w-2 rounded-sm border border-dashed border-slate-400/80" : `h-1.5 w-1.5 rounded-full ${theme.dot}`} />
            <span className="text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-400">{isUnnamed ? "Reported but unnamed" : theme.label}</span>
          </div>
          {data.reportCount > 1 && (
            <span className="shrink-0 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-1.5 py-0.5 text-[8px] font-semibold text-cyan-100">
              in {data.reportCount} reports
            </span>
          )}
        </div>
        <p className="text-sm font-medium leading-snug text-slate-100">{data.label}</p>
      </div>
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-slate-500" />
    </>
  );
}

const nodeTypes = { sutra: SutraNode };
const NODE_WIDTH = 230;
const NODE_HEIGHT = 104;
const nodeTypeOrder: Record<GraphNode["type"], number> = {
  target: 0,
  supplier: 1,
  unnamed_dependency: 2,
  customer: 3,
  lender: 4,
  parent: 5,
  subsidiary: 6,
  group_company: 7,
  industry: 8,
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedNodes(graph: GraphData) {
  return [...graph.nodes].sort((left, right) => nodeTypeOrder[left.type] - nodeTypeOrder[right.type] || compareText(left.id, right.id));
}

function layoutNodes(graph: GraphData) {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const layout = new dagre.graphlib.Graph({ multigraph: true });
  layout.setGraph({
    rankdir: "LR",
    ranker: "network-simplex",
    acyclicer: "greedy",
    nodesep: 82,
    ranksep: 190,
    marginx: 36,
    marginy: 36,
  });
  layout.setDefaultEdgeLabel(() => ({}));

  const sortedNodes = orderedNodes(graph);
  sortedNodes.forEach((node) => layout.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  graph.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .sort((left, right) => compareText(left.source, right.source) || compareText(left.target, right.target) || compareText(left.relation, right.relation))
    .forEach((edge, index) => layout.setEdge(edge.source, edge.target, { weight: edge.risk_flag === "high" ? 3 : 1 }, `edge-${index}`));
  dagre.layout(layout);

  return new Map(
    sortedNodes.map((node) => {
      const positioned = layout.node(node.id);
      return [node.id, { x: positioned.x - NODE_WIDTH / 2, y: positioned.y - NODE_HEIGHT / 2 }];
    }),
  );
}

function toFlowNodes(graph: GraphData, corpus: CorpusIndex, highlightedNodeIds: Set<string>): SutraFlowNode[] {
  const positions = layoutNodes(graph);

  return orderedNodes(graph).map((node) => ({
    id: node.id,
    type: "sutra",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
    data: {
      label: node.label,
      entityType: node.type,
      named: node.named,
      reportCount: getCorpusReportCount(corpus, node.label),
      highlighted: highlightedNodeIds.has(node.id),
    },
  }));
}

function toFlowEdges(
  graph: GraphData,
  highlightedEdgeIds: Set<string>,
  verificationTiers: Record<string, "human_verified" | "machine_validated" | "excluded">,
): SutraFlowEdge[] {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  return graph.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target)).map((edge, index) => {
    const isHighRisk = edge.risk_flag === "high";
    const isMediumRisk = edge.risk_flag === "medium";
    const highlighted = highlightedEdgeIds.has(edgeIdentity(edge));
    const machineValidated = verificationTiers[edgeIdentity(edge)] === "machine_validated";
    return {
      id: `${edge.source}-${edge.target}-${index}`,
      source: edge.source,
      target: edge.target,
      label: edge.relation,
      data: { evidence: edge },
      type: "smoothstep",
      animated: isHighRisk || highlighted,
      markerEnd: { type: MarkerType.ArrowClosed, color: highlighted ? "#67e8f9" : isHighRisk ? "#fb7185" : isMediumRisk ? "#fbbf24" : "#64748b" },
      style: {
        stroke: highlighted ? "#67e8f9" : isHighRisk ? "#fb7185" : isMediumRisk ? "#fbbf24" : "#64748b",
        strokeWidth: highlighted ? 4.5 : isHighRisk ? 3.5 : 1.7,
        strokeDasharray: machineValidated ? "7 5" : undefined,
      },
      labelStyle: { fill: isHighRisk ? "#fecdd3" : "#cbd5e1", fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: "#0f172a", fillOpacity: 0.96 },
      labelBgPadding: [7, 4],
      labelBgBorderRadius: 5,
    };
  });
}

type RelationshipGraphProps = {
  graph: GraphData;
  onSelectEdge: (edge: GraphEdge) => void;
  onSelectNode: (node: GraphNode) => void;
  panelState: GraphPanelState;
  corpus: CorpusIndex;
  highlightedEdges?: GraphEdge[];
  verificationTiers?: Record<string, "human_verified" | "machine_validated" | "excluded">;
  compact?: boolean;
};

function getSafeInsets(panelState: GraphPanelState, compact: boolean) {
  if (compact) return { left: 22, right: 22, top: 22, bottom: 22 };
  const isNarrow = window.innerWidth < 1024;

  if (isNarrow) {
    return {
      left: panelState.leftPanelOpen ? 16 : 78,
      right: 16,
      top: panelState.leftPanelOpen ? 497 : 128,
      bottom: panelState.evidencePanelOpen || panelState.entityPanelOpen ? 390 : 94,
    };
  }

  // Reserve the full footprint of both panel systems, even when they are collapsed.
  // This guarantees graph nodes never sit beneath an overlay as its state changes.
  return {
    left: panelState.leftPanelOpen ? 405 : 90,
    right: panelState.entityPanelOpen ? 500 : 385,
    top: 128,
    bottom: panelState.evidencePanelOpen || panelState.entityPanelOpen ? 430 : 102,
  };
}

function PanelAwareViewport({ graphKey, panelState, compact = false }: { graphKey: string; panelState: GraphPanelState; compact?: boolean }) {
  const { getNodes, getNodesBounds, setViewport } = useReactFlow<SutraFlowNode, SutraFlowEdge>();

  const fitIntoSafeArea = useCallback(() => {
    const insets = getSafeInsets(panelState, compact);
    const availableWidth = compact
      ? Math.min(760, Math.max(300, window.innerWidth - 48))
      : Math.max(240, window.innerWidth - insets.left - insets.right);
    const availableHeight = compact
      ? Math.min(490, Math.max(260, window.innerHeight - 160))
      : Math.max(220, window.innerHeight - insets.top - insets.bottom);
    const nodes = getNodes();
    if (nodes.length === 0) return;
    const bounds = getNodesBounds(nodes);
    if (bounds.width === 0 || bounds.height === 0) return;

    const viewport = getViewportForBounds(bounds, availableWidth, availableHeight, 0.25, 1.25, 0.14);
    void setViewport(
      { x: viewport.x + insets.left, y: viewport.y + insets.top, zoom: viewport.zoom },
      { duration: 420 },
    );
  }, [getNodes, panelState, setViewport]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      // React Flow measures custom nodes during its own render frame.
      // A short defer makes their dimensions available to getNodesBounds.
      window.setTimeout(fitIntoSafeArea, 40);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [fitIntoSafeArea, graphKey]);

  useEffect(() => {
    let resizeFrame = 0;
    const handleResize = () => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(fitIntoSafeArea);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.cancelAnimationFrame(resizeFrame);
    };
  }, [fitIntoSafeArea]);

  return null;
}

export function RelationshipGraph({ graph, onSelectEdge, onSelectNode, panelState, corpus, highlightedEdges = [], verificationTiers = {}, compact = false }: RelationshipGraphProps) {
  const highlightedEdgeIds = useMemo(() => new Set(highlightedEdges.map(edgeIdentity)), [highlightedEdges]);
  const highlightedNodeIds = useMemo(() => new Set(highlightedEdges.flatMap((edge) => [edge.source, edge.target])), [highlightedEdges]);
  const nodes = useMemo(() => toFlowNodes(graph, corpus, highlightedNodeIds), [corpus, graph, highlightedNodeIds]);
  const edges = useMemo(() => toFlowEdges(graph, highlightedEdgeIds, verificationTiers), [graph, highlightedEdgeIds, verificationTiers]);
  const sourceNodeById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph.nodes]);

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: SutraFlowEdge) => {
      if (edge.data?.evidence) onSelectEdge(edge.data.evidence);
    },
    [onSelectEdge],
  );
  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: SutraFlowNode) => {
      const sourceNode = sourceNodeById.get(node.id);
      if (sourceNode) onSelectNode(sourceNode);
    },
    [onSelectNode, sourceNodeById],
  );

  return (
    <div className="absolute inset-0">
      <ReactFlow<SutraFlowNode, SutraFlowEdge>
        key={graph.target_company}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onEdgeClick={handleEdgeClick}
        onNodeClick={handleNodeClick}
        minZoom={0.25}
        maxZoom={1.8}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        className="sutra-flow"
      >
        <Background color="#24324a" gap={28} size={1} />
        <PanelAwareViewport graphKey={graph.target_company} panelState={panelState} compact={compact} />
        <Controls showInteractive={false} className="!bottom-5 !left-auto !right-5 !border-white/10 !bg-slate-950/85 !shadow-xl [&>button]:!border-white/10 [&>button]:!bg-slate-950 [&>button]:!fill-slate-300 [&>button:hover]:!bg-slate-800" />
      </ReactFlow>
    </div>
  );
}
