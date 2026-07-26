import assert from "node:assert/strict";
import test from "node:test";

import { resolveEntity, type EntityMerge } from "./entity-resolution";

function merge(fromEntityId: string, intoEntityId: string, revertedAt: Date | string | null = null): EntityMerge {
  return { fromEntityId, intoEntityId, revertedAt };
}

test("resolveEntity follows a single active merge", () => {
  assert.equal(resolveEntity("samsung", [merge("samsung", "samsung-electronics")]), "samsung-electronics");
});

test("resolveEntity follows multi-hop active merges", () => {
  assert.equal(
    resolveEntity("a", [merge("a", "b"), merge("b", "c")]),
    "c",
  );
});

test("resolveEntity ignores a reverted merge", () => {
  assert.equal(
    resolveEntity("a", [merge("a", "b", "2026-07-26T00:00:00.000Z")]),
    "a",
  );
});

test("resolveEntity terminates a malformed merge cycle at its origin", () => {
  const cycle = [merge("a", "b"), merge("b", "a")];
  assert.equal(resolveEntity("a", cycle), "a");
  assert.equal(resolveEntity("b", cycle), "b");
});
