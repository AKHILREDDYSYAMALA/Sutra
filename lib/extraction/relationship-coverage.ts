import type { GraphData } from "@/lib/graph-data";
import { isMalformedDualTargetEdge, relationTypeFor } from "@/lib/ingestion/resolve-entities";

export const GROUP_STRUCTURE_RELATIONSHIP_CAP = 5;

const relationTypes = [
  "customer",
  "supplier",
  "lender",
  "subsidiary",
  "parent",
  "group_company",
  "unnamed_dependency",
] as const;

export type RelationType = typeof relationTypes[number];
export type RelationTypeCounts = Record<RelationType, number>;

export type RelationshipCoverage = {
  /** Edges returned by the model, before the group-structure safety cap. */
  model_returned_relation_counts: RelationTypeCounts;
  /** Edges eligible to become claims after the cap, quote validation, and integrity checks. */
  claim_relation_counts: RelationTypeCounts;
  /** The model's explicit count of all group-list relationships it encountered. */
  group_structure_total_seen: number;
  group_structure_response_edges: number;
  group_structure_capped: number;
  counterparty_coverage_sweep: boolean;
};

function emptyCounts(): RelationTypeCounts {
  return {
    customer: 0,
    supplier: 0,
    lender: 0,
    subsidiary: 0,
    parent: 0,
    group_company: 0,
    unnamed_dependency: 0,
  };
}

function relationTypeForEdge(
  edge: GraphData["edges"][number],
  nodes: Map<string, GraphData["nodes"][number]>,
): RelationType | null {
  if (isMalformedDualTargetEdge(edge, nodes)) return null;
  try {
    return relationTypeFor(edge, nodes);
  } catch {
    // The existing ingestion path records malformed edges separately. Coverage
    // must never turn a diagnostic into an extraction failure.
    return null;
  }
}

export function relationshipTypeCounts(graph: Pick<GraphData, "nodes" | "edges">): RelationTypeCounts {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.reduce((counts, edge) => {
    const relationType = relationTypeForEdge(edge, nodes);
    if (relationType) counts[relationType] += 1;
    return counts;
  }, emptyCounts());
}

function structuralSubstanceScore(edge: GraphData["edges"][number]) {
  const evidence = `${edge.relation} ${edge.source_quote}`.toLowerCase();
  let score = 0;
  if (edge.exposure_pct !== null) score += 100;
  if (edge.risk_flag) score += 60;
  if (edge.confidence === "high") score += 10;
  if (/revenue|turnover|operat|manufactur|supply|customer|support|guarantee|obligation|debt|loan|funding|cash flow|financial/.test(evidence)) score += 30;
  return score;
}

/**
 * The prompt selects substantive group relationships first. This deterministic
 * guard makes that product rule durable if a model ignores the requested cap;
 * customers, suppliers, lenders, and parents are never limited here.
 */
export function capGroupStructureRelationships(
  graph: GraphData,
  cap = GROUP_STRUCTURE_RELATIONSHIP_CAP,
) {
  const rawCounts = relationshipTypeCounts(graph);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const structureEdges = graph.edges
    .map((edge, index) => ({ edge, index, relationType: relationTypeForEdge(edge, nodes) }))
    .filter((candidate) => candidate.relationType === "subsidiary" || candidate.relationType === "group_company");
  const retainedIndexes = new Set(
    structureEdges
      .slice()
      .sort((left, right) => structuralSubstanceScore(right.edge) - structuralSubstanceScore(left.edge) || left.index - right.index)
      .slice(0, cap)
      .map((candidate) => candidate.index),
  );
  const limitedGraph = structureEdges.length <= cap
    ? graph
    : {
      ...graph,
      edges: graph.edges.filter((edge, index) => {
        const relationType = relationTypeForEdge(edge, nodes);
        return (relationType !== "subsidiary" && relationType !== "group_company") || retainedIndexes.has(index);
      }),
    };
  const modelReportedTotal = graph.relationship_summary?.group_structure_total_seen ?? 0;
  const groupStructureTotalSeen = Math.max(modelReportedTotal, structureEdges.length);

  return {
    graph: limitedGraph,
    modelReturnedRelationCounts: rawCounts,
    groupStructureTotalSeen,
    groupStructureResponseEdges: structureEdges.length,
    groupStructureCapped: structureEdges.length - Math.min(structureEdges.length, cap),
  };
}

export function relationshipCoverage(
  limited: ReturnType<typeof capGroupStructureRelationships>,
  claimGraph: Pick<GraphData, "nodes" | "edges">,
  counterpartyCoverageSweep = false,
): RelationshipCoverage {
  return {
    model_returned_relation_counts: limited.modelReturnedRelationCounts,
    claim_relation_counts: relationshipTypeCounts(claimGraph),
    group_structure_total_seen: limited.groupStructureTotalSeen,
    group_structure_response_edges: limited.groupStructureResponseEdges,
    group_structure_capped: limited.groupStructureCapped,
    counterparty_coverage_sweep: counterpartyCoverageSweep,
  };
}

/** A group-list-heavy response with no dependency edges needs a focused second look. */
export function needsCounterpartyCoverageSweep(graph: GraphData) {
  const counts = relationshipTypeCounts(graph);
  const groupRelationships = counts.subsidiary + counts.group_company;
  const dependencies = counts.customer + counts.supplier + counts.lender + counts.parent + counts.unnamed_dependency;
  const totalGroupSeen = graph.relationship_summary?.group_structure_total_seen ?? groupRelationships;
  return totalGroupSeen > GROUP_STRUCTURE_RELATIONSHIP_CAP && groupRelationships > 0 && dependencies === 0;
}
