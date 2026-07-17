import { z } from "zod";

export const agencySchema = z.enum(["CRISIL", "ICRA", "CARE", "India Ratings"]);
export const entityTypeSchema = z.enum([
  "target",
  "customer",
  "supplier",
  "lender",
  "subsidiary",
  "parent",
  "group_company",
  "industry",
  "unnamed_dependency",
]);
export const riskFlagSchema = z.enum(["high", "medium", "low"]);

export const graphDataSchema = z
  .object({
    target_company: z.string(),
    rating: z.string().nullable(),
    report_date: z.string().nullable(),
    agency: agencySchema.nullable(),
    nodes: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          type: entityTypeSchema,
          // Existing static graphs omit this field; named entities default to true.
          named: z.boolean().default(true),
        })
        .strict(),
    ),
    edges: z.array(
      z
        .object({
          source: z.string(),
          target: z.string(),
          relation: z.string(),
          exposure_pct: z.number().nullable(),
          risk_flag: riskFlagSchema.nullable(),
          source_quote: z.string().min(1),
          source_page: z.number().int().positive().nullable(),
          confidence: z.enum(["high", "medium"]),
        })
        .strict(),
    ),
    key_risks: z.array(z.string()),
  })
  .strict();

/**
 * Persisted sandbox files carry review status outside the model/API graph contract.
 * Live extraction responses never include this field.
 */
export const sandboxGraphSchema = graphDataSchema.extend({
  verified: z.boolean().default(false),
});

export const notRatingReportSchema = z
  .object({
    error: z.literal("not_a_rating_report"),
  })
  .strict();

/** The API contract after Structured Outputs has been unwrapped server-side. */
export const extractionResultSchema = z.union([graphDataSchema, notRatingReportSchema]);

/**
 * OpenAI Structured Outputs requires an object at the schema root. The model returns
 * this envelope, while the route returns the `result` union directly to the client.
 */
export const structuredExtractionEnvelopeSchema = z
  .object({
    result: extractionResultSchema,
  })
  .strict();

export type GraphData = z.infer<typeof graphDataSchema>;
export type SandboxGraphData = z.infer<typeof sandboxGraphSchema>;
export type GraphNode = GraphData["nodes"][number];
export type GraphEdge = GraphData["edges"][number];
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/**
 * Keeps quote comparison resilient to harmless PDF whitespace, line-break, and
 * typography artifacts without allowing changes to the characters themselves.
 */
export function normaliseForQuoteMatch(value: string) {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, "");
}

export function quoteAppearsInReport(sourceQuote: string, reportText: string) {
  return normaliseForQuoteMatch(reportText).includes(normaliseForQuoteMatch(sourceQuote));
}

/**
 * Returns only graph edges whose mandatory evidence appears verbatim in the PDF text.
 * Failed quotes are intentionally omitted; callers can log the dropped count server-side.
 */
export function validateGraphQuotes(graph: GraphData, reportText: string) {
  const validEdges = graph.edges.filter((edge) => quoteAppearsInReport(edge.source_quote, reportText));
  const droppedEdgeCount = graph.edges.length - validEdges.length;

  return {
    graph: { ...graph, edges: validEdges },
    droppedEdgeCount,
  };
}
