import type { AnalysisMeta, GraphData, GraphEdge, GraphNode } from "@/lib/graph-data";

import { buildGraphFromClaims, type LedgerGraph } from "./graph";

export type DependencyReadLine = {
  id: "customer_concentration" | "single_points_of_failure" | "watch_items" | "evidence_coverage";
  label: string;
  text: string;
  tone: "high" | "medium" | "low";
  edges: GraphEdge[];
  nodeIds: string[];
};

export type DependencyRead = {
  headline: string;
  tone: "high" | "medium" | "low";
  customer_concentration: number;
  single_points_of_failure: Array<{ node: GraphNode; edge: GraphEdge }>;
  watch_items: Array<{ text: string; edge?: GraphEdge; nodeId?: string }>;
  evidence_coverage: { retained: number; excluded: number | null };
  lines: DependencyReadLine[];
};

export type DependencyReadOptions = {
  excludedCount?: number | null;
};

function formatPercentage(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function getTargetCounterparty(edge: GraphEdge, targetId: string | undefined, nodeById: Map<string, GraphNode>) {
  if (!targetId) return undefined;
  if (edge.source === targetId) return nodeById.get(edge.target);
  if (edge.target === targetId) return nodeById.get(edge.source);
  return undefined;
}

function uniqueEdges(edges: GraphEdge[]) {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const identity = `${edge.source}\u0000${edge.target}\u0000${edge.relation}\u0000${edge.source_quote}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function summariseNames(items: string[], maximum = 2) {
  if (items.length <= maximum) return items.join(" · ");
  return `${items.slice(0, maximum).join(" · ")} · +${items.length - maximum} more`;
}

/** A conservative analyst read, derived only from graph evidence and key risks. */
export function getDependencyRead(graph: GraphData, options: DependencyReadOptions = {}): DependencyRead {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const targetId = graph.nodes.find((node) => node.type === "target")?.id;
  const customerExposureEdges = graph.edges.filter((edge) => {
    const counterparty = getTargetCounterparty(edge, targetId, nodeById);
    return counterparty?.type === "customer" && typeof edge.exposure_pct === "number";
  });
  const customerConcentration = customerExposureEdges.reduce((total, edge) => total + (edge.exposure_pct ?? 0), 0);
  const distinctCustomers = new Set(customerExposureEdges.map((edge) => getTargetCounterparty(edge, targetId, nodeById)?.id).filter((id): id is string => Boolean(id)));

  const singlePointByNodeId = new Map<string, { node: GraphNode; edge: GraphEdge }>();
  graph.edges.forEach((edge) => {
    const counterparty = getTargetCounterparty(edge, targetId, nodeById);
    if (!counterparty || ((edge.exposure_pct ?? 0) < 25 && edge.risk_flag !== "high")) return;
    const current = singlePointByNodeId.get(counterparty.id);
    const currentScore = current ? (current.edge.risk_flag === "high" ? 10_000 : current.edge.exposure_pct ?? 0) : -1;
    const nextScore = edge.risk_flag === "high" ? 10_000 : edge.exposure_pct ?? 0;
    if (!current || nextScore > currentScore) singlePointByNodeId.set(counterparty.id, { node: counterparty, edge });
  });
  const singlePoints = [...singlePointByNodeId.values()].sort((left, right) => left.node.label.localeCompare(right.node.label));

  const watchItems: DependencyRead["watch_items"] = graph.key_risks.map((risk) => ({ text: risk }));
  const ghostNodeIds = new Set(graph.nodes.filter((node) => node.type === "unnamed_dependency" || node.named === false).map((node) => node.id));
  const ghostEdges = graph.edges.filter((edge) => ghostNodeIds.has(edge.source) || ghostNodeIds.has(edge.target));
  const addedGhostNodeIds = new Set<string>();
  ghostEdges.forEach((edge) => {
    const ghostNode = ghostNodeIds.has(edge.source) ? nodeById.get(edge.source) : nodeById.get(edge.target);
    if (!ghostNode || addedGhostNodeIds.has(ghostNode.id)) return;
    addedGhostNodeIds.add(ghostNode.id);
    watchItems.push({ text: ghostNode.label, edge, nodeId: ghostNode.id });
  });

  const evidenceCoverage = { retained: graph.edges.length, excluded: options.excludedCount ?? null };
  const singlePointEdges = uniqueEdges(singlePoints.map((item) => item.edge));
  const watchEdges = uniqueEdges(watchItems.flatMap((item) => (item.edge ? [item.edge] : [])));
  const watchNodeIds = [...new Set(watchItems.flatMap((item) => (item.nodeId ? [item.nodeId] : [])))];
  const customerNodeIds = [...new Set(customerExposureEdges.flatMap((edge) => {
    const counterparty = getTargetCounterparty(edge, targetId, nodeById);
    return counterparty ? [counterparty.id] : [];
  }))];

  const concentrationLine: DependencyReadLine = customerExposureEdges.length > 0
    ? { id: "customer_concentration", label: "Revenue exposure", text: `≥${formatPercentage(customerConcentration)}% explicitly quantified across ${distinctCustomers.size} ${distinctCustomers.size === 1 ? "customer" : "customers"}`, tone: customerExposureEdges.some((edge) => edge.risk_flag === "high") ? "high" : "medium", edges: customerExposureEdges, nodeIds: customerNodeIds }
    : { id: "customer_concentration", label: "Revenue exposure", text: "No explicit customer percentage retained", tone: "low", edges: [], nodeIds: [] };
  const singlePointLine: DependencyReadLine = singlePoints.length > 0
    ? { id: "single_points_of_failure", label: "Single points", text: `${singlePoints.length} ${singlePoints.length === 1 ? "counterparty" : "counterparties"} · ${summariseNames(singlePoints.map(({ node, edge }) => `${node.label}${typeof edge.exposure_pct === "number" ? ` (${formatPercentage(edge.exposure_pct)}%)` : " (high risk)"}`))}`, tone: singlePoints.some(({ edge }) => edge.risk_flag === "high") ? "high" : "medium", edges: singlePointEdges, nodeIds: singlePoints.map(({ node }) => node.id) }
    : { id: "single_points_of_failure", label: "Single points", text: "No retained counterparties meet the 25% / high-risk threshold", tone: "low", edges: [], nodeIds: [] };
  const watchLine: DependencyReadLine = watchItems.length > 0
    ? { id: "watch_items", label: "Watch items", text: summariseNames(watchItems.map((item) => item.text)), tone: watchEdges.some((edge) => edge.risk_flag === "high") ? "high" : "medium", edges: watchEdges, nodeIds: watchNodeIds }
    : { id: "watch_items", label: "Watch items", text: "No unnamed or key-risk dependencies retained", tone: "low", edges: [], nodeIds: [] };
  const evidenceLine: DependencyReadLine = { id: "evidence_coverage", label: "Evidence coverage", text: `${evidenceCoverage.retained} retained relationship${evidenceCoverage.retained === 1 ? "" : "s"}${evidenceCoverage.excluded === null ? "" : ` · ${evidenceCoverage.excluded} excluded`}`, tone: evidenceCoverage.excluded && evidenceCoverage.excluded > 0 ? "medium" : "low", edges: [], nodeIds: [] };

  const headline = customerExposureEdges.length > 0
    ? `≥${formatPercentage(customerConcentration)}% named customer exposure`
    : singlePoints.length > 0
      ? `${singlePoints.length} potential single point${singlePoints.length === 1 ? "" : "s"} of failure`
      : watchItems.length > 0
        ? `${watchItems.length} reported dependency watch item${watchItems.length === 1 ? "" : "s"}`
        : `${evidenceCoverage.retained} evidence-backed relationships retained`;
  const tone = singlePoints.some(({ edge }) => edge.risk_flag === "high") || customerExposureEdges.some((edge) => edge.risk_flag === "high") ? "high" : customerExposureEdges.length > 0 || watchItems.length > 0 ? "medium" : "low";

  return { headline, tone, customer_concentration: customerConcentration, single_points_of_failure: singlePoints, watch_items: watchItems, evidence_coverage: evidenceCoverage, lines: [concentrationLine, singlePointLine, watchLine, evidenceLine] };
}

/** The worker-facing claim-array form; UI callers can use the graph form above. */
export function getDependencyReadFromClaims(ledger: LedgerGraph, options: DependencyReadOptions = {}) {
  const { graph, excludedClaimCount } = buildGraphFromClaims(ledger);
  return getDependencyRead(graph, { excludedCount: options.excludedCount ?? excludedClaimCount });
}

export function optionsFromAnalysisMeta(meta: AnalysisMeta): DependencyReadOptions {
  return { excludedCount: meta.excluded.length };
}
