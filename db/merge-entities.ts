import { and, eq, isNull } from "drizzle-orm";

import { entityAliases, entities, entityMerges } from "./schema";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";

function requiredFlag(name: string) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required.`);
  return value;
}

/**
 * A deliberately explicit human-only action. `db:entity-review` prints this
 * command but never invokes it. Claims remain untouched; aliases move with the
 * reversible merge record.
 */
async function main() {
  const fromEntityId = requiredFlag("--from");
  const intoEntityId = requiredFlag("--into");
  if (fromEntityId === intoEntityId) throw new Error("--from and --into must be different entities.");

  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    await db.transaction(async (tx) => {
      const [[fromEntity], [intoEntity]] = await Promise.all([
        tx.select().from(entities).where(eq(entities.id, fromEntityId)).limit(1),
        tx.select().from(entities).where(eq(entities.id, intoEntityId)).limit(1),
      ]);
      if (!fromEntity) throw new Error(`Source entity ${fromEntityId} was not found.`);
      if (!intoEntity) throw new Error(`Canonical entity ${intoEntityId} was not found.`);
      if (fromEntity.entityType === "unnamed" || intoEntity.entityType === "unnamed") {
        throw new Error("Unnamed entities cannot be merged with this human-review command.");
      }

      const [existingMerge] = await tx
        .select({ id: entityMerges.id })
        .from(entityMerges)
        .where(and(eq(entityMerges.fromEntityId, fromEntityId), eq(entityMerges.intoEntityId, intoEntityId), isNull(entityMerges.revertedAt)))
        .limit(1);
      if (existingMerge) {
        console.log(`Active merge already exists: ${fromEntity.canonicalName} -> ${intoEntity.canonicalName}`);
        return;
      }

      await tx.insert(entityMerges).values({
        fromEntityId,
        intoEntityId,
        performedBy: "human",
        reason: "manual merge from db:entity-review",
        evidence: {
          source: "db:entity-review",
          fromCanonicalName: fromEntity.canonicalName,
          intoCanonicalName: intoEntity.canonicalName,
        },
      });

      const aliases = await tx.select().from(entityAliases).where(eq(entityAliases.entityId, fromEntityId));
      for (const alias of aliases) {
        const [canonicalAlias] = await tx
          .select({ id: entityAliases.id })
          .from(entityAliases)
          .where(and(eq(entityAliases.entityId, intoEntityId), eq(entityAliases.normalizedRaw, alias.normalizedRaw)))
          .limit(1);
        if (canonicalAlias) {
          await tx.delete(entityAliases).where(eq(entityAliases.id, alias.id));
        } else {
          await tx.update(entityAliases).set({ entityId: intoEntityId }).where(eq(entityAliases.id, alias.id));
        }
      }

      console.log(`Merged ${fromEntity.canonicalName} into ${intoEntity.canonicalName}. Claims were not modified.`);
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
