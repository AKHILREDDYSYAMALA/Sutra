ALTER TABLE "discovered_announcements" ADD COLUMN "failure_reason" text;
--> statement-breakpoint
-- Correct a historical OCR/acronym split. The normalized identity is unchanged,
-- so this is a display-name and slug repair rather than a merge.
UPDATE "companies"
SET "name" = 'Sona BLW Precision Forgings Limited',
    "slug" = 'sona-blw-precision-forgings-limited',
    "updated_at" = now()
WHERE "slug" = 'sona-bl-w-precision-forgings-limited'
   OR "name" = 'Sona BL W Precision Forgings Limited';
--> statement-breakpoint
UPDATE "entities"
SET "canonical_name" = 'Sona BLW Precision Forgings Limited',
    "normalized_name" = 'sona blw precision forgings'
WHERE "company_id" IN (
  SELECT "id" FROM "companies"
  WHERE "slug" = 'sona-blw-precision-forgings-limited'
)
  AND "canonical_name" = 'Sona BL W Precision Forgings Limited';
