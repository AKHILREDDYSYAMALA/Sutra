import assert from "node:assert/strict";
import test from "node:test";

import { planClaimReconciliation, quoteHashFor } from "./claim-reconciliation";

const relationship = {
  documentId: "document",
  companyId: "company",
  sourceEntityId: "source",
  targetEntityId: "target",
  relationType: "customer",
  relationLabel: "Top customer",
  exposurePct: null,
  riskFlag: null,
  page: 1,
  observedDate: "2026-07-29",
  lifecycleState: "current" as const,
  verificationTier: "machine_validated" as const,
  exclusionReason: null,
  extractionConfidence: "high" as const,
  modelVersion: "test-model",
  promptVersion: "test-prompt",
  reviewState: "pending" as const,
  reviewNote: null,
  decisionMethod: null,
};

function candidate(quote: string) {
  return { ...relationship, quote };
}

test("quote hashes normalise harmless quote presentation changes", () => {
  assert.equal(quoteHashFor("A  quoted – sentence."), quoteHashFor("a quoted-sentence."));
});

test("reconciliation skips exact claims and surfaces quote variants", () => {
  const existingQuote = "Revenue from Example Customer was 40%.";
  const existing = [{
    id: "existing-claim",
    documentId: "document",
    sourceEntityId: "source",
    targetEntityId: "target",
    relationType: "customer",
    quote: existingQuote,
    quoteHash: quoteHashFor(existingQuote),
    verificationTier: "human_verified",
  }];
  const plan = planClaimReconciliation([
    candidate(existingQuote),
    candidate("Example Customer contributed 40% of revenue."),
  ], existing);

  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.counts.exact_quote_skipped, 1);
  assert.equal(plan.counts.quote_variants, 1);
  assert.equal(plan.quoteVariants[0]?.existing_claims[0]?.verification_tier, "human_verified");
});

test("an absent relationship is the only recall-recovery insert", () => {
  const plan = planClaimReconciliation([candidate("New relationship evidence.")], []);
  assert.equal(plan.inserts.length, 1);
  assert.equal(plan.counts.new_claims, 1);
  assert.equal(plan.inserts[0]?.quoteHash, quoteHashFor("New relationship evidence."));
});

test("an excluded claim stays final during reconciliation", () => {
  const rejectedQuote = "A reviewer rejected this relationship.";
  const plan = planClaimReconciliation([candidate(rejectedQuote)], [{
    id: "human-rejection",
    documentId: "document",
    sourceEntityId: "source",
    targetEntityId: "target",
    relationType: "customer",
    quote: rejectedQuote,
    quoteHash: quoteHashFor(rejectedQuote),
    verificationTier: "excluded",
  }]);
  assert.equal(plan.inserts.length, 0);
  assert.equal(plan.counts.exact_quote_skipped, 1);
});
