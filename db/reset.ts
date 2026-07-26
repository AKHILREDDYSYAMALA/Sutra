import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";

async function resetDatabase() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("db:reset is disabled when NODE_ENV=production.");
  }

  const directUrl = requiredDirectUrl();
  const sql = postgres(directUrl, { max: 1, prepare: false });

  try {
    // Development only: this removes every application object in public, then
    // applies the checked-in migration history from a clean schema.
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
  console.error(error);
  process.exitCode = 1;
});
