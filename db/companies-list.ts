import { desc, eq, sql } from "drizzle-orm";

import { companies, documents } from "./schema";
import { createDatabaseClient } from "../lib/db/client";
import { requiredDirectUrl } from "./env";

async function main() {
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const rows = await db.select({
      slug: companies.slug, name: companies.name, bseScripCode: companies.bseScripCode, nseSymbol: companies.nseSymbol,
      publishedDocuments: sql<number>`count(distinct ${documents.id}) filter (where ${documents.status} = 'published')::int`,
    }).from(companies).leftJoin(documents, eq(documents.companyId, companies.id))
      .groupBy(companies.id).orderBy(companies.slug);
    console.table(rows.map((row) => ({ slug: row.slug, name: row.name, bse_scrip_code: row.bseScripCode ?? "—", nse_symbol: row.nseSymbol ?? "—", published_documents: row.publishedDocuments })));
  } finally { await client.end({ timeout: 5 }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
