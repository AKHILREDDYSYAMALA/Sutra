import OpenAI from "openai";

import { extractionConfig } from "@/lib/extraction-config";
import { getExtractionSystemPrompt } from "@/lib/extraction-prompt";
import { extractionResponseFormat } from "@/lib/extraction-schema";
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

export const extractionPromptVersion = "rating_rationale_v1";

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

function logExtractionMetrics(durationMs: number, usage?: CompletionUsage) {
  console.info("Sutra extraction metrics", {
    model: extractionConfig.model,
    input_tokens: usage?.prompt_tokens ?? null,
    output_tokens: usage?.completion_tokens ?? null,
    duration_ms: durationMs,
  });
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
          { role: "system", content: getExtractionSystemPrompt() },
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
    logExtractionMetrics(Date.now() - extractionStartedAt, completion.usage);

    const modelContent = completion.choices[0]?.message.content;
    if (!modelContent) throw new ExtractionError("The extraction model returned no analysis. Please try again.", "invalid_result");

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

    const { graph: quoteValidatedGraph, droppedEdgeCount, droppedEdges } = validateGraphQuotes(parsed.data, text.fullText);
    const rejectedQuotes = diagnoseRejectedQuotes(parsed.data, droppedEdges, text.fullText);
    const integrity = ensureGraphIntegrity(quoteValidatedGraph);
    const excluded = buildExclusions(parsed.data, droppedEdges, integrity);
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
      });
    }

    return {
      graph: integrity.graph,
      meta: { excluded },
      modelVersion: extractionConfig.model,
      promptVersion: extractionPromptVersion,
      text,
      rejectedQuotes,
    };
  } catch (error) {
    logExtractionMetrics(Date.now() - extractionStartedAt);
    if (error instanceof ExtractionError) throw error;
    if (error instanceof ExtractionTimeoutError || error instanceof OpenAI.APIConnectionTimeoutError) {
      throw new ExtractionError("The extraction timed out after 30 seconds. Please try a shorter report.", "timeout");
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
