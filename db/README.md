# Sutra claims ledger

`db/schema.ts` is the source of truth for the relational model. Generate a SQL
migration after a schema change with `npm run db:generate`, review and commit the
new file under `db/migrations/`, then apply it with `npm run db:migrate`.

All database maintenance commands use `DIRECT_URL` (Supabase session pooler,
port 5432). The application client uses `DATABASE_URL` (transaction pooler,
port 6543) with prepared statements disabled.

## Vercel environment

Set **only `DATABASE_URL`** for the Sutra Vercel application (Production and
Preview as appropriate). It must be the Supabase **transaction pooler** URL on
port **6543**, including `pgbouncer=true`. Runtime code uses this variable with
`postgres-js` configured as `prepare: false`, because the transaction pooler
does not support prepared statements.

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
deleting a claim.

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
