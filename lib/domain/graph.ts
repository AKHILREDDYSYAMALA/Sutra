import { ensureGraphIntegrity } from "@/lib/graph-integrity";
import type { GraphData, GraphEdge, GraphNode } from "@/lib/graph-data";

export type LedgerEntity = {
  id: string;
  canonicalName: string;
  normalizedName: string;
  entityType: string;
  companyId: string | null;
};

export type LedgerClaim = {
  id: string;
  documentId: string;
  companyId: string;
  sourceEntityId: string;
  targetEntityId: string;
  sourceLabel: string;
  targetLabel: string;
  relationType: string;
  relationLabel: string;
  exposurePct: string | null;
  riskFlag: string | null;
  quote: string;
  page: number | null;
  observedDate: string;
  extractionConfidence: string | null;
  verificationTier: "human_verified" | "machine_validated" | "excluded";
};

export type LedgerGraphDocument = {
  id: string;
  agency: string | null;
  rating: string | null;
  publishedDate: string | null;
  metadata: unknown;
};

export type LedgerGraphCompany = {
  id: string;
  name: string;
};

export type LedgerGraph = {
  company: LedgerGraphCompany;
  document: LedgerGraphDocument;
  claims: LedgerClaim[];
  entities: LedgerEntity[];
  excludedClaimCount: number;
};

export type GraphWithEvidence = {
  graph: GraphData;
  verificationTiers: Record<string, LedgerClaim["verificationTier"]>;
  excludedClaimCount: number;
};

const relationNodeTypes = new Set<GraphNode["type"]>([
  "customer",
  "supplier",
  "lender",
  "subsidiary",
  "parent",
  "group_company",
]);

function agencyForGraph(value: string | null): GraphData["agency"] {
  return value === "CRISIL" || value === "ICRA" || value === "CARE" || value === "India Ratings"
    ? value
    : null;
}

function keyRisksFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || !("keyRisks" in metadata)) return [];
  const risks = (metadata as { keyRisks?: unknown }).keyRisks;
  return Array.isArray(risks) && risks.every((risk) => typeof risk === "string") ? risks : [];
}

function reportDateFromMetadata(document: LedgerGraphDocument): string | null {
  if (document.metadata && typeof document.metadata === "object") {
    const raw = (document.metadata as { reportDateRaw?: unknown }).reportDateRaw;
    if (typeof raw === "string") return raw;
  }
  return document.publishedDate;
}

export function nodeTypeForLedgerClaim(entity: LedgerEntity, claim: LedgerClaim, endpoint: "source" | "target"): GraphNode["type"] {
  if (entity.companyId === claim.companyId) return "target";

  if (endpoint === "target" && relationNodeTypes.has(claim.relationType as GraphNode["type"])) {
    return claim.relationType as GraphNode["type"];
  }

  if (entity.entityType === "unnamed") {
    // An unnamed endpoint can still be a known category (for example “Top five
    // customers”). Its stored entity type remains `unnamed`; this restores the
    // display category from the immutable claim label rather than rewriting it.
    if (endpoint === "target") {
      if (/\bcustomers?\b/i.test(claim.relationLabel)) return "customer";
      if (/\bsuppliers?\b/i.test(claim.relationLabel)) return "supplier";
      if (/\blenders?\b/i.test(claim.relationLabel)) return "lender";
    }
    return "unnamed_dependency";
  }

  // Day 1's compact relation enum has no `industry`. Day 2 preserved the edge as
  // unnamed_dependency while keeping the named entity, which is enough to restore
  // the original graph type without consulting a JSON fixture.
  if (endpoint === "target" && claim.relationType === "unnamed_dependency") return "industry";

  return "industry";
}

export function edgeIdentity(edge: Pick<GraphEdge, "source" | "target" | "relation" | "source_quote">): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.relation}\u0000${edge.source_quote}`;
}

/** Converts one document's ledger claims into the existing UI graph contract. */
export function buildGraphFromClaims(ledger: LedgerGraph): GraphWithEvidence {
  const entities = new Map(ledger.entities.map((entity) => [entity.id, entity]));
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const verificationTiers: GraphWithEvidence["verificationTiers"] = {};

  for (const claim of ledger.claims) {
    const sourceEntity = entities.get(claim.sourceEntityId);
    const targetEntity = entities.get(claim.targetEntityId);
    if (!sourceEntity || !targetEntity) continue;

    if (!nodes.has(sourceEntity.id)) {
      nodes.set(sourceEntity.id, {
        id: sourceEntity.id,
        label: claim.sourceLabel,
        type: nodeTypeForLedgerClaim(sourceEntity, claim, "source"),
        named: sourceEntity.entityType !== "unnamed",
      });
    }
    if (!nodes.has(targetEntity.id)) {
      nodes.set(targetEntity.id, {
        id: targetEntity.id,
        label: claim.targetLabel,
        type: nodeTypeForLedgerClaim(targetEntity, claim, "target"),
        named: targetEntity.entityType !== "unnamed",
      });
    }

    const edge: GraphEdge = {
      source: claim.sourceEntityId,
      target: claim.targetEntityId,
      relation: claim.relationLabel,
      exposure_pct: claim.exposurePct === null ? null : Number(claim.exposurePct),
      risk_flag: claim.riskFlag === "high" || claim.riskFlag === "medium" || claim.riskFlag === "low" ? claim.riskFlag : null,
      source_quote: claim.quote,
      source_page: claim.page,
      confidence: claim.extractionConfidence === "medium" ? "medium" : "high",
    };
    edges.push(edge);
    verificationTiers[edgeIdentity(edge)] = claim.verificationTier;
  }

  const graph: GraphData = {
    target_company: ledger.company.name,
    agency: agencyForGraph(ledger.document.agency),
    rating: ledger.document.rating,
    report_date: reportDateFromMetadata(ledger.document),
    nodes: [...nodes.values()],
    edges,
    key_risks: keyRisksFromMetadata(ledger.document.metadata),
  };

  return {
    graph: ensureGraphIntegrity(graph).graph,
    verificationTiers,
    excludedClaimCount: ledger.excludedClaimCount,
  };
}

/** The common rendering preparation path for both ledger and live-upload graphs. */
export function prepareGraphForRendering(graph: GraphData): GraphData {
  return ensureGraphIntegrity(graph).graph;
}
