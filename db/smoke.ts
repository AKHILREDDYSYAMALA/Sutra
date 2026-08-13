import assert from "node:assert/strict";

import { eq, sql } from "drizzle-orm";

import {
  claims,
  companies,
  documents,
  entities,
  entityMerges,
  entityMergeRejections,
  eventEntities,
  events,
  users,
  watcherState,
  watchlists,
} from "./schema";
import { requiredDirectUrl } from "./env";
import { BseBlockedError } from "../lib/acquisition/bse/client";
import { createDatabaseClient, type DatabaseClient } from "../lib/db/client";
import { ingestDocument } from "../lib/ingestion/ingest";
import { quoteHashFor } from "../lib/ingestion/claim-reconciliation";
import type { DownloadStrategy } from "../lib/ingestion/download-strategies";
import { reprocessDocument } from "../lib/ingestion/reprocess";

class SmokeRollback extends Error {}

async function expectConstraint(
  label: string,
  action: () => Promise<unknown>,
): Promise<void> {
  let error: unknown;

  try {
    await action();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, `${label} should have been rejected by the database`);
}

async function smoke() {
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  let rolledBack = false;

  try {
    await db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({ email: "ledger-smoke@example.test" })
        .returning();
      assert.ok(user);

      const [company] = await tx
        .insert(companies)
        .values({
          name: "Ledger Smoke Industries Limited",
          slug: "ledger-smoke-industries",
          nseSymbol: "SMOKE",
          sector: "Industrials",
        })
        .returning();
      assert.ok(company);

      const [sourceEntity] = await tx
        .insert(entities)
        .values({
          canonicalName: company.name,
          normalizedName: "ledger smoke industries",
          entityType: "company",
          isListed: true,
          companyId: company.id,
        })
        .returning();
      assert.ok(sourceEntity);

      const [targetEntity] = await tx
        .insert(entities)
        .values({
          canonicalName: "Smoke Test Customer Private Limited",
          normalizedName: "smoke test customer",
          entityType: "company",
        })
        .returning();
      assert.ok(targetEntity);

      const [multiHopEntity, multiHopCanonical, cycleEntity, cyclePeer] = await Promise.all([
        tx.insert(entities).values({ canonicalName: "Smoke Merge Hop B", normalizedName: "smoke merge hop b", entityType: "company" }).returning().then(([entity]) => entity),
        tx.insert(entities).values({ canonicalName: "Smoke Merge Hop C", normalizedName: "smoke merge hop c", entityType: "company" }).returning().then(([entity]) => entity),
        tx.insert(entities).values({ canonicalName: "Smoke Merge Cycle A", normalizedName: "smoke merge cycle a", entityType: "company" }).returning().then(([entity]) => entity),
        tx.insert(entities).values({ canonicalName: "Smoke Merge Cycle B", normalizedName: "smoke merge cycle b", entityType: "company" }).returning().then(([entity]) => entity),
      ]);
      assert.ok(multiHopEntity && multiHopCanonical && cycleEntity && cyclePeer);

      const [document] = await tx
        .insert(documents)
        .values({
          companyId: company.id,
          source: "manual",
          docType: "rating_rationale",
          title: "Ledger smoke document",
          url: "https://example.test/ledger-smoke.pdf",
          sha256: "a".repeat(64),
          publishedDate: "2026-07-26",
        })
        .returning();
      assert.ok(document);

      for (const status of [
        "fetched",
        "classified",
        "extracted",
        "validated",
        "resolved",
        "ready_for_review",
        "published",
      ] as const) {
        const [advanced] = await tx
          .update(documents)
          .set({ status })
          .where(eq(documents.id, document.id))
          .returning();
        assert.equal(advanced?.status, status);
      }

      const claimValues = {
        documentId: document.id,
        companyId: company.id,
        sourceEntityId: sourceEntity.id,
        targetEntityId: targetEntity.id,
        relationType: "customer",
        relationLabel: "Top customer, 35% of revenue",
        exposurePct: "35.00",
        riskFlag: "high",
        quote: "The top customer contributed 35% of revenue during the year.",
        quoteHash: quoteHashFor("The top customer contributed 35% of revenue during the year."),
        rawRelationshipPhrase: null,
        page: 4,
        observedDate: "2026-07-26",
        verificationTier: "machine_validated",
        extractionConfidence: "high",
        modelVersion: "smoke-model-v1",
        promptVersion: "smoke-prompt-v1",
      } as const;

      const [originalClaim] = await tx
        .insert(claims)
        .values(claimValues)
        .returning();
      assert.ok(originalClaim);

      await expectConstraint("duplicate relationship and quote hash", () =>
        tx.transaction(async (savepoint) => {
          await savepoint.insert(claims).values({ ...claimValues });
        }),
      );

      const [replacementClaim] = await tx
        .insert(claims)
        .values({
          ...claimValues,
          quote: "The top customer contributed 34% of revenue during the year.",
          quoteHash: quoteHashFor("The top customer contributed 34% of revenue during the year."),
          exposurePct: "34.00",
        })
        .returning();
      assert.ok(replacementClaim);

      const [cycleClaim] = await tx
        .insert(claims)
        .values({
          ...claimValues,
          sourceEntityId: cycleEntity.id,
          quote: "The cycle-resolution smoke claim remains safe to read.",
          quoteHash: quoteHashFor("The cycle-resolution smoke claim remains safe to read."),
        })
        .returning();
      assert.ok(cycleClaim);

      await tx.insert(entityMerges).values([
        { fromEntityId: sourceEntity.id, intoEntityId: multiHopEntity.id, performedBy: "human", reason: "smoke multi-hop" },
        { fromEntityId: multiHopEntity.id, intoEntityId: multiHopCanonical.id, performedBy: "human", reason: "smoke multi-hop" },
        { fromEntityId: targetEntity.id, intoEntityId: multiHopCanonical.id, performedBy: "human", reason: "smoke reverted merge", revertedAt: new Date(), revertedReason: "smoke test reversal" },
        { fromEntityId: cycleEntity.id, intoEntityId: cyclePeer.id, performedBy: "human", reason: "smoke cycle" },
        { fromEntityId: cyclePeer.id, intoEntityId: cycleEntity.id, performedBy: "human", reason: "smoke cycle" },
      ]);

      const resolvedRows = await tx.execute<{
        id: string;
        quote_hash: string;
        raw_relationship_phrase: string | null;
        source_entity_resolved: string;
        target_entity_resolved: string;
      }>(sql`
        select id, quote_hash, raw_relationship_phrase, source_entity_resolved, target_entity_resolved
        from claims_resolved
        where id in (${originalClaim.id}, ${cycleClaim.id})
      `);
      const resolvedByClaimId = new Map(resolvedRows.map((row) => [row.id, row]));
      assert.equal(resolvedByClaimId.get(originalClaim.id)?.quote_hash, claimValues.quoteHash, "claims_resolved includes quote_hash");
      assert.equal(resolvedByClaimId.get(originalClaim.id)?.raw_relationship_phrase, null, "claims_resolved includes raw_relationship_phrase");
      assert.equal(resolvedByClaimId.get(originalClaim.id)?.source_entity_resolved, multiHopCanonical.id, "claims_resolved follows a multi-hop merge");
      assert.equal(resolvedByClaimId.get(originalClaim.id)?.target_entity_resolved, targetEntity.id, "claims_resolved ignores a reverted merge");
      assert.equal(resolvedByClaimId.get(cycleClaim.id)?.source_entity_resolved, cycleEntity.id, "claims_resolved terminates a cycle at its origin");

      const [supersededClaim] = await tx
        .update(claims)
        .set({
          lifecycleState: "superseded",
          supersededByClaimId: replacementClaim.id,
        })
        .where(eq(claims.id, originalClaim.id))
        .returning();
      assert.equal(supersededClaim?.supersededByClaimId, replacementClaim.id);
      assert.equal(supersededClaim?.lifecycleState, "superseded");

      // A review decision is deliberately the only post-insert claim mutation.
      const [reviewedClaim] = await tx
        .update(claims)
        .set({
          verificationTier: "human_verified",
          reviewedBy: user.id,
          reviewedAt: sql`now()`,
          reviewState: "decided",
          decisionMethod: "individual",
        })
        .where(eq(claims.id, replacementClaim.id))
        .returning();
      assert.equal(reviewedClaim?.verificationTier, "human_verified");
      assert.equal(reviewedClaim?.decisionMethod, "individual");

      const [parkedClaim] = await tx
        .update(claims)
        .set({ reviewState: "needs_second_look", reviewNote: "Verify this relationship against the source PDF." })
        .where(eq(claims.id, cycleClaim.id))
        .returning();
      assert.equal(parkedClaim?.reviewState, "needs_second_look");

      await expectConstraint("second-look claim without a note", () =>
        tx.transaction(async (savepoint) => {
          await savepoint
            .update(claims)
            .set({ reviewState: "needs_second_look", reviewNote: null })
            .where(eq(claims.id, originalClaim.id));
        }),
      );

      await expectConstraint("review decision changed after finalization", () =>
        tx.transaction(async (savepoint) => {
          await savepoint
            .update(claims)
            .set({ verificationTier: "excluded", exclusionReason: "other" })
            .where(eq(claims.id, replacementClaim.id));
        }),
      );

      const [event] = await tx
        .insert(events)
        .values({
          headline: "Smoke event is separate from the claims ledger",
          url: "https://example.test/smoke-news",
          source: "smoke-test",
          publishedAt: new Date("2026-07-26T00:00:00Z"),
        })
        .returning();
      assert.ok(event);

      await tx.insert(eventEntities).values({
        eventId: event.id,
        entityId: targetEntity.id,
        linkConfidence: "0.95",
      });

      const [rejection] = await tx
        .insert(entityMergeRejections)
        .values({
          entityAId: [sourceEntity.id, targetEntity.id].sort()[0]!,
          entityBId: [sourceEntity.id, targetEntity.id].sort()[1]!,
          rejectedBy: "ledger-smoke",
          reason: "These are distinct smoke entities.",
        })
        .returning();
      assert.ok(rejection);

      await expectConstraint("entity rejection with non-normalized ordering", () =>
        tx.transaction(async (savepoint) => {
          await savepoint.insert(entityMergeRejections).values({
            entityAId: [sourceEntity.id, targetEntity.id].sort()[1]!,
            entityBId: [sourceEntity.id, targetEntity.id].sort()[0]!,
            rejectedBy: "ledger-smoke",
            reason: "Ordering must be normalized.",
          });
        }),
      );

      await expectConstraint("invalid verification tier", () =>
        tx.transaction(async (savepoint) => {
          await savepoint.insert(claims).values({
            ...claimValues,
            quote: "This tier is intentionally invalid.",
            quoteHash: quoteHashFor("This tier is intentionally invalid."),
            verificationTier: "untrusted",
          });
        }),
      );

      await expectConstraint("excluded claim without an exclusion reason", () =>
        tx.transaction(async (savepoint) => {
          await savepoint.insert(claims).values({
            ...claimValues,
            quote: "This exclusion reason is intentionally missing.",
            quoteHash: quoteHashFor("This exclusion reason is intentionally missing."),
            verificationTier: "excluded",
            exclusionReason: null,
          });
        }),
      );

      await expectConstraint("excluded claim without a human review", () =>
        tx.transaction(async (savepoint) => {
          await savepoint.insert(claims).values({
            ...claimValues,
            quote: "This exclusion lacks reviewer provenance.",
            quoteHash: quoteHashFor("This exclusion lacks reviewer provenance."),
            verificationTier: "excluded",
            exclusionReason: "human rejection required",
            reviewState: "decided",
          });
        }),
      );

      await expectConstraint("exposure percentage above 100", () =>
        tx.transaction(async (savepoint) => {
          await savepoint.insert(claims).values({
            ...claimValues,
            quote: "This exposure is intentionally invalid.",
            quoteHash: quoteHashFor("This exposure is intentionally invalid."),
            exposurePct: "100.01",
          });
        }),
      );

      await expectConstraint("watchlist with both target ids", () =>
        tx.transaction(async (savepoint) => {
          await savepoint.insert(watchlists).values({
            userId: user.id,
            watchType: "company",
            companyId: company.id,
            entityId: targetEntity.id,
          });
        }),
      );

      await expectConstraint("duplicate document sha256", () =>
        tx.transaction(async (savepoint) => {
          await savepoint.insert(documents).values({
            companyId: company.id,
            source: "manual",
            url: "https://example.test/duplicate.pdf",
            sha256: document.sha256,
          });
        }),
      );

      await expectConstraint("invalid transition from published document", () =>
        tx.transaction(async (savepoint) => {
          await savepoint
            .update(documents)
            .set({ status: "fetched" })
            .where(eq(documents.id, document.id));
        }),
      );

      const [retryableDocument] = await tx
        .insert(documents)
        .values({
          companyId: company.id,
          source: "manual",
          url: "https://example.test/retryable.pdf",
          sha256: "b".repeat(64),
        })
        .returning();
      assert.ok(retryableDocument);
      const [failedDocument] = await tx
        .update(documents)
        .set({ status: "failed", lastError: "temporary storage failure" })
        .where(eq(documents.id, retryableDocument.id))
        .returning();
      assert.equal(failedDocument?.status, "failed");
      const [resumedDocument] = await tx
        .update(documents)
        .set({ status: "discovered", lastError: null })
        .where(eq(documents.id, retryableDocument.id))
        .returning();
      assert.equal(resumedDocument?.status, "discovered", "a failed document can resume from discovery");

      const [excludedDocument] = await tx
        .insert(documents)
        .values({
          companyId: company.id,
          source: "manual",
          url: "https://example.test/reclassifiable.pdf",
          sha256: "c".repeat(64),
          status: "discovered",
        })
        .returning();
      assert.ok(excludedDocument);
      const [excluded] = await tx
        .update(documents)
        .set({ status: "excluded", lastError: "classifier outcome" })
        .where(eq(documents.id, excludedDocument.id))
        .returning();
      assert.equal(excluded?.status, "excluded");
      const [reclassifiedDocument] = await tx
        .update(documents)
        .set({ status: "discovered", lastError: null })
        .where(eq(documents.id, excludedDocument.id))
        .returning();
      assert.equal(reclassifiedDocument?.status, "discovered", "an excluded document can be reclassified from discovery");

      // A BSE attachment block is a source-level cooldown, not a terminal
      // document failure. The worker must leave this audit row discoverable and
      // defer it until the same 24-hour source disable expires.
      const [blockedBseDocument] = await tx
        .insert(documents)
        .values({
          companyId: company.id,
          source: "bse",
          url: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/blocked.pdf",
          sha256: "d".repeat(64),
          status: "discovered",
          attempts: 1,
        })
        .returning();
      assert.ok(blockedBseDocument);
      const bseBlockedDownload: DownloadStrategy = {
        id: "bse",
        fetch: async () => { throw new BseBlockedError(403); },
      };
      await assert.rejects(
        ingestDocument({
          db: tx as unknown as DatabaseClient,
          existingDocumentId: blockedBseDocument.id,
          source: "bse",
          url: blockedBseDocument.url!,
          services: { downloadStrategies: new Map([["bse", bseBlockedDownload]]) },
        }),
        BseBlockedError,
      );
      const [deferredBseDocument] = await tx.select().from(documents).where(eq(documents.id, blockedBseDocument.id));
      assert.equal(deferredBseDocument?.status, "discovered");
      assert.match(deferredBseDocument?.lastError ?? "", /HTTP 403/);
      assert.ok(deferredBseDocument?.nextAttemptAt && deferredBseDocument.nextAttemptAt.getTime() > Date.now() + 23 * 60 * 60 * 1_000);
      const [bseState] = await tx.select().from(watcherState).where(eq(watcherState.source, "bse"));
      assert.ok(bseState?.disabledUntil && bseState.disabledUntil.getTime() > Date.now() + 23 * 60 * 60 * 1_000);
      assert.match(bseState?.lastError ?? "", /HTTP 403/);

      await expectConstraint("claim substance update", () =>
        tx.transaction(async (savepoint) => {
          await savepoint
            .update(claims)
            .set({ quote: "Claims must not be mutable." })
            .where(eq(claims.id, originalClaim.id));
        }),
      );

      await expectConstraint("raw relationship phrase update", () =>
        tx.transaction(async (savepoint) => {
          await savepoint
            .update(claims)
            .set({ rawRelationshipPhrase: "joint venture" })
            .where(eq(claims.id, originalClaim.id));
        }),
      );

      // Fixture regression: an India Ratings rationale may open with an upgrade
      // intimation, but its analytical headings must reach machine-claim review.
      const olectraText = `[[PAGE 1]]
India Ratings and Research (Ind-Ra) has upgraded Olectra Greentech Limited's (OGL) bank loan facilities long-term rating to 'IND A' from 'IND A-'.
Analytical Approach
Detailed Rationale of the Rating Action
List of Key Rating Drivers
Detailed Description of Key Rating Drivers
Liquidity
Rating Sensitivities
About the Company
Key Financial Indicators
Rating History
Bank wise Facilities Details
Olectra's top customer contributed 42% of revenue.
New Named Lender sanctioned the facility.`;
      const olectraResult = await ingestDocument({
        db: tx as unknown as DatabaseClient,
        source: "india_ratings",
        title: "India Ratings Upgrades Olectra Greentech",
        fileBuffer: Buffer.from("%PDF-fixture"),
        services: {
          uploadDocumentPdf: async (sha256) => `${sha256}.pdf`,
          extractPdfText: async () => ({ fullText: olectraText, textForModel: olectraText }),
          extract: async (_buffer, text) => ({
            graph: {
              target_company: "Olectra Greentech Limited",
              rating: "IND A/Stable",
              report_date: "May 22, 2026",
              agency: "India Ratings",
              nodes: [
                { id: "olectra", label: "Olectra Greentech Limited", type: "target", named: true },
                { id: "top-customer", label: "Named Top Customer", type: "customer", named: true },
              ],
              edges: [{ source: "olectra", target: "top-customer", relation: "Top customer, 42% of revenue", exposure_pct: 42, risk_flag: "high", source_quote: "Olectra's top customer contributed 42% of revenue.", source_page: 1, confidence: "high" }],
              key_risks: ["Customer concentration."],
            },
            meta: { excluded: [] },
            modelVersion: "fixture-model",
            promptVersion: "fixture-prompt",
            text: text!,
          }),
        },
      });
      assert.equal(olectraResult.status, "ready_for_review");
      assert.equal(olectraResult.claimCount, 1);
      const [olectraDocument] = await tx.select().from(documents).where(eq(documents.id, olectraResult.documentId));
      assert.equal(olectraDocument?.source, "india_ratings");
      assert.equal(olectraDocument?.status, "ready_for_review");
      const metadata = olectraDocument?.metadata as {
        classification?: { docType?: string; signals?: { rationaleSubstanceHeadings?: string[] } };
        extraction?: { relation_type_counts?: { customer?: number }; near_token_ceiling?: boolean | null };
      };
      assert.equal(metadata.classification?.docType, "rating_rationale");
      assert.ok(metadata.classification?.signals?.rationaleSubstanceHeadings?.includes("Detailed Rationale of the Rating Action"));
      assert.equal(metadata.extraction?.relation_type_counts?.customer, 1);
      assert.equal(metadata.extraction?.near_token_ceiling, null, "fixtures without provider usage retain an explicit unknown telemetry state");
      const olectraClaims = await tx.select().from(claims).where(eq(claims.documentId, olectraResult.documentId));
      assert.equal(olectraClaims.length, 1);
      assert.equal(olectraClaims[0]?.verificationTier, "machine_validated");

      // A validation-improvement reprocess keeps the original claim, skips its
      // exact quote hash, and appends only the newly recovered relationship.
      const reprocessResult = await reprocessDocument({
        db: tx as unknown as DatabaseClient,
        documentId: olectraResult.documentId,
        trigger: "quote validation normalization improved",
        services: {
          downloadDocumentPdf: async () => Buffer.from("%PDF-fixture"),
          extractPdfText: async () => ({ fullText: olectraText, textForModel: olectraText }),
          extract: async (_buffer, text) => ({
            graph: {
              target_company: "Olectra Greentech Limited",
              rating: "IND A/Stable",
              report_date: "May 22, 2026",
              agency: "India Ratings",
              nodes: [
                { id: "olectra", label: "Olectra Greentech Limited", type: "target", named: true },
                { id: "top-customer", label: "Named Top Customer", type: "customer", named: true },
                { id: "new-lender", label: "New Named Lender", type: "lender", named: true },
              ],
              edges: [
                { source: "olectra", target: "top-customer", relation: "Top customer, 42% of revenue", exposure_pct: 42, risk_flag: "high", source_quote: "Olectra's top customer contributed 42% of revenue.", source_page: 1, confidence: "high" },
                { source: "olectra", target: "new-lender", relation: "Named lender", exposure_pct: null, risk_flag: null, source_quote: "New Named Lender sanctioned the facility.", source_page: 1, confidence: "medium" },
              ],
              key_risks: ["Customer concentration."],
            },
            meta: { excluded: [] },
            modelVersion: "fixture-model-v2",
            promptVersion: "fixture-prompt-v2",
            text: text!,
          }),
        },
      });
      assert.equal(reprocessResult.reconciliation.exact_quote_skipped, 1);
      assert.equal(reprocessResult.reconciliation.new_claims, 1);
      const reprocessedClaims = await tx.select().from(claims).where(eq(claims.documentId, olectraResult.documentId));
      assert.equal(reprocessedClaims.length, 2);
      assert.ok(reprocessedClaims.every((claim) => claim.verificationTier === "machine_validated"));
      const [reprocessedDocument] = await tx.select().from(documents).where(eq(documents.id, olectraResult.documentId));
      const reprocessMetadata = reprocessedDocument?.metadata as { reprocess?: Array<{ trigger?: string; new_claim_ids?: string[]; reconciliation?: { new_claims?: number } }> };
      assert.equal(reprocessMetadata.reprocess?.length, 1);
      assert.equal(reprocessMetadata.reprocess?.[0]?.trigger, "quote validation normalization improved");
      assert.equal(reprocessMetadata.reprocess?.[0]?.reconciliation?.new_claims, 1);
      assert.equal(reprocessMetadata.reprocess?.[0]?.new_claim_ids?.length, 1);

      // A changed quote for an already-known relationship is auditable metadata,
      // not a second near-duplicate claim for a reviewer to adjudicate.
      const variantResult = await reprocessDocument({
        db: tx as unknown as DatabaseClient,
        documentId: olectraResult.documentId,
        trigger: "table-text reconstruction changed",
        services: {
          downloadDocumentPdf: async () => Buffer.from("%PDF-fixture"),
          extractPdfText: async () => ({ fullText: olectraText, textForModel: olectraText }),
          extract: async (_buffer, text) => ({
            graph: {
              target_company: "Olectra Greentech Limited",
              rating: "IND A/Stable",
              report_date: "May 22, 2026",
              agency: "India Ratings",
              nodes: [
                { id: "olectra", label: "Olectra Greentech Limited", type: "target", named: true },
                { id: "new-lender", label: "New Named Lender", type: "lender", named: true },
              ],
              edges: [
                { source: "olectra", target: "new-lender", relation: "Named lender", exposure_pct: null, risk_flag: null, source_quote: "New Named Lender provided the facility.", source_page: 1, confidence: "medium" },
              ],
              key_risks: ["Customer concentration."],
            },
            meta: { excluded: [] },
            modelVersion: "fixture-model-v3",
            promptVersion: "fixture-prompt-v3",
            text: text!,
          }),
        },
      });
      assert.equal(variantResult.reconciliation.new_claims, 0);
      assert.equal(variantResult.quoteVariantCount, 1);
      const [variantDocument] = await tx.select().from(documents).where(eq(documents.id, olectraResult.documentId));
      const variantMetadata = variantDocument?.metadata as { reprocess?: Array<{ quote_variants?: Array<{ candidate_quote?: string; existing_claims?: Array<{ verification_tier?: string }> }> }> };
      assert.equal(variantMetadata.reprocess?.length, 2);
      assert.equal(variantMetadata.reprocess?.[1]?.quote_variants?.[0]?.candidate_quote, "New Named Lender provided the facility.");
      assert.equal(variantMetadata.reprocess?.[1]?.quote_variants?.[0]?.existing_claims?.[0]?.verification_tier, "machine_validated");

      // The entire fixture is intentionally discarded after all assertions pass.
      throw new SmokeRollback();
    });
  } catch (error) {
    if (error instanceof SmokeRollback) {
      rolledBack = true;
    } else {
      throw error;
    }
  } finally {
    await client.end({ timeout: 5 });
  }

  assert.equal(rolledBack, true, "smoke test transaction did not roll back");
  console.log("db:smoke passed; transaction rolled back and the database is unchanged.");
}

smoke().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
