CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"alert_type" text NOT NULL,
	"company_id" uuid,
	"entity_id" uuid,
	"claim_id" uuid,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	CONSTRAINT "alerts_type_check" CHECK ("alerts"."alert_type" in ('new_claim', 'exposure_changed', 'not_restated', 'new_document', 'rating_action'))
);
--> statement-breakpoint
CREATE TABLE "claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"relation_label" text NOT NULL,
	"exposure_pct" numeric(5, 2),
	"risk_flag" text,
	"quote" text NOT NULL,
	"page" integer,
	"observed_date" date NOT NULL,
	"lifecycle_state" text DEFAULT 'current' NOT NULL,
	"superseded_by_claim_id" uuid,
	"verification_tier" text NOT NULL,
	"exclusion_reason" text,
	"extraction_confidence" text,
	"model_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "claims_relation_type_check" CHECK ("claims"."relation_type" in ('customer', 'supplier', 'lender', 'subsidiary', 'parent', 'group_company', 'unnamed_dependency')),
	CONSTRAINT "claims_exposure_pct_check" CHECK ("claims"."exposure_pct" is null or "claims"."exposure_pct" between 0 and 100),
	CONSTRAINT "claims_risk_flag_check" CHECK ("claims"."risk_flag" is null or "claims"."risk_flag" in ('high', 'medium', 'low')),
	CONSTRAINT "claims_page_positive_check" CHECK ("claims"."page" is null or "claims"."page" > 0),
	CONSTRAINT "claims_lifecycle_state_check" CHECK ("claims"."lifecycle_state" in ('current', 'aging', 'superseded', 'not_restated')),
	CONSTRAINT "claims_supersession_link_check" CHECK (("claims"."lifecycle_state" = 'superseded') = ("claims"."superseded_by_claim_id" is not null)),
	CONSTRAINT "claims_not_self_superseding_check" CHECK ("claims"."superseded_by_claim_id" is null or "claims"."superseded_by_claim_id" <> "claims"."id"),
	CONSTRAINT "claims_verification_tier_check" CHECK ("claims"."verification_tier" in ('human_verified', 'machine_validated', 'excluded')),
	CONSTRAINT "claims_exclusion_reason_check" CHECK ("claims"."verification_tier" <> 'excluded' or "claims"."exclusion_reason" is not null),
	CONSTRAINT "claims_extraction_confidence_check" CHECK ("claims"."extraction_confidence" is null or "claims"."extraction_confidence" in ('high', 'medium'))
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"bse_scrip_code" text,
	"nse_symbol" text,
	"sector" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"raw_query" text NOT NULL,
	"company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"fulfilled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"source" text NOT NULL,
	"doc_type" text,
	"title" text,
	"url" text NOT NULL,
	"storage_path" text,
	"sha256" text NOT NULL,
	"agency" text,
	"rating" text,
	"published_date" date,
	"fetched_at" timestamp with time zone,
	"status" text DEFAULT 'discovered' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone,
	"uploaded_by_user_id" uuid,
	"is_private" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_source_check" CHECK ("documents"."source" in ('bse', 'nse', 'crisil', 'icra', 'care', 'india_ratings', 'user_upload', 'manual')),
	CONSTRAINT "documents_doc_type_check" CHECK ("documents"."doc_type" is null or "documents"."doc_type" in ('rating_rationale', 'rating_intimation', 'annual_report', 'rpt_schedule', 'order_win', 'drhp', 'other')),
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" in ('discovered', 'fetched', 'classified', 'extracted', 'validated', 'resolved', 'ready_for_review', 'published', 'failed', 'excluded', 'superseded_document')),
	CONSTRAINT "documents_attempts_nonnegative" CHECK ("documents"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"country" text DEFAULT 'IN' NOT NULL,
	"is_listed" boolean DEFAULT false NOT NULL,
	"company_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entities_type_check" CHECK ("entities"."entity_type" in ('company', 'government', 'institution', 'unnamed', 'other'))
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"raw_name" text NOT NULL,
	"normalized_raw" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"resolved_by" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_document_id" uuid,
	CONSTRAINT "entity_aliases_normalized_raw_entity_id_unique" UNIQUE("normalized_raw","entity_id"),
	CONSTRAINT "entity_aliases_confidence_check" CHECK ("entity_aliases"."confidence" between 0 and 1),
	CONSTRAINT "entity_aliases_resolved_by_check" CHECK ("entity_aliases"."resolved_by" in ('deterministic', 'llm', 'human', 'user'))
);
--> statement-breakpoint
CREATE TABLE "entity_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"from_entity_id" uuid NOT NULL,
	"into_entity_id" uuid NOT NULL,
	"performed_by" text NOT NULL,
	"reason" text,
	"evidence" jsonb,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone,
	"reverted_reason" text,
	CONSTRAINT "entity_merges_performed_by_check" CHECK ("entity_merges"."performed_by" in ('human', 'llm', 'user')),
	CONSTRAINT "entity_merges_distinct_entities_check" CHECK ("entity_merges"."from_entity_id" <> "entity_merges"."into_entity_id"),
	CONSTRAINT "entity_merges_reversal_reason_check" CHECK ("entity_merges"."reverted_at" is null or "entity_merges"."reverted_reason" is not null)
);
--> statement-breakpoint
CREATE TABLE "event_entities" (
	"event_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"link_confidence" numeric(3, 2) NOT NULL,
	CONSTRAINT "event_entities_event_id_entity_id_pk" PRIMARY KEY("event_id","entity_id"),
	CONSTRAINT "event_entities_link_confidence_check" CHECK ("event_entities"."link_confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"headline" text NOT NULL,
	"url" text,
	"source" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portfolio_holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"portfolio_id" uuid NOT NULL,
	"company_id" uuid,
	"raw_input" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portfolio_holdings_portfolio_raw_input_unique" UNIQUE("portfolio_id","raw_input")
);
--> statement-breakpoint
CREATE TABLE "portfolios" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text DEFAULT 'My portfolio' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_reads" (
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "user_reads_user_id_company_id_pk" PRIMARY KEY("user_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"watch_type" text NOT NULL,
	"company_id" uuid,
	"entity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlists_user_company_unique" UNIQUE("user_id","company_id"),
	CONSTRAINT "watchlists_user_entity_unique" UNIQUE("user_id","entity_id"),
	CONSTRAINT "watchlists_type_check" CHECK ("watchlists"."watch_type" in ('company', 'entity')),
	CONSTRAINT "watchlists_target_matches_type_check" CHECK (("watchlists"."watch_type" = 'company' and "watchlists"."company_id" is not null and "watchlists"."entity_id" is null) or ("watchlists"."watch_type" = 'entity' and "watchlists"."entity_id" is not null and "watchlists"."company_id" is null))
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_claim_id_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_superseded_by_claim_id_claims_id_fk" FOREIGN KEY ("superseded_by_claim_id") REFERENCES "public"."claims"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claims" ADD CONSTRAINT "claims_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_requests" ADD CONSTRAINT "company_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_requests" ADD CONSTRAINT "company_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entities" ADD CONSTRAINT "entities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merges" ADD CONSTRAINT "entity_merges_from_entity_id_entities_id_fk" FOREIGN KEY ("from_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merges" ADD CONSTRAINT "entity_merges_into_entity_id_entities_id_fk" FOREIGN KEY ("into_entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entities" ADD CONSTRAINT "event_entities_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entities" ADD CONSTRAINT "event_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_holdings" ADD CONSTRAINT "portfolio_holdings_portfolio_id_portfolios_id_fk" FOREIGN KEY ("portfolio_id") REFERENCES "public"."portfolios"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolio_holdings" ADD CONSTRAINT "portfolio_holdings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reads" ADD CONSTRAINT "user_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_reads" ADD CONSTRAINT "user_reads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlists" ADD CONSTRAINT "watchlists_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_user_created_at_idx" ON "alerts" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "claims_company_lifecycle_state_idx" ON "claims" USING btree ("company_id","lifecycle_state");--> statement-breakpoint
CREATE INDEX "claims_document_id_idx" ON "claims" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "claims_target_entity_id_idx" ON "claims" USING btree ("target_entity_id");--> statement-breakpoint
CREATE INDEX "claims_source_entity_id_idx" ON "claims" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX "claims_verification_tier_idx" ON "claims" USING btree ("verification_tier");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_slug_unique" ON "companies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "companies_bse_scrip_code_idx" ON "companies" USING btree ("bse_scrip_code");--> statement-breakpoint
CREATE INDEX "companies_nse_symbol_idx" ON "companies" USING btree ("nse_symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_sha256_unique" ON "documents" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "documents_status_next_attempt_at_idx" ON "documents" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "documents_company_id_idx" ON "documents" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "documents_published_date_idx" ON "documents" USING btree ("published_date");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_normalized_name_unique" ON "entities" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "entities_company_id_idx" ON "entities" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "entity_aliases_normalized_raw_idx" ON "entity_aliases" USING btree ("normalized_raw");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	NEW.updated_at = now();
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER companies_set_updated_at
BEFORE UPDATE ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.enforce_document_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.status = OLD.status THEN
		RETURN NEW;
	END IF;

	IF OLD.status IN ('published', 'failed', 'excluded', 'superseded_document') THEN
		RAISE EXCEPTION 'Document % is terminal (%)', OLD.id, OLD.status;
	END IF;

	IF NEW.status IN ('failed', 'excluded', 'superseded_document') THEN
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
--> statement-breakpoint
CREATE TRIGGER documents_enforce_status_transition
BEFORE UPDATE OF status ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.enforce_document_status_transition();
--> statement-breakpoint
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
		OR NEW.verification_tier IS DISTINCT FROM OLD.verification_tier
		OR NEW.exclusion_reason IS DISTINCT FROM OLD.exclusion_reason
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

	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER claims_enforce_append_only
BEFORE UPDATE ON public.claims
FOR EACH ROW
EXECUTE FUNCTION public.enforce_claim_append_only();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.prevent_claim_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'Claims are append-only and cannot be deleted';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER claims_prevent_delete
BEFORE DELETE ON public.claims
FOR EACH ROW
EXECUTE FUNCTION public.prevent_claim_delete();
