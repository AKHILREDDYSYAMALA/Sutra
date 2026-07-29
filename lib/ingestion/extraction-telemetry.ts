import type { ExtractedDocument } from "@/lib/extraction/extract";
import { relationshipTypeCounts, type RelationTypeCounts } from "@/lib/extraction/relationship-coverage";

export type ExtractionTelemetry = {
  relation_type_counts: RelationTypeCounts;
  model_returned_relation_counts: RelationTypeCounts;
  group_structure_total_seen: number;
  group_structure_response_edges: number;
  group_structure_capped: number;
  counterparty_coverage_sweep: boolean;
  near_token_ceiling: boolean | null;
  output_tokens: number | null;
  max_output_tokens: number | null;
};

/** Metadata that makes extraction recall measurable without persisting model prose. */
export function extractionTelemetry(extracted: ExtractedDocument): ExtractionTelemetry {
  const fallbackCounts = relationshipTypeCounts(extracted.graph);
  return {
    relation_type_counts: extracted.coverage?.claim_relation_counts ?? fallbackCounts,
    model_returned_relation_counts: extracted.coverage?.model_returned_relation_counts ?? fallbackCounts,
    group_structure_total_seen: extracted.coverage?.group_structure_total_seen ?? 0,
    group_structure_response_edges: extracted.coverage?.group_structure_response_edges ?? 0,
    group_structure_capped: extracted.coverage?.group_structure_capped ?? 0,
    counterparty_coverage_sweep: extracted.coverage?.counterparty_coverage_sweep ?? false,
    near_token_ceiling: extracted.usage?.nearTokenCeiling ?? null,
    output_tokens: extracted.usage?.outputTokens ?? null,
    max_output_tokens: extracted.usage?.maxTokens ?? null,
  };
}

export function storedExtractionTelemetry(value: unknown): ExtractionTelemetry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const telemetry = (value as { extraction?: unknown }).extraction;
  if (!telemetry || typeof telemetry !== "object" || Array.isArray(telemetry)) return undefined;
  const candidate = telemetry as Partial<ExtractionTelemetry>;
  if (!candidate.relation_type_counts || typeof candidate.relation_type_counts !== "object") return undefined;
  return candidate as ExtractionTelemetry;
}
