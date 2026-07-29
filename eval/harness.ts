import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq, inArray } from "drizzle-orm";

import { documents } from "@/db/schema";
import { normalizeEntityName } from "@/lib/entity-normalization";
import { extractionConfig } from "@/lib/extraction-config";
import { extractionPromptForVersion } from "@/lib/extraction-prompt";
import { extract } from "@/lib/extraction/extract";
import { relationTypeFor } from "@/lib/ingestion/resolve-entities";
import { downloadDocumentPdf } from "@/lib/ingestion/storage";

import { goldenSet } from "./golden-set";
import { goldenRelationTypes, type EvalDocumentResult, type EvalRelationship, type EvalRun, type GoldenDocument, type GoldenRelationType, type GoldenRelationship, type RelationMetric } from "./types";

type Database = any;

const pricingByModel: Record<string, { inputPerMillionUsd: number; outputPerMillionUsd: number; source: string }> = {
  // Default API (not Priority processing). The exact rates used are recorded in
  // every output so past comparisons remain interpretable if pricing changes.
  "gpt-4o": {
    inputPerMillionUsd: 2.5,
    outputPerMillionUsd: 10,
    source: "https://openai.com/index/api-prompt-caching/ (default GPT-4o API rate, checked 2026-07-29)",
  },
};

function zeroMetric(): RelationMetric {
  return { truePositive: 0, falsePositive: 0, falseNegative: 0, precision: null, recall: null };
}

function withRates(truePositive: number, falsePositive: number, falseNegative: number): RelationMetric {
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision: truePositive + falsePositive === 0 ? null : truePositive / (truePositive + falsePositive),
    recall: truePositive + falseNegative === 0 ? null : truePositive / (truePositive + falseNegative),
  };
}

function normalisedEntity(value: string) {
  return normalizeEntityName(value) || value.trim().toLocaleLowerCase();
}

export function relationshipIdentity(relationship: Pick<GoldenRelationship, "sourceEntity" | "targetEntity" | "relationType" | "exposurePct"> | Pick<EvalRelationship, "sourceEntity" | "targetEntity" | "relationType" | "exposurePct">) {
  return [
    normalisedEntity(relationship.sourceEntity),
    normalisedEntity(relationship.targetEntity),
    relationship.relationType,
    relationship.exposurePct === null ? "none" : relationship.exposurePct.toFixed(2),
  ].join("\u001f");
}

export function metricsFor(
  groundTruth: readonly GoldenRelationship[],
  returned: readonly EvalRelationship[],
  relationType?: GoldenRelationType,
) {
  const expected = new Set(
    groundTruth.filter((relationship) => !relationType || relationship.relationType === relationType).map(relationshipIdentity),
  );
  const actual = new Set(
    returned.filter((relationship) => !relationType || relationship.relationType === relationType).map(relationshipIdentity),
  );
  let truePositive = 0;
  actual.forEach((identity) => {
    if (expected.has(identity)) truePositive += 1;
  });
  return withRates(truePositive, actual.size - truePositive, expected.size - truePositive);
}

export function metricsByRelationType(groundTruth: readonly GoldenRelationship[], returned: readonly EvalRelationship[]) {
  return Object.fromEntries(goldenRelationTypes.map((relationType) => [relationType, metricsFor(groundTruth, returned, relationType)])) as Record<GoldenRelationType, RelationMetric>;
}

function returnedRelationships(graph: Awaited<ReturnType<typeof extract>>["graph"]): EvalRelationship[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.flatMap((edge) => {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) return [];
    try {
      return [{
        sourceEntity: source.label,
        targetEntity: target.label,
        relationType: relationTypeFor(edge, nodes) as GoldenRelationType,
        exposurePct: edge.exposure_pct,
        quote: edge.source_quote,
        page: edge.source_page,
      }];
    } catch {
      return [];
    }
  });
}

function estimatedCost(usage: { inputTokens: number | null; outputTokens: number | null }, pricing: EvalRun["pricing"]) {
  if (usage.inputTokens === null || usage.outputTokens === null) return null;
  return (usage.inputTokens * pricing.inputPerMillionUsd + usage.outputTokens * pricing.outputPerMillionUsd) / 1_000_000;
}

function readyGoldenDocuments() {
  const ready = goldenSet.filter((document) => document.curationStatus === "ready");
  if (ready.length === 0) {
    const pending = goldenSet.filter((document) => document.curationStatus !== "ready").map((document) => `${document.company} (${document.curationStatus})`).join(", ");
    throw new Error(`No curated golden documents are ready. Hand-curate eval/golden-set.ts first. Pending: ${pending}`);
  }
  const unprovenanced = ready.filter((document) => !document.curatedBy || !document.curatedAt);
  if (unprovenanced.length > 0) throw new Error(`Ready golden documents need curatedBy and curatedAt: ${unprovenanced.map((document) => document.company).join(", ")}`);
  return ready;
}

function aggregateMetrics(documentsToAggregate: EvalDocumentResult[]) {
  const combined = documentsToAggregate.reduce((totals, document) => ({
    truePositive: totals.truePositive + document.metrics.truePositive,
    falsePositive: totals.falsePositive + document.metrics.falsePositive,
    falseNegative: totals.falseNegative + document.metrics.falseNegative,
  }), { truePositive: 0, falsePositive: 0, falseNegative: 0 });
  return withRates(combined.truePositive, combined.falsePositive, combined.falseNegative);
}

function aggregateMetricsByRelationType(documentsToAggregate: EvalDocumentResult[]) {
  return Object.fromEntries(goldenRelationTypes.map((relationType) => {
    const combined = documentsToAggregate.reduce((totals, document) => {
      const metric = document.metricsByRelationType[relationType];
      return {
        truePositive: totals.truePositive + metric.truePositive,
        falsePositive: totals.falsePositive + metric.falsePositive,
        falseNegative: totals.falseNegative + metric.falseNegative,
      };
    }, { truePositive: 0, falsePositive: 0, falseNegative: 0 });
    return [relationType, withRates(combined.truePositive, combined.falsePositive, combined.falseNegative)];
  })) as Record<GoldenRelationType, RelationMetric>;
}

function errorResult(document: GoldenDocument, error: unknown): EvalDocumentResult {
  return {
    documentId: document.documentId,
    company: document.company,
    agency: document.agency,
    difficulty: document.difficulty,
    latencyMs: 0,
    usage: { inputTokens: null, outputTokens: null },
    estimatedCostUsd: null,
    validationLoss: 0,
    returnedRelationships: [],
    groundTruthRelationships: document.relationships,
    metrics: zeroMetric(),
    metricsByRelationType: Object.fromEntries(goldenRelationTypes.map((type) => [type, zeroMetric()])) as Record<GoldenRelationType, RelationMetric>,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Runs against stored immutable PDFs only. It never inserts or updates ledger data. */
export async function runEvaluation(input: { db: Database; promptVersion: string; outputDirectory: string }) {
  const promptText = extractionPromptForVersion(input.promptVersion);
  const selected = readyGoldenDocuments();
  const pricing = pricingByModel[extractionConfig.model];
  if (!pricing) throw new Error(`No evaluator pricing profile exists for model '${extractionConfig.model}'. Add an explicit one before running eval.`);
  const startedAt = new Date().toISOString();
  const storedDocuments = await input.db
    .select({ id: documents.id, storagePath: documents.storagePath })
    .from(documents)
    .where(inArray(documents.id, selected.map((document) => document.documentId)));
  const storagePathByDocument = new Map<string, string | null>(
    storedDocuments.map((document: { id: string; storagePath: string | null }) => [document.id, document.storagePath]),
  );
  const results: EvalDocumentResult[] = [];

  for (const goldenDocument of selected) {
    const evaluationStartedAt = performance.now();
    try {
      const storagePath = storagePathByDocument.get(goldenDocument.documentId);
      if (!storagePath) throw new Error("Golden document has no immutable stored PDF.");
      const pdf = await downloadDocumentPdf(storagePath);
      const extracted = await extract(pdf, undefined, { promptVersion: input.promptVersion, systemPrompt: promptText });
      const relationships = returnedRelationships(extracted.graph);
      const usage = {
        inputTokens: extracted.usage?.inputTokens ?? null,
        outputTokens: extracted.usage?.outputTokens ?? null,
      };
      results.push({
        documentId: goldenDocument.documentId,
        company: goldenDocument.company,
        agency: goldenDocument.agency,
        difficulty: goldenDocument.difficulty,
        latencyMs: Math.round(performance.now() - evaluationStartedAt),
        usage,
        estimatedCostUsd: estimatedCost(usage, pricing),
        validationLoss: extracted.rejectedQuotes?.length ?? 0,
        returnedRelationships: relationships,
        groundTruthRelationships: goldenDocument.relationships,
        metrics: metricsFor(goldenDocument.relationships, relationships),
        metricsByRelationType: metricsByRelationType(goldenDocument.relationships, relationships),
      });
    } catch (error) {
      results.push(errorResult(goldenDocument, error));
    }
  }

  const successful = results.filter((result) => !result.error);
  const run: EvalRun = {
    schemaVersion: 1,
    id: randomUUID(),
    startedAt,
    completedAt: new Date().toISOString(),
    promptVersion: input.promptVersion,
    promptText,
    modelVersion: extractionConfig.model,
    pricing,
    documents: results,
    summary: {
      metrics: aggregateMetrics(successful),
      metricsByRelationType: aggregateMetricsByRelationType(successful),
      validationLoss: successful.reduce((total, result) => total + result.validationLoss, 0),
      estimatedCostUsd: successful.some((result) => result.estimatedCostUsd === null)
        ? null
        : successful.reduce((total, result) => total + (result.estimatedCostUsd ?? 0), 0),
      latencyMs: successful.reduce((total, result) => total + result.latencyMs, 0),
    },
  };
  await mkdir(input.outputDirectory, { recursive: true });
  const filename = `${run.completedAt.replaceAll(":", "-").replaceAll(".", "-")}--${run.promptVersion}.json`;
  const outputPath = path.join(input.outputDirectory, filename);
  await writeFile(outputPath, `${JSON.stringify(run, null, 2)}\n`, "utf8");
  return { run, outputPath };
}
