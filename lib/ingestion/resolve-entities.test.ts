import assert from "node:assert/strict";
import test from "node:test";

import { isMalformedDualTargetEdge, relationTypeFor } from "./resolve-entities";

function edgeFor(source: string, target: string) {
  return {
    source,
    target,
    relation: "Fixture relation",
    exposure_pct: null,
    risk_flag: null,
    source_quote: "Fixture source quote.",
    source_page: 1,
    confidence: "high" as const,
  };
}

test("relationTypeFor derives inbound relationships from the non-target endpoint", () => {
  const target = { id: "rated-company", label: "Rated Company", type: "target" };
  ["supplier", "parent", "lender"].forEach((type) => {
    const counterpart = { id: type, label: `${type} fixture`, type };
    const nodes = new Map([[target.id, target], [counterpart.id, counterpart]]);
    assert.equal(relationTypeFor(edgeFor(counterpart.id, target.id), nodes), type, `${type} -> target`);
  });
});

test("dual target edges are identified for audit-only omission", () => {
  const source = { id: "rated-company", label: "Rated Company", type: "target" };
  const target = { id: "acquisition-target", label: "Acquisition target", type: "target" };
  const nodes = new Map([[source.id, source], [target.id, target]]);
  assert.equal(isMalformedDualTargetEdge(edgeFor(source.id, target.id), nodes), true);
});
