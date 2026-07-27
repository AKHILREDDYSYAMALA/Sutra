import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { claims, companies, documents, entities, entityAliases, users } from "@/db/schema";
import type { LedgerGraph } from "@/lib/domain/graph";

import type { DatabaseClient } from "./client";

const sourceEntities = alias(entities, "review_source_entities");
const targetEntities = alias(entities, "review_target_entities");
const sourceAliases = alias(entityAliases, "review_source_aliases");
const targetAliases = alias(entityAliases, "review_target_aliases");

type ReviewTier = "human_verified" | "machine_validated" | "excluded";
type ReviewState = "pending" | "needs_second_look" | "decided";
type DecisionMethod = "individual" | "bulk";

function toTier(value: string): ReviewTier {
  return value === "excluded" ? "excluded" : value === "machine_validated" ? "machine_validated" : "human_verified";
}

function toReviewState(value: string): ReviewState {
  return value === "needs_second_look" || value === "decided" ? value : "pending";
}

function toDecisionMethod(value: string | null): DecisionMethod | null {
  return value === "bulk" || value === "individual" ? value : null;
}

export type ReviewQueueItem = {
  id: string;
  title: string | null;
  companyName: string | null;
  agency: string | null;
  rating: string | null;
  publishedDate: string | null;
  claimCount: number;
  pendingCount: number;
  excludedCount: number;
  createdAt: Date;
  storagePath: string | null;
};

export type ReviewDocument = {
  document: {
    id: string;
    title: string | null;
    url: string | null;
    storagePath: string | null;
    agency: string | null;
    rating: string | null;
    publishedDate: string | null;
    metadata: unknown;
    status: string;
  };
  ledger: LedgerGraph;
};

export async function listReviewQueue(db: DatabaseClient): Promise<ReviewQueueItem[]> {
  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      companyName: companies.name,
      agency: documents.agency,
      rating: documents.rating,
      publishedDate: documents.publishedDate,
      createdAt: documents.createdAt,
      storagePath: documents.storagePath,
      claimCount: sql<number>`count(${claims.id})::int`,
      pendingCount: sql<number>`count(*) filter (where ${claims.verificationTier} = 'machine_validated')::int`,
      excludedCount: sql<number>`count(*) filter (where ${claims.verificationTier} = 'excluded')::int`,
    })
    .from(documents)
    .leftJoin(companies, eq(companies.id, documents.companyId))
    .leftJoin(claims, eq(claims.documentId, documents.id))
    .where(eq(documents.status, "ready_for_review"))
    .groupBy(documents.id, companies.id)
    .orderBy(desc(documents.createdAt));
  return rows;
}

/** Builds a review graph from every claim, including excluded decisions. */
export async function getReviewDocument(db: DatabaseClient, documentId: string): Promise<ReviewDocument | null> {
  const rows = await db
    .select({
      documentId: documents.id,
      documentTitle: documents.title,
      documentUrl: documents.url,
      documentStoragePath: documents.storagePath,
      documentAgency: documents.agency,
      documentRating: documents.rating,
      documentPublishedDate: documents.publishedDate,
      documentMetadata: documents.metadata,
      documentStatus: documents.status,
      companyId: companies.id,
      companyName: companies.name,
      claimId: claims.id,
      claimDocumentId: claims.documentId,
      claimCompanyId: claims.companyId,
      sourceEntityId: claims.sourceEntityId,
      targetEntityId: claims.targetEntityId,
      relationType: claims.relationType,
      relationLabel: claims.relationLabel,
      exposurePct: claims.exposurePct,
      riskFlag: claims.riskFlag,
      quote: claims.quote,
      page: claims.page,
      observedDate: claims.observedDate,
      extractionConfidence: claims.extractionConfidence,
      verificationTier: claims.verificationTier,
      reviewState: claims.reviewState,
      reviewNote: claims.reviewNote,
      decisionMethod: claims.decisionMethod,
      sourceCanonicalName: sourceEntities.canonicalName,
      sourceNormalizedName: sourceEntities.normalizedName,
      sourceEntityType: sourceEntities.entityType,
      sourceCompanyId: sourceEntities.companyId,
      targetCanonicalName: targetEntities.canonicalName,
      targetNormalizedName: targetEntities.normalizedName,
      targetEntityType: targetEntities.entityType,
      targetCompanyId: targetEntities.companyId,
      sourceAlias: sourceAliases.rawName,
      targetAlias: targetAliases.rawName,
    })
    .from(documents)
    .innerJoin(companies, eq(companies.id, documents.companyId))
    .innerJoin(claims, eq(claims.documentId, documents.id))
    .innerJoin(sourceEntities, eq(sourceEntities.id, claims.sourceEntityId))
    .innerJoin(targetEntities, eq(targetEntities.id, claims.targetEntityId))
    .leftJoin(sourceAliases, and(eq(sourceAliases.entityId, sourceEntities.id), eq(sourceAliases.sourceDocumentId, documents.id)))
    .leftJoin(targetAliases, and(eq(targetAliases.entityId, targetEntities.id), eq(targetAliases.sourceDocumentId, documents.id)))
    .where(and(eq(documents.id, documentId), eq(documents.status, "ready_for_review")))
    .orderBy(
      sql`case ${claims.riskFlag} when 'high' then 0 when 'medium' then 1 when 'low' then 2 else 3 end`,
      desc(claims.exposurePct),
      asc(claims.createdAt),
    );

  const first = rows[0];
  if (!first) return null;
  const entityById = new Map<string, LedgerGraph["entities"][number]>();
  const claimsById = new Map<string, LedgerGraph["claims"][number]>();
  for (const row of rows) {
    entityById.set(row.sourceEntityId, { id: row.sourceEntityId, canonicalName: row.sourceCanonicalName, normalizedName: row.sourceNormalizedName, entityType: row.sourceEntityType, companyId: row.sourceCompanyId });
    entityById.set(row.targetEntityId, { id: row.targetEntityId, canonicalName: row.targetCanonicalName, normalizedName: row.targetNormalizedName, entityType: row.targetEntityType, companyId: row.targetCompanyId });
    claimsById.set(row.claimId, {
      id: row.claimId,
      documentId: row.claimDocumentId,
      companyId: row.claimCompanyId,
      sourceEntityId: row.sourceEntityId,
      targetEntityId: row.targetEntityId,
      sourceLabel: row.sourceAlias ?? row.sourceCanonicalName,
      targetLabel: row.targetAlias ?? row.targetCanonicalName,
      relationType: row.relationType,
      relationLabel: row.relationLabel,
      exposurePct: row.exposurePct,
      riskFlag: row.riskFlag,
      quote: row.quote,
      page: row.page,
      observedDate: row.observedDate,
      extractionConfidence: row.extractionConfidence,
      verificationTier: toTier(row.verificationTier),
      reviewState: toReviewState(row.reviewState),
      reviewNote: row.reviewNote,
      decisionMethod: toDecisionMethod(row.decisionMethod),
    });
  }
  const ledger: LedgerGraph = {
    company: { id: first.companyId, name: first.companyName },
    document: { id: first.documentId, agency: first.documentAgency, rating: first.documentRating, publishedDate: first.documentPublishedDate, metadata: first.documentMetadata },
    claims: [...claimsById.values()],
    entities: [...entityById.values()],
    excludedClaimCount: [...claimsById.values()].filter((claim) => claim.verificationTier === "excluded").length,
  };
  return {
    document: {
      id: first.documentId,
      title: first.documentTitle,
      url: first.documentUrl,
      storagePath: first.documentStoragePath,
      agency: first.documentAgency,
      rating: first.documentRating,
      publishedDate: first.documentPublishedDate,
      metadata: first.documentMetadata,
      status: first.documentStatus,
    },
    ledger,
  };
}

async function reviewerId(db: DatabaseClient) {
  const email = "system-reviewer@sutra.local";
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return existing.id;
  await db.insert(users).values({ email, isAdmin: true }).onConflictDoNothing({ target: users.email });
  const [created] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (!created) throw new Error("Could not create review actor.");
  return created.id;
}

export async function decideClaims(
  db: DatabaseClient,
  input: {
    documentId: string;
    claimIds: string[];
    decision: "approve" | "reject";
    reason?: string;
    decisionMethod: DecisionMethod;
    bulkConfirmation?: string;
  },
) {
  if (input.claimIds.length === 0) throw new Error("Select at least one claim.");
  if (input.decision === "reject" && !input.reason?.trim()) throw new Error("A rejection reason is required.");
  if (input.decisionMethod === "individual" && input.claimIds.length !== 1) {
    throw new Error("Individual review must decide exactly one claim.");
  }
  if (input.decisionMethod === "bulk") {
    if (input.claimIds.length < 2) throw new Error("Bulk review requires at least two claims.");
    const expected = `${input.decision} ${input.claimIds.length} claims`;
    if (input.bulkConfirmation?.trim().toLowerCase() !== expected) {
      throw new Error(`Type '${expected}' to record a bulk decision.`);
    }
  }
  const reviewer = await reviewerId(db);
  return db.transaction(async (tx) => {
    const [document] = await tx.select({ status: documents.status }).from(documents).where(eq(documents.id, input.documentId)).for("update");
    if (!document || document.status !== "ready_for_review") throw new Error("This document is not available for review.");
    const selected = await tx.select({ id: claims.id, verificationTier: claims.verificationTier, reviewState: claims.reviewState }).from(claims).where(and(eq(claims.documentId, input.documentId), inArray(claims.id, input.claimIds))).for("update");
    if (selected.length !== input.claimIds.length || selected.some((claim) => claim.verificationTier !== "machine_validated")) {
      throw new Error("One or more claims have already been reviewed.");
    }
    const [updated] = await tx.update(claims).set({
      verificationTier: input.decision === "approve" ? "human_verified" : "excluded",
      exclusionReason: input.decision === "reject" ? input.reason!.trim() : null,
      reviewedBy: reviewer,
      reviewedAt: sql`now()`,
      reviewState: "decided",
      decisionMethod: input.decisionMethod,
    }).where(and(eq(claims.documentId, input.documentId), inArray(claims.id, input.claimIds), eq(claims.verificationTier, "machine_validated"))).returning({ id: claims.id });
    if (!updated) throw new Error("No claims were updated.");
    return { reviewed: input.claimIds.length };
  });
}

/** Park a machine-valid claim without deciding it. It remains publish-blocking. */
export async function requestSecondLook(
  db: DatabaseClient,
  input: { documentId: string; claimId: string; note: string },
) {
  if (!input.note.trim()) throw new Error("A second-look note is required.");
  return db.transaction(async (tx) => {
    const [document] = await tx.select({ status: documents.status }).from(documents).where(eq(documents.id, input.documentId)).for("update");
    if (!document || document.status !== "ready_for_review") throw new Error("This document is not available for review.");
    const [claim] = await tx.select({ id: claims.id, verificationTier: claims.verificationTier, reviewState: claims.reviewState }).from(claims).where(and(eq(claims.id, input.claimId), eq(claims.documentId, input.documentId))).for("update");
    if (!claim || claim.verificationTier !== "machine_validated" || claim.reviewState !== "pending") {
      throw new Error("Only an undecided claim can be parked for a second look.");
    }
    const [updated] = await tx.update(claims).set({ reviewState: "needs_second_look", reviewNote: input.note.trim() }).where(eq(claims.id, input.claimId)).returning({ id: claims.id });
    if (!updated) throw new Error("Could not park the claim for a second look.");
    return { parked: 1 };
  });
}

export async function publishReviewedDocument(db: DatabaseClient, documentId: string) {
  return db.transaction(async (tx) => {
    const [document] = await tx.select().from(documents).where(eq(documents.id, documentId)).for("update");
    if (!document || document.status !== "ready_for_review") throw new Error("This document cannot be published.");
    const [pending] = await tx.select({ count: sql<number>`count(*)::int` }).from(claims).where(and(eq(claims.documentId, documentId), eq(claims.verificationTier, "machine_validated")));
    if ((pending?.count ?? 0) > 0) throw new Error("Every claim must be approved or rejected before publishing.");
    const [published] = await tx.update(documents).set({ status: "published", lastError: null, nextAttemptAt: null, updatedAt: sql`now()` }).where(eq(documents.id, documentId)).returning();
    if (!published) throw new Error("Document publish failed.");
    return published;
  });
}
