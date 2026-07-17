# Sutra

Sutra maps the dependencies and counterparties hidden in Indian credit-rating reports. It is built for investors who need to see customer concentration, supplier dependency, group structure, and lending relationships — with a verbatim report excerpt attached to every graph edge.

## What ships

- A full-viewport React Flow graph with deterministic Dagre layout, type-aware nodes, risk-weighted edges, and visually distinct reported-but-unnamed dependency nodes.
- A searchable instant sandbox backed by reviewed static JSON in `data/companies/`.
- Three verified ICRA rationale graphs: MTAR Technologies, Dixon Technologies (India), and Amber Enterprises India.
- Clickable source-evidence panels, source pages, confidence labels, key risks, and a computed risk verdict.
- A `POST /api/analyze` Node.js route for live PDF analysis, including a 10MB limit, scanned-PDF detection, targeted long-report selection, OpenAI extraction, schema checking, and quote validation.

## Local setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

The static sandbox works without any environment variables. To use live analysis locally, replace the placeholder in `.env.local` with your `OPENAI_API_KEY`. This file is ignored by git and must never be committed.

## Evidence guarantee

The API validates every returned `source_quote` by normalising harmless typography/whitespace differences and substring-matching it against the complete extracted PDF text. An edge whose quote is not found is dropped and a count is logged server-side; it is never returned to or displayed for the user.

For reports up to 50,000 characters, the complete extracted text is sent to the model. Larger reports send the first 10 pages plus pages containing relationship, import, and procurement terms; the complete report is still retained for quote validation.

## Static data contract

Every file in `data/companies/*.json` adheres exactly to the supplied graph schema. A node without a named counterparty is marked `named: false` and rendered as a ghost node. All static edges have a source quote and page reference, and each quote is checked against its source rationale before it is added.

Static sandbox entries also include a local review marker: `"verified": true`. Only verified entries are indexed into the corpus and offered in the dropdown. During `npm run dev`, a successful live extraction exposes **Save to sandbox**, which writes an unverified `data/companies/{slug}.json`; manually review the evidence, change the marker to `true`, and refresh to make it available in the instant sandbox. The save endpoint is development-only and will not overwrite an existing company file.

Before every development server start and production build, `npm run static:check` verifies that static graph edge IDs resolve to real nodes. The live route applies the same guard, deterministically repairs close node-ID matches, drops unresolved edges, and marks any remaining unlinked non-target node visibly in the graph.

## Deployment

Deploy to Vercel as a standard Next.js project. Add `OPENAI_API_KEY` in **Project Settings → Environment Variables** for both **Production** and **Preview**. `.env.local` is intentionally not deployed. You may set `SUTRA_EXTRACTION_SYSTEM_PROMPT` there; the extraction model configuration lives in `lib/extraction-config.ts`. The analysis endpoint explicitly uses the Node.js runtime because PDF parsing is not Edge-compatible.

## Live-upload smoke test

1. Paste a valid API key into `.env.local`, then run `npm run dev`.
2. Open `http://localhost:3000`, expand the selected-company chip, and choose a text-based Indian credit-rating PDF under **Choose PDF**.
3. A successful request replaces the static graph with a graph labelled **Live report analysis**; each displayed edge includes a clickable source quote.
4. With the placeholder or no key, the upload stays on the existing graph and displays `server not configured`. A scanned PDF displays the readable-text error instead.
