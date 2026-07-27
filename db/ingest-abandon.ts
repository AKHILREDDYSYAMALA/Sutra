import { eq, sql } from "drizzle-orm";

import { documents } from "./schema";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";
import { advanceDocumentStatus } from "../lib/db/queries";

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const id = valueAfter(args, "--id");
  const reason = valueAfter(args, "--reason") ?? "Abandoned by operator.";
  if (!id) throw new Error("Usage: npm run ingest:abandon -- --id <documentId> [--reason <reason>]");

  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const [document] = await db.select().from(documents).where(eq(documents.id, id)).limit(1);
    if (!document) throw new Error(`Document ${id} was not found.`);
    if (document.status === "published" || document.status === "excluded" || document.status === "superseded_document") {
      throw new Error(`Document ${id} is terminal (${document.status}) and cannot be abandoned.`);
    }
    if (document.status !== "failed") await advanceDocumentStatus(db, id, "failed");
    const [abandoned] = await db
      .update(documents)
      .set({ lastError: reason, nextAttemptAt: null, updatedAt: sql`now()` })
      .where(eq(documents.id, id))
      .returning();
    console.log(JSON.stringify({ id: abandoned?.id, status: abandoned?.status, reason: abandoned?.lastError }, null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
