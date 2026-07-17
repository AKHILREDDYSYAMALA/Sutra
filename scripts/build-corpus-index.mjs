import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companyDirectory = path.join(root, "data", "companies");
const aliases = JSON.parse(fs.readFileSync(path.join(root, "data", "aliases.json"), "utf8"));

function baseNormaliseEntityName(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:ltd|limited|pvt|private|india|inc|incorporated|llc|corp|corporation)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const aliasMap = new Map(Object.entries(aliases).map(([variant, canonical]) => [baseNormaliseEntityName(variant), baseNormaliseEntityName(canonical)]));
const aliasLabels = new Map(Object.entries(aliases).map(([variant, canonical]) => [baseNormaliseEntityName(variant), canonical]));

function normaliseEntityName(value) {
  const base = baseNormaliseEntityName(value);
  return aliasMap.get(base) ?? base;
}

function canonicalLabelFor(value) {
  return aliasLabels.get(baseNormaliseEntityName(value)) ?? value;
}

function perspectiveFor(entity, counterparty, reportCompany, targetNodeId) {
  if (entity.id === targetNodeId) {
    switch (counterparty.type) {
      case "customer":
        return `Supplies to ${counterparty.label}`;
      case "supplier":
        return `Receives supplies from ${counterparty.label}`;
      case "lender":
        return `Financed by ${counterparty.label}`;
      case "subsidiary":
        return `Operates through subsidiary ${counterparty.label}`;
      case "parent":
        return `Part of ${counterparty.label}`;
      case "group_company":
        return `Group relationship with ${counterparty.label}`;
      case "unnamed_dependency":
        return `Has a reported unnamed dependency`;
      default:
        return `Relationship with ${counterparty.label}`;
    }
  }

  switch (entity.type) {
    case "customer":
      return `Customer of ${reportCompany}`;
    case "supplier":
      return `Supplies to ${reportCompany}`;
    case "lender":
      return `Lender to ${reportCompany}`;
    case "subsidiary":
      return `Subsidiary of ${reportCompany}`;
    case "parent":
      return `Parent of ${reportCompany}`;
    case "group_company":
      return `Group company of ${reportCompany}`;
    case "unnamed_dependency":
      return `Reported unnamed dependency of ${reportCompany}`;
    case "industry":
      return `Industry relationship with ${reportCompany}`;
    default:
      return `Relationship with ${reportCompany}`;
  }
}

const entities = new Map();

function addNode(node, reportCompany) {
  const key = normaliseEntityName(node.label);
  if (!key) return null;

  if (!entities.has(key)) {
    entities.set(key, {
      canonical_label: canonicalLabelFor(node.label),
      report_ids: new Set(),
      relationships: [],
    });
  }

  const entity = entities.get(key);
  entity.report_ids.add(reportCompany);
  return { key, entity };
}

const companyFiles = fs
  .readdirSync(companyDirectory)
  .filter((file) => file.endsWith(".json"))
  .sort();
let verifiedCompanyCount = 0;

for (const file of companyFiles) {
  const graph = JSON.parse(fs.readFileSync(path.join(companyDirectory, file), "utf8"));
  if (graph.verified !== true) continue;
  verifiedCompanyCount += 1;
  const nodesById = new Map(graph.nodes.map((node) => [node.id, { ...node, named: node.named !== false }]));
  const targetNode = graph.nodes.find((node) => node.type === "target");

  for (const node of nodesById.values()) addNode(node, graph.target_company);

  for (const edge of graph.edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (!source || !target) continue;

    for (const [entity, counterparty] of [
      [source, target],
      [target, source],
    ]) {
      const indexed = addNode(entity, graph.target_company);
      if (!indexed) continue;
      indexed.entity.relationships.push({
        entity_label: entity.label,
        entity_named: entity.named,
        entity_type: entity.type,
        counterparty_label: counterparty.label,
        counterparty_named: counterparty.named,
        counterparty_type: counterparty.type,
        perspective: perspectiveFor(entity, counterparty, graph.target_company, targetNode?.id),
        report_company: graph.target_company,
        report_date: graph.report_date,
        agency: graph.agency,
        rating: graph.rating,
        relation: edge.relation,
        exposure_pct: edge.exposure_pct,
        risk_flag: edge.risk_flag,
        source_quote: edge.source_quote,
        source_page: edge.source_page,
        confidence: edge.confidence,
      });
    }
  }
}

const serialisedEntities = Object.fromEntries(
  [...entities.entries()].map(([key, entity]) => [
    key,
    {
      canonical_label: entity.canonical_label,
      report_count: entity.report_ids.size,
      relationships: entity.relationships.sort(
        (left, right) => (right.report_date ?? "").localeCompare(left.report_date ?? "") || left.report_company.localeCompare(right.report_company),
      ),
    },
  ]),
);

const output = {
  generated_at_build: true,
  entity_normalisation: "lowercase; punctuation and legal suffixes stripped; aliases applied",
  entities: serialisedEntities,
};

fs.writeFileSync(path.join(root, "data", "corpus-index.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Indexed ${Object.keys(serialisedEntities).length} entities across ${verifiedCompanyCount} verified static reports.`);
