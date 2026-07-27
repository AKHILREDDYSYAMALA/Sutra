-- Review metadata is separate from immutable claim substance. A reviewer can
-- park a machine-valid claim for a second look, then make one final decision.
ALTER TABLE "claims" ADD COLUMN "review_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "review_note" text;--> statement-breakpoint
ALTER TABLE "claims" ADD COLUMN "decision_method" text;--> statement-breakpoint

-- Existing imports predate review-state telemetry. Give their final claims an
-- explicit migration actor and terminal state without claiming knowledge of
-- whether their historical decision was individual or bulk.
INSERT INTO "users" ("email", "is_admin")
VALUES ('migration-reviewer@sutra.local', true)
ON CONFLICT ("email") DO NOTHING;--> statement-breakpoint
UPDATE "claims"
SET "review_state" = 'decided',
    "reviewed_by" = coalesce("reviewed_by", (SELECT "id" FROM "users" WHERE "email" = 'migration-reviewer@sutra.local')),
    "reviewed_at" = coalesce("reviewed_at", now())
WHERE "verification_tier" IN ('human_verified', 'excluded');--> statement-breakpoint

ALTER TABLE "claims" ADD CONSTRAINT "claims_review_state_check" CHECK ("claims"."review_state" in ('pending', 'needs_second_look', 'decided'));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_review_state_matches_tier_check" CHECK (("claims"."verification_tier" = 'machine_validated' and "claims"."review_state" in ('pending', 'needs_second_look')) or ("claims"."verification_tier" in ('human_verified', 'excluded') and "claims"."review_state" = 'decided'));--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_second_look_note_check" CHECK ("claims"."review_state" <> 'needs_second_look' or nullif(btrim("claims"."review_note"), '') is not null);--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_decision_method_check" CHECK ("claims"."decision_method" is null or "claims"."decision_method" in ('individual', 'bulk'));--> statement-breakpoint

CREATE TABLE "entity_merge_rejections" (
	"entity_a_id" uuid NOT NULL,
	"entity_b_id" uuid NOT NULL,
	"rejected_by" text NOT NULL,
	"reason" text NOT NULL,
	"rejected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entity_merge_rejections_entity_a_id_entity_b_id_pk" PRIMARY KEY("entity_a_id","entity_b_id"),
	CONSTRAINT "entity_merge_rejections_normalized_order_check" CHECK ("entity_merge_rejections"."entity_a_id" < "entity_merge_rejections"."entity_b_id")
);--> statement-breakpoint
ALTER TABLE "entity_merge_rejections" ADD CONSTRAINT "entity_merge_rejections_entity_a_id_entities_id_fk" FOREIGN KEY ("entity_a_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merge_rejections" ADD CONSTRAINT "entity_merge_rejections_entity_b_id_entities_id_fk" FOREIGN KEY ("entity_b_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Apply known human decisions for corpora already present when this migration
-- runs. Later static imports and ingestion invoke the same idempotent seeder.
INSERT INTO "entity_merge_rejections" ("entity_a_id", "entity_b_id", "rejected_by", "reason")
SELECT least(left_entity.id, right_entity.id), greatest(left_entity.id, right_entity.id), 'sutra-curation', 'Distinct legal entities: parent and group company; never merge.'
FROM "entities" left_entity
JOIN "entities" right_entity ON left_entity.canonical_name = 'Modison Limited' AND right_entity.canonical_name = 'Modison Copper Private Limited'
ON CONFLICT ("entity_a_id", "entity_b_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "entity_merge_rejections" ("entity_a_id", "entity_b_id", "rejected_by", "reason")
SELECT least(left_entity.id, right_entity.id), greatest(left_entity.id, right_entity.id), 'sutra-curation', 'Olectra defines MEIL as Megha Engineering, not MEIL Holdings; similarity is misleading.'
FROM "entities" left_entity
JOIN "entities" right_entity ON left_entity.canonical_name = 'MEIL Holdings Limited' AND right_entity.canonical_name = 'Megha Engineering & Infrastructures Ltd'
ON CONFLICT ("entity_a_id", "entity_b_id") DO NOTHING;--> statement-breakpoint

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
		OR NEW.exposure_pct IS DISTINCT FROM OLD.exposure_pct
		OR NEW.risk_flag IS DISTINCT FROM OLD.risk_flag
		OR NEW.quote IS DISTINCT FROM OLD.quote
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
$$;
