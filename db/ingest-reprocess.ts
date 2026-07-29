import { and, eq, sql } from "drizzle-orm";

import { documents } from "./schema";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";
import { reprocessDocument } from "../lib/ingestion/reprocess";

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const id = valueAfter(args, "--id");
  const trigger = valueAfter(args, "--trigger");
  const nearTokenCeiling = args.includes("--near-token-ceiling");
  if (!trigger || Boolean(id) === nearTokenCeiling || args.length !== (id ? 4 : 3)) {
    throw new Error("Usage: npm run ingest:reprocess -- --id <documentId> --trigger <reason> | --near-token-ceiling --trigger <reason>");
  }
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    if (id) {
      console.log(JSON.stringify(await reprocessDocument({ db, documentId: id, trigger }), null, 2));
      return;
    }
    const candidates = await db
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(and(
        eq(documents.status, "ready_for_review"),
        eq(documents.docType, "rating_rationale"),
        sql`${documents.metadata} @> '{"extraction":{"near_token_ceiling":true}}'::jsonb`,
      ));
    const results: Array<Record<string, string | number>> = [];
    for (const candidate of candidates) {
      try {
        const result = await reprocessDocument({ db, documentId: candidate.id, trigger });
        results.push({ id: candidate.id, title: candidate.title ?? "—", status: result.status, new_claims: result.reconciliation.new_claims, quote_variants: result.quoteVariantCount });
      } catch (error) {
        results.push({ id: candidate.id, title: candidate.title ?? "—", status: "failed", new_claims: "—", quote_variants: error instanceof Error ? error.message : String(error) });
      }
    }
    console.table(results);
    if (results.some((result) => result.status === "failed")) process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
