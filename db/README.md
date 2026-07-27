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

Set `ADMIN_TOKEN` as a temporary Day 5 review gate. In production, the reviewer
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
decision is then immutable too.

## Ingestion and review

`npm run ingest -- --url <pdf-url>` and `npm run ingest -- --file <path>` use
the same exported PDF extraction path as `/api/analyze`. URL downloads have a
PDF content-type check, 10MB cap, 30-second timeout, and an identifiable user
agent. The raw PDF is hash-addressed at `documents/<sha256>.pdf` in private
Storage; duplicate hashes stop before re-extraction. Only `rating_rationale`
documents proceed to extraction. Validation exclusions are stored in
`documents.metadata.excluded` and never become claims.

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

## Resolved claims view

`claims_resolved` is the default SQL surface for merge-aware analytics. It
exposes every `claims` column plus `source_entity_resolved` and
`target_entity_resolved`. A recursive CTE follows active (`reverted_at is
null`) merge chains, including multi-hop chains, and uses a visited path to
terminate safely on malformed cycles. The equivalent worker-side logic lives
in `lib/domain/entity-resolution.ts`.

## News boundary

`events` are news records, not claims. They connect to the graph only through
`event_entities`; there is deliberately no foreign key, column, or relationship
from events to claims.
