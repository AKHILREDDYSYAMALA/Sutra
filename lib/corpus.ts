import aliases from "@/data/aliases.json";
import corpusIndexData from "@/data/corpus-index.json";
import type { GraphData, GraphEdge, GraphNode } from "@/lib/graph-data";

export type CorpusRelationship = {
  entity_label: string;
  entity_named: boolean;
  entity_type: string;
  counterparty_label: string;
  counterparty_named: boolean;
  counterparty_type: string;
  perspective: string;
  report_company: string;
  report_date: string | null;
  agency: "CRISIL" | "ICRA" | "CARE" | "India Ratings" | null;
  rating: string | null;
  relation: string;
  exposure_pct: number | null;
  risk_flag: "high" | "medium" | "low" | null;
  source_quote: string;
  source_page: number | null;
  confidence: "high" | "medium";
};

export type CorpusEntity = {
  canonical_label: string;
  report_count: number;
  relationships: CorpusRelationship[];
};

type CorpusIndex = {
  entities: Record<string, CorpusEntity>;
};

function baseNormaliseEntityName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:ltd|limited|pvt|private|india|inc|incorporated|llc|corp|corporation)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const aliasMap = new Map(
  Object.entries(aliases).map(([variant, canonical]) => [baseNormaliseEntityName(variant), baseNormaliseEntityName(canonical)]),
);
const corpusIndex = corpusIndexData as CorpusIndex;

export function normaliseEntityName(value: string) {
  const base = baseNormaliseEntityName(value);
  return aliasMap.get(base) ?? base;
}

export function getCorpusEntity(label: string) {
  return corpusIndex.entities[normaliseEntityName(label)] ?? null;
}

export function getCorpusReportCount(label: string) {
  return getCorpusEntity(label)?.report_count ?? 0;
}

function perspectiveFor(entity: GraphNode, counterparty: GraphNode, reportCompany: string) {
  if (entity.type === "target") {
    switch (counterparty.type) {
      case "customer":
        return `Supplies to ${counterparty.label}`;
      case "supplier":
        return `Receives supplies from ${counterparty.label}`;
      case "lender":
        return `Financed by ${counterparty.label}`;
      case "subsidiary":
        return `Operates through subsidiary ${counterparty.label}`;
      case "parent":
        return `Part of ${counterparty.label}`;
      case "group_company":
        return `Group relationship with ${counterparty.label}`;
      case "unnamed_dependency":
        return "Has a reported unnamed dependency";
      default:
        return `Relationship with ${counterparty.label}`;
    }
  }

  switch (entity.type) {
    case "customer":
      return `Customer of ${reportCompany}`;
    case "supplier":
      return `Supplies to ${reportCompany}`;
    case "lender":
      return `Lender to ${reportCompany}`;
    case "subsidiary":
      return `Subsidiary of ${reportCompany}`;
    case "parent":
      return `Parent of ${reportCompany}`;
    case "group_company":
      return `Group company of ${reportCompany}`;
    case "unnamed_dependency":
      return `Reported unnamed dependency of ${reportCompany}`;
    case "industry":
      return `Industry relationship with ${reportCompany}`;
    default:
      return `Relationship with ${reportCompany}`;
  }
}

function relationshipFor(entity: GraphNode, counterparty: GraphNode, graph: GraphData, edge: GraphEdge): CorpusRelationship {
  return {
    entity_label: entity.label,
    entity_named: entity.named,
    entity_type: entity.type,
    counterparty_label: counterparty.label,
    counterparty_named: counterparty.named,
    counterparty_type: counterparty.type,
    perspective: perspectiveFor(entity, counterparty, graph.target_company),
    report_company: graph.target_company,
    report_date: graph.report_date,
    agency: graph.agency,
    rating: graph.rating,
    relation: edge.relation,
    exposure_pct: edge.exposure_pct,
    risk_flag: edge.risk_flag,
    source_quote: edge.source_quote,
    source_page: edge.source_page,
    confidence: edge.confidence,
  };
}

export function graphReportIdentity(graph: GraphData) {
  return [graph.target_company, graph.report_date ?? "", graph.agency ?? "", graph.rating ?? ""].join("|");
}

/** Relationships attached to the clicked node in the currently rendered graph. */
export function getGraphRelationshipsForEntity(graph: GraphData, entityId: string) {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const entity = nodesById.get(entityId);
  if (!entity) return [];

  return graph.edges.flatMap((edge) => {
    if (edge.source === entityId) {
      const counterparty = nodesById.get(edge.target);
      return counterparty ? [relationshipFor(entity, counterparty, graph, edge)] : [];
    }
    if (edge.target === entityId) {
      const counterparty = nodesById.get(edge.source);
      return counterparty ? [relationshipFor(entity, counterparty, graph, edge)] : [];
    }
    return [];
  });
}

/**
 * Keeps successful live uploads searchable until the browser session ends. The active
 * graph is deliberately excluded: it belongs in "In this report", not the corpus.
 */
export function getSessionCorpusRelationships(graphs: GraphData[], entityLabel: string, activeGraph: GraphData) {
  const entityKey = normaliseEntityName(entityLabel);
  const activeIdentity = graphReportIdentity(activeGraph);
  const relationships = graphs
    .filter((graph) => graphReportIdentity(graph) !== activeIdentity)
    .flatMap((graph) =>
      graph.nodes
        .filter((node) => normaliseEntityName(node.label) === entityKey)
        .flatMap((node) => getGraphRelationshipsForEntity(graph, node.id)),
    );

  return relationships.filter(
    (relationship, index) =>
      relationships.findIndex(
        (candidate) =>
          candidate.report_company === relationship.report_company &&
          candidate.report_date === relationship.report_date &&
          candidate.entity_label === relationship.entity_label &&
          candidate.counterparty_label === relationship.counterparty_label &&
          candidate.source_quote === relationship.source_quote,
      ) === index,
  );
}

export function getOtherStaticCorpusRelationships(entityLabel: string, activeGraph: GraphData) {
  const activeIdentity = graphReportIdentity(activeGraph);
  return (getCorpusEntity(entityLabel)?.relationships ?? []).filter(
    (relationship) => [relationship.report_company, relationship.report_date ?? "", relationship.agency ?? "", relationship.rating ?? ""].join("|") !== activeIdentity,
  );
}

function reportedPercentage(relationship: CorpusRelationship) {
  const inRelation = relationship.relation.match(/(?:>|≥)?\s*\d+(?:\.\d+)?%/);
  return inRelation?.[0] ?? `${relationship.exposure_pct}%`;
}

export function formatCorpusExposure(relationship: CorpusRelationship) {
  if (relationship.exposure_pct === null) return null;

  const percentage = reportedPercentage(relationship);
  const company = relationship.report_company.endsWith("s") ? `${relationship.report_company}'` : `${relationship.report_company}’s`;

  if (/\b(revenue|sales)\b/i.test(relationship.relation)) return `${percentage} of ${company} revenue`;
  if (/\bpurchase/i.test(relationship.relation)) return `${percentage} of ${company} purchases`;
  return `${percentage} exposure reported by ${relationship.report_company}`;
}
