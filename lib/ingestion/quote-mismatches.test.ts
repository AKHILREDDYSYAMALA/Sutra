import assert from "node:assert/strict";
import test from "node:test";

import type { GraphData } from "@/lib/graph-data";

import { diagnoseRejectedQuotes, mergeRejectedQuoteDiagnostics } from "./quote-mismatches";

function graphWithQuote(quote: string): GraphData {
  return {
    target_company: "Fixture Company",
    rating: null,
    report_date: "2026-06-25",
    agency: "ICRA",
    nodes: [
      { id: "company", label: "Fixture Company", type: "target", named: true },
      { id: "counterparty", label: "Fixture Counterparty", type: "lender", named: true },
    ],
    edges: [{
      source: "company",
      target: "counterparty",
      relation: "Fixture lender",
      exposure_pct: null,
      risk_flag: null,
      source_quote: quote,
      source_page: 1,
      confidence: "high",
    }],
    key_risks: [],
  };
}

function bucketFor(quote: string, reportText: string) {
  const graph = graphWithQuote(quote);
  return diagnoseRejectedQuotes(graph, graph.edges, reportText)[0]!;
}

test("quote-mismatch diagnostics classify source windows without changing validation", () => {
  const table = bucketFor(
    "Axis Bank facility limit 100 tenure 2026",
    "[[PAGE 1]] Axis Bank Limit 100 200 Tenure 2026 2027 Rating A A",
  );
  assert.equal(table.reason_bucket, "table_derived");
  assert.ok(table.best_matching_window?.includes("Axis Bank"));

  const linearisedAnnexure = bucketFor(
    "Annexure List of Entities Consolidated 2 Tata Example Subsidiary",
    "[[PAGE 3]] Annexure List of Entities Consolidated Sr No Names of Entities Consolidated Extent of Consolidation 1 Tata Motors 2 Tata Example Subsidiary",
  );
  assert.equal(linearisedAnnexure.reason_bucket, "table_derived");

  const crossPage = bucketFor(
    "alpha beta delta epsilon",
    "[[PAGE 1]] alpha beta gamma [[PAGE 2]] delta epsilon zeta",
  );
  assert.equal(crossPage.reason_bucket, "cross_page");
  assert.equal(crossPage.best_match_start_page, 1);
  assert.equal(crossPage.best_match_end_page, 2);

  const truncated = bucketFor(
    "Total facilities",
    "Total facilities sanctioned by lenders remain unchanged during the year.",
  );
  assert.equal(truncated.reason_bucket, "truncated");

  const paraphrase = bucketFor(
    "Strong financial flexibility with ample liquidity",
    "The company has strong liquidity position and prudent debt metrics.",
  );
  assert.equal(paraphrase.reason_bucket, "paraphrase");
  assert.ok(paraphrase.similarity_score > 0.2);

  const notFound = bucketFor(
    "Aerospace turbine orders from an overseas customer",
    "Domestic steel operations remained stable during the quarter.",
  );
  assert.equal(notFound.reason_bucket, "not_found");
  assert.equal(notFound.best_matching_window, null);
});

test("retry diagnostics retain earlier rejected quotes without duplicate rows", () => {
  const earlier = bucketFor(
    "Axis Bank facility limit 100 tenure 2026",
    "[[PAGE 1]] Axis Bank Limit 100 200 Tenure 2026 2027 Rating A A",
  );
  const later = bucketFor(
    "Strong financial flexibility with ample liquidity",
    "The company has strong liquidity position and prudent debt metrics.",
  );
  assert.deepEqual(mergeRejectedQuoteDiagnostics([earlier], [later, earlier]), [earlier, later]);
});
