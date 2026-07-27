import { desc, eq, notInArray } from "drizzle-orm";

import { companies, documents } from "./schema";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";

async function main() {
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const rows = await db
      .select({
        id: documents.id,
        company: companies.name,
        status: documents.status,
        attempts: documents.attempts,
        lastError: documents.lastError,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .leftJoin(companies, eq(companies.id, documents.companyId))
      .where(notInArray(documents.status, ["published", "excluded"]))
      .orderBy(desc(documents.createdAt));
    console.table(rows.map((row) => ({
      id: row.id,
      company: row.company ?? "—",
      status: row.status,
      attempts: row.attempts,
      last_error: row.lastError ?? "—",
      created_at: row.createdAt.toISOString(),
    })));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
