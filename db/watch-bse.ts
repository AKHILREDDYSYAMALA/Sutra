import { createDatabaseClient } from "../lib/db/client";
import { requiredDirectUrl } from "./env";
import { watchBse } from "../lib/acquisition/bse/watcher";

const dryRun = process.argv.includes("--dry-run");
async function main() {
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try { console.log(JSON.stringify(await watchBse({ db, dryRun }))); }
  finally { await client.end({ timeout: 5 }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
