import { createDatabaseClient } from "../lib/db/client";
import { requiredDirectUrl } from "./env";
import { BseClient } from "../lib/acquisition/bse/client";
import { watchBse } from "../lib/acquisition/bse/watcher";

const dryRun = process.argv.includes("--dry-run");
const single = process.argv.includes("--single");
const scripIndex = process.argv.indexOf("--scrip");
const scripCode = scripIndex >= 0 ? process.argv[scripIndex + 1] : undefined;

async function singleScripCheck(code: string) {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1_000);
  const bse = new BseClient();
  // One API page only; the client also makes its required session-page request.
  const announcements = await bse.announcements({ scripCode: code, from, to, maxPages: 1 });
  console.log(JSON.stringify({
    source: "bse",
    mode: "single",
    scripCode: code,
    apiPages: 1,
    httpRequests: bse.requestsMade,
    announcements: announcements.map((announcement) => ({
      id: announcement.bseAnnouncementId,
      company: announcement.companyName,
      date: announcement.announcementDate.toISOString(),
      headline: announcement.headline,
      attachmentUrl: announcement.attachmentUrl,
    })),
  }, null, 2));
}

async function main() {
  if (single) {
    if (!scripCode || scripCode.startsWith("--")) throw new Error("Usage: npm run watch:bse -- --single --scrip <code>");
    await singleScripCheck(scripCode);
    return;
  }
  if (scripCode) throw new Error("--scrip is only valid with --single");
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try { console.log(JSON.stringify(await watchBse({ db, dryRun }))); }
  finally { await client.end({ timeout: 5 }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
