import { createHash } from "node:crypto";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { claims, companies, documents } from "@/db/schema";
import { seedKnownEntityMergeRejections } from "@/db/known-entity-rejections";
import { parseReportDate, slugify } from "@/db/static-graphs";
import { advanceDocumentStatus, getDb, scheduleDocumentRetry, type DatabaseClient } from "@/lib/db";
import { extract, extractPdfText, type ExtractedDocument, type ExtractedPdfText } from "@/lib/extraction/extract";
import { normalizeEntityName } from "@/lib/entity-normalization";

import { classifyDocument, collectClassificationSignals, type DocumentClassification, type DocumentType } from "./classify";
import { reconcileClaimInserts } from "./claim-reconciliation";
import { extractionTelemetry, storedExtractionTelemetry, type ExtractionTelemetry } from "./extraction-telemetry";
import { mergeRejectedQuoteDiagnostics, type RejectedQuoteDiagnostic } from "./quote-mismatches";
import { isMalformedDualTargetEdge, resolveGraphEntities, relationTypeFor } from "./resolve-entities";
import { downloadDocumentPdf, uploadDocumentPdf } from "./storage";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export type IngestSource = "bse" | "nse" | "crisil" | "icra" | "care" | "india_ratings" | "user_upload" | "manual";

export type IngestDocumentInput = {
  source: IngestSource;
  url?: string;
  fileBuffer?: Buffer;
  fileName?: string;
  title?: string;
  docType?: DocumentType;
  /** Marks a forced type supplied by a human reclassification action. */
  classificationOverride?: boolean;
  companyHint?: string;
  isPrivate?: boolean;
  /** Dependency injection for CLI and tests; runtime callers use DATABASE_URL. */
  db?: DatabaseClient;
  /** Test/worker seam; production uses the shared extraction and Storage functions. */
  services?: Partial<{
    uploadDocumentPdf: typeof uploadDocumentPdf;
    extractPdfText: typeof extractPdfText;
    extract: (fileBuffer: Buffer, text?: ExtractedPdfText) => Promise<ExtractedDocument>;
  }>;
};

export type IngestDocumentResult = {
  outcome: "ready_for_review" | "excluded" | "duplicate";
  documentId: string;
  sha256: string;
  status: string;
  claimCount: number;
  excludedCount: number;
  company: string | null;
  docType: string | null;
  resumedFrom?: string;
  reason?: string;
  extractionTelemetry?: ExtractionTelemetry;
};

type PdfInput = { bytes: Buffer; title: string; url: string | null };

function assertPdf(bytes: Buffer) {
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new Error("PDF must be non-empty and no larger than 10MB.");
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("The source is not a PDF.");
}

export function sourceForUrl(url: string): IngestSource {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes("crisil")) return "crisil";
  if (host.includes("icra")) return "icra";
  if (host.includes("care")) return "care";
  if (host.includes("indiaratings") || host.includes("india-ratings") || host.includes("ind-ra")) return "india_ratings";
  if (host.includes("bseindia")) return "bse";
  if (host.includes("nseindia")) return "nse";
  return "manual";
}

async function downloadPdf(url: string): Promise<PdfInput> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "Sutra document ingestion/1.0 (+https://sutra.local)" },
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.includes("application/pdf")) throw new Error(`Expected application/pdf, received ${contentType || "no content type"}.`);
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_FILE_BYTES) throw new Error("PDF is larger than 10MB.");
    if (!response.body) throw new Error("Download returned no response body.");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      length += value.byteLength;
      if (length > MAX_FILE_BYTES) {
        await reader.cancel();
        throw new Error("PDF is larger than 10MB.");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    assertPdf(bytes);
    const disposition = response.headers.get("content-disposition") ?? "";
    const named = /filename\*?=(?:UTF-8'')?\"?([^\";]+)/i.exec(disposition)?.[1];
    return { bytes, title: decodeURIComponent(named ?? (path.basename(new URL(url).pathname) || "Untitled PDF")), url };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Download timed out after 30 seconds.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadPdf(input: IngestDocumentInput): Promise<PdfInput> {
  if (Boolean(input.url) === Boolean(input.fileBuffer)) throw new Error("Provide exactly one of url or fileBuffer.");
  if (input.url) return downloadPdf(input.url);
  const bytes = input.fileBuffer!;
  assertPdf(bytes);
  return { bytes, title: input.title ?? input.fileName ?? "Uploaded PDF", url: null };
}

async function findOrCreateCompany(db: DatabaseClient, name: string) {
  const normalized = normalizeEntityName(name);
  const allCompanies = await db.select().from(companies);
  const existing = allCompanies.find((company) => normalizeEntityName(company.name) === normalized);
  if (existing) return { company: existing, path: "matched_existing" as const };

  const baseSlug = slugify(name);
  let slug = baseSlug;
  let suffix = 2;
  while (allCompanies.some((company) => company.slug === slug)) slug = `${baseSlug}-${suffix++}`;
  const [company] = await db.insert(companies).values({ name, slug }).returning();
  if (!company) throw new Error(`Could not create company ${name}.`);
  return { company, path: "created" as const };
}

function reportDate(graphDate: string | null) {
  if (!graphDate) throw new Error("A rating rationale needs a report_date before claims can be recorded.");
  return parseReportDate(graphDate);
}

function documentMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function storedRejectedQuoteDiagnostics(value: unknown): RejectedQuoteDiagnostic[] {
  const entries = documentMetadata(value).rejected_quotes;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is RejectedQuoteDiagnostic => Boolean(
    entry && typeof entry === "object"
      && typeof (entry as RejectedQuoteDiagnostic).model_quote === "string"
      && typeof (entry as RejectedQuoteDiagnostic).reason_bucket === "string",
  ));
}

function storedValidationExclusionCount(value: unknown) {
  const metadata = documentMetadata(value);
  return Array.isArray(metadata.excluded) ? metadata.excluded.length : 0;
}

async function storedDocumentCounts(db: DatabaseClient, document: typeof documents.$inferSelect) {
  const existingClaims = await db
    .select({ verificationTier: claims.verificationTier })
    .from(claims)
    .where(eq(claims.documentId, document.id));
  return {
    claimCount: existingClaims.length,
    // Preserve the result contract used for a fresh ingestion: this is the
    // number of edges validation excluded before they became ledger claims.
    excludedCount: storedValidationExclusionCount(document.metadata),
    extractionTelemetry: storedExtractionTelemetry(document.metadata),
  };
}

const resumableDocumentStatuses = new Set(["discovered", "fetched", "classified", "failed"]);
const documentTypes = new Set(["rating_rationale", "rating_intimation", "annual_report", "rpt_schedule", "order_win", "drhp", "other"]);

function documentType(value: string | null): IngestDocumentInput["docType"] | undefined {
  return value && documentTypes.has(value) ? value as NonNullable<IngestDocumentInput["docType"]> : undefined;
}

function suppliedClassification(input: IngestDocumentInput, text: ExtractedPdfText): DocumentClassification {
  if (!input.docType) throw new Error("A supplied classification needs docType.");
  const signals = collectClassificationSignals({ title: input.title, url: input.url, text: text.fullText });
  return {
    docType: input.docType,
    confidence: "deterministic",
    reason: input.classificationOverride ? "human classification override" : "document type supplied by caller",
    decisionPath: input.classificationOverride ? "human_forced_type" : "caller_supplied_type",
    signals,
  };
}

async function createOrResumeDocument(
  db: DatabaseClient,
  input: IngestDocumentInput,
  sourcePdf: PdfInput,
  sha256: string,
) {
  const [existing] = await db.select().from(documents).where(eq(documents.sha256, sha256)).limit(1);
  if (existing && !resumableDocumentStatuses.has(existing.status)) {
    return {
      duplicate: true as const,
      document: existing,
      resumedFrom: undefined,
    };
  }

  if (existing) {
    const resumedFrom = existing.status;
    const [resumed] = await db
      .update(documents)
      .set({
        // `failed` is auditable but explicitly retryable from discovery. Earlier
        // stages retain their completed work and continue at the next stage.
        status: existing.status === "failed" ? "discovered" : existing.status,
        attempts: sql`${documents.attempts} + 1`,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, existing.id))
      .returning();
    if (!resumed) throw new Error(`Could not resume document ${existing.id}.`);
    return { duplicate: false as const, document: resumed, resumedFrom };
  }

  const [created] = await db.insert(documents).values({
    source: input.source,
    title: input.title ?? sourcePdf.title,
    url: sourcePdf.url,
    sha256,
    status: "discovered",
    attempts: 1,
    isPrivate: input.isPrivate ?? input.source === "user_upload",
    metadata: { ingestion: { source: sourcePdf.url ? "url" : "file" } },
  }).returning();
  if (!created) throw new Error("Document creation did not return a row.");
  return { duplicate: false as const, document: created, resumedFrom: undefined };
}

/**
 * Persistent ingestion entrypoint. Each successful stage transition is written to
 * the ledger; terminal documents are never automatically published.
 */
export async function ingestDocument(input: IngestDocumentInput): Promise<IngestDocumentResult> {
  const db = input.db ?? getDb();
  const uploadPdf = input.services?.uploadDocumentPdf ?? uploadDocumentPdf;
  const extractText = input.services?.extractPdfText ?? extractPdfText;
  const extractGraph = input.services?.extract ?? extract;
  const sourcePdf = await loadPdf(input);
  const sha256 = createHash("sha256").update(sourcePdf.bytes).digest("hex");
  const prepared = await createOrResumeDocument(db, input, sourcePdf, sha256);
  if (prepared.duplicate) {
    const existingCounts = await storedDocumentCounts(db, prepared.document);
    return {
      outcome: "duplicate",
      documentId: prepared.document.id,
      sha256,
      status: prepared.document.status,
      claimCount: existingCounts.claimCount,
      excludedCount: existingCounts.excludedCount,
      company: prepared.document.companyId
        ? (await db.select({ name: companies.name }).from(companies).where(eq(companies.id, prepared.document.companyId)).limit(1))[0]?.name ?? null
        : null,
      docType: prepared.document.docType,
      extractionTelemetry: existingCounts.extractionTelemetry,
      reason: `Duplicate: document already has durable work at status '${prepared.document.status}'.`,
    };
  }
  const document = prepared.document;
  let stage = document.status;

  try {
    if (stage === "discovered") {
      // A resumed audit row already has the immutable hash-addressed PDF. Do
      // not re-upload it (or depend on a Storage bucket round trip) before the
      // actual retry work can begin.
      const storagePath = document.storagePath ?? await uploadPdf(sha256, sourcePdf.bytes);
      await db.update(documents).set({ storagePath, fetchedAt: new Date(), updatedAt: sql`now()` }).where(eq(documents.id, document.id));
      await advanceDocumentStatus(db, document.id, "fetched");
      stage = "fetched";
    }

    let text: ExtractedPdfText | undefined;
    let classification: DocumentClassification;
    if (stage === "fetched") {
      text = await extractText(sourcePdf.bytes);
      classification = input.docType
        ? suppliedClassification(input, text)
        : await classifyDocument({ title: document.title, url: document.url, text: text.fullText });
      await db.update(documents).set({
        docType: classification.docType,
        metadata: { ...documentMetadata(document.metadata), classification },
        updatedAt: sql`now()`,
      }).where(eq(documents.id, document.id));
      await advanceDocumentStatus(db, document.id, "classified");
      stage = "classified";
    } else if (stage === "classified") {
      const savedType = documentType(document.docType);
      classification = savedType
        ? suppliedClassification({ ...input, docType: savedType }, text ?? await extractPdfText(sourcePdf.bytes))
        : await classifyDocument({ title: document.title, url: document.url, text: (text = await extractText(sourcePdf.bytes)).fullText });
    } else {
      throw new Error(`Document ${document.id} cannot be resumed from status ${stage}.`);
    }

    if (classification.docType !== "rating_rationale") {
      await advanceDocumentStatus(db, document.id, "excluded");
      await db.update(documents).set({ lastError: classification.reason, updatedAt: sql`now()` }).where(eq(documents.id, document.id));
      return { outcome: "excluded", documentId: document.id, sha256, status: "excluded", claimCount: 0, excludedCount: 0, company: null, docType: classification.docType, resumedFrom: prepared.resumedFrom, reason: classification.reason };
    }

    const extracted = await extractGraph(sourcePdf.bytes, text ?? await extractText(sourcePdf.bytes));
    const telemetry = extractionTelemetry(extracted);
    const rejectedQuotes = mergeRejectedQuoteDiagnostics(
      storedRejectedQuoteDiagnostics(document.metadata),
      extracted.rejectedQuotes ?? [],
    );
    const extractedNodes = new Map(extracted.graph.nodes.map((node) => [node.id, node]));
    // The ledger intentionally has no catch-all relationship type. Preserve a
    // malformed dual-target edge for inspection, but never turn a prospective
    // acquisition (or another model error) into a false group-company claim.
    const malformedDualTargetEdges = extracted.graph.edges.filter((edge) => isMalformedDualTargetEdge(edge, extractedNodes));
    const claimEdges = extracted.graph.edges.filter((edge) => !isMalformedDualTargetEdge(edge, extractedNodes));
    const malformedRelationshipDiagnostics = malformedDualTargetEdges.map((edge) => ({
      source: extractedNodes.get(edge.source)?.label ?? edge.source,
      target: extractedNodes.get(edge.target)?.label ?? edge.target,
      source_type: extractedNodes.get(edge.source)?.type ?? null,
      target_type: extractedNodes.get(edge.target)?.type ?? null,
      relation: edge.relation,
      reason: "dual_target_edge_has_no_supported_claim_relation",
    }));
    if (malformedRelationshipDiagnostics.length > 0) {
      console.warn("Sutra malformed relationship edges omitted from claims.", {
        documentId: document.id,
        edges: malformedRelationshipDiagnostics,
      });
    }
    await advanceDocumentStatus(db, document.id, "extracted");
    await db.update(documents).set({
      metadata: {
        ...documentMetadata(document.metadata),
        classification,
        excluded: extracted.meta.excluded,
        rejected_quotes: rejectedQuotes,
        malformed_relationships: malformedRelationshipDiagnostics,
        extraction: telemetry,
        // This server-only source text makes a claim's ±1 sentence context
        // reviewable without forcing every reviewer to open the source PDF.
        extractedText: extracted.text.fullText,
      },
      updatedAt: sql`now()`,
    }).where(eq(documents.id, document.id));
    await advanceDocumentStatus(db, document.id, "validated");

    const publishedDate = reportDate(extracted.graph.report_date);
    const companyName = input.companyHint?.trim() || extracted.graph.target_company;
    const companyResult = await findOrCreateCompany(db, companyName);
    const company = companyResult.company;
    await db.update(documents).set({
      companyId: company.id,
      agency: extracted.graph.agency,
      rating: extracted.graph.rating,
      publishedDate,
      metadata: {
        ...documentMetadata(document.metadata),
        classification,
        excluded: extracted.meta.excluded,
        rejected_quotes: rejectedQuotes,
        malformed_relationships: malformedRelationshipDiagnostics,
        extraction: telemetry,
        extractedText: extracted.text.fullText,
        keyRisks: extracted.graph.key_risks,
        reportDateRaw: extracted.graph.report_date,
        companyResolution: { path: companyResult.path, companyName, extractedCompanyName: extracted.graph.target_company },
      },
      updatedAt: sql`now()`,
    }).where(eq(documents.id, document.id));

    const reconciliation = await db.transaction(async (tx) => {
      const [lockedDocument] = await tx.select({ id: documents.id }).from(documents).where(eq(documents.id, document.id)).for("update");
      if (!lockedDocument) throw new Error(`Document ${document.id} disappeared during claim reconciliation.`);
      const claimNodeIds = new Set(claimEdges.flatMap((edge) => [edge.source, edge.target]));
      const entityByNodeId = await resolveGraphEntities(tx, {
        documentId: document.id,
        companyId: company.id,
        nodes: extracted.graph.nodes.filter((node) => claimNodeIds.has(node.id)),
        resolvedBy: "deterministic",
      });
      const rows = claimEdges.map((edge) => {
        const sourceEntityId = entityByNodeId.get(edge.source);
        const targetEntityId = entityByNodeId.get(edge.target);
        if (!sourceEntityId || !targetEntityId) throw new Error(`Could not resolve ${edge.source} -> ${edge.target}.`);
        return {
          documentId: document.id,
          companyId: company.id,
          sourceEntityId,
          targetEntityId,
          relationType: relationTypeFor(edge, extractedNodes),
          relationLabel: edge.relation,
          exposurePct: edge.exposure_pct === null ? null : String(edge.exposure_pct),
          riskFlag: edge.risk_flag,
          quote: edge.source_quote,
          page: edge.source_page,
          observedDate: publishedDate,
          lifecycleState: "current" as const,
          verificationTier: "machine_validated" as const,
          extractionConfidence: edge.confidence,
          modelVersion: extracted.modelVersion,
          promptVersion: extracted.promptVersion,
        };
      });
      return reconcileClaimInserts(tx, { documentId: document.id, candidates: rows });
    });
    await seedKnownEntityMergeRejections(db);
    await advanceDocumentStatus(db, document.id, "resolved");
    await advanceDocumentStatus(db, document.id, "ready_for_review");
    return { outcome: "ready_for_review", documentId: document.id, sha256, status: "ready_for_review", claimCount: reconciliation.counts.new_claims, excludedCount: extracted.meta.excluded.length, company: company.name, docType: classification.docType, resumedFrom: prepared.resumedFrom, extractionTelemetry: telemetry };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Sutra document ingestion failed", { documentId: document.id, sha256, message });
    // The direct ingestion invocation created this document with attempts=1. A
    // later worker claim increments again before retrying; don't double-count
    // the current failed attempt or skip the initial five-minute backoff.
    await scheduleDocumentRetry(db, document.id, message.slice(0, 2_000));
    throw error;
  }
}

/** Explicitly resumes an incomplete document without creating or deleting rows. */
export async function retryDocument(input: { db?: DatabaseClient; documentId: string; forceType?: DocumentType }): Promise<IngestDocumentResult> {
  const db = input.db ?? getDb();
  let [document] = await db.select().from(documents).where(eq(documents.id, input.documentId)).limit(1);
  if (!document) throw new Error(`Document ${input.documentId} was not found.`);
  if (document.status === "validated") {
    const [existingClaims] = await db.select({ count: sql<number>`count(*)::int` }).from(claims).where(eq(claims.documentId, document.id));
    if ((existingClaims?.count ?? 0) > 0) {
      throw new Error(`Document ${input.documentId} reached validated with claims already present; refusing to replay evidence.`);
    }
    // Resolution can fail after validation (for example, a date parse or an
    // inbound relation mapper). There are no claims to duplicate yet, so an
    // explicit retry records the failed branch then restarts from discovery.
    const [restarted] = await db.transaction(async (tx) => {
      await tx.update(documents).set({ status: "failed", updatedAt: sql`now()` }).where(eq(documents.id, document.id));
      const [updated] = await tx.update(documents).set({
        status: "discovered",
        lastError: null,
        nextAttemptAt: null,
        metadata: {
          ...documentMetadata(document.metadata),
          retryRestart: { restartedAt: new Date().toISOString(), restartedFrom: "validated", reason: document.lastError },
        },
        updatedAt: sql`now()`,
      }).where(eq(documents.id, document.id)).returning();
      return [updated];
    });
    if (!restarted) throw new Error(`Document ${input.documentId} could not restart from validated.`);
    document = restarted;
  }
  if (!resumableDocumentStatuses.has(document.status)) {
    throw new Error(`Document ${input.documentId} is '${document.status}' and is not retryable.`);
  }
  const source = document.source as IngestSource;
  const docType = input.forceType ?? documentType(document.docType);
  const classificationOverride = Boolean(input.forceType);
  // Retrying an existing audit row should not depend on a source URL remaining
  // live. The hash-addressed PDF is the canonical retry input once stored.
  if (document.storagePath) {
    const fileBuffer = await downloadDocumentPdf(document.storagePath);
    return ingestDocument({ db, source, fileBuffer, fileName: document.title ?? undefined, docType, classificationOverride });
  }
  if (document.url) return ingestDocument({ db, source, url: document.url, title: document.title ?? undefined, docType, classificationOverride });
  throw new Error(`Document ${input.documentId} has neither a source URL nor a stored PDF; retry it with --file <path>.`);
}
