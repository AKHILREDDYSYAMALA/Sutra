import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "../../db/schema";

export type DatabaseClient = ReturnType<typeof createDatabaseClient>["db"];

export function createDatabaseClient(connectionString: string) {
  const client = postgres(connectionString, {
    // Supabase's transaction pooler (DATABASE_URL, port 6543) rejects prepared statements.
    prepare: false,
  });

  return {
    client,
    db: drizzle(client, { schema }),
  };
}

let runtimeClient: ReturnType<typeof createDatabaseClient> | undefined;

/**
 * Server-only runtime database client. It deliberately uses DATABASE_URL, which
 * is Supabase's transaction pooler (port 6543).
 */
export function getDb() {
  if (!runtimeClient) {
    const databaseUrl = process.env.DATABASE_URL;

    if (!databaseUrl) {
      throw new Error(
        "DATABASE_URL is required. Set the Supabase transaction-pooler URL (port 6543).",
      );
    }

    runtimeClient = createDatabaseClient(databaseUrl);
  }

  return runtimeClient.db;
}

export const db = new Proxy({} as DatabaseClient, {
  get(_target, property, receiver) {
    return Reflect.get(getDb(), property, receiver);
  },
});
