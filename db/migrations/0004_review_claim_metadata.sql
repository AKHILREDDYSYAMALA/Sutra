-- Verification is review metadata, not claim substance. A decision can be recorded
-- once for a machine-validated claim; the immutable evidence and relationship fields
-- remain protected by the append-only trigger.
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
			OR NEW.exclusion_reason IS DISTINCT FROM OLD.exclusion_reason) THEN
		RAISE EXCEPTION 'A claim review decision cannot be changed';
	END IF;

	IF NEW.verification_tier <> 'machine_validated'
		AND NEW.reviewed_at IS NULL THEN
		RAISE EXCEPTION 'A final verification decision requires review metadata';
	END IF;

	RETURN NEW;
END;
$$;
