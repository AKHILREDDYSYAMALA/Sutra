import type { GraphData, GraphEdge, GraphNode } from "@/lib/graph-data";

const FUZZY_REPAIR_THRESHOLD = 0.78;

export type GraphEdgeRepair = {
  edgeIndex: number;
  endpoint: "source" | "target";
  from: string;
  to: string;
  score: number;
};

export type DroppedGraphEdge = {
  edgeIndex: number;
  source: string;
  target: string;
};

export type GraphIntegrityResult = {
  graph: GraphData;
  repairedEdges: GraphEdgeRepair[];
  droppedEdges: DroppedGraphEdge[];
  unlinkedNodeIds: string[];
  duplicateNodeIds: string[];
};

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normaliseReference(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    for (let column = 0; column < current.length; column += 1) previous[column] = current[column];
  }

  return previous[right.length];
}

function similarity(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;

  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  const editScore = 1 - levenshteinDistance(left, right) / longer;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const sharedTokens = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tokenScore = sharedTokens / new Set([...leftTokens, ...rightTokens]).size;
  const containmentScore = shorter >= 4 && (left.includes(right) || right.includes(left)) ? 0.8 + 0.2 * (shorter / longer) : 0;

  return Math.max(editScore, tokenScore, containmentScore);
}

function closestNode(reference: string, nodes: GraphNode[]) {
  const normalisedReference = normaliseReference(reference);
  let best: { id: string; score: number } | null = null;

  for (const node of [...nodes].sort((left, right) => compareText(left.id, right.id))) {
    const score = Math.max(similarity(normalisedReference, normaliseReference(node.id)), similarity(normalisedReference, normaliseReference(node.label)));
    if (!best || score > best.score || (score === best.score && compareText(node.id, best.id) < 0)) {
      best = { id: node.id, score };
    }
  }

  return best && best.score >= FUZZY_REPAIR_THRESHOLD ? best : null;
}

function repairEndpoint(
  reference: string,
  endpoint: "source" | "target",
  edgeIndex: number,
  nodeIds: Set<string>,
  nodes: GraphNode[],
  repairedEdges: GraphEdgeRepair[],
) {
  if (nodeIds.has(reference)) return reference;

  const closest = closestNode(reference, nodes);
  if (!closest) return null;

  repairedEdges.push({ edgeIndex, endpoint, from: reference, to: closest.id, score: Number(closest.score.toFixed(3)) });
  return closest.id;
}

/**
 * Ensures every rendered edge terminates at an actual React Flow node. Near matches
 * from model output are repaired deterministically; ambiguous references are dropped
 * rather than letting React Flow silently hide an edge.
 */
export function ensureGraphIntegrity(graph: GraphData): GraphIntegrityResult {
  const seenNodeIds = new Set<string>();
  const duplicateNodeIds: string[] = [];
  const nodes = graph.nodes.filter((node) => {
    if (seenNodeIds.has(node.id)) {
      duplicateNodeIds.push(node.id);
      return false;
    }
    seenNodeIds.add(node.id);
    return true;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const repairedEdges: GraphEdgeRepair[] = [];
  const droppedEdges: DroppedGraphEdge[] = [];
  const edges: GraphEdge[] = [];

  graph.edges.forEach((edge, edgeIndex) => {
    const source = repairEndpoint(edge.source, "source", edgeIndex, nodeIds, nodes, repairedEdges);
    const target = repairEndpoint(edge.target, "target", edgeIndex, nodeIds, nodes, repairedEdges);

    if (!source || !target) {
      droppedEdges.push({ edgeIndex, source: edge.source, target: edge.target });
      return;
    }

    edges.push({ ...edge, source, target });
  });

  const linkedNodeIds = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const unlinkedNodeIds = nodes.filter((node) => node.type !== "target" && !linkedNodeIds.has(node.id)).map((node) => node.id);
  // A disconnected counterparty carries no usable relationship evidence. Keep its
  // identity in diagnostics, but never render it as a floating React Flow node.
  const renderedNodes = nodes.filter((node) => node.type === "target" || linkedNodeIds.has(node.id));

  return {
    graph: { ...graph, nodes: renderedNodes, edges },
    repairedEdges,
    droppedEdges,
    unlinkedNodeIds,
    duplicateNodeIds,
  };
}
