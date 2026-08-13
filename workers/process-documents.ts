import { eq, sql } from "drizzle-orm";

import { companies, documents } from "../db/schema";
import { BseAttachmentNotFoundError } from "../lib/acquisition/bse/client";
import { claimNextDocument, createDatabaseClient, scheduleDocumentRetry } from "../lib/db";
import { ingestDocument, type IngestSource } from "../lib/ingestion/ingest";
import { requiredWorkerEnvironment } from "./env";

function numberOption(name: string) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : undefined;
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new Error(`${name} must be a positive integer.`);
  return value;
}
const once = process.argv.includes("--once");
const retryFailed = process.argv.includes("--retry-failed");
const maximum = numberOption("--max") ?? (once ? 1 : Number.POSITIVE_INFINITY);
let stopping = false;
process.on("SIGINT", () => { stopping = true; console.log(JSON.stringify({ worker: "documents", event: "shutdown_requested" })); });
process.on("SIGTERM", () => { stopping = true; console.log(JSON.stringify({ worker: "documents", event: "shutdown_requested" })); });
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function requeueFailedDocuments(db: ReturnType<typeof createDatabaseClient>["db"]) {
  const requeued = await db
    .update(documents)
    .set({
      status: "discovered",
      lastError: null,
      nextAttemptAt: null,
      updatedAt: sql`now()`,
    })
    .where(eq(documents.status, "failed"))
    .returning({ id: documents.id, source: documents.source });
  const bySource = requeued.reduce<Record<string, number>>((counts, document) => {
    counts[document.source] = (counts[document.source] ?? 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({ worker: "documents", event: "failed_documents_requeued", count: requeued.length, bySource }));
}

async function main() {
  const { databaseUrl } = requiredWorkerEnvironment();
  const idleMs = Number(process.env.WORKER_IDLE_MS ?? 30_000);
  if (!Number.isFinite(idleMs) || idleMs < 1_000) throw new Error("WORKER_IDLE_MS must be at least 1000.");
  const { client, db } = createDatabaseClient(databaseUrl);
  let processed = 0;
  try {
    if (retryFailed) await requeueFailedDocuments(db);
    while (!stopping && processed < maximum) {
      const document = await claimNextDocument(db, "discovered");
      if (!document) {
        if (once) break;
        await sleep(idleMs);
        continue;
      }
      const startedAt = Date.now();
      const [company] = document.companyId
        ? await db.select({ name: companies.name }).from(companies).where(eq(companies.id, document.companyId)).limit(1)
        : [];
      try {
        if (!document.url) {
          const message = "Discovered document has no attachment URL.";
          await scheduleDocumentRetry(db, document.id, message);
          throw new Error(message);
        }
        const result = await ingestDocument({ db, existingDocumentId: document.id, source: document.source as IngestSource, url: document.url, title: document.title ?? undefined, companyHint: company?.name });
        console.log(JSON.stringify({ worker: "documents", documentId: document.id, company: company?.name ?? null, stage: result.status, durationMs: Date.now() - startedAt, outcome: result.outcome }));
      } catch (error) {
        console.error(JSON.stringify({ worker: "documents", documentId: document.id, company: company?.name ?? null, stage: document.status, durationMs: Date.now() - startedAt, outcome: error instanceof BseAttachmentNotFoundError ? "failed" : "retry_scheduled", error: error instanceof Error ? error.message : String(error) }));
      }
      processed += 1;
    }
    console.log(JSON.stringify({ worker: "documents", event: "stopped", processed }));
  } finally {
    await client.end({ timeout: 5 });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
