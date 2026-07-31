# Sutra claims ledger

`db/schema.ts` is the source of truth for the relational model. Generate a SQL
migration after a schema change with `npm run db:generate`, review and commit the
new file under `db/migrations/`, then apply it with `npm run db:migrate`.

All database maintenance commands use `DIRECT_URL` (Supabase session pooler,
port 5432). The application client uses `DATABASE_URL` (transaction pooler,
port 6543) with prepared statements disabled.

## Vercel environment

Set `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`OPENAI_API_KEY` for the
Sutra Vercel application (Production and Preview as appropriate). `DATABASE_URL`
must be the Supabase **transaction pooler** URL on port **6543**, including
`pgbouncer=true`. Runtime code uses this variable with `postgres-js` configured
as `prepare: false`, because the transaction pooler does not support prepared
statements. The Supabase URL and service-role key are server-only: ingestion
uses them for the private `documents` Storage bucket and the review page creates
short-lived signed PDF URLs. Never expose the key through `NEXT_PUBLIC_*`.

Set `ADMIN_TOKEN` as a temporary review gate. In production, the reviewer
must send this exact token in either `Authorization: Bearer …` or
`x-admin-token`; comparison is timing-safe. Development permits review without
the token. Day 6 authentication will replace this gate.

Do **not** use `DIRECT_URL` in a request handler or Server Component, and do
not need to set it in Vercel for the application. `DIRECT_URL` is the Supabase
**session pooler** URL on port **5432** and is only needed in a trusted local or
CI migration job for `drizzle-kit`, `db:migrate`, smoke tests, and maintenance
scripts. The homepage renders dynamically while caching its ledger payload for
five minutes, so `next build` does not connect to either database URL.

## Document state machine

The normal document path is:

`discovered → fetched → classified → extracted → validated → resolved → ready_for_review → published`

## Acquisition watcher boundary

`watcher_state` stores the BSE delta watermark, circuit-breaker state, and an
explicit `disabled_until` timestamp. A BSE 403 or 429 disables polling for at
least 24 hours; it is a hard stop, never a signal to retry through a block.
`discovered_announcements` is the append-only-ish exchange audit trail keyed by
`(source, external_id)` before a PDF hash exists. The watcher may create only a
`documents.status='discovered'` row and link it from the announcement; it never
downloads, classifies, extracts, validates, or publishes. The local worker owns
those later transitions through the existing ingestion pipeline.

`failed`, `excluded`, and `superseded_document` are terminal branches. Retryable
worker errors do not change the stage; they retain it, record `last_error`, and
schedule `next_attempt_at` using exponential backoff. `claimNextDocument` locks
one due row with `FOR UPDATE SKIP LOCKED`, increments its attempt counter, and
sets a short lease in `next_attempt_at`.

## Ledger rule

Claims are append-only. A correction is a new claim. Supersession inserts the
replacement claim and then only marks the older claim `superseded` with a
forward pointer. A database trigger prevents changing claim substance or
deleting a claim. The only mutable claim fields are the one-time human review
metadata: a `machine_validated` tier can become `human_verified` or `excluded`
alongside `reviewed_by`, `reviewed_at`, and an exclusion reason. That final
decision is then immutable too. Review metadata also records `review_state`
(`pending`, `needs_second_look`, or final `decided`) and a queryable
`decision_method` (`individual` or `bulk`). A second-look note is immutable
once recorded, while the still-machine-validated claim remains publish-blocking.

`claims.raw_relationship_phrase` is optional immutable evidence provenance: a
deterministic matcher captures wording such as `associate company`, `joint
venture`, or `acquisition of a majority stake` from the verbatim quote. It is
separate from the controlled `relation_type` vocabulary. Do not add taxonomy
types or prompt instructions merely because a phrase appears; analyse the
accumulated field first.

## Ingestion and review

`npm run ingest -- --url <pdf-url>` and `npm run ingest -- --file <path>` use
the same exported PDF extraction path as `/api/analyze`. URL downloads have a
PDF content-type check, 10MB cap, 30-second timeout, and an identifiable user
agent. The raw PDF is hash-addressed at `documents/<sha256>.pdf` in private
Storage; duplicate hashes stop before re-extraction. Only `rating_rationale`
documents proceed to extraction. Validation exclusions are stored in
`documents.metadata.excluded` and never become claims.

Quote validation remains strictly verbatim. For every rejected quote, ingestion
records measurement-only diagnostics in `documents.metadata.rejected_quotes`:
the model quote, claimed page, endpoint labels, closest same-length source-text
window, lexical similarity, and one of `table_derived`, `cross_page`,
`truncated`, `paraphrase`, or `not_found`. Inspect them with
`npm run ingest:mismatches -- --id <documentId>`. These diagnostics never relax
validation, create claims, or auto-approve anything.

Malformed model edges with two distinct `target` endpoints are separately stored
in `documents.metadata.malformed_relationships` and omitted from claims. The
ledger has no generic relationship type, so this preserves the audit trail
without mislabelling a prospective acquisition as a group-company claim.

For downloaded batches, run `npm run ingest -- --dir <path/to/pdfs>`. Files run
sequentially, duplicates are shown as skipped with their existing claim counts,
and failures are reported without stopping later files. Add `--dry-run` to list
the batch without changing the ledger. The final table reports each file,
company, document type, claim count, validation exclusions, and status. A
rating rationale with fewer than three retained claims is visibly marked
`review: unusually thin` for manual triage.

New claims are `machine_validated` and a document stops at
`ready_for_review`. `/review` is the human queue; it is the only Day 5 path that
can approve/reject claims and publish a document. Public reads continue to
select only `documents.status = 'published'` and non-excluded verification
tiers.

An existing hash is a true duplicate only once the document is at `extracted` or
beyond (or in another terminal outcome). `discovered`, `fetched`, `classified`,
and `failed` documents resume their existing audit row instead. Use
`npm run ingest -- --retry <documentId>` for an explicit retry,
`npm run ingest:status` to list all non-published/non-excluded documents, and
`npm run ingest:abandon -- --id <documentId>` to record a failed abandonment;
none of these commands delete rows.

An explicit retry can also restart a `validated` document only when it has no
claims yet. This covers deterministic post-validation failures such as a strict
report-date parse or relation mapping failure; the retry records the restart in
metadata and replays the PDF from discovery rather than duplicating evidence.

### Reprocessing after a validation improvement

Use `npm run ingest:reprocess -- --id <documentId> --trigger <reason>` for an
already `ready_for_review` rating rationale. It reads the immutable stored PDF
and records a new extraction pass without changing any prior claim.

Reconciliation first compares the relationship key
`(document_id, source_entity_id, target_entity_id, relation_type)`. Every claim
also stores `quote_hash`, the SHA-256 of the normalised evidence quote. An exact
relationship-and-hash match is skipped; a relationship with a changed hash is
recorded as `documents.metadata.reprocess[].quote_variants` for a human rather
than inserted. Only a previously absent relationship becomes a new
`machine_validated` claim. The composite unique index includes the hash instead
of raw quote text, so long table quotes remain safe to index.

Validation-dropped edges still live only in document metadata, never in
`claims`. Every persisted `excluded` claim requires a final reviewer record, so
it represents a human decision and remains final during reconciliation.
`documents.metadata.reprocess[]` appends the timestamp, trigger, model and
prompt versions, reconciliation counts, quote variants, and IDs of newly added
claims for every successful run.

### Recall telemetry and group-structure cap

The extraction response ceiling is 12,000 tokens. A response at or above 90%
of that ceiling logs a server warning and records `documents.metadata.extraction`
with token usage, `near_token_ceiling`, counts for every relation type, and the
model's total named subsidiary/group-company count. Batch ingestion prints this
coverage, including a structure-heavy/no-dependency review marker.

Subsidiary and `group_company` edges are capped at five combined. The model is
instructed to retain only substantive operational or financial links and report
the complete group-list count; a deterministic fallback enforces the cap if it
does not comply. Customer, supplier, lender, parent, and unnamed-dependency
edges are never capped.

When a response reports more than five group relationships but returns no
customer, supplier, lender, parent, or unnamed dependency, Sutra automatically
runs one bounded counterparty-only coverage sweep over the same PDF. It is
merged before strict quote validation and the normal append-only reconciliation;
the metadata records that the sweep ran.

To run the additive reconciliation pass after a ceiling or cap change, use
`npm run ingest:reprocess -- --id <documentId> --trigger <reason>`. Operators
can rerun every ready-for-review rationale recorded as near the ceiling with
`npm run ingest:reprocess -- --near-token-ceiling --trigger <reason>`.

Published documents are intentionally rejected by this command until the
review-batch UI ships: that UI will keep the document `published`, expose only
the new claim IDs from its reprocess entry for review, and leave earlier public
claims untouched. This avoids exposing new `machine_validated` claims publicly
or moving a published document backward through the state machine.

If a classifier fix changes an `excluded` decision, run
`npm run ingest:reclassify -- --id <documentId>`. It resets only that row to
`discovered` and re-runs the normal pipeline. `--force-type rating_rationale`
records a human classification override in document metadata before rerunning;
it is not an automatic publish path. Use `--source india_ratings` when a local
India Ratings/Ind-Ra file was originally ingested as `manual`.

## Destructive operations and backups

`db:reset` is deliberately difficult to invoke. It first prints row counts,
then only drops a schema when all of these are true: `ALLOW_DESTRUCTIVE=1`, the
exact confirmation is supplied, and `DIRECT_URL` does **not** point to
`PRODUCTION_SUPABASE_PROJECT_REF`.

```sh
ALLOW_DESTRUCTIVE=1 npm run db:reset -- --confirm "RESET SUTRA DATABASE"
```

Set `PRODUCTION_SUPABASE_PROJECT_REF` in local/CI configuration; it is
intentionally required before reset can proceed. Never add that value or a
connection string to Git.

`npm run db:backup` writes a timestamped JSON recovery file under `backups/`
(which is gitignored). It preserves companies, documents, entities, aliases,
merges, claims, review actors, and merge rejections. Restore only into an empty
database with `npm run db:restore -- --file backups/<file>.json`; it refuses if
claims or any ledger table already contain rows. Use a separate scratch project
for backup round-trips—never reset the shared production project. With
`SCRATCH_DIRECT_URL` set to that project, run `npm run db:backup-roundtrip` to
backup the configured source, reset and restore the scratch database, then run
`db:verify-import` and `verify:parity` there.

## Resolved claims view

`claims_resolved` is the default SQL surface for merge-aware analytics. It
exposes every `claims` column plus `source_entity_resolved` and
`target_entity_resolved`. A recursive CTE follows active (`reverted_at is
null`) merge chains, including multi-hop chains, and uses a visited path to
terminate safely on malformed cycles. The equivalent worker-side logic lives
in `lib/domain/entity-resolution.ts`.

## Entity merge rejections

`entity_merge_rejections` stores human-declined entity pairs in normalized UUID
order. `npm run db:entity-review` is read-only and excludes these pairs, so a
known bad merge is not re-suggested. `npm run db:seed-entity-rejections` is
idempotent curation that protects Modison Limited vs Modison Copper Private
Limited and MEIL Holdings Limited vs Megha Engineering & Infrastructures Ltd.

## News boundary

`events` are news records, not claims. They connect to the graph only through
`event_entities`; there is deliberately no foreign key, column, or relationship
from events to claims.
