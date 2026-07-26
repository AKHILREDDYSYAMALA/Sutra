-- Custom SQL migration file, put your code below! --
-- Merge-aware read surface for every analytical query. The path array prevents
-- malformed A -> B -> A merge chains from recursing forever; in a cycle each
-- origin deterministically resolves to itself, matching lib/domain/resolveEntity.
CREATE OR REPLACE VIEW "claims_resolved" AS
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
