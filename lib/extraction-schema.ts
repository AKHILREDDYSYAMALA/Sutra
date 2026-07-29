/**
 * JSON Schema sent to OpenAI Structured Outputs. It deliberately mirrors the Zod
 * data contract in graph-data.ts, including required `named` fields for strict mode.
 */
const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: "null" }],
});

const nodeSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    type: {
      type: "string",
      enum: ["target", "customer", "supplier", "lender", "subsidiary", "parent", "group_company", "industry", "unnamed_dependency"],
    },
    named: { type: "boolean" },
  },
  required: ["id", "label", "type", "named"],
  additionalProperties: false,
};

const edgeSchema = {
  type: "object",
  properties: {
    source: { type: "string" },
    target: { type: "string" },
    relation: { type: "string" },
    exposure_pct: nullable({ type: "number" }),
    risk_flag: nullable({ type: "string", enum: ["high", "medium", "low"] }),
    source_quote: { type: "string", minLength: 1 },
    source_page: nullable({ type: "integer", minimum: 1 }),
    confidence: { type: "string", enum: ["high", "medium"] },
  },
  required: ["source", "target", "relation", "exposure_pct", "risk_flag", "source_quote", "source_page", "confidence"],
  additionalProperties: false,
};

const graphSchema = {
  type: "object",
  properties: {
    target_company: { type: "string" },
    rating: nullable({ type: "string" }),
    report_date: nullable({ type: "string" }),
    agency: nullable({ type: "string", enum: ["CRISIL", "ICRA", "CARE", "India Ratings"] }),
    nodes: { type: "array", items: nodeSchema },
    edges: { type: "array", items: edgeSchema },
    relationship_summary: {
      type: "object",
      properties: {
        group_structure_total_seen: { type: "integer", minimum: 0 },
      },
      required: ["group_structure_total_seen"],
      additionalProperties: false,
    },
    key_risks: { type: "array", items: { type: "string" } },
  },
  required: ["target_company", "rating", "report_date", "agency", "nodes", "edges", "relationship_summary", "key_risks"],
  additionalProperties: false,
};

const notRatingReportSchema = {
  type: "object",
  properties: {
    error: { type: "string", const: "not_a_rating_report" },
  },
  required: ["error"],
  additionalProperties: false,
};

/**
 * The API requires strict schemas to have an object root. The nested union gives
 * the model a graph-or-error result, and the route unwraps `result` before reply.
 */
export const extractionStructuredOutputSchema = {
  type: "object",
  properties: {
    result: {
      anyOf: [graphSchema, notRatingReportSchema],
    },
  },
  required: ["result"],
  additionalProperties: false,
} as const;

export const extractionResponseFormat = {
  type: "json_schema" as const,
  json_schema: {
    name: "sutra_extraction_result",
    strict: true,
    schema: extractionStructuredOutputSchema,
  },
} as const;
