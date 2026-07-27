import { entities, entityMergeRejections } from "./schema";
import type { DatabaseClient } from "../lib/db/client";
import { normalizeEntityName } from "../lib/entity-normalization";

const KNOWN_REJECTIONS = [
  {
    left: "Modison Limited",
    right: "Modison Copper Private Limited",
    reason: "Distinct legal entities: parent and group company; never merge.",
  },
  {
    left: "MEIL Holdings Limited",
    right: "Megha Engineering & Infrastructures Ltd",
    reason: "Olectra defines MEIL as Megha Engineering, not MEIL Holdings; similarity is misleading.",
  },
] as const;

/**
 * These are deliberate negative-resolution facts, not heuristics. The helper
 * is idempotent and is invoked after static imports and new graph ingestion so
 * a fresh database receives the same protection once the entities exist.
 */
export async function seedKnownEntityMergeRejections(db: DatabaseClient) {
  const allEntities = await db.select({ id: entities.id, canonicalName: entities.canonicalName }).from(entities);
  let seeded = 0;

  for (const rejection of KNOWN_REJECTIONS) {
    const left = allEntities.find((entity) => normalizeEntityName(entity.canonicalName) === normalizeEntityName(rejection.left));
    const right = allEntities.find((entity) => normalizeEntityName(entity.canonicalName) === normalizeEntityName(rejection.right));
    if (!left || !right || left.id === right.id) continue;
    const [entityAId, entityBId] = [left.id, right.id].sort();
    const inserted = await db
      .insert(entityMergeRejections)
      .values({ entityAId, entityBId, rejectedBy: "sutra-curation", reason: rejection.reason })
      .onConflictDoNothing()
      .returning({ entityAId: entityMergeRejections.entityAId });
    seeded += inserted.length;
  }

  return seeded;
}

export { KNOWN_REJECTIONS };
