import {
  and,
  asc,
  desc,
  eq,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";

import {
  claims,
  companies,
  documents,
  documentStatuses,
  type Claim,
  type Document,
  type NewClaim,
} from "../../db/schema";
import type { DatabaseClient } from "./client";

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
