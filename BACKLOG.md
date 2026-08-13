# Sutra backlog

## Acquisition

### Intimation → rationale hop

**Problem:** BSE credit-rating attachments are usually short intimations rather
than full rationales (for example, the Ashok Leyland intimation was 1,562
characters and had no rationale headings). The intimation identifies the rating
agency and action, but does not contain the relationship evidence Sutra needs.

Investigate these paths in order of legitimacy:

1. Whether the intimation PDF itself links to the agency press release.
2. Whether the company files the full rationale as a later, separate BSE
   announcement.
3. Whether the company IR page publishes its own rating document.

Do **not** fetch from ICRA, CRISIL, or NSE. Their explicit prohibitions remain
binding. Any future hop must retain its complete provenance from the BSE
intimation through the resolved rationale.

## Claims model

### Episodic rating-intimation claims (§12)

Intimations are still useful evidence of a dated event: rating agency, action
(upgrade, reaffirmation, or downgrade), rating, and date. When `claim_class`
ships, model these as quotable **episodic** claims/timeline entries, not graph
edges. Until then, do not coerce intimations into relationship claims or treat
them as rationale evidence.
