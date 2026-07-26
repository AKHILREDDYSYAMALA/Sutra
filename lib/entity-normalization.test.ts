import assert from "node:assert/strict";
import test from "node:test";

import { normalizeEntityName } from "./entity-normalization";

test("normalizes entity names deterministically", () => {
  const cases = [
    ["Tata Motors Limited", "tata motors"],
    ["Tata Motors Ltd", "tata motors"],
    ["LG Electronics (India) Private Limited", "lg electronics (india)"],
    ["LG Electronics India Pvt Ltd", "lg electronics"],
    ["Bloom Energy Corporation", "bloom energy"],
    ["Ministry of Defence, GoI", "ministry of defence goi"],
    ["Samsung Electronics", "samsung electronics"],
    ["Samsung", "samsung"],
  ] as const;

  for (const [raw, expected] of cases) {
    assert.equal(normalizeEntityName(raw), expected, raw);
  }
});
