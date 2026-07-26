import assert from "node:assert/strict";

import { requiredDirectUrl } from "../db/env.ts";
import { loadStaticGraphFiles } from "../db/static-graphs.ts";
import { createDatabaseClient } from "../lib/db/client.ts";
import { getCompanyGraph } from "../lib/db/queries.ts";
import { getDependencyRead } from "../lib/domain/dependency-read.ts";
import { buildGraphFromClaims } from "../lib/domain/graph.ts";
import { graphDataSchema } from "../lib/graph-data.ts";

function graphProjection(graph) {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return {
    target_company: graph.target_company,
    rating: graph.rating,
    report_date: graph.report_date,
    agency: graph.agency,
    key_risks: graph.key_risks,
    nodes: graph.nodes.map(({ label, type, named }) => ({ label, type, named })).sort((left, right) => left.label.localeCompare(right.label)),
    edges: graph.edges
      .map((edge) => ({ ...edge, source: labels.get(edge.source), target: labels.get(edge.target) }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

function dependencyProjection(graph) {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const edgeProjection = (edge) => ({
    source: labels.get(edge.source),
    target: labels.get(edge.target),
    relation: edge.relation,
    source_quote: edge.source_quote,
  });
  const read = getDependencyRead(graph);
  return {
    headline: read.headline,
    tone: read.tone,
    customer_concentration: read.customer_concentration,
    evidence_coverage: read.evidence_coverage,
    single_points_of_failure: read.single_points_of_failure.map(({ node, edge }) => ({ node: node.label, edge: edgeProjection(edge) })),
    watch_items: read.watch_items.map(({ text, edge }) => ({ text, edge: edge ? edgeProjection(edge) : undefined })),
    lines: read.lines.map(({ id, label, text, tone, edges }) => ({ id, label, text, tone, edges: edges.map(edgeProjection) })),
  };
}

async function main() {
  const fixtures = await loadStaticGraphFiles();
  const { client, db } = createDatabaseClient(requiredDirectUrl());

  try {
    for (const fixture of fixtures) {
      const expected = graphDataSchema.parse({
        ...fixture.graph,
        nodes: fixture.graph.nodes.map((node) => ({ ...node, named: node.named !== false })),
      });
      const ledger = await getCompanyGraph(db, fixture.slug);
      assert.ok(ledger, `${fixture.slug}: missing published ledger graph`);
      const actual = buildGraphFromClaims(ledger).graph;

      assert.deepStrictEqual(graphProjection(actual), graphProjection(expected), `${fixture.slug}: rendered graph differs from fixture`);
      assert.deepStrictEqual(dependencyProjection(actual), dependencyProjection(expected), `${fixture.slug}: dependency read differs from fixture`);
      console.log(`${fixture.slug}: graph and dependency read match`);
    }
  } finally {
    await client.end({ timeout: 5 });
  }

  console.log(`UI parity verified for ${fixtures.length} ledger-backed company graphs.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
