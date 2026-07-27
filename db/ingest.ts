import { readFile } from "node:fs/promises";

import { createDatabaseClient } from "../lib/db/client";
import { ingestDocument, retryDocument, sourceForUrl } from "../lib/ingestion/ingest";
import { requiredDirectUrl } from "./env";

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const url = valueAfter(args, "--url");
  const filePath = valueAfter(args, "--file");
  const retryDocumentId = valueAfter(args, "--retry");
  const source = valueAfter(args, "--source");
  if (retryDocumentId && (url || filePath)) {
    throw new Error("Use --retry <documentId> by itself, or provide exactly one of --url / --file.");
  }
  if (!retryDocumentId && Boolean(url) === Boolean(filePath)) {
    throw new Error("Usage: npm run ingest -- --url <https://…pdf> | --file <path/to/report.pdf> | --retry <documentId> [--source manual] [--private]");
  }

  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const result = retryDocumentId
      ? await retryDocument({ db, documentId: retryDocumentId })
      : await ingestDocument({
        db,
        url,
        fileBuffer: filePath ? await readFile(filePath) : undefined,
        fileName: filePath,
        source: (source as Parameters<typeof ingestDocument>[0]["source"]) ?? (url ? sourceForUrl(url) : "manual"),
        isPrivate: args.includes("--private"),
      });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
