import assert from "node:assert/strict";
import test from "node:test";

import { companies, watcherState } from "@/db/schema";
import type { DatabaseClient } from "@/lib/db";

import { BseClient } from "./client";
import { watchBse } from "./watcher";

function blockedWatchDatabase() {
  let persistedState: Record<string, unknown> | undefined;
  const company = { id: "00000000-0000-0000-0000-000000000001", slug: "test-company", bseScripCode: "532500" };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === companies ? [company] : [];
        return {
          where: () => ({ limit: async () => rows }),
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
      },
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => {
        persistedState = value;
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  };
  return { db: db as unknown as DatabaseClient, persistedState: () => persistedState };
}

test("a BSE 403 disables the source for at least 24 hours and stops the run", async () => {
  const { db, persistedState } = blockedWatchDatabase();
  const now = new Date("2026-07-31T12:00:00.000Z");
  const client = new BseClient({ fetch: async () => new Response("blocked", { status: 403 }) });

  const summary = await watchBse({ db, client, now });
  const disabledUntil = persistedState()?.disabledUntil as Date | null;

  assert.equal(summary.polledCompanies, 1);
  assert.equal(summary.failures, 1);
  assert.equal(disabledUntil?.toISOString(), "2026-08-01T12:00:00.000Z");
  assert.equal(persistedState()?.consecutiveFailures, 0);
  assert.match(String(persistedState()?.lastError), /HTTP 403/);
});
