import { createHash } from "node:crypto";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { claims, companies, documents } from "@/db/schema";
import { parseReportDate, slugify } from "@/db/static-graphs";
import { advanceDocumentStatus, getDb, scheduleDocumentRetry, type DatabaseClient } from "@/lib/db";
import { extract, extractPdfText, type ExtractedPdfText } from "@/lib/extraction/extract";
import { normalizeEntityName } from "@/lib/entity-normalization";

import { classifyDocument } from "./classify";
import { resolveGraphEntities, relationTypeFor } from "./resolve-entities";
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
  docType?: "rating_rationale" | "rating_intimation" | "annual_report" | "rpt_schedule" | "order_win" | "drhp" | "other";
  companyHint?: string;
  isPrivate?: boolean;
  /** Dependency injection for CLI and tests; runtime callers use DATABASE_URL. */
  db?: DatabaseClient;
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
  if (host.includes("indiaratings")) return "india_ratings";
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

const resumableDocumentStatuses = new Set(["discovered", "fetched", "classified", "failed"]);
const documentTypes = new Set(["rating_rationale", "rating_intimation", "annual_report", "rpt_schedule", "order_win", "drhp", "other"]);

function documentType(value: string | null): IngestDocumentInput["docType"] | undefined {
  return value && documentTypes.has(value) ? value as NonNullable<IngestDocumentInput["docType"]> : undefined;
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
  const sourcePdf = await loadPdf(input);
  const sha256 = createHash("sha256").update(sourcePdf.bytes).digest("hex");
  const prepared = await createOrResumeDocument(db, input, sourcePdf, sha256);
  if (prepared.duplicate) {
    return {
      outcome: "duplicate",
      documentId: prepared.document.id,
      sha256,
      status: prepared.document.status,
      claimCount: 0,
      excludedCount: 0,
      company: null,
      docType: prepared.document.docType,
      reason: `Duplicate: document already has durable work at status '${prepared.document.status}'.`,
    };
  }
  const document = prepared.document;
  let stage = document.status;

  try {
    if (stage === "discovered") {
      const storagePath = await uploadDocumentPdf(sha256, sourcePdf.bytes);
      await db.update(documents).set({ storagePath, fetchedAt: new Date(), updatedAt: sql`now()` }).where(eq(documents.id, document.id));
      await advanceDocumentStatus(db, document.id, "fetched");
      stage = "fetched";
    }

    let text: ExtractedPdfText | undefined;
    let classification: Awaited<ReturnType<typeof classifyDocument>>;
    if (stage === "fetched") {
      text = await extractPdfText(sourcePdf.bytes);
      classification = input.docType
        ? { docType: input.docType, confidence: "deterministic" as const, reason: "document type supplied by caller" }
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
        ? { docType: savedType, confidence: "deterministic", reason: "resuming existing classification" }
        : await classifyDocument({ title: document.title, url: document.url, text: (text = await extractPdfText(sourcePdf.bytes)).fullText });
    } else {
      throw new Error(`Document ${document.id} cannot be resumed from status ${stage}.`);
    }

    if (classification.docType !== "rating_rationale") {
      await advanceDocumentStatus(db, document.id, "excluded");
      await db.update(documents).set({ lastError: classification.reason, updatedAt: sql`now()` }).where(eq(documents.id, document.id));
      return { outcome: "excluded", documentId: document.id, sha256, status: "excluded", claimCount: 0, excludedCount: 0, company: null, docType: classification.docType, resumedFrom: prepared.resumedFrom, reason: classification.reason };
    }

    const extracted = await extract(sourcePdf.bytes, text ?? await extractPdfText(sourcePdf.bytes));
    await advanceDocumentStatus(db, document.id, "extracted");
    await db.update(documents).set({
      metadata: { ...documentMetadata(document.metadata), classification, excluded: extracted.meta.excluded },
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
      metadata: { ...documentMetadata(document.metadata), classification, excluded: extracted.meta.excluded, keyRisks: extracted.graph.key_risks, reportDateRaw: extracted.graph.report_date, companyResolution: { path: companyResult.path, companyName, extractedCompanyName: extracted.graph.target_company } },
      updatedAt: sql`now()`,
    }).where(eq(documents.id, document.id));

    const claimCount = await db.transaction(async (tx) => {
      const entityByNodeId = await resolveGraphEntities(tx, {
        documentId: document.id,
        companyId: company.id,
        nodes: extracted.graph.nodes,
        resolvedBy: "deterministic",
      });
      const nodes = new Map(extracted.graph.nodes.map((node) => [node.id, node]));
      const rows = extracted.graph.edges.map((edge) => {
        const sourceEntityId = entityByNodeId.get(edge.source);
        const targetEntityId = entityByNodeId.get(edge.target);
        if (!sourceEntityId || !targetEntityId) throw new Error(`Could not resolve ${edge.source} -> ${edge.target}.`);
        return {
          documentId: document.id,
          companyId: company.id,
          sourceEntityId,
          targetEntityId,
          relationType: relationTypeFor(edge, nodes),
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
      if (rows.length > 0) await tx.insert(claims).values(rows);
      return rows.length;
    });
    await advanceDocumentStatus(db, document.id, "resolved");
    await advanceDocumentStatus(db, document.id, "ready_for_review");
    return { outcome: "ready_for_review", documentId: document.id, sha256, status: "ready_for_review", claimCount, excludedCount: extracted.meta.excluded.length, company: company.name, docType: classification.docType, resumedFrom: prepared.resumedFrom };
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
export async function retryDocument(input: { db?: DatabaseClient; documentId: string }): Promise<IngestDocumentResult> {
  const db = input.db ?? getDb();
  const [document] = await db.select().from(documents).where(eq(documents.id, input.documentId)).limit(1);
  if (!document) throw new Error(`Document ${input.documentId} was not found.`);
  if (!resumableDocumentStatuses.has(document.status)) {
    throw new Error(`Document ${input.documentId} is '${document.status}' and is not retryable.`);
  }
  const source = document.source as IngestSource;
  const docType = documentType(document.docType);
  if (document.url) return ingestDocument({ db, source, url: document.url, title: document.title ?? undefined, docType });
  if (document.storagePath) {
    const fileBuffer = await downloadDocumentPdf(document.storagePath);
    return ingestDocument({ db, source, fileBuffer, fileName: document.title ?? undefined, docType });
  }
  throw new Error(`Document ${input.documentId} has neither a source URL nor a stored PDF; retry it with --file <path>.`);
}
