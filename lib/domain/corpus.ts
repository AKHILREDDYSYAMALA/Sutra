import { normalizeEntityName } from "@/lib/entity-normalization";
import type { GraphData, GraphEdge, GraphNode } from "@/lib/graph-data";

import { resolveEntity, type EntityMerge } from "./entity-resolution";
import { nodeTypeForLedgerClaim, type LedgerEntity, type LedgerGraph } from "./graph";

export type CorpusRelationship = {
  entityId?: string;
  counterpartyId?: string;
  /** Corpus-wide inverse-document-frequency score for the entity being viewed. */
  entity_specificity_score?: number;
  /** Corpus-wide inverse-document-frequency score for this relationship's counterparty. */
  counterparty_specificity_score?: number;
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
  verification_tier: "human_verified" | "machine_validated" | "excluded";
};

export type CorpusEntity = {
  id: string;
  canonical_label: string;
  report_count: number;
  /** Smoothed inverse document frequency across every ledger document in the corpus. */
  specificity_score: number;
  relationships: CorpusRelationship[];
};

export type CorpusIndex = {
  entities: Record<string, CorpusEntity>;
  normalizedLookup: Record<string, string>;
  document_count: number;
};

export type EntityAlias = {
  normalizedRaw: string;
  entityId: string;
};

function agencyForCorpus(value: string | null): CorpusRelationship["agency"] {
  return value === "CRISIL" || value === "ICRA" || value === "CARE" || value === "India Ratings" ? value : null;
}

function reportDate(metadata: unknown, publishedDate: string | null) {
  if (metadata && typeof metadata === "object") {
    const raw = (metadata as { reportDateRaw?: unknown }).reportDateRaw;
    if (typeof raw === "string") return raw;
  }
  return publishedDate;
}

function perspectiveFor(entity: GraphNode, counterparty: GraphNode, reportCompany: string) {
  if (entity.type === "target") {
    switch (counterparty.type) {
      case "customer": return `Supplies to ${counterparty.label}`;
      case "supplier": return `Receives supplies from ${counterparty.label}`;
      case "lender": return `Financed by ${counterparty.label}`;
      case "subsidiary": return `Operates through subsidiary ${counterparty.label}`;
      case "parent": return `Part of ${counterparty.label}`;
      case "group_company": return `Group relationship with ${counterparty.label}`;
      case "unnamed_dependency": return "Has a reported unnamed dependency";
      default: return `Relationship with ${counterparty.label}`;
    }
  }
  switch (entity.type) {
    case "customer": return `Customer of ${reportCompany}`;
    case "supplier": return `Supplies to ${reportCompany}`;
    case "lender": return `Lender to ${reportCompany}`;
    case "subsidiary": return `Subsidiary of ${reportCompany}`;
    case "parent": return `Parent of ${reportCompany}`;
    case "group_company": return `Group company of ${reportCompany}`;
    case "unnamed_dependency": return `Reported unnamed dependency of ${reportCompany}`;
    case "industry": return `Industry relationship with ${reportCompany}`;
    default: return `Relationship with ${reportCompany}`;
  }
}

function graphNode(entity: LedgerEntity, claim: LedgerGraph["claims"][number], endpoint: "source" | "target", label: string): GraphNode {
  return {
    id: entity.id,
    label,
    type: nodeTypeForLedgerClaim(entity, claim, endpoint),
    named: entity.entityType !== "unnamed",
  };
}

function relationshipFor(entity: GraphNode, counterparty: GraphNode, ledger: LedgerGraph, claim: LedgerGraph["claims"][number]): CorpusRelationship {
  return {
    entityId: entity.id,
    counterpartyId: counterparty.id,
    entity_label: entity.label,
    entity_named: entity.named,
    entity_type: entity.type,
    counterparty_label: counterparty.label,
    counterparty_named: counterparty.named,
    counterparty_type: counterparty.type,
    perspective: perspectiveFor(entity, counterparty, ledger.company.name),
    report_company: ledger.company.name,
    report_date: reportDate(ledger.document.metadata, ledger.document.publishedDate),
    agency: agencyForCorpus(ledger.document.agency),
    rating: ledger.document.rating,
    relation: claim.relationLabel,
    exposure_pct: claim.exposurePct === null ? null : Number(claim.exposurePct),
    risk_flag: claim.riskFlag === "high" || claim.riskFlag === "medium" || claim.riskFlag === "low" ? claim.riskFlag : null,
    source_quote: claim.quote,
    source_page: claim.page,
    confidence: claim.extractionConfidence === "medium" ? "medium" : "high",
    verification_tier: claim.verificationTier,
  };
}

/**
 * A smoothed inverse-document-frequency score. An entity in every document has a
 * score of 1; entities found in fewer documents score higher. We deliberately do
 * not filter low-scoring entities: this only gives ranking surfaces a useful signal.
 */
export function entitySpecificityScore(documentCount: number, entityDocumentCount: number) {
  if (documentCount <= 0 || entityDocumentCount <= 0) return 0;
  return Math.log((documentCount + 1) / (entityDocumentCount + 1)) + 1;
}

/** Builds a merge-resolved corpus index from plain ledger rows. */
export function buildCorpusIndex(
  ledgers: readonly LedgerGraph[],
  merges: readonly EntityMerge[],
  aliases: readonly EntityAlias[],
): CorpusIndex {
  const allEntities = new Map<string, LedgerEntity>();
  for (const ledger of ledgers) for (const entity of ledger.entities) allEntities.set(entity.id, entity);

  const entities: Record<string, CorpusEntity> = {};
  const reportIds = new Map<string, Set<string>>();
  const normalizedLookup: Record<string, string> = {};
  const documentCount = new Set(ledgers.map((ledger) => ledger.document.id)).size;

  for (const entity of allEntities.values()) {
    const resolvedId = resolveEntity(entity.id, merges);
    normalizedLookup[entity.normalizedName] = resolvedId;
    if (!entities[resolvedId]) {
      const canonical = allEntities.get(resolvedId) ?? entity;
      entities[resolvedId] = {
        id: resolvedId,
        canonical_label: canonical.canonicalName,
        report_count: 0,
        specificity_score: 0,
        relationships: [],
      };
      reportIds.set(resolvedId, new Set());
    }
  }
  for (const alias of aliases) normalizedLookup[alias.normalizedRaw] = resolveEntity(alias.entityId, merges);

  for (const ledger of ledgers) {
    const entitiesById = new Map(ledger.entities.map((entity) => [entity.id, entity]));
    for (const claim of ledger.claims) {
      const sourceEntity = entitiesById.get(claim.sourceEntityId);
      const targetEntity = entitiesById.get(claim.targetEntityId);
      if (!sourceEntity || !targetEntity) continue;
      const source = graphNode(sourceEntity, claim, "source", claim.sourceLabel);
      const target = graphNode(targetEntity, claim, "target", claim.targetLabel);

      for (const [entity, counterparty] of [[source, target], [target, source]] as const) {
        const resolvedId = resolveEntity(entity.id, merges);
        const entry = entities[resolvedId];
        if (!entry) continue;
        const relationship = relationshipFor(entity, counterparty, ledger, claim);
        relationship.entityId = resolvedId;
        relationship.counterpartyId = resolveEntity(counterparty.id, merges);
        entry.relationships.push(relationship);
        reportIds.get(resolvedId)?.add(ledger.document.id);
      }
    }
  }

  for (const [id, entry] of Object.entries(entities)) {
    entry.report_count = reportIds.get(id)?.size ?? 0;
    entry.specificity_score = entitySpecificityScore(documentCount, entry.report_count);
  }

  for (const entry of Object.values(entities)) {
    for (const relationship of entry.relationships) {
      relationship.entity_specificity_score = entry.specificity_score;
      relationship.counterparty_specificity_score = relationship.counterpartyId
        ? entities[relationship.counterpartyId]?.specificity_score ?? 0
        : 0;
    }
    entry.relationships.sort((left, right) => (right.report_date ?? "").localeCompare(left.report_date ?? "") || left.report_company.localeCompare(right.report_company));
  }

  return { entities, normalizedLookup, document_count: documentCount };
}

export function getCorpusEntity(corpus: CorpusIndex, label: string): CorpusEntity | null {
  const id = corpus.normalizedLookup[normalizeEntityName(label)];
  return id ? corpus.entities[id] ?? null : null;
}

export function getCorpusReportCount(corpus: CorpusIndex, label: string): number {
  return getCorpusEntity(corpus, label)?.report_count ?? 0;
}

export function getCorpusEntitySpecificity(corpus: CorpusIndex, label: string): number {
  return getCorpusEntity(corpus, label)?.specificity_score ?? 0;
}

/** Maps graph-node ids to their corpus specificity where the node is known to the corpus. */
export function graphSpecificityByNodeId(corpus: CorpusIndex, graph: Pick<GraphData, "nodes">): Record<string, number> {
  return Object.fromEntries(graph.nodes.map((node) => [node.id, getCorpusEntitySpecificity(corpus, node.label)]));
}

/**
 * Surfaces relationship records with rarer counterparties first. Session-only
 * entities have no corpus signal and remain visible after known counterparties.
 */
export function sortRelationshipsByCounterpartySpecificity(corpus: CorpusIndex, relationships: readonly CorpusRelationship[]) {
  return [...relationships].sort((left, right) => {
    const rightScore = right.counterparty_specificity_score ?? getCorpusEntitySpecificity(corpus, right.counterparty_label);
    const leftScore = left.counterparty_specificity_score ?? getCorpusEntitySpecificity(corpus, left.counterparty_label);
    return rightScore - leftScore
      || (right.report_date ?? "").localeCompare(left.report_date ?? "")
      || left.counterparty_label.localeCompare(right.counterparty_label)
      || left.relation.localeCompare(right.relation);
  });
}

export function graphReportIdentity(graph: Pick<GraphData, "target_company" | "report_date" | "agency" | "rating">) {
  return [graph.target_company, graph.report_date ?? "", graph.agency ?? "", graph.rating ?? ""].join("|");
}

export function getGraphRelationshipsForEntity(graph: GraphData, entityId: string): CorpusRelationship[] {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const entity = nodesById.get(entityId);
  if (!entity) return [];

  return graph.edges.flatMap((edge) => {
    const counterparty = edge.source === entityId ? nodesById.get(edge.target) : edge.target === entityId ? nodesById.get(edge.source) : undefined;
    if (!counterparty) return [];
    return [{
      entityId,
      counterpartyId: counterparty.id,
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
      verification_tier: "machine_validated",
    }];
  });
}

export function getOtherCorpusRelationships(corpus: CorpusIndex, entityLabel: string, activeGraph: GraphData) {
  const activeIdentity = graphReportIdentity(activeGraph);
  return sortRelationshipsByCounterpartySpecificity(corpus, (getCorpusEntity(corpus, entityLabel)?.relationships ?? []).filter(
    (relationship) => graphReportIdentity({ target_company: relationship.report_company, report_date: relationship.report_date, agency: relationship.agency, rating: relationship.rating }) !== activeIdentity,
  ));
}

export function getSessionCorpusRelationships(corpus: CorpusIndex, graphs: GraphData[], entityLabel: string, activeGraph: GraphData) {
  const entity = getCorpusEntity(corpus, entityLabel);
  if (!entity) return [];
  const activeIdentity = graphReportIdentity(activeGraph);
  const matches = graphs.filter((graph) => graphReportIdentity(graph) !== activeIdentity).flatMap((graph) => graph.nodes.filter((node) => normalizeEntityName(node.label) === normalizeEntityName(entityLabel)).flatMap((node) => getGraphRelationshipsForEntity(graph, node.id)));

  return matches.filter((relationship, index) => matches.findIndex((candidate) => candidate.report_company === relationship.report_company && candidate.report_date === relationship.report_date && candidate.entity_label === relationship.entity_label && candidate.counterparty_label === relationship.counterparty_label && candidate.source_quote === relationship.source_quote) === index);
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
