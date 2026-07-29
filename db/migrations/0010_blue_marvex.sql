CREATE TABLE "discovered_announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"scrip_code" text NOT NULL,
	"company_id" uuid,
	"headline" text NOT NULL,
	"category" text,
	"announcement_date" timestamp with time zone NOT NULL,
	"attachment_url" text,
	"raw_payload" jsonb NOT NULL,
	"document_id" uuid,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discovered_announcements_status_check" CHECK ("discovered_announcements"."status" in ('new', 'linked', 'ignored', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "watcher_state" (
	"source" text PRIMARY KEY NOT NULL,
	"last_polled_at" timestamp with time zone,
	"last_announcement_date" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovered_announcements" ADD CONSTRAINT "discovered_announcements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovered_announcements" ADD CONSTRAINT "discovered_announcements_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discovered_announcements_source_external_id_unique" ON "discovered_announcements" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "discovered_announcements_company_date_idx" ON "discovered_announcements" USING btree ("company_id","announcement_date");