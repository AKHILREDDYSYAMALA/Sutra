# Sutra — see who a company depends on, and why

**Live:** https://sutra-theta.vercel.app · **Demo video:** [link after recording] · Built solo in 4 days for the OpenAI × NamasteDev Codex Hackathon.

Every listed company hangs by threads — one dominant customer, one critical supplier, one lender that funds its working capital. For Indian retail investors those threads are invisible: they are not in the P&L, not on stock apps, and the platforms that do track counterparty risk (Bloomberg, FactSet) cost more per year than most retail portfolios. Yet much of the raw intelligence is public — buried in credit-rating rationale PDFs that almost nobody reads.

Sutra is an AI analyst that reads those PDFs and draws the map: an interactive dependency graph of customers, suppliers, lenders, and group structure — **with a verbatim excerpt from the source document attached to every single edge**.

> Example from the live sandbox: MTAR Technologies, a ₹8,000-crore listed company, derives **≥70% of revenue from one customer** (Bloom Energy, California). That fact is stated in a public rating report. Sutra surfaces it in seconds, with the sentence that proves it.

## Why rating reports?

The founding insight, validated by hand before any code was written: **credit-rating rationales name counterparties that earnings transcripts never do.** Rating agencies must assess concentration risk, so their reports explicitly name top customers, critical suppliers, lenders, and group exposures — with percentages. Transcripts say "a key client"; rating reports say who, and how much. Sutra is built on the densest evidence-per-page public source that exists for this question.

## What ships

- **Six verified company graphs** in the instant sandbox — MTAR Technologies, Dixon Technologies, Amber Enterprises, Hindustan Aeronautics, Modison, PTC Industries — each manually reviewed quote-by-quote against its source rationale (ICRA / CARE).
- **Live analysis:** drop any Indian credit-rating rationale PDF (≤10MB) and GPT-4o extracts the dependency graph in ~8 seconds — schema-enforced, temperature 0.
- **Evidence on every edge:** click any relationship to see the exact sentence from the report, with page reference and confidence label.
- **The Dependency Read:** an analyst-style verdict computed purely from evidenced data — named revenue concentration, single points of failure, watch items, evidence coverage. Every line is clickable and traces back to its edge in the graph. Sutra states nothing it cannot prove.
- **Reported-but-unnamed dependencies:** when a report says "top five suppliers account for 60–65% of purchases" without naming them, Sutra renders an honest ghost node instead of pretending to know more than the document says.
- **Reverse intelligence:** click any counterparty to see it across the whole corpus. Samsung never filed a rating report — but its role emerges from its suppliers' reports. Every report analysed makes every other company's picture richer.
- **Refusal as a feature:** relationships whose supporting quote cannot be verified verbatim against the document are excluded — and the exclusion is disclosed to the user, not hidden.

## How it works

```
PDF → text extraction (page-tagged)
    → GPT-4o (strict JSON schema, temperature 0, structured outputs)
    → quote validation: every source_quote substring-matched against the
      full document text (typography/whitespace-normalised)
    → graph integrity: edge endpoints resolved, close ID matches repaired
      deterministically, unresolved/unevidenced items excluded & disclosed
    → deterministic Dagre layout → React Flow graph + Dependency Read
```

Two models, three layers of honesty: **Codex wrote the application; GPT-4o is the analyst; deterministic validation keeps both honest.**

## Evidence guarantee

The API validates every returned `source_quote` by normalising harmless typography differences (whitespace, curly quotes, soft hyphens, ligatures, page markers) and substring-matching it against the complete extracted PDF text. An edge whose quote is not found verbatim is dropped, counted, and disclosed in the UI via `meta.excluded`. Percentages are never inverted or inferred: "35% of Amber's revenue" is always attributed to the reporting company, never restated as the counterparty's own dependency.

For reports up to 50,000 characters, the complete text is sent to the model. Larger reports send the first 10 pages plus pages containing relationship, import, and procurement terms; the complete report is retained for quote validation.

## Built with AI, on purpose

- **OpenAI Codex** wrote and iterated the entire application across the 4 days — scaffolding, the extraction pipeline, validation layers, graph UI, and production hardening. The commit history is the workflow log.
- **GPT-4o** performs extraction as a strict unstructured-to-structured engine (JSON schema enforced, temperature 0) — not a chatbot layer.
- Human in the loop where it matters: every sandbox graph carries `"verified": true` only after manual quote-by-quote review against the source PDF. Unverified extractions never enter the corpus.

## Static data contract

Every file in `data/companies/*.json` follows the graph schema exactly. Nodes without a named counterparty are `named: false` and render as ghost nodes. All static edges carry a source quote and page reference, checked against the source rationale. On every dev start and production build, `scripts/build-company-manifest.mjs` regenerates the verified-company manifest that drives the deployed sandbox, and `static:check` verifies edge integrity. During `npm run dev`, a successful live extraction exposes **Save to sandbox** (development-only endpoint), which writes an unverified entry for manual review; flipping `"verified": true` promotes it to the sandbox and corpus.

## Local setup

```bash
npm install
cp .env.example .env.local   # paste your OPENAI_API_KEY for live analysis
npm run dev
```

The static sandbox works with no environment variables. `.env.local` is git-ignored and must never be committed.

## Deployment

Standard Next.js on Vercel. Set `OPENAI_API_KEY` in Project Settings → Environment Variables (Production + Preview) and redeploy. The analysis endpoint pins the Node.js runtime (PDF parsing is not Edge-compatible).

## Roadmap

The 4-day build is a slice of a larger system, in deliberate order:

1. **Claims ledger:** every edge becomes a time-stamped claim with document provenance — two reports disagreeing on a percentage is not a conflict, it is a *trend* ("watch this customer concentration grow across four filings").
2. **The disclosure firehose:** BSE/NSE corporate-announcement feeds as watchers — rating intimations trigger automatic rationale fetch → extraction → human review queue. New document types: order-win announcements, related-party schedules, annual-report chapters (chunked), DRHPs.
3. **Entity resolution at scale:** alias tables, confidence scoring, review queues — the verified/unverified gate in this build is the embryo of that workflow.
4. **A living corpus:** database-backed, multi-user, with alerts ("MTAR's BEC concentration changed 70% → 62%") — dependency intelligence for every listed company in India, built from documents anyone can read but nobody does.
