import { eq } from "drizzle-orm";

import { documents } from "./schema";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";
import { countQuoteMismatchBuckets, type RejectedQuoteDiagnostic } from "../lib/ingestion/quote-mismatches";

function documentIdFromArgs() {
  const index = process.argv.indexOf("--id");
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("Usage: npm run ingest:mismatches -- --id <documentId>");
  return value;
}

function rejectedQuotesFromMetadata(value: unknown): RejectedQuoteDiagnostic[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const entries = (value as { rejected_quotes?: unknown }).rejected_quotes;
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is RejectedQuoteDiagnostic => Boolean(
    entry && typeof entry === "object"
      && typeof (entry as RejectedQuoteDiagnostic).model_quote === "string"
      && typeof (entry as RejectedQuoteDiagnostic).reason_bucket === "string",
  ));
}

async function main() {
  const id = documentIdFromArgs();
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const [document] = await db.select({ id: documents.id, title: documents.title, metadata: documents.metadata }).from(documents).where(eq(documents.id, id)).limit(1);
    if (!document) throw new Error(`Document ${id} was not found.`);
    const entries = rejectedQuotesFromMetadata(document.metadata);
    console.log(`${document.title ?? document.id}: ${entries.length} rejected quote${entries.length === 1 ? "" : "s"}`);
    console.table(Object.entries(countQuoteMismatchBuckets(entries)).map(([bucket, count]) => ({ bucket, count })));
    if (entries.length === 0) return;

    entries.forEach((entry, index) => {
      const matchedPages = entry.best_match_start_page === entry.best_match_end_page
        ? entry.best_match_start_page ?? "unknown"
        : `${entry.best_match_start_page ?? "unknown"} → ${entry.best_match_end_page ?? "unknown"}`;
      console.log(`\n#${index + 1} ${entry.reason_bucket} · similarity ${entry.similarity_score.toFixed(3)} · claimed page ${entry.claimed_page ?? "unknown"} · best-match page(s) ${matchedPages}`);
      console.log(`Entities: ${entry.entity_labels.source} → ${entry.entity_labels.target}`);
      console.log(`Model quote: ${entry.model_quote}`);
      console.log(`Source window: ${entry.best_matching_window ?? "(no window above the diagnostic floor)"}`);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
