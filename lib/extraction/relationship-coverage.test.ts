import assert from "node:assert/strict";
import test from "node:test";

import { extractionUsage } from "./extract";
import { capGroupStructureRelationships, GROUP_STRUCTURE_RELATIONSHIP_CAP, needsCounterpartyCoverageSweep, relationshipCoverage } from "./relationship-coverage";

test("token-ceiling telemetry flags the final ten percent of the configured output budget", () => {
  assert.equal(extractionUsage({ completion_tokens: 10_800 }).nearTokenCeiling, true);
  assert.equal(extractionUsage({ completion_tokens: 10_799 }).nearTokenCeiling, false);
  assert.equal(extractionUsage().nearTokenCeiling, null);
});

test("group-structure claims are capped while dependency relations remain uncapped and measurable", () => {
  const graph = {
    target_company: "Suzlon Energy Limited",
    rating: "ICRA A/Stable",
    report_date: "July 1, 2026",
    agency: "ICRA" as const,
    nodes: [
      { id: "suzlon", label: "Suzlon Energy Limited", type: "target" as const, named: true },
      { id: "customer", label: "Named Wind Customer", type: "customer" as const, named: true },
      { id: "lender", label: "Named Bank", type: "lender" as const, named: true },
      ...Array.from({ length: GROUP_STRUCTURE_RELATIONSHIP_CAP + 2 }, (_, index) => ({
        id: `subsidiary-${index + 1}`,
        label: `Suzlon Subsidiary ${index + 1}`,
        type: "subsidiary" as const,
        named: true,
      })),
    ],
    edges: [
      {
        source: "suzlon", target: "customer", relation: "Top wind customer", exposure_pct: 42, risk_flag: "high" as const,
        source_quote: "Named Wind Customer contributed 42% of revenue.", source_page: 2, confidence: "high" as const,
      },
      {
        source: "lender", target: "suzlon", relation: "Working capital lender", exposure_pct: null, risk_flag: null,
        source_quote: "Named Bank provides working capital facilities.", source_page: 3, confidence: "high" as const,
      },
      ...Array.from({ length: GROUP_STRUCTURE_RELATIONSHIP_CAP + 2 }, (_, index) => ({
        source: "suzlon", target: `subsidiary-${index + 1}`, relation: `Subsidiary ${index + 1}`, exposure_pct: null, risk_flag: null,
        source_quote: `Suzlon Subsidiary ${index + 1} is included in the consolidation scope.`, source_page: 4, confidence: "medium" as const,
      })),
    ],
    relationship_summary: { group_structure_total_seen: 29 },
    key_risks: [],
  };

  const limited = capGroupStructureRelationships(graph);
  const coverage = relationshipCoverage(limited, limited.graph);

  assert.equal(needsCounterpartyCoverageSweep(graph), false, "a single dependency edge prevents the focused sweep");
  assert.equal(needsCounterpartyCoverageSweep({
    ...graph,
    edges: graph.edges.filter((edge) => edge.target.startsWith("subsidiary-")),
  }), true, "a large structure-only response triggers the focused sweep");
  assert.equal(limited.graph.edges.filter((edge) => edge.target.startsWith("subsidiary-")).length, GROUP_STRUCTURE_RELATIONSHIP_CAP);
  assert.equal(coverage.model_returned_relation_counts.subsidiary, GROUP_STRUCTURE_RELATIONSHIP_CAP + 2);
  assert.equal(coverage.claim_relation_counts.subsidiary, GROUP_STRUCTURE_RELATIONSHIP_CAP);
  assert.equal(coverage.claim_relation_counts.customer, 1);
  assert.equal(coverage.claim_relation_counts.lender, 1);
  assert.equal(coverage.group_structure_total_seen, 29);
  assert.equal(coverage.group_structure_capped, 2);
});
