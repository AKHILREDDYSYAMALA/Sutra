import { eq, sql } from "drizzle-orm";

import {
  claims,
  companies,
  documents,
  entities,
  entityAliases,
  type Document,
} from "./schema";
import {
  loadStaticGraphFiles,
  parseReportDate,
  slugify,
  type StaticEdge,
  type StaticGraphFile,
  type StaticNode,
} from "./static-graphs";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";
import { normalizeEntityName } from "../lib/entity-normalization";

const PUBLISHED_TRANSITIONS = [
  "fetched",
  "classified",
  "extracted",
  "validated",
  "resolved",
  "ready_for_review",
  "published",
] as const;

const AGENCY_SOURCES: Record<string, "icra" | "care" | "crisil" | "india_ratings"> = {
  icra: "icra",
  care: "care",
  crisil: "crisil",
  "india ratings": "india_ratings",
};

const GOVERNMENT_ENTITY = /^(ministry of defence|government of india|indian (army|navy|air force|airforce)|indian space research organisation|isro|indian railways)$/i;
const FOREIGN_ENTITY = /\b(bloom energy|motorola mobility|ismartu|longcheer|toshiba|samsung|lg|xiaomi|rolls[- ]royce|dassault|israel aerospace|blue origin)\b/i;

function documentSource(agency: string | null) {
  return agency ? AGENCY_SOURCES[agency.trim().toLowerCase()] ?? "manual" : "manual";
}

function isCoveredCompanyNode(node: StaticNode): boolean {
  return node.type === "target" || node.type === "company";
}

function entityTypeFor(node: StaticNode): "company" | "government" | "institution" | "unnamed" {
  if (node.named === false) return "unnamed";
  if (GOVERNMENT_ENTITY.test(node.label)) return "government";
  if (
    node.type === "lender" &&
    /\b(bank|lic|life insurance corporation)\b/i.test(node.label)
  ) {
    return "institution";
  }
  return "company";
}

function countryFor(node: StaticNode): string | null {
  return FOREIGN_ENTITY.test(node.label) ? null : "IN";
}

function relationTypeFor(edge: StaticEdge, nodes: Map<string, StaticNode>) {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) throw new Error(`Unknown edge endpoint ${edge.source} -> ${edge.target}.`);

  if (source.named === false || target.named === false || target.type === "industry") {
    // The Day 1 ledger has no industry relation type. Treat sector-wide and
    // ghost-node dependencies as the intentionally broad dependency category.
    return "unnamed_dependency" as const;
  }

  if (
    target.type === "customer" ||
    target.type === "supplier" ||
    target.type === "lender" ||
    target.type === "subsidiary" ||
    target.type === "parent" ||
    target.type === "group_company"
  ) {
    return target.type;
  }

  throw new Error(`Cannot map target node type ${JSON.stringify(target.type)} to a claim relation type.`);
}

async function advanceToPublished(
  tx: Parameters<ReturnType<typeof createDatabaseClient>["db"]["transaction"]>[0] extends (tx: infer T) => Promise<unknown> ? T : never,
  documentId: string,
): Promise<Document> {
  let published: Document | undefined;

  for (const status of PUBLISHED_TRANSITIONS) {
    const [updated] = await tx
      .update(documents)
      .set({ status, lastError: null, nextAttemptAt: null, updatedAt: sql`now()` })
      .where(eq(documents.id, documentId))
      .returning();
    published = updated;
  }

  if (!published) throw new Error(`Document ${documentId} could not advance to published.`);
  return published;
}

async function importFile(
  db: ReturnType<typeof createDatabaseClient>["db"],
  staticFile: StaticGraphFile,
): Promise<"imported" | "skipped"> {
  return db.transaction(async (tx) => {
    const [existingDocument] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(eq(documents.sha256, staticFile.hash))
      .limit(1);

    if (existingDocument) return "skipped";

    const [company] = await tx
      .insert(companies)
      .values({ name: staticFile.graph.target_company, slug: staticFile.slug })
      .onConflictDoUpdate({
        target: companies.slug,
        set: { name: staticFile.graph.target_company, updatedAt: sql`now()` },
      })
      .returning();

    if (!company) throw new Error(`${staticFile.fileName}: company upsert did not return a row.`);

    const publishedDate = parseReportDate(staticFile.graph.report_date);
    const [createdDocument] = await tx
      .insert(documents)
      .values({
        companyId: company.id,
        source: documentSource(staticFile.graph.agency),
        docType: "rating_rationale",
        title: `Imported from data/companies/${staticFile.fileName}`,
        url: null,
        storagePath: null,
        sha256: staticFile.hash,
        agency: staticFile.graph.agency,
        rating: staticFile.graph.rating,
        publishedDate,
        status: "discovered",
        isPrivate: false,
        uploadedByUserId: null,
      })
      .returning();

    if (!createdDocument) throw new Error(`${staticFile.fileName}: document insert did not return a row.`);
    const document = await advanceToPublished(tx, createdDocument.id);

    const entityByNodeId = new Map<string, string>();
    for (const node of staticFile.graph.nodes) {
      if (node.named === false) {
        const [entity] = await tx
          .insert(entities)
          .values({
            canonicalName: node.label,
            normalizedName: `unnamed:${document.id}:${slugify(node.label)}`,
            entityType: "unnamed",
            country: "IN",
            isListed: false,
          })
          .returning();

        if (!entity) throw new Error(`${staticFile.fileName}: unnamed entity insert did not return a row.`);
        entityByNodeId.set(node.id, entity.id);
        continue;
      }

      const normalizedName = normalizeEntityName(node.label);
      if (!normalizedName) throw new Error(`${staticFile.fileName}: node ${node.id} normalized to an empty name.`);

      let [entity] = await tx
        .select()
        .from(entities)
        .where(eq(entities.normalizedName, normalizedName))
        .limit(1);

      if (!entity) {
        [entity] = await tx
          .insert(entities)
          .values({
            canonicalName: node.label,
            normalizedName,
            entityType: entityTypeFor(node),
            country: countryFor(node),
            isListed: isCoveredCompanyNode(node),
            companyId: isCoveredCompanyNode(node) ? company.id : null,
          })
          .returning();
      } else if (isCoveredCompanyNode(node) && (entity.companyId !== company.id || !entity.isListed)) {
        [entity] = await tx
          .update(entities)
          .set({ companyId: company.id, isListed: true })
          .where(eq(entities.id, entity.id))
          .returning();
      }

      if (!entity) throw new Error(`${staticFile.fileName}: entity resolution did not return a row.`);
      entityByNodeId.set(node.id, entity.id);

      await tx
        .insert(entityAliases)
        .values({
          rawName: node.label,
          normalizedRaw: normalizedName,
          entityId: entity.id,
          confidence: "1.00",
          resolvedBy: "human",
          sourceDocumentId: document.id,
        })
        .onConflictDoNothing({ target: [entityAliases.normalizedRaw, entityAliases.entityId] });
    }

    const nodes = new Map(staticFile.graph.nodes.map((node) => [node.id, node]));
    for (const edge of staticFile.graph.edges) {
      const sourceEntityId = entityByNodeId.get(edge.source);
      const targetEntityId = entityByNodeId.get(edge.target);
      if (!sourceEntityId || !targetEntityId) {
        throw new Error(`${staticFile.fileName}: edge ${edge.source} -> ${edge.target} was not resolved.`);
      }
      if (edge.source_quote.trim() === "") {
        throw new Error(`${staticFile.fileName}: edge ${edge.source} -> ${edge.target} has an empty source_quote.`);
      }

      await tx.insert(claims).values({
        documentId: document.id,
        companyId: company.id,
        sourceEntityId,
        targetEntityId,
        relationType: relationTypeFor(edge, nodes),
        relationLabel: edge.relation,
        exposurePct: edge.exposure_pct === null ? null : String(edge.exposure_pct),
        riskFlag: edge.risk_flag,
        quote: edge.source_quote,
        page: edge.source_page,
        observedDate: publishedDate,
        lifecycleState: "current",
        verificationTier: "human_verified",
        extractionConfidence: edge.confidence,
        modelVersion: "gpt-4o",
        promptVersion: "rating_rationale_v1",
      });
    }

    return "imported";
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--force")) {
    throw new Error("--force is not supported for claims. Re-import requires npm run db:reset.");
  }
  if (args.length > 0) throw new Error(`Unsupported argument(s): ${args.join(" ")}`);

  const staticFiles = await loadStaticGraphFiles();
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  let imported = 0;
  let skipped = 0;

  try {
    for (const staticFile of staticFiles) {
      const result = await importFile(db, staticFile);
      if (result === "skipped") {
        skipped += 1;
        console.log(`${staticFile.fileName}: already imported`);
      } else {
        imported += 1;
        console.log(`${staticFile.fileName}: imported`);
      }
    }
  } finally {
    await client.end({ timeout: 5 });
  }

  console.log(`Import complete: ${imported} imported, ${skipped} skipped.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
