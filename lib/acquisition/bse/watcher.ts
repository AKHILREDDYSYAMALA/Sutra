import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";

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
};

export function isRatingAnnouncement(announcement: Pick<Announcement, "headline" | "category" | "subCategory">) {
  return ratingLanguage.test([announcement.headline, announcement.category, announcement.subCategory].filter(Boolean).join(" "));
}

/** Guard against a mistyped manual scrip mapping attaching another company's filings. */
export function bseCompanyNameMatches(mappedCompanyName: string, announcementCompanyName: string) {
  return normalizeEntityName(mappedCompanyName) === normalizeEntityName(announcementCompanyName);
}

function provisionalHash(announcement: Announcement) {
  return createHash("sha256").update(`bse-announcement:${announcement.bseAnnouncementId}`).digest("hex");
}

function since(state: typeof watcherState.$inferSelect | undefined) {
  return state?.lastAnnouncementDate ?? new Date(Date.now() - initialLookbackMs);
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
export async function watchBse(input: { db: DatabaseClient; dryRun?: boolean; client?: BseClient; now?: Date }): Promise<BseWatchSummary> {
  const { db, dryRun = false } = input;
  const now = input.now ?? new Date();
  const client = input.client ?? new BseClient();
  const [state] = await db.select().from(watcherState).where(eq(watcherState.source, "bse")).limit(1);
  const summary: BseWatchSummary = { polledCompanies: 0, skippedCompanies: 0, announcementsSeen: 0, relevant: 0, linked: 0, ignored: 0, failures: 0, dryRun };
  if (state?.disabledUntil && state.disabledUntil > now) return { ...summary, skipped: "disabled_until" };
  if (state && now.getTime() - (state.lastPolledAt?.getTime() ?? 0) < BSE_MIN_POLL_INTERVAL_MS) return { ...summary, skipped: "poll_interval" };
  if ((state?.consecutiveFailures ?? 0) >= BSE_MAX_CONSECUTIVE_FAILURES) return { ...summary, skipped: "circuit_open" };

  const mappedCompanies = await db.select().from(companies);
  let latestAnnouncementDate = state?.lastAnnouncementDate ?? null;
  const sourceErrors: string[] = [];
  let transportFailures = 0;
  let consecutiveRequestFailures = 0;
  let blockedUntil: Date | null = null;
  for (const company of mappedCompanies) {
    if (!company.bseScripCode) {
      summary.skippedCompanies += 1;
      console.warn(JSON.stringify({ source: "bse", event: "company_skipped", company: company.slug, reason: "missing_bse_scrip_code" }));
      continue;
    }
    summary.polledCompanies += 1;
    try {
      const announcements = await client.announcements({ scripCode: company.bseScripCode, from: since(state), to: now });
      consecutiveRequestFailures = 0;
      for (const announcement of announcements) {
        summary.announcementsSeen += 1;
        if (!latestAnnouncementDate || announcement.announcementDate > latestAnnouncementDate) latestAnnouncementDate = announcement.announcementDate;
        if (!bseCompanyNameMatches(company.name, announcement.companyName)) {
          const mismatch = `BSE scrip-name mismatch: mapped '${company.name}' but announcement names '${announcement.companyName}' (scrip ${company.bseScripCode}).`;
          await recordAnnouncement(db, company.id, announcement, "failed", mismatch);
          summary.failures += 1;
          console.error(JSON.stringify({ source: "bse", event: "scrip_name_mismatch", company: company.slug, mapped_name: company.name, announcement_name: announcement.companyName, scrip_code: company.bseScripCode, announcement_id: announcement.bseAnnouncementId }));
          continue;
        }
        const relevant = isRatingAnnouncement(announcement);
        const saved = await recordAnnouncement(db, company.id, announcement, relevant && announcement.attachmentUrl ? "new" : "ignored");
        if (!relevant || !announcement.attachmentUrl) {
          summary.ignored += 1;
          if (saved.status !== "ignored") await db.update(discoveredAnnouncements).set({ status: "ignored" }).where(eq(discoveredAnnouncements.id, saved.id));
          continue;
        }
        summary.relevant += 1;
        if (saved.documentId) continue;
        if (dryRun) {
          summary.linked += 1;
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
      }
    } catch (error) {
      summary.failures += 1;
      transportFailures += 1;
      const message = error instanceof Error ? error.message : String(error);
      sourceErrors.push(`${company.slug}: ${message}`);
      if (error instanceof BseBlockedError) {
        blockedUntil = new Date(now.getTime() + BSE_BLOCK_COOLDOWN_MS);
        console.error(JSON.stringify({ source: "bse", event: "source_blocked", status: error.status, disabled_until: blockedUntil.toISOString(), company: company.slug }));
        break;
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
  const nextWatermark = failed
    ? state?.lastAnnouncementDate ?? null
    : latestAnnouncementDate ?? now;
  const nextConsecutiveFailures = blockedUntil
    ? 0
    : failed
      ? (state?.consecutiveFailures ?? 0) + 1
      : 0;
  await db.insert(watcherState).values({
    source: "bse", lastPolledAt: now, lastAnnouncementDate: nextWatermark,
    consecutiveFailures: nextConsecutiveFailures,
    lastError: failed ? sourceErrors.join(" | ").slice(0, 2_000) : null,
    disabledUntil: blockedUntil,
  }).onConflictDoUpdate({
    target: watcherState.source,
    set: {
      lastPolledAt: now, lastAnnouncementDate: nextWatermark,
      consecutiveFailures: nextConsecutiveFailures,
      lastError: failed ? sourceErrors.join(" | ").slice(0, 2_000) : null,
      disabledUntil: blockedUntil,
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
