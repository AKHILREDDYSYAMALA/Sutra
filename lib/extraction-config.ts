/**
 * One place to tune Sutra's extraction behavior. Keep this server-side by importing
 * it only from API routes.
 */
export const extractionConfig = {
  model: "gpt-4o",
  temperature: 0,
  maxTokens: 4_000,
  timeoutMs: 30_000,
} as const;
