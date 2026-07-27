import { eq } from "drizzle-orm";

import { entities, entityAliases } from "@/db/schema";
import { normalizeEntityName } from "@/lib/entity-normalization";

type ResolverNode = {
  id: string;
  label: string;
  type: string;
  named?: boolean;
};

type ResolverEdge = {
  source: string;
  target: string;
  relation: string;
  exposure_pct: number | null;
  risk_flag: "high" | "medium" | "low" | null;
  source_quote: string;
  source_page: number | null;
  confidence: "high" | "medium";
};

// Drizzle transaction types vary with the driver's pool configuration. This module
// only relies on the common query-builder surface, so callers retain their exact
// transaction type while resolution stays reusable by CLI and worker code.
type Transaction = any;
type Entity = typeof entities.$inferSelect;

const GOVERNMENT_ENTITY = /^(ministry of defence|government of india|indian (army|navy|air force|airforce)|indian space research organisation|isro|indian railways)$/i;
const FOREIGN_ENTITY = /\b(bloom energy|motorola mobility|ismartu|longcheer|toshiba|samsung|lg|xiaomi|rolls[- ]royce|dassault|israel aerospace|blue origin)\b/i;

function isCoveredCompanyNode(node: ResolverNode) {
  return node.type === "target" || node.type === "company";
}

function entityTypeFor(node: ResolverNode): "company" | "government" | "institution" | "unnamed" {
  if (node.named === false) return "unnamed";
  if (GOVERNMENT_ENTITY.test(node.label)) return "government";
  if (node.type === "lender" && /\b(bank|lic|life insurance corporation)\b/i.test(node.label)) return "institution";
  return "company";
}

function countryFor(node: ResolverNode): string | null {
  return FOREIGN_ENTITY.test(node.label) ? null : "IN";
}

export function relationTypeFor(edge: ResolverEdge, nodes: Map<string, ResolverNode>) {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) throw new Error(`Unknown edge endpoint ${edge.source} -> ${edge.target}.`);
  if (source.named === false || target.named === false || target.type === "industry") return "unnamed_dependency" as const;
  if (target.type === "customer" || target.type === "supplier" || target.type === "lender" || target.type === "subsidiary" || target.type === "parent" || target.type === "group_company") return target.type;
  throw new Error(`Cannot map target node type ${JSON.stringify(target.type)} to a claim relation type.`);
}

/**
 * Resolves named nodes via aliases first and canonical normalized names second.
 * Ghost/unnamed nodes are intentionally document-scoped and never cross-linked.
 */
export async function resolveGraphEntities(
  tx: Transaction,
  input: { documentId: string; companyId: string; nodes: readonly ResolverNode[]; resolvedBy: "deterministic" | "llm" | "human" | "user" },
): Promise<Map<string, string>> {
  const entityByNodeId = new Map<string, string>();

  for (const node of input.nodes) {
    if (node.named === false) {
      const [entity] = await tx.insert(entities).values({
        canonicalName: node.label,
        normalizedName: `unnamed:${input.documentId}:${node.id}`,
        entityType: "unnamed",
        country: "IN",
        isListed: false,
      }).returning();
      if (!entity) throw new Error(`Could not create unnamed entity ${node.id}.`);
      entityByNodeId.set(node.id, entity.id);
      continue;
    }

    const normalizedName = normalizeEntityName(node.label);
    if (!normalizedName) throw new Error(`Node ${node.id} normalized to an empty name.`);

    const matchingAliases = await tx
      .select({ entityId: entityAliases.entityId })
      .from(entityAliases)
      .where(eq(entityAliases.normalizedRaw, normalizedName));
    let entity: Entity | undefined;
    // An alias that points at multiple entities is evidence for review, not a
    // licence to choose an arbitrary counterparty during ingestion.
    if (matchingAliases.length === 1) {
      [entity] = await tx.select().from(entities).where(eq(entities.id, matchingAliases[0]!.entityId)).limit(1);
    }
    if (!entity) [entity] = await tx.select().from(entities).where(eq(entities.normalizedName, normalizedName)).limit(1);

    if (!entity) {
      [entity] = await tx.insert(entities).values({
        canonicalName: node.label,
        normalizedName,
        entityType: entityTypeFor(node),
        country: countryFor(node),
        isListed: isCoveredCompanyNode(node),
        companyId: isCoveredCompanyNode(node) ? input.companyId : null,
      }).returning();
    } else if (isCoveredCompanyNode(node) && (entity.companyId !== input.companyId || !entity.isListed)) {
      [entity] = await tx.update(entities).set({ companyId: input.companyId, isListed: true }).where(eq(entities.id, entity.id)).returning();
    }
    if (!entity) throw new Error(`Could not resolve entity ${node.label}.`);

    entityByNodeId.set(node.id, entity.id);
    await tx.insert(entityAliases).values({
      rawName: node.label,
      normalizedRaw: normalizedName,
      entityId: entity.id,
      confidence: "1.00",
      resolvedBy: input.resolvedBy,
      sourceDocumentId: input.documentId,
    }).onConflictDoNothing({ target: [entityAliases.normalizedRaw, entityAliases.entityId] });
  }

  return entityByNodeId;
}
