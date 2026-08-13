import { eq, inArray, sql } from "drizzle-orm";

import { companies, documents, type Document } from "../db/schema";
import { BseAttachmentNotFoundError } from "../lib/acquisition/bse/client";
import { claimNextDocument, createDatabaseClient, scheduleDocumentRetry, type DatabaseClient } from "../lib/db";
import { DownloadHttpError } from "../lib/ingestion/download-strategies";
import { ingestDocument, type IngestSource } from "../lib/ingestion/ingest";
import { requiredWorkerEnvironment } from "./env";
import { errorCode, FailureWindow, isRetryableNetworkError } from "./resilience";

const HEARTBEAT_MS = 5 * 60 * 1_000;
const LOOP_ERROR_PAUSE_MS = 5_000;

function numberOption(name: string) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? Number(process.argv[index + 1]) : undefined;
  if (value !== undefined && (!Number.isInteger(value) || value <= 0)) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const once = process.argv.includes("--once");
const retryFailed = process.argv.includes("--retry-failed");
const maximum = numberOption("--max") ?? (once ? 1 : Number.POSITIVE_INFINITY);
let stopping = false;
let fatalUnhandled = false;
const unhandledFailures = new FailureWindow();

function reportUnhandled(kind: "uncaught_exception" | "unhandled_rejection", error: unknown) {
  const failure = unhandledFailures.record();
  console.error(JSON.stringify({
    worker: "documents",
    event: kind,
    error: errorMessage(error),
    code: errorCode(error),
    recentUnhandledFailures: failure.count,
  }));
  if (failure.tripped) {
    fatalUnhandled = true;
    stopping = true;
    console.error(JSON.stringify({
      worker: "documents",
      event: "unhandled_failure_circuit_open",
      limit: 5,
      windowSeconds: 60,
      action: "stopping",
    }));
  }
}

process.on("uncaughtException", (error) => reportUnhandled("uncaught_exception", error));
process.on("unhandledRejection", (reason) => reportUnhandled("unhandled_rejection", reason));
process.on("SIGINT", () => { stopping = true; console.log(JSON.stringify({ worker: "documents", event: "shutdown_requested" })); });
process.on("SIGTERM", () => { stopping = true; console.log(JSON.stringify({ worker: "documents", event: "shutdown_requested" })); });

const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function resetDocumentsForRetry(db: DatabaseClient) {
  const requeued = await db
    .update(documents)
    .set({
      status: "discovered",
      attempts: 0,
      lastError: null,
      nextAttemptAt: null,
      updatedAt: sql`now()`,
    })
    .where(inArray(documents.status, ["discovered", "failed"]))
    .returning({ id: documents.id, source: documents.source });
  const bySource = requeued.reduce<Record<string, number>>((counts, document) => {
    counts[document.source] = (counts[document.source] ?? 0) + 1;
    return counts;
  }, {});
  console.log(JSON.stringify({
    worker: "documents",
    event: "documents_reset_for_retry",
    count: requeued.length,
    bySource,
    statuses: ["discovered", "failed"],
    attemptsReset: true,
  }));
}

async function logHeartbeat(db: DatabaseClient) {
  const [queue] = await db.select({
    pending: sql<number>`count(*) filter (where ${documents.status} = 'discovered')::int`,
    nextAttemptAt: sql<Date | null>`min(coalesce(${documents.nextAttemptAt}, now())) filter (where ${documents.status} = 'discovered')`,
  }).from(documents);
  console.log(JSON.stringify({
    worker: "documents",
    event: "heartbeat",
    documentsPending: queue?.pending ?? 0,
    nextAttemptAt: queue?.nextAttemptAt instanceof Date ? queue.nextAttemptAt.toISOString() : queue?.nextAttemptAt ?? null,
  }));
}

async function persistDocumentFailure(db: DatabaseClient, document: Document, error: unknown) {
  const message = errorMessage(error).slice(0, 2_000);
  const terminal = error instanceof BseAttachmentNotFoundError || (error instanceof DownloadHttpError && error.status === 404);
  let nextAttemptAt: string | null = null;
  let recordError: string | null = null;

  if (!terminal) {
    try {
      const scheduled = await scheduleDocumentRetry(db, document.id, message);
      nextAttemptAt = scheduled.nextAttemptAt?.toISOString() ?? null;
    } catch (scheduleError) {
      // If the database connection itself is the transient fault, the lease
      // written by claimNextDocument keeps the document out of a tight loop.
      recordError = errorMessage(scheduleError);
    }
  }

  console.error(JSON.stringify({
    worker: "documents",
    event: "document_processing_failed",
    documentId: document.id,
    source: document.source,
    statusAtClaim: document.status,
    outcome: terminal ? "failed" : "retry_scheduled",
    retryableNetworkError: isRetryableNetworkError(error),
    error: message,
    code: errorCode(error),
    nextAttemptAt,
    ...(recordError ? { retryRecordError: recordError } : {}),
  }));
}

async function processDocument(db: DatabaseClient, document: Document) {
  const startedAt = Date.now();
  let companyName: string | null = null;
  try {
    if (document.companyId) {
      const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, document.companyId)).limit(1);
      companyName = company?.name ?? null;
    }
    if (!document.url) throw new Error("Discovered document has no attachment URL.");
    const result = await ingestDocument({
      db,
      existingDocumentId: document.id,
      source: document.source as IngestSource,
      url: document.url,
      title: document.title ?? undefined,
      companyHint: companyName ?? undefined,
    });
    console.log(JSON.stringify({
      worker: "documents",
      documentId: document.id,
      company: companyName,
      stage: result.status,
      durationMs: Date.now() - startedAt,
      outcome: result.outcome,
    }));
  } catch (error) {
    await persistDocumentFailure(db, document, error);
  }
}

async function main() {
  const { databaseUrl } = requiredWorkerEnvironment();
  const idleMs = Number(process.env.WORKER_IDLE_MS ?? 30_000);
  if (!Number.isFinite(idleMs) || idleMs < 1_000) throw new Error("WORKER_IDLE_MS must be at least 1000.");
  const { client, db } = createDatabaseClient(databaseUrl);
  let processed = 0;
  let lastHeartbeatAt = 0;

  try {
    if (retryFailed) await resetDocumentsForRetry(db);
    while (!stopping && processed < maximum) {
      try {
        const document = await claimNextDocument(db, "discovered");
        if (!document) {
          if (once) break;
          if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
            await logHeartbeat(db);
            lastHeartbeatAt = Date.now();
          }
          await sleep(idleMs);
          continue;
        }
        await processDocument(db, document);
        processed += 1;
      } catch (error) {
        // Includes database/socket faults while claiming work or emitting a
        // heartbeat. Continue after a short pause; no claimed document is lost.
        console.error(JSON.stringify({
          worker: "documents",
          event: "worker_loop_error",
          error: errorMessage(error),
          code: errorCode(error),
          retryableNetworkError: isRetryableNetworkError(error),
        }));
        if (!stopping) await sleep(LOOP_ERROR_PAUSE_MS);
      }
    }
    console.log(JSON.stringify({ worker: "documents", event: "stopped", processed, reason: fatalUnhandled ? "unhandled_failure_circuit_open" : "completed_or_shutdown" }));
  } finally {
    await client.end({ timeout: 5 });
  }
  if (fatalUnhandled) process.exitCode = 1;
}

main().catch((error) => {
  // Startup failures (configuration/client construction) occur before any
  // document can be safely claimed, so surface them rather than pretending the
  // worker can make progress without a database.
  console.error(JSON.stringify({ worker: "documents", event: "startup_failed", error: errorMessage(error), code: errorCode(error) }));
  process.exitCode = 1;
});
