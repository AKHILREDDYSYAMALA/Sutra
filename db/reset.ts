import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { countedTables } from "./ledger-tables";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";

const CONFIRMATION = "RESET SUTRA DATABASE";

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function projectRefFromConnectionString(connectionString: string) {
  const parsed = new URL(connectionString);
  const username = decodeURIComponent(parsed.username);
  const usernameMatch = /^postgres\.([a-z0-9-]+)$/i.exec(username);
  if (usernameMatch) return usernameMatch[1];
  const hostMatch = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(parsed.hostname);
  return hostMatch?.[1] ?? null;
}

function assertDestructiveResetAllowed(directUrl: string) {
  if (process.env.NODE_ENV === "production" || process.env.VERCEL_ENV === "production") {
    throw new Error("db:reset is disabled in a production runtime.");
  }
  if (process.env.ALLOW_DESTRUCTIVE !== "1") {
    throw new Error("Refusing to reset. Set ALLOW_DESTRUCTIVE=1 and provide a typed confirmation.");
  }
  if (valueAfter(process.argv.slice(2), "--confirm") !== CONFIRMATION) {
    throw new Error(`Refusing to reset. Re-run with --confirm \"${CONFIRMATION}\".`);
  }

  const productionRef = process.env.PRODUCTION_SUPABASE_PROJECT_REF?.trim();
  if (!productionRef) {
    throw new Error("Refusing to reset until PRODUCTION_SUPABASE_PROJECT_REF is set. This protects the shared production project.");
  }
  if (projectRefFromConnectionString(directUrl) === productionRef) {
    throw new Error("Refusing to reset: DIRECT_URL points at the configured production Supabase project.");
  }
}

async function printRowCounts(sql: ReturnType<typeof postgres>) {
  console.log("Current row counts (the following data will be dropped):");
  for (const table of countedTables) {
    const [result] = await sql.unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM public."${table}"`);
    console.log(`  ${table}: ${result?.count ?? 0}`);
  }
}

async function resetDatabase() {
  const directUrl = requiredDirectUrl();
  assertDestructiveResetAllowed(directUrl);
  const sql = postgres(directUrl, { max: 1, prepare: false });

  try {
    await printRowCounts(sql);
    await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
    await sql.unsafe("CREATE SCHEMA public");
    await sql.unsafe("GRANT ALL ON SCHEMA public TO postgres");
    await sql.unsafe("GRANT ALL ON SCHEMA public TO public");
  } finally {
    await sql.end({ timeout: 5 });
  }

  const { client, db } = createDatabaseClient(directUrl);
  try {
    await migrate(db, { migrationsFolder: "./db/migrations" });
  } finally {
    await client.end({ timeout: 5 });
  }
}

resetDatabase().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
