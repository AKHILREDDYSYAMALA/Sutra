/**
 * One place to tune Sutra's extraction behavior. Keep this server-side by importing
 * it only from API routes.
 */
export const extractionConfig = {
  model: "gpt-4o",
  temperature: 0,
  // Group-heavy rationales can otherwise spend the entire response on a
  // consolidation list before reaching customer, supplier, and lender evidence.
  maxTokens: 12_000,
  nearTokenCeilingRatio: 0.9,
  // A 12k-token structured response can legitimately outlast the old 30s cap.
  timeoutMs: 90_000,
} as const;
