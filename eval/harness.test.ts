import assert from "node:assert/strict";
import test from "node:test";

import { metricsByRelationType, metricsFor } from "./harness";

const groundTruth = [
  { sourceEntity: "Rated Company", targetEntity: "Customer A", relationType: "customer" as const, exposurePct: 35, evidenceQuote: "Customer A contributed 35% of revenue." },
  { sourceEntity: "Bank B", targetEntity: "Rated Company", relationType: "lender" as const, exposurePct: null, evidenceQuote: "Bank B provides working capital facilities." },
];

test("evaluation scores direction, type, and explicitly stated exposure", () => {
  const returned = [
    { sourceEntity: "Rated Company Limited", targetEntity: "Customer A", relationType: "customer" as const, exposurePct: 35, quote: groundTruth[0]!.evidenceQuote, page: 1 },
    { sourceEntity: "Rated Company", targetEntity: "Bank B", relationType: "lender" as const, exposurePct: null, quote: groundTruth[1]!.evidenceQuote, page: 2 },
  ];
  const aggregate = metricsFor(groundTruth, returned);
  assert.deepEqual(aggregate, { truePositive: 1, falsePositive: 1, falseNegative: 1, precision: 0.5, recall: 0.5 });

  const breakdown = metricsByRelationType(groundTruth, returned);
  assert.deepEqual(breakdown.customer, { truePositive: 1, falsePositive: 0, falseNegative: 0, precision: 1, recall: 1 });
  assert.deepEqual(breakdown.lender, { truePositive: 0, falsePositive: 1, falseNegative: 1, precision: 0, recall: 0 });
});
