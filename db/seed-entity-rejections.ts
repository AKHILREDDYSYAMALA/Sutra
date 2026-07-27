import { seedKnownEntityMergeRejections } from "./known-entity-rejections";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";

async function main() {
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const seeded = await seedKnownEntityMergeRejections(db);
    console.log(`Seeded ${seeded} known entity-merge rejection(s).`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
