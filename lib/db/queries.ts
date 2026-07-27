import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import {
  claims,
  companies,
  documents,
  documentStatuses,
  entities,
  entityAliases,
  entityMerges,
  type Claim,
  type Document,
  type NewClaim,
} from "../../db/schema";
import { resolveEntity, type EntityMerge } from "../domain/entity-resolution";
import type { LedgerGraph } from "../domain/graph";
import type { DatabaseClient } from "./client";

const sourceEntities = alias(entities, "source_entities");
const targetEntities = alias(entities, "target_entities");
const sourceAliases = alias(entityAliases, "source_aliases");
const targetAliases = alias(entityAliases, "target_aliases");
const latestDocuments = alias(documents, "latest_documents");

const verifiedTiers = ["human_verified", "machine_validated"] as const;

/** Keeps the UI to one current published report per company as the corpus grows. */
function isLatestPublishedDocument() {
  return sql`${documents.id} = (
    select ${latestDocuments.id}
    from ${documents} as ${sql.identifier("latest_documents")}
    where ${latestDocuments.companyId} = ${companies.id}
      and ${latestDocuments.status} = 'published'
    order by ${latestDocuments.publishedDate} desc nulls last, ${latestDocuments.createdAt} desc
    limit 1
  )`;
}

function verificationTier(value: string): LedgerGraph["claims"][number]["verificationTier"] {
  return value === "machine_validated" ? "machine_validated" : value === "excluded" ? "excluded" : "human_verified";
}

export type DocumentStatus = (typeof documentStatuses)[number];

const terminalDocumentStatuses = new Set<DocumentStatus>([
  "published",
  "failed",
  "excluded",
  "superseded_document",
]);

const documentStatusTransitions: Record<DocumentStatus, readonly DocumentStatus[]> = {
  discovered: ["fetched", "failed", "excluded", "superseded_document"],
  fetched: ["classified", "failed", "excluded", "superseded_document"],
  classified: ["extracted", "failed", "excluded", "superseded_document"],
  extracted: ["validated", "failed", "excluded", "superseded_document"],
  validated: ["resolved", "failed", "excluded", "superseded_document"],
  resolved: ["ready_for_review", "failed", "excluded", "superseded_document"],
  ready_for_review: ["published", "failed", "excluded", "superseded_document"],
  published: [],
  failed: [],
  excluded: [],
  superseded_document: [],
};

export function isDocumentStatus(value: string): value is DocumentStatus {
  return (documentStatuses as readonly string[]).includes(value);
}

export function canTransitionDocument(
  from: DocumentStatus,
  to: DocumentStatus,
): boolean {
  return from === to || documentStatusTransitions[from].includes(to);
}

export async function findCompanyBySlug(db: DatabaseClient, slug: string) {
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.slug, slug))
    .limit(1);

  return company;
}

export async function listClaimsForCompany(
  db: DatabaseClient,
  companyId: string,
): Promise<Claim[]> {
  return db
    .select()
    .from(claims)
    .where(eq(claims.companyId, companyId))
    .orderBy(desc(claims.observedDate), desc(claims.createdAt));
}

/** Inserts a claim without mutating an existing claim. */
export async function appendClaim(
  db: DatabaseClient,
  values: NewClaim,
): Promise<Claim> {
  const [claim] = await db.insert(claims).values(values).returning();

  if (!claim) {
    throw new Error("Claim insert did not return a row.");
  }

  return claim;
}

/**
 * Appends the replacement first, then marks the prior claim as superseded and
 * links it forward. The database trigger rejects every other substance update.
 */
export async function supersedeClaim(
  db: DatabaseClient,
  previousClaimId: string,
  replacement: Omit<NewClaim, "lifecycleState" | "supersededByClaimId">,
): Promise<{ previous: Claim; replacement: Claim }> {
  return db.transaction(async (tx) => {
    const [previous] = await tx
      .select()
      .from(claims)
      .where(eq(claims.id, previousClaimId))
      .for("update");

    if (!previous) {
      throw new Error(`Claim ${previousClaimId} was not found.`);
    }

    if (previous.supersededByClaimId) {
      throw new Error(`Claim ${previousClaimId} has already been superseded.`);
    }

    const [replacementClaim] = await tx
      .insert(claims)
      .values({ ...replacement, lifecycleState: "current" })
      .returning();

    if (!replacementClaim) {
      throw new Error("Replacement claim insert did not return a row.");
    }

    const [updatedPrevious] = await tx
      .update(claims)
      .set({
        lifecycleState: "superseded",
        supersededByClaimId: replacementClaim.id,
      })
      .where(eq(claims.id, previousClaimId))
      .returning();

    if (!updatedPrevious) {
      throw new Error(`Claim ${previousClaimId} could not be superseded.`);
    }

    return { previous: updatedPrevious, replacement: replacementClaim };
  });
}

/**
 * Claims one due document for one processing stage. This emits
 * `SELECT … FOR UPDATE SKIP LOCKED`, increments attempts atomically, and puts
 * a short lease in `next_attempt_at` so another worker cannot pick it up after
 * this transaction commits. Workers must finish with advanceDocumentStatus or
 * scheduleDocumentRetry.
 */
export async function claimNextDocument(
  db: DatabaseClient,
  status: DocumentStatus,
  options: { leaseSeconds?: number } = {},
): Promise<Document | undefined> {
  if (terminalDocumentStatuses.has(status)) {
    throw new Error(`Cannot claim work for terminal status ${status}.`);
  }

  const leaseSeconds = options.leaseSeconds ?? 10 * 60;

  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error("leaseSeconds must be a positive integer.");
  }

  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.status, status),
          or(
            isNull(documents.nextAttemptAt),
            lte(documents.nextAttemptAt, sql`now()`),
          ),
        ),
      )
      .orderBy(asc(documents.nextAttemptAt), asc(documents.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!candidate) {
      return undefined;
    }

    const [claimed] = await tx
      .update(documents)
      .set({
        attempts: sql`${documents.attempts} + 1`,
        nextAttemptAt: sql`now() + ${leaseSeconds} * interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, candidate.id))
      .returning();

    return claimed;
  });
}

/**
 * Makes a successful status transition. Repeating a transition to the current
 * state is a no-op, which makes workers safe to retry after an interrupted ack.
 */
export async function advanceDocumentStatus(
  db: DatabaseClient,
  documentId: string,
  nextStatus: DocumentStatus,
): Promise<Document> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .for("update");

    if (!current) {
      throw new Error(`Document ${documentId} was not found.`);
    }

    if (!isDocumentStatus(current.status)) {
      throw new Error(`Document ${documentId} has an invalid status ${current.status}.`);
    }

    if (current.status === nextStatus) {
      return current;
    }

    if (!canTransitionDocument(current.status, nextStatus)) {
      throw new Error(
        `Invalid document transition: ${current.status} -> ${nextStatus}.`,
      );
    }

    const [updated] = await tx
      .update(documents)
      .set({
        status: nextStatus,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, documentId))
      .returning();

    if (!updated) {
      throw new Error(`Document ${documentId} could not be updated.`);
    }

    return updated;
  });
}

/**
 * Schedules a retry without changing processing stage. The delay is five
 * minutes doubled per attempt, capped at 24 hours; permanent failures use
 * markDocumentFailed instead.
 */
export async function scheduleDocumentRetry(
  db: DatabaseClient,
  documentId: string,
  error: string,
): Promise<Document> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .for("update");

    if (!current) {
      throw new Error(`Document ${documentId} was not found.`);
    }

    if (!isDocumentStatus(current.status) || terminalDocumentStatuses.has(current.status)) {
      throw new Error(`Cannot retry terminal document ${documentId}.`);
    }

    const delaySeconds = Math.min(
      5 * 60 * 2 ** Math.max(0, current.attempts - 1),
      24 * 60 * 60,
    );

    const [updated] = await tx
      .update(documents)
      .set({
        lastError: error,
        nextAttemptAt: sql`now() + ${delaySeconds} * interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, documentId))
      .returning();

    if (!updated) {
      throw new Error(`Document ${documentId} could not be scheduled for retry.`);
    }

    return updated;
  });
}

export async function markDocumentFailed(
  db: DatabaseClient,
  documentId: string,
  error: string,
): Promise<Document> {
  const failed = await advanceDocumentStatus(db, documentId, "failed");

  const [updated] = await db
    .update(documents)
    .set({ lastError: error, nextAttemptAt: null, updatedAt: sql`now()` })
    .where(eq(documents.id, failed.id))
    .returning();

  if (!updated) {
    throw new Error(`Document ${documentId} could not be marked failed.`);
  }

  return updated;
}

export type VerifiedCompanySummary = {
  id: string;
  slug: string;
  name: string;
  agency: string | null;
  rating: string | null;
  publishedDate: string | null;
  claimCount: number;
  riskSummary: { high: number; medium: number; low: number };
  verificationSummary: { humanVerified: number; machineValidated: number };
};

/** Lists companies that have a published document with retained claims. */
export async function listVerifiedCompanies(db: DatabaseClient): Promise<VerifiedCompanySummary[]> {
  const rows = await db
    .select({
      id: companies.id,
      slug: companies.slug,
      name: companies.name,
      agency: documents.agency,
      rating: documents.rating,
      publishedDate: documents.publishedDate,
      claimCount: sql<number>`count(${claims.id})::int`,
      highRiskCount: sql<number>`count(*) filter (where ${claims.riskFlag} = 'high')::int`,
      mediumRiskCount: sql<number>`count(*) filter (where ${claims.riskFlag} = 'medium')::int`,
      lowRiskCount: sql<number>`count(*) filter (where ${claims.riskFlag} = 'low')::int`,
      humanVerifiedCount: sql<number>`count(*) filter (where ${claims.verificationTier} = 'human_verified')::int`,
      machineValidatedCount: sql<number>`count(*) filter (where ${claims.verificationTier} = 'machine_validated')::int`,
    })
    .from(companies)
    .innerJoin(documents, and(eq(documents.companyId, companies.id), eq(documents.status, "published"), isLatestPublishedDocument()))
    .innerJoin(claims, and(eq(claims.documentId, documents.id), inArray(claims.verificationTier, verifiedTiers)))
    .groupBy(companies.id, documents.id)
    .orderBy(companies.name);

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    agency: row.agency,
    rating: row.rating,
    publishedDate: row.publishedDate,
    claimCount: row.claimCount,
    riskSummary: { high: row.highRiskCount, medium: row.mediumRiskCount, low: row.lowRiskCount },
    verificationSummary: { humanVerified: row.humanVerifiedCount, machineValidated: row.machineValidatedCount },
  }));
}

/**
 * Retrieves one published company graph in a single joined query. Source-document
 * aliases preserve the original fixture labels even after a curated merge changes
 * an entity's canonical display name.
 */
export async function getCompanyGraph(db: DatabaseClient, slug: string): Promise<LedgerGraph | null> {
  const rows = await db
    .select({
      companyId: companies.id,
      companyName: companies.name,
      documentId: documents.id,
      documentAgency: documents.agency,
      documentRating: documents.rating,
      documentPublishedDate: documents.publishedDate,
      documentMetadata: documents.metadata,
      excludedClaimCount: sql<number>`(
        select count(*)::int from ${claims} excluded_claim
        where excluded_claim.document_id = ${documents.id}
          and excluded_claim.verification_tier = 'excluded'
      )`,
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
    .from(companies)
    .innerJoin(documents, and(eq(documents.companyId, companies.id), eq(documents.status, "published"), isLatestPublishedDocument()))
    .innerJoin(claims, and(eq(claims.documentId, documents.id), inArray(claims.verificationTier, verifiedTiers)))
    .innerJoin(sourceEntities, eq(sourceEntities.id, claims.sourceEntityId))
    .innerJoin(targetEntities, eq(targetEntities.id, claims.targetEntityId))
    .leftJoin(sourceAliases, and(eq(sourceAliases.entityId, sourceEntities.id), eq(sourceAliases.sourceDocumentId, documents.id)))
    .leftJoin(targetAliases, and(eq(targetAliases.entityId, targetEntities.id), eq(targetAliases.sourceDocumentId, documents.id)))
    .where(eq(companies.slug, slug))
    .orderBy(desc(documents.publishedDate), asc(claims.createdAt));

  const first = rows[0];
  if (!first) return null;

  const entityById = new Map<string, LedgerGraph["entities"][number]>();
  const claimsById = new Map<string, LedgerGraph["claims"][number]>();
  for (const row of rows) {
    entityById.set(row.sourceEntityId, {
      id: row.sourceEntityId,
      canonicalName: row.sourceCanonicalName,
      normalizedName: row.sourceNormalizedName,
      entityType: row.sourceEntityType,
      companyId: row.sourceCompanyId,
    });
    entityById.set(row.targetEntityId, {
      id: row.targetEntityId,
      canonicalName: row.targetCanonicalName,
      normalizedName: row.targetNormalizedName,
      entityType: row.targetEntityType,
      companyId: row.targetCompanyId,
    });
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
      verificationTier: verificationTier(row.verificationTier),
    });
  }

  return {
    company: { id: first.companyId, name: first.companyName },
    document: {
      id: first.documentId,
      agency: first.documentAgency,
      rating: first.documentRating,
      publishedDate: first.documentPublishedDate,
      metadata: first.documentMetadata,
    },
    claims: [...claimsById.values()],
    entities: [...entityById.values()],
    excludedClaimCount: first.excludedClaimCount,
  };
}

export async function listEntityMerges(db: DatabaseClient): Promise<EntityMerge[]> {
  return db
    .select({ fromEntityId: entityMerges.fromEntityId, intoEntityId: entityMerges.intoEntityId, revertedAt: entityMerges.revertedAt })
    .from(entityMerges);
}

export async function listEntityAliases(db: DatabaseClient) {
  return db
    .select({ normalizedRaw: entityAliases.normalizedRaw, entityId: entityAliases.entityId })
    .from(entityAliases);
}

export type EntityAcrossCorpusClaim = {
  claim: Claim;
  company: { id: string; slug: string; name: string };
  document: { id: string; agency: string | null; rating: string | null; publishedDate: string | null };
  sourceEntity: { id: string; canonicalName: string; normalizedName: string; entityType: string; companyId: string | null };
  targetEntity: { id: string; canonicalName: string; normalizedName: string; entityType: string; companyId: string | null };
};

/** Every retained corpus claim that references an entity or one of its active merge predecessors. */
export async function getEntityAcrossCorpus(db: DatabaseClient, entityId: string): Promise<{ entityId: string; claims: EntityAcrossCorpusClaim[] }> {
  const merges = await listEntityMerges(db);
  const resolvedEntityId = resolveEntity(entityId, merges);

  const rows = await db
    .select({
      claim: claims,
      companyId: companies.id,
      companySlug: companies.slug,
      companyName: companies.name,
      documentId: documents.id,
      documentAgency: documents.agency,
      documentRating: documents.rating,
      documentPublishedDate: documents.publishedDate,
      sourceEntityId: sourceEntities.id,
      sourceCanonicalName: sourceEntities.canonicalName,
      sourceNormalizedName: sourceEntities.normalizedName,
      sourceEntityType: sourceEntities.entityType,
      sourceCompanyId: sourceEntities.companyId,
      targetEntityId: targetEntities.id,
      targetCanonicalName: targetEntities.canonicalName,
      targetNormalizedName: targetEntities.normalizedName,
      targetEntityType: targetEntities.entityType,
      targetCompanyId: targetEntities.companyId,
    })
    .from(claims)
    .innerJoin(companies, eq(companies.id, claims.companyId))
    .innerJoin(documents, eq(documents.id, claims.documentId))
    .innerJoin(sourceEntities, eq(sourceEntities.id, claims.sourceEntityId))
    .innerJoin(targetEntities, eq(targetEntities.id, claims.targetEntityId))
    .where(and(
      inArray(claims.verificationTier, verifiedTiers),
      sql`${claims.id} in (
        select "id"
        from "claims_resolved"
        where "source_entity_resolved" = ${resolvedEntityId}
           or "target_entity_resolved" = ${resolvedEntityId}
      )`,
    ))
    .orderBy(desc(documents.publishedDate), desc(claims.createdAt));

  return {
    entityId: resolvedEntityId,
    claims: rows.map((row) => ({
      claim: row.claim,
      company: { id: row.companyId, slug: row.companySlug, name: row.companyName },
      document: { id: row.documentId, agency: row.documentAgency, rating: row.documentRating, publishedDate: row.documentPublishedDate },
      sourceEntity: { id: row.sourceEntityId, canonicalName: row.sourceCanonicalName, normalizedName: row.sourceNormalizedName, entityType: row.sourceEntityType, companyId: row.sourceCompanyId },
      targetEntity: { id: row.targetEntityId, canonicalName: row.targetCanonicalName, normalizedName: row.targetNormalizedName, entityType: row.targetEntityType, companyId: row.targetCompanyId },
    })),
  };
}
