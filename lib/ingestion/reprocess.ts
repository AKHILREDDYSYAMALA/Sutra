import { eq, sql } from "drizzle-orm";

import { documents } from "@/db/schema";
import { seedKnownEntityMergeRejections } from "@/db/known-entity-rejections";
import { getDb, type DatabaseClient } from "@/lib/db";
import { extract, extractPdfText } from "@/lib/extraction/extract";

import { reconcileClaimInserts, type ReconciliationCounts, type QuoteVariant } from "./claim-reconciliation";
import { mergeRejectedQuoteDiagnostics, type RejectedQuoteDiagnostic } from "./quote-mismatches";
import { isMalformedDualTargetEdge, resolveGraphEntities, relationTypeFor } from "./resolve-entities";
import { downloadDocumentPdf } from "./storage";

type Transaction = any;

export type ReprocessDocumentResult = {
  documentId: string;
  status: "ready_for_review";
  reconciliation: ReconciliationCounts;
  quoteVariantCount: number;
  newClaimIds: string[];
};

function metadataObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function storedRejectedQuotes(value: unknown): RejectedQuoteDiagnostic[] {
  const entries = metadataObject(value).rejected_quotes;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is RejectedQuoteDiagnostic => Boolean(
    entry && typeof entry === "object"
      && typeof (entry as RejectedQuoteDiagnostic).model_quote === "string"
      && typeof (entry as RejectedQuoteDiagnostic).reason_bucket === "string",
  ));
}

function existingReprocesses(value: unknown) {
  const entries = metadataObject(value).reprocess;
  return Array.isArray(entries) ? entries : [];
}

function malformedRelationshipDiagnostics(
  graph: Awaited<ReturnType<typeof extract>>["graph"],
) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const malformed = graph.edges.filter((edge) => isMalformedDualTargetEdge(edge, nodes));
  return {
    nodes,
    claimEdges: graph.edges.filter((edge) => !isMalformedDualTargetEdge(edge, nodes)),
    diagnostics: malformed.map((edge) => ({
      source: nodes.get(edge.source)?.label ?? edge.source,
      target: nodes.get(edge.target)?.label ?? edge.target,
      source_type: nodes.get(edge.source)?.type ?? null,
      target_type: nodes.get(edge.target)?.type ?? null,
      relation: edge.relation,
      reason: "dual_target_edge_has_no_supported_claim_relation",
    })),
  };
}

/**
 * Explicitly re-extracts a document that is already in human review. It never
 * mutates prior claims: reconciliation inserts only relationships absent from
 * this document, while exact repeats and changed-quote variants are auditable.
 */
export async function reprocessDocument(input: {
  documentId: string;
  trigger: string;
  db?: DatabaseClient;
  services?: Partial<{
    downloadDocumentPdf: typeof downloadDocumentPdf;
    extractPdfText: typeof extractPdfText;
    extract: typeof extract;
  }>;
}): Promise<ReprocessDocumentResult> {
  const trigger = input.trigger.trim();
  if (!trigger) throw new Error("A reprocess trigger is required.");
  const db = input.db ?? getDb();
  const [document] = await db.select().from(documents).where(eq(documents.id, input.documentId)).limit(1);
  if (!document) throw new Error(`Document ${input.documentId} was not found.`);
  if (document.status === "published") {
    throw new Error("Published-document reprocessing requires the review-batch UI and is not enabled yet.");
  }
  if (document.status !== "ready_for_review") {
    throw new Error(`Document ${input.documentId} is '${document.status}'; only ready_for_review documents can be reprocessed.`);
  }
  if (document.docType !== "rating_rationale") {
    throw new Error(`Document ${input.documentId} is not a rating rationale.`);
  }
  if (!document.storagePath) throw new Error(`Document ${input.documentId} has no stored PDF to reprocess.`);
  if (!document.companyId || !document.publishedDate) {
    throw new Error(`Document ${input.documentId} is missing its resolved company or published date.`);
  }

  const downloadPdf = input.services?.downloadDocumentPdf ?? downloadDocumentPdf;
  const extractText = input.services?.extractPdfText ?? extractPdfText;
  const extractGraph = input.services?.extract ?? extract;
  const fileBuffer = await downloadPdf(document.storagePath);
  const text = await extractText(fileBuffer);
  const extracted = await extractGraph(fileBuffer, text);
  const relationshipData = malformedRelationshipDiagnostics(extracted.graph);
  const reprocessedAt = new Date().toISOString();

  const result = await db.transaction(async (tx: Transaction) => {
    const [locked] = await tx.select().from(documents).where(eq(documents.id, document.id)).for("update");
    if (!locked) throw new Error(`Document ${document.id} disappeared during reprocessing.`);
    if (locked.status !== "ready_for_review") {
      throw new Error(`Document ${document.id} changed to '${locked.status}' while it was being reprocessed.`);
    }
    if (!locked.companyId || !locked.publishedDate) throw new Error(`Document ${document.id} lost required reconciliation fields.`);

    const claimNodeIds = new Set(relationshipData.claimEdges.flatMap((edge) => [edge.source, edge.target]));
    const entityByNodeId = await resolveGraphEntities(tx, {
      documentId: locked.id,
      companyId: locked.companyId,
      nodes: extracted.graph.nodes.filter((node) => claimNodeIds.has(node.id)),
      resolvedBy: "deterministic",
    });
    const candidates = relationshipData.claimEdges.map((edge) => {
      const sourceEntityId = entityByNodeId.get(edge.source);
      const targetEntityId = entityByNodeId.get(edge.target);
      if (!sourceEntityId || !targetEntityId) throw new Error(`Could not resolve ${edge.source} -> ${edge.target}.`);
      return {
        documentId: locked.id,
        companyId: locked.companyId,
        sourceEntityId,
        targetEntityId,
        relationType: relationTypeFor(edge, relationshipData.nodes),
        relationLabel: edge.relation,
        exposurePct: edge.exposure_pct === null ? null : String(edge.exposure_pct),
        riskFlag: edge.risk_flag,
        quote: edge.source_quote,
        page: edge.source_page,
        observedDate: locked.publishedDate,
        lifecycleState: "current" as const,
        verificationTier: "machine_validated" as const,
        extractionConfidence: edge.confidence,
        modelVersion: extracted.modelVersion,
        promptVersion: extracted.promptVersion,
      };
    });
    const reconciliation = await reconcileClaimInserts(tx, { documentId: locked.id, candidates });
    const rejectedQuotes = mergeRejectedQuoteDiagnostics(
      storedRejectedQuotes(locked.metadata),
      extracted.rejectedQuotes ?? [],
    );
    const reprocessEntry = {
      reprocessed_at: reprocessedAt,
      trigger,
      model_version: extracted.modelVersion,
      prompt_version: extracted.promptVersion,
      reconciliation: reconciliation.counts,
      quote_variants: reconciliation.quoteVariants satisfies QuoteVariant[],
      new_claim_ids: reconciliation.insertedClaimIds,
      malformed_relationships: relationshipData.diagnostics,
    };
    await tx.update(documents).set({
      metadata: {
        ...metadataObject(locked.metadata),
        rejected_quotes: rejectedQuotes,
        reprocess: [...existingReprocesses(locked.metadata), reprocessEntry],
      },
      updatedAt: sql`now()`,
    }).where(eq(documents.id, locked.id));
    return reconciliation;
  });
  await seedKnownEntityMergeRejections(db);

  return {
    documentId: document.id,
    status: "ready_for_review",
    reconciliation: result.counts,
    quoteVariantCount: result.quoteVariants.length,
    newClaimIds: result.insertedClaimIds,
  };
}
