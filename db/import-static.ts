import { eq, sql } from "drizzle-orm";

import { claims, companies, documents, type Document } from "./schema";
import {
  loadStaticGraphFiles,
  parseReportDate,
  slugify,
  type StaticGraphFile,
} from "./static-graphs";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";
import { relationTypeFor, resolveGraphEntities } from "../lib/ingestion/resolve-entities";
import { quoteHashFor } from "../lib/ingestion/claim-reconciliation";
import { seedKnownEntityMergeRejections } from "./known-entity-rejections";

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

function documentSource(agency: string | null) {
  return agency ? AGENCY_SOURCES[agency.trim().toLowerCase()] ?? "manual" : "manual";
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
        metadata: {
          keyRisks: staticFile.graph.key_risks,
          reportDateRaw: staticFile.graph.report_date,
        },
      })
      .returning();

    if (!createdDocument) throw new Error(`${staticFile.fileName}: document insert did not return a row.`);
    const document = await advanceToPublished(tx, createdDocument.id);

    const entityByNodeId = await resolveGraphEntities(tx, {
      documentId: document.id,
      companyId: company.id,
      nodes: staticFile.graph.nodes,
      resolvedBy: "human",
    });

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
        quoteHash: quoteHashFor(edge.source_quote),
        page: edge.source_page,
        observedDate: publishedDate,
        lifecycleState: "current",
        verificationTier: "human_verified",
        reviewState: "decided",
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
    const protectedPairs = await seedKnownEntityMergeRejections(db);
    if (protectedPairs > 0) console.log(`Seeded ${protectedPairs} known entity-merge rejection(s).`);
  } finally {
    await client.end({ timeout: 5 });
  }

  console.log(`Import complete: ${imported} imported, ${skipped} skipped.`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
