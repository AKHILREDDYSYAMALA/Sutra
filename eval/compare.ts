import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { relationshipIdentity } from "./harness";
import type { EvalRelationship, EvalRun } from "./types";

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function readableRelationship(relationship: EvalRelationship) {
  const exposure = relationship.exposurePct === null ? "" : ` (${relationship.exposurePct.toFixed(2)}%)`;
  return `${relationship.sourceEntity} → ${relationship.targetEntity} [${relationship.relationType}]${exposure}`;
}

async function latestRunForPrompt(directory: string, promptVersion: string) {
  const candidates = await Promise.all((await readdir(directory))
    .filter((file) => file.endsWith(".json"))
    .map(async (file) => ({
      file,
      run: JSON.parse(await readFile(path.join(directory, file), "utf8")) as EvalRun,
    })));
  const matches = candidates
    .filter((candidate) => candidate.run.schemaVersion === 1 && candidate.run.promptVersion === promptVersion)
    .sort((left, right) => right.run.completedAt.localeCompare(left.run.completedAt));
  const latest = matches[0];
  if (!latest) throw new Error(`No saved eval run for prompt '${promptVersion}' in ${directory}.`);
  return latest.run;
}

export function compareEvalRuns(left: EvalRun, right: EvalRun) {
  const leftByDocument = new Map(left.documents.map((document) => [document.documentId, document]));
  const rightByDocument = new Map(right.documents.map((document) => [document.documentId, document]));
  return [...new Set([...leftByDocument.keys(), ...rightByDocument.keys()])]
    .map((documentId) => {
      const a = leftByDocument.get(documentId);
      const b = rightByDocument.get(documentId);
      const aRelationships = new Map((a?.returnedRelationships ?? []).map((relationship) => [relationshipIdentity(relationship), relationship]));
      const bRelationships = new Map((b?.returnedRelationships ?? []).map((relationship) => [relationshipIdentity(relationship), relationship]));
      const gained = [...bRelationships.entries()].filter(([identity]) => !aRelationships.has(identity)).map(([, relationship]) => relationship);
      const lost = [...aRelationships.entries()].filter(([identity]) => !bRelationships.has(identity)).map(([, relationship]) => relationship);
      return {
        documentId,
        company: b?.company ?? a?.company ?? documentId,
        gained,
        lost,
      };
    })
    .filter((document) => document.gained.length > 0 || document.lost.length > 0);
}

async function main() {
  const args = process.argv.slice(2);
  const a = valueAfter(args, "--a");
  const b = valueAfter(args, "--b");
  if (!a || !b || args.length !== 4) throw new Error("Usage: npm run eval:compare -- --a <prompt_version> --b <prompt_version>");
  const directory = path.join(process.cwd(), "evals");
  const [left, right] = await Promise.all([latestRunForPrompt(directory, a), latestRunForPrompt(directory, b)]);
  const differences = compareEvalRuns(left, right);
  if (differences.length === 0) {
    console.log(`No relationship differences between ${a} and ${b}.`);
    return;
  }
  differences.forEach((difference) => {
    console.log(`\n${difference.company} (${difference.documentId})`);
    difference.gained.forEach((relationship) => console.log(`  + ${readableRelationship(relationship)}`));
    difference.lost.forEach((relationship) => console.log(`  - ${readableRelationship(relationship)}`));
  });
  const recallRegressions = Object.entries(right.summary.metricsByRelationType)
    .flatMap(([relationType, next]) => {
      const previous = left.summary.metricsByRelationType[relationType as keyof typeof left.summary.metricsByRelationType];
      if (previous.recall === null || next.recall === null || next.recall >= previous.recall) return [];
      return [{ relationType, before: previous.recall, after: next.recall }];
    });
  if (recallRegressions.length > 0) {
    console.error("\nRecall regression — reject or revise this prompt change:");
    recallRegressions.forEach((regression) => console.error(
      `  ${regression.relationType}: ${(regression.before * 100).toFixed(1)}% → ${(regression.after * 100).toFixed(1)}%`,
    ));
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
