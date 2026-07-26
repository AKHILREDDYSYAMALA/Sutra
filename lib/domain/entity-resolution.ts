export type EntityMerge = {
  fromEntityId: string;
  intoEntityId: string;
  revertedAt: Date | string | null;
};

/** Follows active merge records without mutating the original claim endpoint. */
export function resolveEntity(entityId: string, merges: readonly EntityMerge[]): string {
  const activeMerges = new Map<string, string>();
  for (const merge of merges) {
    if (merge.revertedAt === null) activeMerges.set(merge.fromEntityId, merge.intoEntityId);
  }

  const seen = new Set<string>();
  let resolved = entityId;
  while (activeMerges.has(resolved) && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = activeMerges.get(resolved)!;
  }

  return resolved;
}

export function entityFamily(canonicalEntityId: string, merges: readonly EntityMerge[]): Set<string> {
  const members = new Set<string>([canonicalEntityId]);
  let changed = true;

  while (changed) {
    changed = false;
    for (const merge of merges) {
      if (merge.revertedAt === null && members.has(merge.intoEntityId) && !members.has(merge.fromEntityId)) {
        members.add(merge.fromEntityId);
        changed = true;
      }
    }
  }

  return members;
}
