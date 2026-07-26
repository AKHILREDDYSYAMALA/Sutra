import assert from "node:assert/strict";
import test from "node:test";

import { loadStaticGraphFiles, parseReportDate, type StaticEdge, type StaticGraph, type StaticGraphFile } from "../../db/static-graphs";
import { normalizeEntityName } from "../entity-normalization";
import { buildCorpusIndex, getCorpusEntity } from "./corpus";
import { getDependencyRead } from "./dependency-read";
import { buildGraphFromClaims, type LedgerGraph } from "./graph";

function relationTypeFor(edge: StaticEdge, nodes: Map<string, StaticGraph["nodes"][number]>) {
  const source = nodes.get(edge.source)!;
  const target = nodes.get(edge.target)!;
  if (source.named === false || target.named === false || target.type === "industry") return "unnamed_dependency";
  return target.type === "customer" || target.type === "supplier" || target.type === "lender" || target.type === "subsidiary" || target.type === "parent" || target.type === "group_company"
    ? target.type
    : "unnamed_dependency";
}

/** Adapts a checked-in fixture into plain ledger rows without consulting a database. */
function ledgerFromFixture(file: StaticGraphFile): LedgerGraph {
  const nodes = new Map(file.graph.nodes.map((node) => [node.id, node]));
  const target = file.graph.nodes.find((node) => node.type === "target")!;
  const companyId = `${file.slug}:company`;
  const documentId = `${file.slug}:document`;

  return {
    company: { id: companyId, name: file.graph.target_company },
    document: {
      id: documentId,
      agency: file.graph.agency,
      rating: file.graph.rating,
      publishedDate: parseReportDate(file.graph.report_date),
      metadata: { keyRisks: file.graph.key_risks, reportDateRaw: file.graph.report_date },
    },
    entities: file.graph.nodes.map((node) => ({
      id: `${file.slug}:${node.id}`,
      canonicalName: node.label,
      normalizedName: node.named === false ? `unnamed:${file.slug}:${node.id}` : normalizeEntityName(node.label),
      entityType: node.named === false ? "unnamed" : "company",
      companyId: node.id === target.id ? companyId : null,
    })),
    claims: file.graph.edges.map((edge, index) => ({
      id: `${file.slug}:claim:${index}`,
      documentId,
      companyId,
      sourceEntityId: `${file.slug}:${edge.source}`,
      targetEntityId: `${file.slug}:${edge.target}`,
      sourceLabel: nodes.get(edge.source)!.label,
      targetLabel: nodes.get(edge.target)!.label,
      relationType: relationTypeFor(edge, nodes),
      relationLabel: edge.relation,
      exposurePct: edge.exposure_pct === null ? null : String(edge.exposure_pct),
      riskFlag: edge.risk_flag,
      quote: edge.source_quote,
      page: edge.source_page,
      observedDate: parseReportDate(file.graph.report_date),
      extractionConfidence: edge.confidence,
      verificationTier: "human_verified" as const,
    })),
    excludedClaimCount: 0,
  };
}

function graphProjection(graph: ReturnType<typeof buildGraphFromClaims>["graph"]) {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return {
    target_company: graph.target_company,
    rating: graph.rating,
    report_date: graph.report_date,
    agency: graph.agency,
    key_risks: graph.key_risks,
    nodes: graph.nodes.map(({ label, type, named }) => ({ label, type, named })).sort((left, right) => left.label.localeCompare(right.label)),
    edges: graph.edges.map((edge) => ({ ...edge, source: labels.get(edge.source), target: labels.get(edge.target) })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

function fixtureProjection(file: StaticGraphFile) {
  const labels = new Map(file.graph.nodes.map((node) => [node.id, node.label]));
  return {
    target_company: file.graph.target_company,
    rating: file.graph.rating,
    report_date: file.graph.report_date,
    agency: file.graph.agency,
    key_risks: file.graph.key_risks,
    nodes: file.graph.nodes.map((node) => ({ label: node.label, type: node.type, named: node.named !== false })).sort((left, right) => left.label.localeCompare(right.label)),
    edges: file.graph.edges.map((edge) => ({ ...edge, source: labels.get(edge.source), target: labels.get(edge.target) })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

test("ledger graph rendering preserves the checked-in fixture semantics", async () => {
  const fixtures = await loadStaticGraphFiles();

  for (const fixture of fixtures) {
    const rendered = buildGraphFromClaims(ledgerFromFixture(fixture));
    assert.deepEqual(graphProjection(rendered.graph), fixtureProjection(fixture), fixture.fileName);
    assert.deepEqual(getDependencyRead(rendered.graph), getDependencyRead(rendered.graph), `${fixture.fileName} dependency read must be deterministic`);
  }
});

test("corpus resolution follows a reversible entity merge without changing claims", async () => {
  const fixtures = await loadStaticGraphFiles();
  const amber = ledgerFromFixture(fixtures.find((fixture) => fixture.slug === "amber-enterprises")!);
  const dixon = ledgerFromFixture(fixtures.find((fixture) => fixture.slug === "dixon-technologies")!);
  const corpus = buildCorpusIndex(
    [amber, dixon],
    [{ fromEntityId: "amber-enterprises:samsung", intoEntityId: "dixon-technologies:samsung-electronics", revertedAt: null }],
    [{ normalizedRaw: "samsung", entityId: "dixon-technologies:samsung-electronics" }],
  );

  const samsung = getCorpusEntity(corpus, "Samsung");
  assert.ok(samsung);
  assert.equal(samsung.canonical_label, "Samsung Electronics");
  assert.equal(samsung.report_count, 2);
  assert.equal(amber.claims.some((claim) => claim.targetEntityId === "amber-enterprises:samsung"), true);
});
