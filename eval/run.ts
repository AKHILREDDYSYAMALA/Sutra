import path from "node:path";

import { requiredDirectUrl } from "@/db/env";
import { createDatabaseClient } from "@/lib/db/client";
import { defaultExtractionPromptVersion } from "@/lib/extraction-prompt";

import { runEvaluation } from "./harness";

function valueAfter(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function percentage(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

async function main() {
  const args = process.argv.slice(2);
  const promptVersion = valueAfter(args, "--prompt-version") ?? defaultExtractionPromptVersion;
  if (args.length !== (args.includes("--prompt-version") ? 2 : 0)) {
    throw new Error("Usage: npm run eval -- [--prompt-version <version>]");
  }
  const { client, db } = createDatabaseClient(requiredDirectUrl());
  try {
    const { run, outputPath } = await runEvaluation({
      db,
      promptVersion,
      outputDirectory: path.join(process.cwd(), "evals"),
    });
    console.table(run.documents.map((document) => ({
      company: document.company,
      precision: percentage(document.metrics.precision),
      recall: percentage(document.metrics.recall),
      validation_loss: document.validationLoss,
      input_tokens: document.usage.inputTokens ?? "—",
      output_tokens: document.usage.outputTokens ?? "—",
      cost_usd: document.estimatedCostUsd?.toFixed(6) ?? "—",
      latency_ms: document.latencyMs,
      error: document.error ?? "—",
    })));
    console.table(Object.entries(run.summary.metricsByRelationType).map(([relationType, metric]) => ({
      relation_type: relationType,
      precision: percentage(metric.precision),
      recall: percentage(metric.recall),
      tp: metric.truePositive,
      fp: metric.falsePositive,
      fn: metric.falseNegative,
    })));
    console.log(JSON.stringify({
      output: outputPath,
      precision: percentage(run.summary.metrics.precision),
      recall: percentage(run.summary.metrics.recall),
      validationLoss: run.summary.validationLoss,
      estimatedCostUsd: run.summary.estimatedCostUsd,
      latencyMs: run.summary.latencyMs,
    }, null, 2));
    if (run.documents.some((document) => document.error)) process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
