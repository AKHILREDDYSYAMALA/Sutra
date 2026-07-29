import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { eq, sql } from "drizzle-orm";

import { claims, companies, documents } from "./schema";
import { createDatabaseClient } from "../lib/db/client";
import { ingestDocument, retryDocument, sourceForUrl, type IngestSource } from "../lib/ingestion/ingest";
import { requiredDirectUrl } from "./env";

type SummaryRow = {
  file: string;
  company: string;
  doc_type: string;
  claims: number | string;
  excluded: number | string;
  status: string;
  review?: string;
  note?: string;
};

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  return "Usage: npm run ingest -- --url <https://…pdf> | --file <path/to/report.pdf> | --dir <path/to/pdfs> [--dry-run] | --retry <documentId> [--source manual] [--private]";
}

function isPdf(filePath: string) {
  return path.extname(filePath).toLowerCase() === ".pdf";
}

function thinExtractionMarker(docType: string | null, claimCount: number) {
  return docType === "rating_rationale" && claimCount < 3 ? "review: unusually thin" : "";
}

function sourceFromArg(value: string | undefined, fallback: IngestSource): IngestSource {
  if (!value) return fallback;
  const sources: IngestSource[] = ["bse", "nse", "crisil", "icra", "care", "india_ratings", "user_upload", "manual"];
  if (!sources.includes(value as IngestSource)) throw new Error(`Unsupported --source '${value}'.`);
  return value as IngestSource;
}

async function listPdfFiles(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && isPdf(entry.name))
    .map((entry) => path.join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function existingDocumentSummary(
  db: ReturnType<typeof createDatabaseClient>["db"],
  sha256: string,
): Promise<SummaryRow | undefined> {
  const [existing] = await db
    .select({
      id: documents.id,
      status: documents.status,
      docType: documents.docType,
      metadata: documents.metadata,
      companyName: companies.name,
    })
    .from(documents)
    .leftJoin(companies, eq(companies.id, documents.companyId))
    .where(eq(documents.sha256, sha256))
    .limit(1);
  if (!existing) return undefined;
  const [counts] = await db
    .select({ claimCount: sql<number>`count(*)::int` })
    .from(claims)
    .where(eq(claims.documentId, existing.id));
  const validationExclusions = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
    && Array.isArray((existing.metadata as { excluded?: unknown }).excluded)
    ? (existing.metadata as { excluded: unknown[] }).excluded.length
    : 0;
  return {
    file: "",
    company: existing.companyName ?? "—",
    doc_type: existing.docType ?? "—",
    claims: counts?.claimCount ?? 0,
    excluded: validationExclusions,
    status: `skipped (${existing.status})`,
    review: thinExtractionMarker(existing.docType, counts?.claimCount ?? 0),
  };
}

async function dryRunDirectory(
  db: ReturnType<typeof createDatabaseClient>["db"],
  files: string[],
): Promise<SummaryRow[]> {
  const rows: SummaryRow[] = [];
  for (const filePath of files) {
    try {
      const bytes = await readFile(filePath);
      if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("not a PDF");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const existing = await existingDocumentSummary(db, sha256);
      rows.push(existing ? { ...existing, file: path.basename(filePath) } : {
        file: path.basename(filePath), company: "—", doc_type: "—", claims: "—", excluded: "—", status: "would ingest",
      });
    } catch (error) {
      rows.push({ file: path.basename(filePath), company: "—", doc_type: "—", claims: "—", excluded: "—", status: "invalid", note: error instanceof Error ? error.message : String(error) });
    }
  }
  return rows;
}

async function ingestDirectory(
  db: ReturnType<typeof createDatabaseClient>["db"],
  files: string[],
  source: IngestSource,
  isPrivate: boolean,
): Promise<{ rows: SummaryRow[]; failed: boolean }> {
  const rows: SummaryRow[] = [];
  let failed = false;
  for (const filePath of files) {
    try {
      const fileBuffer = await readFile(filePath);
      const sha256 = createHash("sha256").update(fileBuffer).digest("hex");
      // Batch mode is intentionally conservative: a matching hash is already
      // an auditable document, so report it as skipped rather than implicitly
      // retrying work. Operators can use --retry for an explicit resume.
      const existing = await existingDocumentSummary(db, sha256);
      if (existing) {
        rows.push({ ...existing, file: path.basename(filePath) });
        continue;
      }
      const result = await ingestDocument({
        db,
        source,
        fileBuffer,
        fileName: filePath,
        isPrivate,
      });
      rows.push({
        file: path.basename(filePath),
        company: result.company ?? "—",
        doc_type: result.docType ?? "—",
        claims: result.claimCount,
        excluded: result.excludedCount,
        status: result.outcome === "duplicate" ? `skipped (${result.status})` : result.status,
        review: thinExtractionMarker(result.docType, result.claimCount),
        note: result.reason,
      });
    } catch (error) {
      failed = true;
      rows.push({
        file: path.basename(filePath),
        company: "—",
        doc_type: "—",
        claims: "—",
        excluded: "—",
        status: "failed",
        note: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { rows, failed };
}

function printSummary(rows: SummaryRow[]) {
  console.table(rows);
  const skipped = rows.filter((row) => row.status.startsWith("skipped")).length;
  const failed = rows.filter((row) => row.status === "failed" || row.status === "invalid").length;
  console.log(`Batch complete: ${rows.length} file(s), ${skipped} skipped, ${failed} failed.`);
}

async function main() {
  const args = process.argv.slice(2);
  const url = valueAfter(args, "--url");
  const filePath = valueAfter(args, "--file");
  const directory = valueAfter(args, "--dir");
  const retryDocumentId = valueAfter(args, "--retry");
  const source = valueAfter(args, "--source");
  const dryRun = args.includes("--dry-run");
  const modes = [url, filePath, directory, retryDocumentId].filter(Boolean).length;
  if (modes !== 1 || (dryRun && retryDocumentId)) throw new Error(usage());

  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    if (directory) {
      const files = await listPdfFiles(directory);
      if (files.length === 0) {
        console.log("No PDF files found. No database changes were made.");
        return;
      }
      if (dryRun) {
        printSummary(await dryRunDirectory(db, files));
        return;
      }
      const result = await ingestDirectory(db, files, sourceFromArg(source, "manual"), args.includes("--private"));
      printSummary(result.rows);
      if (result.failed) process.exitCode = 1;
      return;
    }

    const result = retryDocumentId
      ? await retryDocument({ db, documentId: retryDocumentId })
      : await ingestDocument({
        db,
        url,
        fileBuffer: filePath ? await readFile(filePath) : undefined,
        fileName: filePath,
        source: sourceFromArg(source, url ? sourceForUrl(url) : "manual"),
        isPrivate: args.includes("--private"),
      });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
