import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeEntityName, normalizeEntityName } from "./entity-normalization";

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
    ["Sona BL W Precision Forgings Limited", "sona blw precision forgings"],
    ["Syrma SG S Technology Limited", "syrma sgs technology"],
    ["Cyient DL M Limited", "cyient dlm"],
    ["P T C Industries Limited", "ptc industries"],
  ] as const;

  for (const [raw, expected] of cases) {
    assert.equal(normalizeEntityName(raw), expected, raw);
  }
});

test("repairs only split all-caps acronym display names", () => {
  assert.equal(canonicalizeEntityName("Sona BL W Precision Forgings Limited"), "Sona BLW Precision Forgings Limited");
  assert.equal(canonicalizeEntityName("Syrma SG S Technology Limited"), "Syrma SGS Technology Limited");
  assert.equal(canonicalizeEntityName("Cyient DL M Limited"), "Cyient DLM Limited");
  assert.equal(canonicalizeEntityName("P T C Industries Limited"), "PTC Industries Limited");
  assert.equal(canonicalizeEntityName("India Private Limited"), "India Private Limited");
});
