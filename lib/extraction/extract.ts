import OpenAI from "openai";

import { extractionConfig } from "@/lib/extraction-config";
import { defaultExtractionPromptVersion, getExtractionSystemPrompt } from "@/lib/extraction-prompt";
import { extractionResponseFormat } from "@/lib/extraction-schema";
import { capGroupStructureRelationships, needsCounterpartyCoverageSweep, relationshipCoverage, type RelationshipCoverage } from "@/lib/extraction/relationship-coverage";
import { ensureGraphIntegrity } from "@/lib/graph-integrity";
import { diagnoseRejectedQuotes, type RejectedQuoteDiagnostic } from "@/lib/ingestion/quote-mismatches";
import {
  type AnalysisExclusion,
  graphDataSchema,
  normaliseForQuoteMatch,
  notRatingReportSchema,
  structuredExtractionEnvelopeSchema,
  validateGraphQuotes,
  type AnalysisMeta,
  type GraphData,
} from "@/lib/graph-data";

const TEXT_MINIMUM = 200;
const relationshipPageKeywords = /customer|supplier|vendor|procurement|import|raw material|concentration|counterparty/i;

export const extractionPromptVersion = defaultExtractionPromptVersion;

type PdfPageData = {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
};

type PdfParseResult = { text: string };
type PdfParse = (
  buffer: Buffer,
  options: { pagerender: (pageData: PdfPageData) => Promise<string> },
) => Promise<PdfParseResult>;

type CompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

export type ExtractionUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  maxTokens: number;
  nearTokenCeiling: boolean | null;
};

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly code: "not_configured" | "unreadable_pdf" | "timeout" | "service_unavailable" | "invalid_result" | "not_rating_report",
  ) {
    super(message);
    this.name = "ExtractionError";
  }
}

class ExtractionTimeoutError extends Error {
  constructor() {
    super("Extraction timed out");
    this.name = "ExtractionTimeoutError";
  }
}

export type ExtractedPdfText = {
  fullText: string;
  textForModel: string;
};

export type ExtractedDocument = {
  graph: GraphData;
  meta: AnalysisMeta;
  modelVersion: string;
  promptVersion: string;
  text: ExtractedPdfText;
  /** Measurement-only diagnostics for edges strict quote validation rejected. */
  rejectedQuotes?: RejectedQuoteDiagnostic[];
  /** Runtime token telemetry; null values mean the provider did not report usage. */
  usage?: ExtractionUsage;
  /** Per-relation response coverage, including the group-structure cap audit. */
  coverage?: RelationshipCoverage;
};

/** Used by the read-only evaluator to reproduce a particular checked-in prompt. */
export type ExtractionRunOptions = {
  promptVersion?: string;
  systemPrompt?: string;
};

function labelledPages(pages: string[]) {
  return pages.map((page, index) => `[[PAGE ${index + 1}]]\n${page}`).join("\n\n");
}

function selectTextForModel(pages: string[], fallbackText: string) {
  const fullText = pages.length ? labelledPages(pages) : fallbackText;
  if (fullText.length <= 50_000 || pages.length === 0) return fullText;

  return labelledPages(pages.filter((page, index) => index < 10 || relationshipPageKeywords.test(page)));
}

function parseStructuredResult(content: string) {
  return structuredExtractionEnvelopeSchema.parse(JSON.parse(content)).result;
}

export function extractionUsage(usage?: CompletionUsage): ExtractionUsage {
  const outputTokens = usage?.completion_tokens ?? null;
  const nearTokenCeiling = outputTokens === null
    ? null
    : outputTokens >= Math.ceil(extractionConfig.maxTokens * extractionConfig.nearTokenCeilingRatio);
  return {
    inputTokens: usage?.prompt_tokens ?? null,
    outputTokens,
    maxTokens: extractionConfig.maxTokens,
    nearTokenCeiling,
  };
}

function combinedUsage(...usages: ExtractionUsage[]) {
  const knownInputs = usages.map((usage) => usage.inputTokens).filter((value): value is number => value !== null);
  const knownOutputs = usages.map((usage) => usage.outputTokens).filter((value): value is number => value !== null);
  return {
    inputTokens: knownInputs.length === 0 ? null : knownInputs.reduce((total, value) => total + value, 0),
    outputTokens: knownOutputs.length === 0 ? null : knownOutputs.reduce((total, value) => total + value, 0),
    maxTokens: extractionConfig.maxTokens,
    nearTokenCeiling: usages.some((usage) => usage.nearTokenCeiling === true)
      ? true
      : usages.every((usage) => usage.nearTokenCeiling === null) ? null : false,
  } satisfies ExtractionUsage;
}

function logExtractionMetrics(durationMs: number, usage?: CompletionUsage) {
  const metrics = extractionUsage(usage);
  console.info("Sutra extraction metrics", {
    model: extractionConfig.model,
    input_tokens: metrics.inputTokens,
    output_tokens: metrics.outputTokens,
    max_output_tokens: metrics.maxTokens,
    near_token_ceiling: metrics.nearTokenCeiling,
    duration_ms: durationMs,
  });
  if (metrics.nearTokenCeiling) {
    console.warn("Sutra extraction response is near its output-token ceiling; recall may be incomplete.", {
      model: extractionConfig.model,
      output_tokens: metrics.outputTokens,
      max_output_tokens: metrics.maxTokens,
      threshold: extractionConfig.nearTokenCeilingRatio,
    });
  }
  return metrics;
}

function labelsForEndpoints(graph: { nodes: Array<{ id: string; label: string; type: string }> }, endpoints: string[]) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const knownNodes = endpoints.flatMap((endpoint) => {
    const node = nodeById.get(endpoint);
    return node ? [node] : [];
  });
  const nonTargetLabels = knownNodes.filter((node) => node.type !== "target").map((node) => node.label);
  return [...new Set(nonTargetLabels.length > 0 ? nonTargetLabels : knownNodes.map((node) => node.label))];
}

function buildExclusions(
  sourceGraph: Parameters<typeof validateGraphQuotes>[0],
  quoteMismatches: ReturnType<typeof validateGraphQuotes>["droppedEdges"],
  integrity: ReturnType<typeof ensureGraphIntegrity>,
) {
  const exclusions = new Map<string, AnalysisExclusion["reason"]>();
  const add = (labels: string[], reason: AnalysisExclusion["reason"]) => {
    labels.forEach((label) => {
      if (!exclusions.has(label) || reason === "quote_not_verified") exclusions.set(label, reason);
    });
  };

  quoteMismatches.forEach((edge) => add(labelsForEndpoints(sourceGraph, [edge.source, edge.target]), "quote_not_verified"));
  integrity.droppedEdges.forEach((edge) => add(labelsForEndpoints(sourceGraph, [edge.source, edge.target]), "unresolved_endpoint"));
  integrity.unlinkedNodeIds.forEach((nodeId) => add(labelsForEndpoints(sourceGraph, [nodeId]), "unresolved_endpoint"));

  return [...exclusions.entries()].map(([label, reason]) => ({ label, reason }));
}

function mergeGraphs(primary: GraphData, sweep: GraphData): GraphData {
  const nodes = [...primary.nodes];
  const identityToId = new Map(primary.nodes.map((node) => [`${node.type}\u001f${node.named}\u001f${normaliseForQuoteMatch(node.label)}`, node.id]));
  const usedIds = new Set(primary.nodes.map((node) => node.id));
  const remappedSweepIds = new Map<string, string>();
  sweep.nodes.forEach((node) => {
    const identity = `${node.type}\u001f${node.named}\u001f${normaliseForQuoteMatch(node.label)}`;
    const knownId = identityToId.get(identity);
    if (knownId) {
      remappedSweepIds.set(node.id, knownId);
      return;
    }
    let id = node.id;
    let suffix = 2;
    while (usedIds.has(id)) id = `${node.id}-sweep-${suffix++}`;
    usedIds.add(id);
    identityToId.set(identity, id);
    remappedSweepIds.set(node.id, id);
    nodes.push({ ...node, id });
  });
  const seenEdges = new Set(primary.edges.map((edge) => `${edge.source}\u001f${edge.target}\u001f${normaliseForQuoteMatch(edge.source_quote)}`));
  const edges = [...primary.edges];
  sweep.edges.forEach((edge) => {
    const source = remappedSweepIds.get(edge.source) ?? edge.source;
    const target = remappedSweepIds.get(edge.target) ?? edge.target;
    const key = `${source}\u001f${target}\u001f${normaliseForQuoteMatch(edge.source_quote)}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push({ ...edge, source, target });
  });
  return {
    ...primary,
    nodes,
    edges,
    relationship_summary: {
      group_structure_total_seen: Math.max(
        primary.relationship_summary?.group_structure_total_seen ?? 0,
        sweep.relationship_summary?.group_structure_total_seen ?? 0,
      ),
    },
    key_risks: [...new Set([...primary.key_risks, ...sweep.key_risks])],
  };
}

function graphFromModelContent(modelContent: string): GraphData {
  let modelResult;
  try {
    modelResult = parseStructuredResult(modelContent);
  } catch {
    console.warn("Sutra could not parse a Structured Outputs response.", { model: extractionConfig.model });
    throw new ExtractionError("The extraction model returned an unreadable structured result. Please try again.", "invalid_result");
  }
  if (notRatingReportSchema.safeParse(modelResult).success) {
    throw new ExtractionError("This doesn't look like a credit rating report", "not_rating_report");
  }
  const parsed = graphDataSchema.safeParse(modelResult);
  if (!parsed.success) {
    console.warn("Sutra rejected an extraction that did not match the graph schema.", parsed.error.flatten());
    throw new ExtractionError("The extraction did not match Sutra's evidence schema. Please try again.", "invalid_result");
  }
  return parsed.data;
}

/** Extracts labelled PDF text once so classification and extraction share the same source. */
export async function extractPdfText(fileBuffer: Buffer): Promise<ExtractedPdfText> {
  const pages: string[] = [];
  const imported = await import("pdf-parse");
  const pdfParse = (imported.default ?? imported) as unknown as PdfParse;
  const result = await pdfParse(fileBuffer, {
    pagerender: async (pageData) => {
      const textContent = await pageData.getTextContent();
      const pageText = textContent.items
        .map((item) => item.str ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push(pageText);
      return pageText;
    },
  });

  return {
    fullText: pages.length ? labelledPages(pages) : result.text,
    textForModel: selectTextForModel(pages, result.text),
  };
}

/**
 * The only model-backed PDF extraction path. Browser uploads and the persistent
 * ingestion pipeline both call this function, so quote validation cannot drift.
 */
export async function extract(
  fileBuffer: Buffer,
  suppliedText?: ExtractedPdfText,
  options: ExtractionRunOptions = {},
): Promise<ExtractedDocument> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || apiKey === "YOUR_OPENAI_API_KEY") {
    throw new ExtractionError("server not configured", "not_configured");
  }

  let text: ExtractedPdfText;
  try {
    text = suppliedText ?? await extractPdfText(fileBuffer);
  } catch {
    throw new ExtractionError(
      "We could not detect readable text in this PDF. Please upload a text-based report rather than a scanned document.",
      "unreadable_pdf",
    );
  }

  if (normaliseForQuoteMatch(text.fullText).length < TEXT_MINIMUM) {
    throw new ExtractionError(
      "We could not detect readable text in this PDF. Please upload a text-based report rather than a scanned document.",
      "unreadable_pdf",
    );
  }

  const client = new OpenAI({ apiKey, maxRetries: 0 });
  const systemPrompt = options.systemPrompt ?? getExtractionSystemPrompt();
  const promptVersion = options.promptVersion ?? extractionPromptVersion;
  const extractionStartedAt = Date.now();
  const abortController = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const completionRequest = client.chat.completions.create(
      {
        model: extractionConfig.model,
        temperature: extractionConfig.temperature,
        max_tokens: extractionConfig.maxTokens,
        response_format: extractionResponseFormat,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Extract the relationship graph from this rating report. The full report is used for quote verification; analyse only the report text below.\n\n${text.textForModel}`,
          },
        ],
      },
      { timeout: extractionConfig.timeoutMs, maxRetries: 0, signal: abortController.signal },
    );
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        reject(new ExtractionTimeoutError());
      }, extractionConfig.timeoutMs);
    });
    const completion = await Promise.race([completionRequest, timeout]);
    const primaryUsage = logExtractionMetrics(Date.now() - extractionStartedAt, completion.usage);

    const modelContent = completion.choices[0]?.message.content;
    if (!modelContent) throw new ExtractionError("The extraction model returned no analysis. Please try again.", "invalid_result");
    let extractedGraph = graphFromModelContent(modelContent);
    let usage = primaryUsage;
    let counterpartyCoverageSweep = false;
    if (needsCounterpartyCoverageSweep(extractedGraph)) {
      try {
        const sweepRequest = client.chat.completions.create(
          {
            model: extractionConfig.model,
            temperature: extractionConfig.temperature,
            max_tokens: extractionConfig.maxTokens,
            response_format: extractionResponseFormat,
            messages: [
              { role: "system", content: systemPrompt },
              {
                role: "user",
                content: `Run a counterparty coverage sweep over this rating report. Return ONLY explicitly evidenced customer, supplier, lender, parent, and unnamed_dependency relationships. Do not return subsidiary or group_company edges in this sweep; those were handled separately. Continue through the entire report and prioritise named counterparties. Still populate relationship_summary as required by the schema.\n\n${text.textForModel}`,
              },
            ],
          },
          { timeout: extractionConfig.timeoutMs, maxRetries: 0, signal: abortController.signal },
        );
        const sweepCompletion = await Promise.race([sweepRequest, timeout]);
        const sweepUsage = logExtractionMetrics(Date.now() - extractionStartedAt, sweepCompletion.usage);
        const sweepContent = sweepCompletion.choices[0]?.message.content;
        if (!sweepContent) throw new ExtractionError("The counterparty coverage sweep returned no analysis.", "invalid_result");
        extractedGraph = mergeGraphs(extractedGraph, graphFromModelContent(sweepContent));
        usage = combinedUsage(primaryUsage, sweepUsage);
        counterpartyCoverageSweep = true;
      } catch (error) {
        // The primary result remains valid. A supplemental recall pass must not
        // turn an otherwise reviewable report into a failed ingestion.
        console.warn("Sutra counterparty coverage sweep did not complete; retaining the primary extraction.", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const limited = capGroupStructureRelationships(extractedGraph);
    const { graph: quoteValidatedGraph, droppedEdgeCount, droppedEdges } = validateGraphQuotes(limited.graph, text.fullText);
    const rejectedQuotes = diagnoseRejectedQuotes(limited.graph, droppedEdges, text.fullText);
    const integrity = ensureGraphIntegrity(quoteValidatedGraph);
    const coverage = relationshipCoverage(limited, integrity.graph, counterpartyCoverageSweep);
    const excluded = buildExclusions(limited.graph, droppedEdges, integrity);
    if (droppedEdgeCount > 0 || integrity.droppedEdges.length > 0 || integrity.repairedEdges.length > 0 || integrity.unlinkedNodeIds.length > 0 || integrity.duplicateNodeIds.length > 0) {
      console.warn("Sutra extraction integrity adjustments.", {
        quoteMismatch: droppedEdgeCount,
        quoteMismatchBuckets: rejectedQuotes.reduce<Record<string, number>>((counts, entry) => {
          counts[entry.reason_bucket] = (counts[entry.reason_bucket] ?? 0) + 1;
          return counts;
        }, {}),
        unresolvedEndpoint: integrity.droppedEdges.length,
        repairedEndpoint: integrity.repairedEdges.length,
        unlinkedNodes: integrity.unlinkedNodeIds,
        duplicateNodeIds: integrity.duplicateNodeIds,
        excludedEntities: excluded.length,
        returnedEdges: integrity.graph.edges.length,
        relationCounts: coverage.claim_relation_counts,
        groupStructureTotalSeen: coverage.group_structure_total_seen,
        groupStructureCapped: coverage.group_structure_capped,
      });
    }

    return {
      graph: integrity.graph,
      meta: { excluded },
      modelVersion: extractionConfig.model,
      promptVersion,
      text,
      rejectedQuotes,
      usage,
      coverage,
    };
  } catch (error) {
    logExtractionMetrics(Date.now() - extractionStartedAt);
    if (error instanceof ExtractionError) throw error;
    if (error instanceof ExtractionTimeoutError || error instanceof OpenAI.APIConnectionTimeoutError) {
      throw new ExtractionError(`The extraction timed out after ${Math.round(extractionConfig.timeoutMs / 1_000)} seconds. Please try a shorter report.`, "timeout");
    }
    if (error instanceof OpenAI.APIError) {
      console.warn("Sutra extraction API request failed.", { model: extractionConfig.model, status: error.status, code: error.code, type: error.type });
      throw new ExtractionError("The extraction service is temporarily unavailable. Please try again later.", "service_unavailable");
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// Kept as a descriptive alias for existing server callers while `extract` remains
// the single public extraction entry point used by both Day 5 paths.
export const extractDocumentFromPdf = extract;
