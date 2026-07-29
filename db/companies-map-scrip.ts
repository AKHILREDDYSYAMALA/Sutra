import { eq } from "drizzle-orm";

import { companies } from "./schema";
import { createDatabaseClient } from "../lib/db/client";
import { requiredDirectUrl } from "./env";

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const slug = option("--slug");
const scrip = option("--scrip");
const nse = option("--nse");
if (!slug || !scrip || !/^\d{1,12}$/.test(scrip)) throw new Error("Usage: npm run companies:map-scrip -- --slug <slug> --scrip <numeric-code> [--nse <symbol>]");
const selectedSlug: string = slug;
const selectedScrip: string = scrip;
async function main() {
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const [company] = await db.update(companies).set({ bseScripCode: selectedScrip, ...(nse ? { nseSymbol: nse.toUpperCase() } : {}) }).where(eq(companies.slug, selectedSlug)).returning();
    if (!company) throw new Error(`Company '${selectedSlug}' was not found.`);
    console.log(JSON.stringify({ slug: company.slug, bse_scrip_code: company.bseScripCode, nse_symbol: company.nseSymbol }, null, 2));
  } finally { await client.end({ timeout: 5 }); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
