import type { RelationTypeCounts } from "@/lib/extraction/relationship-coverage";

export const goldenRelationTypes = [
  "customer",
  "supplier",
  "lender",
  "subsidiary",
  "parent",
  "group_company",
  "unnamed_dependency",
] as const;

export type GoldenRelationType = typeof goldenRelationTypes[number];

/** Hand-maintained fact from a report, not a model-derived ledger row. */
export type GoldenRelationship = {
  sourceEntity: string;
  targetEntity: string;
  relationType: GoldenRelationType;
  /** Use null when the evidence sentence has no explicit percentage. */
  exposurePct: number | null;
  /** Exact sentence(s) that a human curator verified in the source report. */
  evidenceQuote: string;
};

export type GoldenDocument = {
  documentId: string;
  company: string;
  agency: "ICRA" | "CARE" | "CRISIL" | "India Ratings";
  difficulty: "easy" | "medium" | "hard";
  curationStatus: "needs_curation" | "ready" | "blocked_no_stored_pdf";
  /** Required before changing curationStatus to ready. */
  curatedBy?: string;
  curatedAt?: string;
  relationships: GoldenRelationship[];
  notes?: string;
};

export type EvalRelationship = {
  sourceEntity: string;
  targetEntity: string;
  relationType: GoldenRelationType;
  exposurePct: number | null;
  quote: string;
  page: number | null;
};

export type RelationMetric = {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
};

export type EvalDocumentResult = {
  documentId: string;
  company: string;
  agency: GoldenDocument["agency"];
  difficulty: GoldenDocument["difficulty"];
  latencyMs: number;
  usage: { inputTokens: number | null; outputTokens: number | null };
  estimatedCostUsd: number | null;
  validationLoss: number;
  returnedRelationships: EvalRelationship[];
  groundTruthRelationships: GoldenRelationship[];
  metrics: RelationMetric;
  metricsByRelationType: Record<GoldenRelationType, RelationMetric>;
  error?: string;
};

export type EvalRun = {
  schemaVersion: 1;
  id: string;
  startedAt: string;
  completedAt: string;
  promptVersion: string;
  promptText: string;
  modelVersion: string;
  pricing: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    source: string;
  };
  documents: EvalDocumentResult[];
  summary: {
    metrics: RelationMetric;
    metricsByRelationType: Record<GoldenRelationType, RelationMetric>;
    validationLoss: number;
    estimatedCostUsd: number | null;
    latencyMs: number;
  };
};

export type Counts = RelationTypeCounts;
