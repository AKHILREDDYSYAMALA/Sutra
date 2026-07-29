import postgres from "postgres";

import { requiredDirectUrl } from "./env";

const tables = [
  "users",
  "companies",
  "entities",
  "entity_aliases",
  "entity_merges",
  "entity_merge_rejections",
  "documents",
  "claims",
  "portfolios",
  "portfolio_holdings",
  "watchlists",
  "alerts",
  "user_reads",
  "company_requests",
  "watcher_state",
  "discovered_announcements",
  "events",
  "event_entities",
] as const;

async function checkDatabase() {
  const sql = postgres(requiredDirectUrl(), { max: 1, prepare: false });

  try {
    for (const table of tables) {
      const [result] = await sql.unsafe<{ count: number }[]>(
        `SELECT count(*)::int AS count FROM public."${table}"`,
      );
      console.log(`${table}: ${result?.count ?? 0}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

checkDatabase().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
