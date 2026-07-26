import { eq, sql } from "drizzle-orm";

import { claims, companies, documents, entities } from "./schema";
import { loadStaticGraphFiles } from "./static-graphs";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";

type VerificationRow = {
  company: string;
  "json_nodes vs db_entities_referenced": string;
  "json_edges vs db_claims": string;
  quotes_match: boolean;
  pages_match: boolean;
  exposure_match: boolean;
};

type ResolvedClaimEndpoint = {
  document_id: string;
  source_entity_resolved: string;
  target_entity_resolved: string;
};

function sorted(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function same(values: string[], databaseValues: string[]): boolean {
  const left = sorted(values);
  const right = sorted(databaseValues);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exposureValue(value: number | string | null): string | null {
  return value === null ? null : String(Number(value));
}

async function main() {
  const staticFiles = await loadStaticGraphFiles();
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  const rows: VerificationRow[] = [];
  const mismatches: string[] = [];

  try {
    for (const staticFile of staticFiles) {
      const [company] = await db
        .select()
        .from(companies)
        .where(eq(companies.slug, staticFile.slug))
        .limit(1);
      const [document] = await db
        .select()
        .from(documents)
        .where(eq(documents.sha256, staticFile.hash))
        .limit(1);
      const documentClaims = document
        ? await db.select().from(claims).where(eq(claims.documentId, document.id))
        : [];
      const entityIds = new Set(
        documentClaims.flatMap((claim) => [claim.sourceEntityId, claim.targetEntityId]),
      );

      const quotesMatch = same(
        staticFile.graph.edges.map((edge) => edge.source_quote),
        documentClaims.map((claim) => claim.quote),
      );
      const pagesMatch = same(
        staticFile.graph.edges.map((edge) => JSON.stringify([edge.source_quote, edge.source_page])),
        documentClaims.map((claim) => JSON.stringify([claim.quote, claim.page])),
      );
      const exposureMatch = same(
        staticFile.graph.edges.map((edge) => JSON.stringify([edge.source_quote, exposureValue(edge.exposure_pct)])),
        documentClaims.map((claim) => JSON.stringify([claim.quote, exposureValue(claim.exposurePct)])),
      );

      rows.push({
        company: staticFile.graph.target_company,
        "json_nodes vs db_entities_referenced": `${staticFile.graph.nodes.length} vs ${entityIds.size}`,
        "json_edges vs db_claims": `${staticFile.graph.edges.length} vs ${documentClaims.length}`,
        quotes_match: quotesMatch,
        pages_match: pagesMatch,
        exposure_match: exposureMatch,
      });

      const expectedEntityCount = staticFile.graph.nodes.length;
      if (!company || !document || document.companyId !== company.id) {
        mismatches.push(`${staticFile.fileName}: company or document provenance is missing.`);
      }
      if (document?.status !== "published") {
        mismatches.push(`${staticFile.fileName}: document is not published.`);
      }
      if (entityIds.size !== expectedEntityCount || documentClaims.length !== staticFile.graph.edges.length) {
        mismatches.push(`${staticFile.fileName}: referenced entity or claim count differs.`);
      }
      if (!quotesMatch || !pagesMatch || !exposureMatch) {
        mismatches.push(`${staticFile.fileName}: evidence parity differs.`);
      }
      if (documentClaims.some((claim) => claim.verificationTier !== "human_verified")) {
        mismatches.push(`${staticFile.fileName}: contains a non-human-verified claim.`);
      }
    }

    const [allCompanies, allDocuments, allEntities, allClaims, resolvedEndpoints] = await Promise.all([
      db.select().from(companies),
      db.select().from(documents),
      db.select().from(entities),
      db.select().from(claims),
      db.execute<ResolvedClaimEndpoint>(sql`
        select document_id, source_entity_resolved, target_entity_resolved
        from claims_resolved
      `),
    ]);
    const documentsByEntity = new Map<string, Set<string>>();
    for (const endpoint of resolvedEndpoints) {
      for (const entityId of [endpoint.source_entity_resolved, endpoint.target_entity_resolved]) {
        const entityDocuments = documentsByEntity.get(entityId) ?? new Set<string>();
        entityDocuments.add(endpoint.document_id);
        documentsByEntity.set(entityId, entityDocuments);
      }
    }
    const multiDocumentEntities = [...documentsByEntity.values()].filter(
      (entityDocuments) => entityDocuments.size >= 2,
    ).length;

    console.table(rows);
    console.table([
      {
        companies: allCompanies.length,
        documents: allDocuments.length,
        entities_named: allEntities.filter((entity) => entity.entityType !== "unnamed").length,
        entities_unnamed: allEntities.filter((entity) => entity.entityType === "unnamed").length,
        claims: allClaims.length,
        entities_in_2_or_more_documents: multiDocumentEntities,
      },
    ]);

    if (multiDocumentEntities === 0) {
      mismatches.push("No entity appears in two or more documents.");
    }
    if (mismatches.length > 0) {
      throw new Error(`Import parity failed:\n- ${mismatches.join("\n- ")}`);
    }

    console.log("Import parity verified with zero mismatches.");
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
