import { createDatabaseClient } from "../lib/db/client";
import { requiredDirectUrl } from "./env";
import { listBseWatchStatus } from "../lib/acquisition/bse/watcher";

async function main() {
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const { state, announcements } = await listBseWatchStatus(db);
    console.log("watcher_state", state ?? "not yet polled");
    console.table(announcements.map((row) => ({ id: row.id, company: row.company ?? "—", scrip_code: row.scripCode, status: row.status, announcement_date: row.announcementDate.toISOString(), headline: row.headline, document_id: row.documentId ?? "—" })));
  } finally { await client.end({ timeout: 5 }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
