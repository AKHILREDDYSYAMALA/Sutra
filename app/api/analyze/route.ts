import OpenAI from "openai";
import { NextResponse } from "next/server";
import { extractionConfig } from "@/lib/extraction-config";
import { getExtractionSystemPrompt } from "@/lib/extraction-prompt";
import { extractionResponseFormat } from "@/lib/extraction-schema";
import { ensureGraphIntegrity } from "@/lib/graph-integrity";
import {
  type AnalysisExclusion,
  graphDataSchema,
  normaliseForQuoteMatch,
  notRatingReportSchema,
  structuredExtractionEnvelopeSchema,
  validateGraphQuotes,
} from "@/lib/graph-data";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const TEXT_MINIMUM = 200;
const relationshipPageKeywords = /customer|supplier|vendor|procurement|import|raw material|concentration|counterparty/i;

type PdfPageData = {
  getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
};

type PdfParseResult = { text: string };
type PdfParse = (
  buffer: Buffer,
  options: { pagerender: (pageData: PdfPageData) => Promise<string> },
) => Promise<PdfParseResult>;

function labelledPages(pages: string[]) {
  return pages.map((page, index) => `[[PAGE ${index + 1}]]\n${page}`).join("\n\n");
}

function selectTextForModel(pages: string[], fallbackText: string) {
  const fullText = pages.length ? labelledPages(pages) : fallbackText;
  if (fullText.length <= 50_000 || pages.length === 0) return fullText;

  // Per the product decision: retain the first ten pages and every relationship-relevant page.
  const selectedPages = pages.filter((page, index) => index < 10 || relationshipPageKeywords.test(page));
  return labelledPages(selectedPages);
}

function parseStructuredResult(content: string) {
  // Structured Outputs returns JSON matching the declared schema; no fence/prose extraction is performed.
  return structuredExtractionEnvelopeSchema.parse(JSON.parse(content)).result;
}

type CompletionUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

class ExtractionTimeoutError extends Error {
  constructor() {
    super("Extraction timed out");
    this.name = "ExtractionTimeoutError";
  }
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

async function extractPdfText(fileBuffer: Buffer) {
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

  const fullText = pages.length ? labelledPages(pages) : result.text;
  return { fullText, textForModel: selectTextForModel(pages, result.text) };
}

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey || apiKey === "YOUR_OPENAI_API_KEY") {
      return NextResponse.json({ error: "server not configured" }, { status: 503 });
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Please upload a PDF rating report." }, { status: 400 });
    }

    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "Please upload a non-empty PDF smaller than 10MB." }, { status: 413 });
    }
    if (file.type && file.type !== "application/pdf") {
      return NextResponse.json({ error: "Only PDF rating reports are supported." }, { status: 415 });
    }

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const { fullText, textForModel } = await extractPdfText(fileBuffer);

    if (normaliseForQuoteMatch(fullText).length < TEXT_MINIMUM) {
      return NextResponse.json(
        { error: "We could not detect readable text in this PDF. Please upload a text-based report rather than a scanned document." },
        { status: 422 },
      );
    }

    // Disable SDK retries: the user-facing deadline is a hard 30 seconds, not
    // 30 seconds per retry. The AbortController and race below provide an
    // additional hard wall-clock guard in case the transport ignores timeout.
    const client = new OpenAI({ apiKey, maxRetries: 0 });
    const extractionStartedAt = Date.now();
    let completion;
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
              content: `Extract the relationship graph from this rating report. The full report is used for quote verification; analyse only the report text below.\n\n${textForModel}`,
            },
          ],
        },
        {
          timeout: extractionConfig.timeoutMs,
          maxRetries: 0,
          signal: abortController.signal,
        },
      );
      const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort();
          reject(new ExtractionTimeoutError());
        }, extractionConfig.timeoutMs);
      });

      completion = await Promise.race([completionRequest, timeout]);
    } catch (error) {
      const durationMs = Date.now() - extractionStartedAt;
      logExtractionMetrics(durationMs);

      if (error instanceof ExtractionTimeoutError || error instanceof OpenAI.APIConnectionTimeoutError) {
        return NextResponse.json({ error: "The extraction timed out after 30 seconds. Please try a shorter report." }, { status: 504 });
      }

      console.warn("Sutra extraction API request failed.", {
        model: extractionConfig.model,
        status: error instanceof OpenAI.APIError ? error.status : null,
        code: error instanceof OpenAI.APIError ? error.code : null,
        type: error instanceof OpenAI.APIError ? error.type : null,
      });

      if (error instanceof OpenAI.APIError) {
        return NextResponse.json({ error: "The extraction service is temporarily unavailable. Please try again later." }, { status: 503 });
      }

      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    logExtractionMetrics(Date.now() - extractionStartedAt, completion.usage);

    const modelContent = completion.choices[0]?.message.content;
    if (!modelContent) {
      return NextResponse.json({ error: "The extraction model returned no analysis. Please try again." }, { status: 502 });
    }

    let modelResult;
    try {
      modelResult = parseStructuredResult(modelContent);
    } catch {
      console.warn("Sutra could not parse a Structured Outputs response.", { model: extractionConfig.model });
      return NextResponse.json({ error: "The extraction model returned an unreadable structured result. Please try again." }, { status: 502 });
    }

    if (notRatingReportSchema.safeParse(modelResult).success) {
      return NextResponse.json({ error: "This doesn't look like a credit rating report" }, { status: 422 });
    }

    const parsed = graphDataSchema.safeParse(modelResult);
    if (!parsed.success) {
      console.warn("Sutra rejected an extraction that did not match the graph schema.", parsed.error.flatten());
      return NextResponse.json({ error: "The extraction did not match Sutra's evidence schema. Please try again." }, { status: 502 });
    }

    const { graph: quoteValidatedGraph, droppedEdgeCount, droppedEdges } = validateGraphQuotes(parsed.data, fullText);
    const integrity = ensureGraphIntegrity(quoteValidatedGraph);
    const excluded = buildExclusions(parsed.data, droppedEdges, integrity);

    if (droppedEdgeCount > 0 || integrity.droppedEdges.length > 0 || integrity.repairedEdges.length > 0 || integrity.unlinkedNodeIds.length > 0 || integrity.duplicateNodeIds.length > 0) {
      console.warn("Sutra extraction integrity adjustments.", {
        quoteMismatch: droppedEdgeCount,
        unresolvedEndpoint: integrity.droppedEdges.length,
        repairedEndpoint: integrity.repairedEdges.length,
        unlinkedNodes: integrity.unlinkedNodeIds,
        duplicateNodeIds: integrity.duplicateNodeIds,
        excludedEntities: excluded.length,
        returnedEdges: integrity.graph.edges.length,
      });
    }

    return NextResponse.json({ graph: integrity.graph, meta: { excluded } });
  } catch {
    // Do not log request headers or SDK error objects: they may contain sensitive context.
    console.error("Sutra PDF analysis failed.");
    return NextResponse.json({ error: "We could not analyse this PDF. Please try another text-based rating report." }, { status: 500 });
  }
}
