import assert from "node:assert/strict";
import test from "node:test";

import { companies, discoveredAnnouncements, watcherState } from "@/db/schema";
import type { DatabaseClient } from "@/lib/db";

import { BseClient } from "./client";
import { watchBse } from "./watcher";

function watchDatabase(input: { state?: Record<string, unknown>; companies?: Array<Record<string, unknown>> } = {}) {
  let persistedState: Record<string, unknown> | undefined;
  const recordedAnnouncements: Array<Record<string, unknown>> = [];
  const companiesToWatch = input.companies ?? [{ id: "00000000-0000-0000-0000-000000000001", name: "Test Company Limited", slug: "test-company", bseScripCode: "532500" }];
  const stateRows = input.state ? [input.state] : [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === companies ? companiesToWatch : stateRows;
        return {
          where: () => ({ limit: async () => rows }),
          then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        if (table === discoveredAnnouncements) {
          recordedAnnouncements.push(value);
          return {
            onConflictDoUpdate: () => ({
              returning: async () => [{ id: `announcement-${recordedAnnouncements.length}`, status: value.status, documentId: null }],
            }),
          };
        }
        persistedState = value;
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  };
  return { db: db as unknown as DatabaseClient, persistedState: () => persistedState, recordedAnnouncements };
}

test("a BSE 403 disables the source for at least 24 hours and stops the run", async () => {
  const { db, persistedState } = watchDatabase();
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

test("a manual --since backfill bypasses only the interval gate and keeps the normal watermark", async () => {
  const previousPoll = new Date("2026-07-31T11:45:00.000Z");
  const previousWatermark = new Date("2026-07-30T18:30:00.000Z");
  const now = new Date("2026-07-31T12:00:00.000Z");
  const { db, persistedState } = watchDatabase({
    state: {
      source: "bse", lastPolledAt: previousPoll, lastAnnouncementDate: previousWatermark,
      consecutiveFailures: 0, lastError: null, disabledUntil: null, updatedAt: previousPoll,
    },
  });
  const emptyClient = { announcements: async () => [] } as unknown as BseClient;

  const summary = await watchBse({ db, client: emptyClient, now, dryRun: true, since: new Date("2026-01-01T00:00:00.000Z") });

  assert.equal(summary.skipped, undefined);
  assert.equal(summary.force, true);
  assert.equal(summary.since, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(summary.companyCounts, [{
    company: "test-company", scripCode: "532500", announcementsSeen: 0, relevant: 0, linked: 0, ignored: 0, failed: 0,
  }]);
  assert.equal((persistedState()?.lastAnnouncementDate as Date).toISOString(), previousWatermark.toISOString());
  assert.equal((persistedState()?.lastPolledAt as Date).toISOString(), previousPoll.toISOString());
});

test("--force bypasses an active poll interval but not an active source disable", async () => {
  const now = new Date("2026-07-31T12:00:00.000Z");
  const { db } = watchDatabase({
    state: {
      source: "bse", lastPolledAt: new Date("2026-07-31T11:55:00.000Z"), lastAnnouncementDate: null,
      consecutiveFailures: 0, lastError: "BSE returned HTTP 429", disabledUntil: new Date("2026-08-01T12:00:00.000Z"), updatedAt: now,
    },
  });
  const neverCallClient = { announcements: async () => { throw new Error("BSE must not be called while disabled"); } } as unknown as BseClient;

  const summary = await watchBse({ db, client: neverCallClient, now, force: true });

  assert.equal(summary.force, true);
  assert.equal(summary.skipped, "disabled_until");
  assert.equal(summary.polledCompanies, 0);
});

test("BSE reports repeated scrip-name mismatches once per company while retaining each announcement", async () => {
  const { db, recordedAnnouncements } = watchDatabase();
  const client = {
    announcements: async () => [
      {
        bseAnnouncementId: "wrong-1", scripCode: "532500", companyName: "Different Company Limited", headline: "Update",
        category: null, subCategory: null, announcementDate: new Date("2026-07-31T12:00:00.000Z"), attachmentUrl: null, rawPayload: {},
      },
      {
        bseAnnouncementId: "wrong-2", scripCode: "532500", companyName: "Different Company Limited", headline: "Another update",
        category: null, subCategory: null, announcementDate: new Date("2026-07-31T12:01:00.000Z"), attachmentUrl: null, rawPayload: {},
      },
    ],
  } as unknown as BseClient;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...values: unknown[]) => { errors.push(values.map(String).join(" ")); };
  try {
    const summary = await watchBse({ db, client, now: new Date("2026-07-31T13:00:00.000Z") });
    assert.equal(summary.failures, 2);
  } finally {
    console.error = originalError;
  }

  assert.equal(recordedAnnouncements.length, 2);
  assert.equal(errors.length, 1);
  assert.deepEqual(JSON.parse(errors[0]!), {
    source: "bse",
    event: "scrip_name_mismatch_summary",
    company: "test-company",
    mapped_name: "Test Company Limited",
    scrip_code: "532500",
    count: 2,
    detail: "Individual mismatch details are recorded in discovered_announcements.",
  });
});
