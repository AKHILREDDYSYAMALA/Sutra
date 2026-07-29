-- Preserve raw source wording without expanding the controlled relation_type
-- vocabulary. Existing claims are backfilled only when the evidence quote
-- contains a recognisable taxonomy-strain phrase.
ALTER TABLE "claims" ADD COLUMN "raw_relationship_phrase" text;--> statement-breakpoint
UPDATE "claims"
SET "raw_relationship_phrase" = nullif(concat_ws('; ',
  CASE WHEN "quote" ~* '\massociate[[:space:]]+company\M'
    THEN (regexp_match("quote", '(associate[[:space:]]+company)', 'i'))[1] END,
  CASE WHEN "quote" ~* '\mjoint[[:space:]]+venture\M'
    THEN (regexp_match("quote", '(joint[[:space:]]+venture)', 'i'))[1] END,
  CASE WHEN "quote" ~* '(acquisition[[:space:]]+of[[:space:]]+(an?[[:space:]]+)?majority[[:space:]]+stake|acquir(ed|es|ing)?[[:space:]]+(a[[:space:]]+)?majority[[:space:]]+stake|majority[[:space:]]+stake[[:space:]]+acquisition)'
    THEN (regexp_match("quote", '(acquisition[[:space:]]+of[[:space:]]+(an?[[:space:]]+)?majority[[:space:]]+stake|acquir(ed|es|ing)?[[:space:]]+(a[[:space:]]+)?majority[[:space:]]+stake|majority[[:space:]]+stake[[:space:]]+acquisition)', 'i'))[1] END
), '');--> statement-breakpoint

-- The phrase is part of immutable evidence provenance, never mutable review
-- metadata. Recreate the existing function with that additional invariant.
CREATE OR REPLACE FUNCTION public.enforce_claim_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.id IS DISTINCT FROM OLD.id
		OR NEW.document_id IS DISTINCT FROM OLD.document_id
		OR NEW.company_id IS DISTINCT FROM OLD.company_id
		OR NEW.source_entity_id IS DISTINCT FROM OLD.source_entity_id
		OR NEW.target_entity_id IS DISTINCT FROM OLD.target_entity_id
		OR NEW.relation_type IS DISTINCT FROM OLD.relation_type
		OR NEW.relation_label IS DISTINCT FROM OLD.relation_label
		OR NEW.raw_relationship_phrase IS DISTINCT FROM OLD.raw_relationship_phrase
		OR NEW.exposure_pct IS DISTINCT FROM OLD.exposure_pct
		OR NEW.risk_flag IS DISTINCT FROM OLD.risk_flag
		OR NEW.quote IS DISTINCT FROM OLD.quote
		OR NEW.quote_hash IS DISTINCT FROM OLD.quote_hash
		OR NEW.page IS DISTINCT FROM OLD.page
		OR NEW.observed_date IS DISTINCT FROM OLD.observed_date
		OR NEW.extraction_confidence IS DISTINCT FROM OLD.extraction_confidence
		OR NEW.model_version IS DISTINCT FROM OLD.model_version
		OR NEW.prompt_version IS DISTINCT FROM OLD.prompt_version
		OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
		RAISE EXCEPTION 'Claims are append-only; insert a correction or supersession instead';
	END IF;

	IF OLD.superseded_by_claim_id IS NOT NULL
		AND NEW.superseded_by_claim_id IS DISTINCT FROM OLD.superseded_by_claim_id THEN
		RAISE EXCEPTION 'A claim supersession link cannot be changed or removed';
	END IF;

	IF OLD.lifecycle_state = 'superseded'
		AND NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
		RAISE EXCEPTION 'A superseded claim cannot be reactivated';
	END IF;

	IF OLD.verification_tier <> 'machine_validated'
		AND NEW.verification_tier IS DISTINCT FROM OLD.verification_tier THEN
		RAISE EXCEPTION 'A final verification decision cannot be changed';
	END IF;

	IF OLD.reviewed_at IS NOT NULL
		AND (NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at
			OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
			OR NEW.verification_tier IS DISTINCT FROM OLD.verification_tier
			OR NEW.exclusion_reason IS DISTINCT FROM OLD.exclusion_reason
			OR NEW.review_state IS DISTINCT FROM OLD.review_state
			OR NEW.review_note IS DISTINCT FROM OLD.review_note
			OR NEW.decision_method IS DISTINCT FROM OLD.decision_method) THEN
		RAISE EXCEPTION 'A claim review decision cannot be changed';
	END IF;

	IF OLD.review_state = 'needs_second_look'
		AND NEW.review_state NOT IN ('needs_second_look', 'decided') THEN
		RAISE EXCEPTION 'A second-look claim cannot return to pending';
	END IF;

	IF OLD.review_note IS NOT NULL
		AND NEW.review_note IS DISTINCT FROM OLD.review_note THEN
		RAISE EXCEPTION 'A second-look note cannot be changed or removed';
	END IF;

	IF OLD.verification_tier = 'machine_validated'
		AND NEW.verification_tier <> 'machine_validated'
		AND (NEW.reviewed_at IS NULL OR NEW.reviewed_by IS NULL OR NEW.decision_method IS NULL) THEN
		RAISE EXCEPTION 'A final verification decision requires reviewer metadata and a decision method';
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint

-- claims_resolved exposes all claim fields by contract, and Postgres freezes a
-- wildcard at view-creation time. Rebuild it so raw_relationship_phrase is
-- available to all merge-aware analytics.
DROP VIEW IF EXISTS "claims_resolved";--> statement-breakpoint
CREATE VIEW "claims_resolved" AS
WITH RECURSIVE entity_resolution AS (
  SELECT
    "entities"."id" AS "origin_entity_id",
    "entities"."id" AS "resolved_entity_id",
    ARRAY["entities"."id"]::uuid[] AS "path",
    false AS "cycle"
  FROM "entities"

  UNION ALL

  SELECT
    "entity_resolution"."origin_entity_id",
    "entity_merges"."into_entity_id" AS "resolved_entity_id",
    "entity_resolution"."path" || "entity_merges"."into_entity_id" AS "path",
    "entity_merges"."into_entity_id" = ANY("entity_resolution"."path") AS "cycle"
  FROM "entity_resolution"
  INNER JOIN "entity_merges"
    ON "entity_merges"."from_entity_id" = "entity_resolution"."resolved_entity_id"
    AND "entity_merges"."reverted_at" IS NULL
  WHERE NOT "entity_resolution"."cycle"
),
terminal_resolution AS (
  SELECT DISTINCT ON ("origin_entity_id")
    "origin_entity_id",
    "resolved_entity_id"
  FROM "entity_resolution"
  WHERE "cycle"
    OR NOT EXISTS (
      SELECT 1
      FROM "entity_merges" AS "next_merge"
      WHERE "next_merge"."from_entity_id" = "entity_resolution"."resolved_entity_id"
        AND "next_merge"."reverted_at" IS NULL
    )
  ORDER BY
    "origin_entity_id",
    cardinality("path") DESC,
    "resolved_entity_id"
)
SELECT
  "claims".*,
  COALESCE("source_resolution"."resolved_entity_id", "claims"."source_entity_id") AS "source_entity_resolved",
  COALESCE("target_resolution"."resolved_entity_id", "claims"."target_entity_id") AS "target_entity_resolved"
FROM "claims"
LEFT JOIN "terminal_resolution" AS "source_resolution"
  ON "source_resolution"."origin_entity_id" = "claims"."source_entity_id"
LEFT JOIN "terminal_resolution" AS "target_resolution"
  ON "target_resolution"."origin_entity_id" = "claims"."target_entity_id";
