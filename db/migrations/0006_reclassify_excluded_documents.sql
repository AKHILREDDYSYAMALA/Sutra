-- A classifier outcome is auditable but not permanent. Operators may restart an
-- excluded document after a classifier fix; published documents remain terminal.
CREATE OR REPLACE FUNCTION public.enforce_document_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.status = OLD.status THEN
		RETURN NEW;
	END IF;

	IF NEW.status IN ('failed', 'excluded', 'superseded_document') THEN
		RETURN NEW;
	END IF;

	IF OLD.status IN ('failed', 'excluded') AND NEW.status = 'discovered' THEN
		RETURN NEW;
	END IF;

	IF (OLD.status = 'discovered' AND NEW.status = 'fetched')
		OR (OLD.status = 'fetched' AND NEW.status = 'classified')
		OR (OLD.status = 'classified' AND NEW.status = 'extracted')
		OR (OLD.status = 'extracted' AND NEW.status = 'validated')
		OR (OLD.status = 'validated' AND NEW.status = 'resolved')
		OR (OLD.status = 'resolved' AND NEW.status = 'ready_for_review')
		OR (OLD.status = 'ready_for_review' AND NEW.status = 'published') THEN
		RETURN NEW;
	END IF;

	RAISE EXCEPTION 'Invalid document status transition: % -> %', OLD.status, NEW.status;
END;
$$;
