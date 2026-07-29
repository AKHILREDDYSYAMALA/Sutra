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
  if (!id || !trigger || args.length !== 4) {
    throw new Error("Usage: npm run ingest:reprocess -- --id <documentId> --trigger <reason>");
  }
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    console.log(JSON.stringify(await reprocessDocument({ db, documentId: id, trigger }), null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
