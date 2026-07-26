import aliases from "../data/aliases.json";
import { and, eq, isNull } from "drizzle-orm";

import { claims, entities, entityAliases, entityMerges } from "./schema";
import { requiredDirectUrl } from "./env";
import { createDatabaseClient } from "../lib/db/client";
import { normalizeEntityName } from "../lib/entity-normalization";

type AliasMap = Record<string, string>;

function candidatesForGroup(
  allEntities: Array<typeof entities.$inferSelect>,
  rawNames: string[],
  canonicalName: string,
) {
  const rawNormalizations = new Set(rawNames.map(normalizeEntityName));
  const canonicalNormalization = normalizeEntityName(canonicalName);

  return allEntities.filter((entity) =>
    rawNormalizations.has(entity.normalizedName) ||
    entity.canonicalName.toLowerCase() === canonicalName.toLowerCase() ||
    entity.normalizedName === canonicalNormalization ||
    entity.normalizedName.startsWith(canonicalNormalization),
  );
}

async function main() {
  const groups = new Map<string, string[]>();
  for (const [rawName, canonicalName] of Object.entries(aliases as AliasMap)) {
    const rawNames = groups.get(canonicalName) ?? [];
    rawNames.push(rawName);
    groups.set(canonicalName, rawNames);
  }

  const { client, db } = createDatabaseClient(requiredDirectUrl());
  let createdMerges = 0;
  let createdAliases = 0;

  try {
    await db.transaction(async (tx) => {
      const [allEntities, allClaims, activeMerges] = await Promise.all([
        tx.select().from(entities),
        tx.select({ sourceEntityId: claims.sourceEntityId, targetEntityId: claims.targetEntityId }).from(claims),
        tx.select().from(entityMerges).where(isNull(entityMerges.revertedAt)),
      ]);
      const claimCounts = new Map<string, number>();
      for (const claim of allClaims) {
        claimCounts.set(claim.sourceEntityId, (claimCounts.get(claim.sourceEntityId) ?? 0) + 1);
        claimCounts.set(claim.targetEntityId, (claimCounts.get(claim.targetEntityId) ?? 0) + 1);
      }

      for (const [canonicalName, rawNames] of groups) {
        const candidates = candidatesForGroup(allEntities, rawNames, canonicalName);
        if (candidates.length === 0) {
          throw new Error(`No entity could be resolved for curated alias group ${canonicalName}.`);
        }

        let canonical = candidates.find((entity) => entity.canonicalName.toLowerCase() === canonicalName.toLowerCase());
        if (!canonical) {
          canonical = [...candidates].sort((left, right) => (claimCounts.get(right.id) ?? 0) - (claimCounts.get(left.id) ?? 0))[0]!;
          const [updated] = await tx
            .update(entities)
            .set({ canonicalName })
            .where(eq(entities.id, canonical.id))
            .returning();
          canonical = updated!;
        }

        for (const duplicate of candidates) {
          if (duplicate.id === canonical.id) continue;
          const existingMerge = activeMerges.find(
            (merge) => merge.fromEntityId === duplicate.id && merge.intoEntityId === canonical.id,
          );
          if (!existingMerge) {
            await tx.insert(entityMerges).values({
              fromEntityId: duplicate.id,
              intoEntityId: canonical.id,
              performedBy: "human",
              reason: "seeded from data/aliases.json",
              evidence: { canonicalName, aliases: Object.fromEntries(rawNames.map((rawName) => [rawName, canonicalName])) },
            });
            createdMerges += 1;
          }

          const duplicateAliases = await tx.select().from(entityAliases).where(eq(entityAliases.entityId, duplicate.id));
          for (const alias of duplicateAliases) {
            const [alreadyCanonical] = await tx
              .select({ id: entityAliases.id })
              .from(entityAliases)
              .where(and(eq(entityAliases.entityId, canonical.id), eq(entityAliases.normalizedRaw, alias.normalizedRaw)))
              .limit(1);
            if (alreadyCanonical) {
              await tx.delete(entityAliases).where(eq(entityAliases.id, alias.id));
            } else {
              await tx.update(entityAliases).set({ entityId: canonical.id }).where(eq(entityAliases.id, alias.id));
            }
          }
        }

        for (const rawName of rawNames) {
          const normalizedRaw = normalizeEntityName(rawName);
          const [existingAlias] = await tx
            .select({ id: entityAliases.id })
            .from(entityAliases)
            .where(and(eq(entityAliases.entityId, canonical.id), eq(entityAliases.normalizedRaw, normalizedRaw)))
            .limit(1);
          if (existingAlias) continue;

          await tx.insert(entityAliases).values({
            rawName,
            normalizedRaw,
            entityId: canonical.id,
            confidence: "1.00",
            resolvedBy: "human",
            sourceDocumentId: null,
          });
          createdAliases += 1;
        }
      }
    });
  } finally {
    await client.end({ timeout: 5 });
  }

  console.log(`Seeded curated aliases: ${createdMerges} merge(s), ${createdAliases} alias row(s).`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
