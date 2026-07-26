import { eq } from "drizzle-orm";

import { documents } from "./schema";
import { loadStaticGraphFiles } from "./static-graphs";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";

async function main() {
  const staticFiles = await loadStaticGraphFiles();
  const { client, db } = createDatabaseClient(requiredDirectUrl());

  try {
    for (const staticFile of staticFiles) {
      const [document] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.sha256, staticFile.hash))
        .limit(1);

      if (!document) {
        throw new Error(`${staticFile.fileName}: imported document was not found.`);
      }

      await db
        .update(documents)
        .set({
          metadata: {
            keyRisks: staticFile.graph.key_risks,
            reportDateRaw: staticFile.graph.report_date,
          },
        })
        .where(eq(documents.id, document.id));
    }
  } finally {
    await client.end({ timeout: 5 });
  }

  console.log(`Backfilled static metadata for ${staticFiles.length} document(s).`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
