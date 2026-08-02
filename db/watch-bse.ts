import { BSE_MAX_CONSECUTIVE_FAILURES, BseBlockedError, BseClient } from "../lib/acquisition/bse/client";
import { disableBseWatcher, getBseWatcherState, watchBse } from "../lib/acquisition/bse/watcher";
import { createDatabaseClient } from "../lib/db/client";
import { requiredDirectUrl } from "./env";

const validFlags = "--dry-run, --force, --since <YYYY-MM-DD>, --single, --scrip <code>";

type WatchCliOptions = {
  dryRun: boolean;
  force: boolean;
  since: Date | undefined;
  single: boolean;
  scripCode: string | undefined;
};

function parseSince(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid --since date '${value}'. Use YYYY-MM-DD.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`Invalid --since date '${value}'. Use a real calendar date.`);
  return parsed;
}

function parseOptions(args: string[]): WatchCliOptions {
  const options: WatchCliOptions = { dryRun: false, force: false, since: undefined, single: false, scripCode: undefined };
  const seen = new Set<string>();
  const requireValue = (flag: string, index: number) => {
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value. Valid flags: ${validFlags}.`);
    return value;
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (seen.has(argument)) throw new Error(`Duplicate flag '${argument}'. Valid flags: ${validFlags}.`);
    switch (argument) {
      case "--dry-run":
        seen.add(argument);
        options.dryRun = true;
        break;
      case "--force":
        seen.add(argument);
        options.force = true;
        break;
      case "--single":
        seen.add(argument);
        options.single = true;
        break;
      case "--since":
        seen.add(argument);
        options.since = parseSince(requireValue(argument, index));
        index += 1;
        break;
      case "--scrip":
        seen.add(argument);
        options.scripCode = requireValue(argument, index);
        index += 1;
        break;
      default:
        throw new Error(`Unrecognised argument '${argument}'. Valid flags: ${validFlags}.`);
    }
  }

  if (options.scripCode && !options.single) throw new Error(`--scrip is only valid with --single. Valid flags: ${validFlags}.`);
  if (options.single && !options.scripCode) throw new Error(`--single requires --scrip <code>. Valid flags: ${validFlags}.`);
  return options;
}

async function singleScripCheck(input: { db: ReturnType<typeof createDatabaseClient>["db"]; code: string; since: Date | undefined; dryRun: boolean }) {
  const now = new Date();
  const state = await getBseWatcherState(input.db);
  if (state?.disabledUntil && state.disabledUntil > now) {
    console.log(JSON.stringify({ source: "bse", mode: "single", scripCode: input.code, skipped: "disabled_until", disabledUntil: state.disabledUntil.toISOString() }, null, 2));
    return;
  }
  if ((state?.consecutiveFailures ?? 0) >= BSE_MAX_CONSECUTIVE_FAILURES) {
    console.log(JSON.stringify({ source: "bse", mode: "single", scripCode: input.code, skipped: "circuit_open" }, null, 2));
    return;
  }

  const from = input.since ?? new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const bse = new BseClient();
  try {
    // One API page only; the client also makes its required session-page request.
    const announcements = await bse.announcements({ scripCode: input.code, from, to: now, maxPages: 1 });
    console.log(JSON.stringify({
      source: "bse",
      mode: "single",
      scripCode: input.code,
      dryRun: input.dryRun,
      since: input.since?.toISOString() ?? null,
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
  } catch (error) {
    if (!(error instanceof BseBlockedError) || (error.status !== 403 && error.status !== 429)) throw error;
    const { disabledUntil } = await disableBseWatcher({ db: input.db, state, now, status: error.status, advancePoll: false });
    console.error(JSON.stringify({ source: "bse", event: "source_blocked", status: error.status, disabled_until: disabledUntil.toISOString(), mode: "single", scrip_code: input.code }));
    console.log(JSON.stringify({ source: "bse", mode: "single", scripCode: input.code, skipped: "disabled_until", disabledUntil: disabledUntil.toISOString() }, null, 2));
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    if (options.single) {
      await singleScripCheck({ db, code: options.scripCode!, since: options.since, dryRun: options.dryRun });
      return;
    }
    console.log(JSON.stringify(
      await watchBse({ db, dryRun: options.dryRun, force: options.force, since: options.since }),
      null,
      2,
    ));
  } finally { await client.end({ timeout: 5 }); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
