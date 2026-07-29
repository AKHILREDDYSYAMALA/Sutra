# Golden-set evaluation

`golden-set.ts` is hand-maintained ground truth. For every `ready` document,
record **every** explicit relationship from the stored source PDF: directional
source and target names, ledger relation type, explicit exposure (or `null`),
and the exact evidence sentence. Never seed it from existing claims or model
output. Add curator identity and date before changing a document to `ready`.

Two CARE entries are deliberately blocked: the Day-2 static import has no raw
PDF in Storage, so it cannot be evaluated until the immutable source document
is added. Olectra is a smoke-test fixture rather than a persisted document;
add its stored report before placing it in this set.

Run the read-only benchmark after curation:

```sh
npm run eval -- --prompt-version rating_rationale_v4
```

It reads stored PDFs, calls extraction, and writes a timestamped result under
the ignored `evals/` directory. It never inserts or updates ledger records.
The result preserves prompt text, model version, token usage, pricing rates,
latency, validation loss, per-document relationships, and aggregate/per-type
precision and recall.

Compare the latest two saved prompt runs with:

```sh
npm run eval:compare -- --a rating_rationale_v4 --b rating_rationale_v5
```

The comparator prints gains and losses by document. A prompt change may ship
only after a before/after eval. Any recall loss for a relation type requires a
revision or explicit rejection of that change.
