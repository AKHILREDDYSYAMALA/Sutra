import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const companyDirectory = path.join(root, "data", "companies");
const fuzzyRepairThreshold = 0.78;

function normaliseReference(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    for (let column = 0; column < current.length; column += 1) previous[column] = current[column];
  }
  return previous[right.length];
}

function similarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  const editScore = 1 - levenshteinDistance(left, right) / longer;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  const sharedTokens = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const tokenScore = sharedTokens / new Set([...leftTokens, ...rightTokens]).size;
  const containmentScore = shorter >= 4 && (left.includes(right) || right.includes(left)) ? 0.8 + 0.2 * (shorter / longer) : 0;
  return Math.max(editScore, tokenScore, containmentScore);
}

function closestNode(reference, nodes) {
  const normalisedReference = normaliseReference(reference);
  let best = null;
  for (const node of [...nodes].sort((left, right) => left.id.localeCompare(right.id))) {
    const score = Math.max(similarity(normalisedReference, normaliseReference(node.id)), similarity(normalisedReference, normaliseReference(node.label)));
    if (!best || score > best.score || (score === best.score && node.id < best.id)) best = { id: node.id, score };
  }
  return best?.score >= fuzzyRepairThreshold ? best : null;
}

const files = fs.readdirSync(companyDirectory).filter((file) => file.endsWith(".json")).sort();
let hardErrorCount = 0;
let warningCount = 0;

for (const file of files) {
  const relativeFile = path.join("data", "companies", file);
  const graph = JSON.parse(fs.readFileSync(path.join(companyDirectory, file), "utf8"));
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const nodeIds = new Set();
  const duplicateIds = [];

  for (const node of nodes) {
    if (!node?.id || nodeIds.has(node.id)) duplicateIds.push(node?.id ?? "<missing>");
    else nodeIds.add(node.id);
  }

  if (duplicateIds.length) {
    hardErrorCount += 1;
    console.error(`[static graph integrity] ${relativeFile}: duplicate or missing node IDs: ${duplicateIds.join(", ")}`);
    continue;
  }

  const repairedEdges = [];
  const unresolvedEdges = [];
  const linkedNodeIds = new Set();

  edges.forEach((edge, index) => {
    const resolved = {};
    for (const endpoint of ["source", "target"]) {
      const value = edge?.[endpoint];
      if (nodeIds.has(value)) {
        resolved[endpoint] = value;
        continue;
      }
      const closest = closestNode(value, nodes);
      if (!closest) {
        unresolvedEdges.push(`#${index} ${endpoint}="${value}"`);
        continue;
      }
      resolved[endpoint] = closest.id;
      repairedEdges.push(`#${index} ${endpoint}: "${value}" → "${closest.id}"`);
    }
    if (resolved.source && resolved.target) {
      linkedNodeIds.add(resolved.source);
      linkedNodeIds.add(resolved.target);
    }
  });

  if (unresolvedEdges.length) {
    hardErrorCount += 1;
    console.error(`[static graph integrity] ${relativeFile}: unresolved edge endpoints: ${unresolvedEdges.join("; ")}`);
  }
  if (repairedEdges.length) {
    warningCount += 1;
    console.warn(`[static graph integrity] ${relativeFile}: runtime will repair ${repairedEdges.join("; ")}`);
  }

  const unlinkedNodes = nodes.filter((node) => node?.type !== "target" && !linkedNodeIds.has(node.id)).map((node) => node.label ?? node.id);
  if (unlinkedNodes.length) {
    warningCount += 1;
    console.warn(`[static graph integrity] ${relativeFile}: unlinked non-target node(s): ${unlinkedNodes.join(", ")}`);
  }
}

if (hardErrorCount) {
  console.error(`Static graph integrity failed with ${hardErrorCount} blocking error(s).`);
  process.exitCode = 1;
} else {
  console.log(`Static graph integrity passed for ${files.length} file(s)${warningCount ? ` with ${warningCount} warning(s)` : ""}.`);
}
