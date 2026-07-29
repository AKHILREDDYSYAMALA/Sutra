import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { claims, type NewClaim } from "@/db/schema";
import { normaliseForQuoteMatch } from "@/lib/graph-data";

type Transaction = any;

export type ClaimRelationship = {
  documentId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
};

export type ExistingRelationshipClaim = ClaimRelationship & {
  id: string;
  quote: string;
  quoteHash: string;
  verificationTier: string;
};

export type QuoteVariant = {
  document_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  candidate_quote: string;
  candidate_quote_hash: string;
  existing_claims: Array<{
    claim_id: string;
    quote: string;
    quote_hash: string;
    verification_tier: string;
  }>;
};

export type ReconciliationCounts = {
  relationship_existing: number;
  exact_quote_skipped: number;
  quote_variants: number;
  new_claims: number;
  insert_conflicts: number;
};

export type ReconciliationResult = {
  insertedClaimIds: string[];
  quoteVariants: QuoteVariant[];
  counts: ReconciliationCounts;
};

export function quoteHashFor(quote: string) {
  return createHash("sha256").update(normaliseForQuoteMatch(quote)).digest("hex");
}

export function relationshipKey(relationship: ClaimRelationship) {
  return [
    relationship.documentId,
    relationship.sourceEntityId,
    relationship.targetEntityId,
    relationship.relationType,
  ].join("\u001f");
}

type CandidateClaim = Omit<NewClaim, "quoteHash"> & { quoteHash?: string };

function toExistingRelationshipClaim(claim: Pick<typeof claims.$inferSelect, "id" | "documentId" | "sourceEntityId" | "targetEntityId" | "relationType" | "quote" | "quoteHash" | "verificationTier">): ExistingRelationshipClaim {
  return {
    id: claim.id,
    documentId: claim.documentId,
    sourceEntityId: claim.sourceEntityId,
    targetEntityId: claim.targetEntityId,
    relationType: claim.relationType,
    quote: claim.quote,
    quoteHash: claim.quoteHash,
    verificationTier: claim.verificationTier,
  };
}

function quoteVariant(candidate: CandidateClaim & { quoteHash: string }, existing: ExistingRelationshipClaim[]): QuoteVariant {
  return {
    document_id: candidate.documentId,
    source_entity_id: candidate.sourceEntityId,
    target_entity_id: candidate.targetEntityId,
    relation_type: candidate.relationType,
    candidate_quote: candidate.quote,
    candidate_quote_hash: candidate.quoteHash,
    existing_claims: existing.map((claim) => ({
      claim_id: claim.id,
      quote: claim.quote,
      quote_hash: claim.quoteHash,
      verification_tier: claim.verificationTier,
    })),
  };
}

/**
 * Pure reconciliation policy. It intentionally considers the relationship key
 * before quote equality: a changed quote is evidence for a human, not a licence
 * to create a near-duplicate claim.
 */
export function planClaimReconciliation(
  candidates: CandidateClaim[],
  existingClaims: ExistingRelationshipClaim[],
) {
  const existingByRelationship = new Map<string, ExistingRelationshipClaim[]>();
  existingClaims.forEach((claim) => {
    const key = relationshipKey(claim);
    existingByRelationship.set(key, [...(existingByRelationship.get(key) ?? []), claim]);
  });

  const inserts: Array<CandidateClaim & { quoteHash: string }> = [];
  const quoteVariants: QuoteVariant[] = [];
  const seenCandidateQuotes = new Set<string>();
  const seenCandidateRelationships = new Set<string>();
  let exactQuoteSkipped = 0;
  let relationshipExisting = 0;

  candidates.forEach((candidate) => {
    const withHash = { ...candidate, quoteHash: candidate.quoteHash ?? quoteHashFor(candidate.quote) };
    const relation = relationshipKey(withHash);
    const exact = `${relation}\u001f${withHash.quoteHash}`;
    if (seenCandidateQuotes.has(exact)) {
      exactQuoteSkipped += 1;
      return;
    }
    seenCandidateQuotes.add(exact);

    const existing = existingByRelationship.get(relation);
    if (existing && existing.length > 0) {
      relationshipExisting += 1;
      if (existing.some((claim) => claim.quoteHash === withHash.quoteHash)) {
        exactQuoteSkipped += 1;
      } else {
        quoteVariants.push(quoteVariant(withHash, existing));
      }
      return;
    }

    // A model occasionally emits the same relationship twice in one response.
    // Keep the first deterministic candidate; surface any changed quote instead
    // of allowing a second relationship row in the same reprocess run.
    if (seenCandidateRelationships.has(relation)) {
      quoteVariants.push({
        ...quoteVariant(withHash, []),
        existing_claims: [{
          claim_id: "pending_same_reprocess",
          quote: inserts.find((insert) => relationshipKey(insert) === relation)?.quote ?? "",
          quote_hash: inserts.find((insert) => relationshipKey(insert) === relation)?.quoteHash ?? "",
          verification_tier: "machine_validated",
        }],
      });
      return;
    }
    seenCandidateRelationships.add(relation);
    inserts.push(withHash);
  });

  return {
    inserts,
    quoteVariants,
    counts: {
      relationship_existing: relationshipExisting,
      exact_quote_skipped: exactQuoteSkipped,
      quote_variants: quoteVariants.length,
      new_claims: inserts.length,
      insert_conflicts: 0,
    } satisfies ReconciliationCounts,
  };
}

/**
 * The caller must hold a FOR UPDATE lock on its document row for the duration
 * of this transaction. That serialises different-quote candidates for one
 * relationship; the database unique index covers exact quote-hash races.
 */
export async function reconcileClaimInserts(
  tx: Transaction,
  input: { documentId: string; candidates: CandidateClaim[] },
): Promise<ReconciliationResult> {
  const stored = await tx
    .select({
      id: claims.id,
      documentId: claims.documentId,
      sourceEntityId: claims.sourceEntityId,
      targetEntityId: claims.targetEntityId,
      relationType: claims.relationType,
      quote: claims.quote,
      quoteHash: claims.quoteHash,
      verificationTier: claims.verificationTier,
    })
    .from(claims)
    .where(eq(claims.documentId, input.documentId));
  const plan = planClaimReconciliation(input.candidates, stored.map(toExistingRelationshipClaim));
  if (plan.inserts.length === 0) {
    return { insertedClaimIds: [], quoteVariants: plan.quoteVariants, counts: plan.counts };
  }

  const inserted = await tx
    .insert(claims)
    .values(plan.inserts)
    .onConflictDoNothing({
      target: [claims.documentId, claims.sourceEntityId, claims.targetEntityId, claims.relationType, claims.quoteHash],
    })
    .returning({ id: claims.id });
  const insertConflicts = plan.inserts.length - inserted.length;
  return {
    insertedClaimIds: inserted.map((claim: { id: string }) => claim.id),
    quoteVariants: plan.quoteVariants,
    counts: { ...plan.counts, new_claims: inserted.length, insert_conflicts: insertConflicts },
  };
}
