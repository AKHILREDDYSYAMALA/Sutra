import { eq, sql } from "drizzle-orm";

import { documents } from "./schema";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";
import { retryDocument } from "../lib/ingestion/ingest";
import type { DocumentType } from "../lib/ingestion/classify";
import type { IngestSource } from "../lib/ingestion/ingest";

const documentTypes = new Set<DocumentType>(["rating_rationale", "rating_intimation", "annual_report", "rpt_schedule", "order_win", "drhp", "other"]);
const sources = new Set<IngestSource>(["bse", "nse", "crisil", "icra", "care", "india_ratings", "user_upload", "manual"]);

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function main() {
  const args = process.argv.slice(2);
  const id = valueAfter(args, "--id");
  const forceTypeRaw = valueAfter(args, "--force-type");
  const sourceRaw = valueAfter(args, "--source");
  if (!id) throw new Error("Usage: npm run ingest:reclassify -- --id <documentId> [--force-type rating_rationale] [--source india_ratings]");
  if (forceTypeRaw && !documentTypes.has(forceTypeRaw as DocumentType)) throw new Error(`Unsupported --force-type ${forceTypeRaw}.`);
  if (sourceRaw && !sources.has(sourceRaw as IngestSource)) throw new Error(`Unsupported --source ${sourceRaw}.`);
  const forceType = forceTypeRaw as DocumentType | undefined;
  const source = sourceRaw as IngestSource | undefined;

  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const [document] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    if (!document) throw new Error(`Document ${id} was not found.`);
    if (document.status !== "excluded") throw new Error(`Document ${id} is '${document.status}'; only excluded documents can be reclassified.`);
    const metadata = metadataRecord(document.metadata);
    const [reset] = await db
      .update(documents)
      .set({
        status: "discovered",
        source: source ?? document.source,
        docType: forceType ?? null,
        lastError: null,
        nextAttemptAt: null,
        metadata: {
          ...metadata,
          reclassification: { requestedAt: new Date().toISOString(), priorStatus: document.status, forceType: forceType ?? null, source: source ?? document.source },
          ...(forceType ? { humanClassificationOverride: { docType: forceType, appliedAt: new Date().toISOString() } } : {}),
        },
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, id))
      .returning();
    if (!reset) throw new Error(`Document ${id} could not be reset.`);
    const result = await retryDocument({ db, documentId: id, forceType });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
