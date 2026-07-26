# Sutra claims ledger

`db/schema.ts` is the source of truth for the relational model. Generate a SQL
migration after a schema change with `npm run db:generate`, review and commit the
new file under `db/migrations/`, then apply it with `npm run db:migrate`.

All database maintenance commands use `DIRECT_URL` (Supabase session pooler,
port 5432). The application client uses `DATABASE_URL` (transaction pooler,
port 6543) with prepared statements disabled.

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

## News boundary

`events` are news records, not claims. They connect to the graph only through
`event_entities`; there is deliberately no foreign key, column, or relationship
from events to claims.
