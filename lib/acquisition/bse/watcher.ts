import { createHash } from "node:crypto";

import { and, eq, gte, sql } from "drizzle-orm";

import { companies, discoveredAnnouncements, documents, watcherState } from "@/db/schema";
import type { DatabaseClient } from "@/lib/db";
import { normalizeEntityName } from "@/lib/entity-normalization";

import {
  BSE_MAX_CONSECUTIVE_FAILURES,
  BSE_MAX_REQUESTS_PER_RUN,
  BSE_MIN_POLL_INTERVAL_MS,
  BseBlockedError,
  BseClient,
  BseRequestError,
  BseRequestLimitError,
  type Announcement,
} from "./client";

const initialLookbackMs = 24 * 60 * 60 * 1_000;
const BSE_BLOCK_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const ratingLanguage = /\b(credit\s*rating|rating\s*action|rating\s*agency|crisil|icra|care\s*ratings?|india\s*ratings?|ind[- ]?ra|acuite|brickwork|infomerics)\b/i;
const bseLegalSuffix = /\b(?:limited|ltd|private|pvt|plc|inc|incorporated|corporation|corp|company|co|llp|llc|gmbh|sa|nv|bv|ag|pte)\.?\s*$/i;
const bseTrailingGroupMarker = /\s*-\s*[^\p{L}\p{N}\s]\s*$/u;

export type BseWatchSummary = {
  skipped?: "disabled_until" | "poll_interval" | "circuit_open" | "no_mapped_companies";
  polledCompanies: number;
  skippedCompanies: number;
  announcementsSeen: number;
  relevant: number;
  linked: number;
  ignored: number;
  failures: number;
  dryRun: boolean;
  force: boolean;
  since: string | null;
  companyCounts: BseCompanyCounts[];
};

export type BseCompanyCounts = {
  company: string;
  scripCode: string | null;
  announcementsSeen: number;
  relevant: number;
  linked: number;
  ignored: number;
  failed: number;
  skipped?: "missing_bse_scrip_code";
};

export type BseWatcherState = typeof watcherState.$inferSelect;

export function isRatingAnnouncement(announcement: Pick<Announcement, "headline" | "category" | "subCategory">) {
  return ratingLanguage.test([announcement.headline, announcement.category, announcement.subCategory].filter(Boolean).join(" "));
}

/** Guard against a mistyped manual scrip mapping attaching another company's filings. */
export function bseCompanyNameMatches(mappedCompanyName: string, announcementCompanyName: string) {
  return normalizeEntityName(stripBseListingGroupMarker(mappedCompanyName))
    === normalizeEntityName(stripBseListingGroupMarker(announcementCompanyName));
}

/**
 * BSE sometimes appends a one-character listing group to the legal company name
 * (for example, "Modison Ltd-$"). It is not part of the issuer identity. Only
 * remove it when it follows a recognised legal suffix so meaningful name tokens
 * can never be silently discarded.
 */
export function stripBseListingGroupMarker(name: string) {
  const trimmed = name.trim();
  const withoutMarker = trimmed.replace(bseTrailingGroupMarker, "").trim();
  return withoutMarker !== trimmed && bseLegalSuffix.test(withoutMarker) ? withoutMarker : trimmed;
}

function provisionalHash(announcement: Announcement) {
  return createHash("sha256").update(`bse-announcement:${announcement.bseAnnouncementId}`).digest("hex");
}

function since(state: typeof watcherState.$inferSelect | undefined) {
  return state?.lastAnnouncementDate ?? new Date(Date.now() - initialLookbackMs);
}

export async function getBseWatcherState(db: DatabaseClient): Promise<BseWatcherState | undefined> {
  const [state] = await db.select().from(watcherState).where(eq(watcherState.source, "bse")).limit(1);
  return state;
}

export async function disableBseWatcher(input: {
  db: DatabaseClient;
  state: BseWatcherState | undefined;
  now: Date;
  status: 403 | 429;
  advancePoll: boolean;
}) {
  const disabledUntil = new Date(input.now.getTime() + BSE_BLOCK_COOLDOWN_MS);
  const lastError = `BSE returned HTTP ${input.status}; disabled until ${disabledUntil.toISOString()}.`;
  await input.db.insert(watcherState).values({
    source: "bse",
    lastPolledAt: input.advancePoll ? input.now : input.state?.lastPolledAt ?? null,
    lastAnnouncementDate: input.state?.lastAnnouncementDate ?? null,
    consecutiveFailures: 0,
    lastError,
    disabledUntil,
  }).onConflictDoUpdate({
    target: watcherState.source,
    set: {
      lastPolledAt: input.advancePoll ? input.now : input.state?.lastPolledAt ?? null,
      lastAnnouncementDate: input.state?.lastAnnouncementDate ?? null,
      consecutiveFailures: 0,
      lastError,
      disabledUntil,
      updatedAt: sql`now()`,
    },
  });
  return { disabledUntil, lastError };
}

async function recordAnnouncement(
  db: DatabaseClient,
  companyId: string,
  announcement: Announcement,
  status: "new" | "ignored" | "failed",
  failureReason: string | null = null,
) {
  const [saved] = await db.insert(discoveredAnnouncements).values({
    source: "bse",
    externalId: announcement.bseAnnouncementId,
    scripCode: announcement.scripCode,
    companyId,
    headline: announcement.headline,
    category: announcement.category,
    announcementDate: announcement.announcementDate,
    attachmentUrl: announcement.attachmentUrl,
    rawPayload: announcement.rawPayload,
    status,
    failureReason,
  }).onConflictDoUpdate({
    target: [discoveredAnnouncements.source, discoveredAnnouncements.externalId],
    set: {
      companyId,
      headline: announcement.headline,
      category: announcement.category,
      announcementDate: announcement.announcementDate,
      attachmentUrl: announcement.attachmentUrl,
      rawPayload: announcement.rawPayload,
      status: sql`case when ${discoveredAnnouncements.documentId} is null then ${status} else ${discoveredAnnouncements.status} end`,
      failureReason,
    },
  }).returning();
  if (!saved) throw new Error(`Could not record BSE announcement ${announcement.bseAnnouncementId}.`);
  return saved;
}

/** One idempotent acquisition cycle. It never downloads or classifies a PDF. */
export async function watchBse(input: {
  db: DatabaseClient;
  dryRun?: boolean;
  force?: boolean;
  since?: Date;
  client?: BseClient;
  now?: Date;
}): Promise<BseWatchSummary> {
  const { db, dryRun = false } = input;
  const now = input.now ?? new Date();
  const client = input.client ?? new BseClient();
  const state = await getBseWatcherState(db);
  const manualBackfill = input.since !== undefined;
  const force = input.force === true || manualBackfill;
  const summary: BseWatchSummary = {
    polledCompanies: 0, skippedCompanies: 0, announcementsSeen: 0, relevant: 0, linked: 0, ignored: 0, failures: 0,
    dryRun, force, since: input.since?.toISOString() ?? null, companyCounts: [],
  };
  if (state?.disabledUntil && state.disabledUntil > now) return { ...summary, skipped: "disabled_until" };
  const pollIntervalActive = state && now.getTime() - (state.lastPolledAt?.getTime() ?? 0) < BSE_MIN_POLL_INTERVAL_MS;
  if (pollIntervalActive && !force) return { ...summary, skipped: "poll_interval" };
  if (pollIntervalActive && force) {
    console.warn(JSON.stringify({
      source: "bse", event: "poll_interval_bypassed", reason: manualBackfill ? "manual_since" : "force",
      last_polled_at: state.lastPolledAt?.toISOString() ?? null, since: input.since?.toISOString() ?? null,
    }));
  }
  if ((state?.consecutiveFailures ?? 0) >= BSE_MAX_CONSECUTIVE_FAILURES) return { ...summary, skipped: "circuit_open" };

  const mappedCompanies = await db.select().from(companies);
  let latestAnnouncementDate = state?.lastAnnouncementDate ?? null;
  const sourceErrors: string[] = [];
  let transportFailures = 0;
  let consecutiveRequestFailures = 0;
  for (const company of mappedCompanies) {
    if (!company.bseScripCode) {
      summary.skippedCompanies += 1;
      summary.companyCounts.push({ company: company.slug, scripCode: null, announcementsSeen: 0, relevant: 0, linked: 0, ignored: 0, failed: 0, skipped: "missing_bse_scrip_code" });
      console.warn(JSON.stringify({ source: "bse", event: "company_skipped", company: company.slug, reason: "missing_bse_scrip_code" }));
      continue;
    }
    const companyCounts: BseCompanyCounts = { company: company.slug, scripCode: company.bseScripCode, announcementsSeen: 0, relevant: 0, linked: 0, ignored: 0, failed: 0 };
    summary.companyCounts.push(companyCounts);
    summary.polledCompanies += 1;
    try {
      const announcements = await client.announcements({ scripCode: company.bseScripCode, from: input.since ?? since(state), to: now });
      consecutiveRequestFailures = 0;
      let scripNameMismatchCount = 0;
      for (const announcement of announcements) {
        summary.announcementsSeen += 1;
        companyCounts.announcementsSeen += 1;
        if (!latestAnnouncementDate || announcement.announcementDate > latestAnnouncementDate) latestAnnouncementDate = announcement.announcementDate;
        if (!bseCompanyNameMatches(company.name, announcement.companyName)) {
          const mismatch = `BSE scrip-name mismatch: mapped '${company.name}' but announcement names '${announcement.companyName}' (scrip ${company.bseScripCode}).`;
          await recordAnnouncement(db, company.id, announcement, "failed", mismatch);
          summary.failures += 1;
          companyCounts.failed += 1;
          scripNameMismatchCount += 1;
          continue;
        }
        const relevant = isRatingAnnouncement(announcement);
        const saved = await recordAnnouncement(db, company.id, announcement, relevant && announcement.attachmentUrl ? "new" : "ignored");
        if (!relevant || !announcement.attachmentUrl) {
          summary.ignored += 1;
          companyCounts.ignored += 1;
          if (saved.status !== "ignored") await db.update(discoveredAnnouncements).set({ status: "ignored" }).where(eq(discoveredAnnouncements.id, saved.id));
          continue;
        }
        summary.relevant += 1;
        companyCounts.relevant += 1;
        if (saved.documentId) continue;
        if (dryRun) {
          summary.linked += 1;
          companyCounts.linked += 1;
          continue;
        }
        const [createdDocument] = await db.insert(documents).values({
          companyId: company.id,
          source: "bse",
          title: announcement.headline,
          url: announcement.attachmentUrl,
          sha256: provisionalHash(announcement),
          status: "discovered",
          metadata: { acquisition: { source: "bse", announcementId: announcement.bseAnnouncementId, announcedAt: announcement.announcementDate.toISOString() } },
        }).onConflictDoNothing().returning();
        // Recover cleanly if a process stopped after reserving the document but
        // before it linked the announcement. The provisional hash is unique per
        // announcement until the worker replaces it with the PDF content hash.
        const document = createdDocument ?? (await db.select().from(documents).where(eq(documents.sha256, provisionalHash(announcement))).limit(1))[0];
        if (!document) throw new Error(`Could not create document for BSE announcement ${announcement.bseAnnouncementId}.`);
        await db.update(discoveredAnnouncements).set({ documentId: document.id, status: "linked" }).where(eq(discoveredAnnouncements.id, saved.id));
        summary.linked += 1;
        companyCounts.linked += 1;
      }
      if (scripNameMismatchCount > 0) {
        console.error(JSON.stringify({
          source: "bse",
          event: "scrip_name_mismatch_summary",
          company: company.slug,
          mapped_name: company.name,
          scrip_code: company.bseScripCode,
          count: scripNameMismatchCount,
          detail: "Individual mismatch details are recorded in discovered_announcements.",
        }));
      }
    } catch (error) {
      summary.failures += 1;
      companyCounts.failed += 1;
      transportFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      sourceErrors.push(`${company.slug}: ${message}`);
      if (error instanceof BseBlockedError) {
        const { disabledUntil } = await disableBseWatcher({ db, state, now, status: error.status as 403 | 429, advancePoll: !manualBackfill });
        console.error(JSON.stringify({ source: "bse", event: "source_blocked", status: error.status, disabled_until: disabledUntil.toISOString(), company: company.slug }));
        return { ...summary, skipped: "disabled_until" };
      }
      if (error instanceof BseRequestLimitError) {
        console.warn(JSON.stringify({ source: "bse", event: "request_limit_reached", limit: BSE_MAX_REQUESTS_PER_RUN, company: company.slug }));
        break;
      }
      consecutiveRequestFailures += error instanceof BseRequestError ? error.attempts : 1;
      if (consecutiveRequestFailures >= BSE_MAX_CONSECUTIVE_FAILURES) {
        console.error(JSON.stringify({ source: "bse", event: "consecutive_failures_hard_stop", failures: consecutiveRequestFailures, company: company.slug }));
        break;
      }
    }
  }
  // Do not consume the 30-minute source window before the operator has mapped
  // at least one scrip code. Mapping is intentionally manual and may happen
  // immediately after this first status check.
  if (summary.polledCompanies === 0) return { ...summary, skipped: "no_mapped_companies" };
  const failed = transportFailures > 0;
  const nextWatermark = manualBackfill
    ? state?.lastAnnouncementDate ?? null
    : failed
    ? state?.lastAnnouncementDate ?? null
    : latestAnnouncementDate ?? now;
  const nextConsecutiveFailures = failed ? (state?.consecutiveFailures ?? 0) + 1 : 0;
  await db.insert(watcherState).values({
    source: "bse", lastPolledAt: manualBackfill ? state?.lastPolledAt ?? null : now, lastAnnouncementDate: nextWatermark,
    consecutiveFailures: nextConsecutiveFailures,
    lastError: failed ? sourceErrors.join(" | ").slice(0, 2_000) : null,
    disabledUntil: null,
  }).onConflictDoUpdate({
    target: watcherState.source,
    set: {
      lastPolledAt: manualBackfill ? state?.lastPolledAt ?? null : now, lastAnnouncementDate: nextWatermark,
      consecutiveFailures: nextConsecutiveFailures,
      lastError: failed ? sourceErrors.join(" | ").slice(0, 2_000) : null,
      disabledUntil: null,
      updatedAt: sql`now()`,
    },
  });
  return summary;
}

export async function listBseWatchStatus(db: DatabaseClient) {
  const state = await db.select().from(watcherState).where(eq(watcherState.source, "bse"));
  const announcements = await db.select({
    id: discoveredAnnouncements.id, externalId: discoveredAnnouncements.externalId, headline: discoveredAnnouncements.headline,
    status: discoveredAnnouncements.status, announcementDate: discoveredAnnouncements.announcementDate,
    company: companies.name, scripCode: discoveredAnnouncements.scripCode, documentId: discoveredAnnouncements.documentId,
    failureReason: discoveredAnnouncements.failureReason,
  }).from(discoveredAnnouncements).leftJoin(companies, eq(discoveredAnnouncements.companyId, companies.id))
    .where(eq(discoveredAnnouncements.source, "bse")).orderBy(sql`${discoveredAnnouncements.createdAt} desc`).limit(20);
  return { state: state[0] ?? null, announcements };
}

/** Read-only relevance-filter diagnostic; it never calls BSE or mutates the ledger. */
export async function listBseIgnoredAnnouncements(db: DatabaseClient, input: { since?: Date } = {}) {
  const conditions = [
    eq(discoveredAnnouncements.source, "bse"),
    eq(discoveredAnnouncements.status, "ignored"),
    ...(input.since ? [gte(discoveredAnnouncements.announcementDate, input.since)] : []),
  ];
  return db.select({
    id: discoveredAnnouncements.id,
    externalId: discoveredAnnouncements.externalId,
    company: companies.name,
    scripCode: discoveredAnnouncements.scripCode,
    headline: discoveredAnnouncements.headline,
    category: discoveredAnnouncements.category,
    announcementDate: discoveredAnnouncements.announcementDate,
    attachmentUrl: discoveredAnnouncements.attachmentUrl,
  }).from(discoveredAnnouncements)
    .leftJoin(companies, eq(discoveredAnnouncements.companyId, companies.id))
    .where(and(...conditions))
    .orderBy(sql`${companies.name} asc`, sql`${discoveredAnnouncements.announcementDate} desc`);
}
