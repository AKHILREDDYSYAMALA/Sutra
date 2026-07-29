import type { GraphData, GraphEdge } from "@/lib/graph-data";

export const quoteMismatchBuckets = [
  "table_derived",
  "cross_page",
  "truncated",
  "paraphrase",
  "not_found",
] as const;

export type QuoteMismatchBucket = (typeof quoteMismatchBuckets)[number];

/** Persisted only for rejected evidence; never used to accept a quote. */
export type RejectedQuoteDiagnostic = {
  model_quote: string;
  claimed_page: number | null;
  entity_labels: { source: string; target: string };
  best_matching_window: string | null;
  similarity_score: number;
  reason_bucket: QuoteMismatchBucket;
  best_match_start_page: number | null;
  best_match_end_page: number | null;
};

type DocumentToken = { value: string; start: number; end: number; page: number | null };
type BestWindow = { start: number; length: number; score: number };

const wordPattern = /[\p{L}\p{N}]+/gu;
const NOT_FOUND_FLOOR = 0.2;

function tokenValue(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function tokenizeValue(value: string) {
  return [...value.matchAll(wordPattern)].map((match) => tokenValue(match[0]!)).filter(Boolean);
}

function tokenizeDocument(value: string): DocumentToken[] {
  const markers = [...value.matchAll(/\[\[\s*page\s+(\d+)\s*\]\]/gi)];
  const segments: Array<{ start: number; end: number; page: number | null }> = [];
  let cursor = 0;
  let page: number | null = null;
  for (const marker of markers) {
    if (cursor < marker.index!) segments.push({ start: cursor, end: marker.index!, page });
    page = Number(marker[1]);
    cursor = marker.index! + marker[0].length;
  }
  if (cursor < value.length) segments.push({ start: cursor, end: value.length, page });
  if (segments.length === 0 && value.length > 0) segments.push({ start: 0, end: value.length, page: null });

  return segments.flatMap((segment) => {
    const text = value.slice(segment.start, segment.end);
    return [...text.matchAll(wordPattern)].map((match) => ({
      value: tokenValue(match[0]!),
      start: segment.start + match.index!,
      end: segment.start + match.index! + match[0]!.length,
      page: segment.page,
    }));
  }).filter((token) => token.value.length > 0);
}

function tokenCounts(tokens: readonly string[]) {
  const counts = new Map<string, number>();
  tokens.forEach((token) => counts.set(token, (counts.get(token) ?? 0) + 1));
  return counts;
}

function overlapScore(modelCounts: Map<string, number>, modelLength: number, candidate: readonly DocumentToken[]) {
  const candidateCounts = new Map<string, number>();
  candidate.forEach((token) => candidateCounts.set(token.value, (candidateCounts.get(token.value) ?? 0) + 1));
  let overlap = 0;
  for (const [token, modelCount] of modelCounts) overlap += Math.min(modelCount, candidateCounts.get(token) ?? 0);
  if (overlap === 0) return 0;
  const precision = overlap / candidate.length;
  const recall = overlap / modelLength;
  return (2 * precision * recall) / (precision + recall);
}

function candidateLengths(modelLength: number, documentLength: number) {
  return [...new Set([
    Math.floor(modelLength * 0.7),
    Math.floor(modelLength * 0.85),
    modelLength - 1,
    modelLength,
    modelLength + 1,
    Math.ceil(modelLength * 1.15),
    Math.ceil(modelLength * 1.3),
  ])]
    .filter((length) => length > 0 && length <= documentLength)
    .sort((left, right) => left - right);
}

function bestMatchingWindow(modelTokens: string[], documentTokens: DocumentToken[]): BestWindow | null {
  if (modelTokens.length === 0 || documentTokens.length === 0) return null;
  const modelCounts = tokenCounts(modelTokens);
  let best: BestWindow | null = null;
  for (const length of candidateLengths(modelTokens.length, documentTokens.length)) {
    for (let start = 0; start <= documentTokens.length - length; start += 1) {
      const score = overlapScore(modelCounts, modelTokens.length, documentTokens.slice(start, start + length));
      const current = { start, length, score };
      if (!best
        || score > best.score
        || (score === best.score && Math.abs(length - modelTokens.length) < Math.abs(best.length - modelTokens.length))) {
        best = current;
      }
    }
  }
  return best;
}

function includesSequence(tokens: readonly string[], sequence: readonly string[]) {
  if (sequence.length === 0 || sequence.length > tokens.length) return false;
  for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
    if (sequence.every((token, index) => token === tokens[start + index])) return true;
  }
  return false;
}

function isStrictPrefixOrSuffix(modelTokens: string[], documentTokens: DocumentToken[], window: BestWindow) {
  const context = documentTokens
    .slice(Math.max(0, window.start - 6), Math.min(documentTokens.length, window.start + window.length + 6))
    .map((token) => token.value);
  if (context.length <= modelTokens.length || !includesSequence(context, modelTokens)) return false;
  const starts = modelTokens.every((token, index) => token === context[index]);
  const ends = modelTokens.every((token, index) => token === context[context.length - modelTokens.length + index]);
  return starts || ends;
}

function isTableLike(window: string, tokens: readonly DocumentToken[], localContext: { text: string; tokens: readonly DocumentToken[] }) {
  if (tokens.length === 0) return false;
  // The token-overlap winner can land on the repeated header at one edge of a
  // table row. Include one window of immediate context on either side so a
  // nearby row number and column labels remain available for classification.
  const tableTokens = localContext.tokens.length > 0 ? localContext.tokens : tokens;
  const shortTokens = tableTokens.filter((token) => token.value.length <= 4).length / tableTokens.length;
  const numericTokens = tableTokens.filter((token) => /\d/.test(token.value)).length / tableTokens.length;
  // Do not mistake the final dot in a company abbreviation (for example, N.A.)
  // for sentence punctuation. Tables commonly contain those abbreviations.
  const tableText = `${window} ${localContext.text}`;
  const hasSentencePunctuation = /(?:[a-z0-9])[.!?](?:\s|$)/.test(tableText);
  const tableHeaders = tableText.match(/\b(annexure|list|details|facility|facilities|amount|limit|lender|rating|consolidation|sr|no)\b/gi)?.length ?? 0;

  // Linearised PDF tables often repeat a header and have only one numeral in a
  // short best-match window. The stricter first branch catches generic tabular
  // windows; the second recognises that repeated-header signature without
  // treating ordinary prose as a table.
  return !hasSentencePunctuation && (
    (shortTokens >= 0.55 && numericTokens >= 0.08)
    || (shortTokens >= 0.4 && numericTokens >= 0.04 && tableHeaders >= 2)
  );
}

function bucketFor(
  modelTokens: string[],
  documentTokens: DocumentToken[],
  window: BestWindow | null,
  sourceWindow: string | null,
  localTableContext: { text: string; tokens: readonly DocumentToken[] },
) {
  if (!window || window.score < NOT_FOUND_FLOOR || !sourceWindow) return "not_found" as const;
  const slice = documentTokens.slice(window.start, window.start + window.length);
  const startsOn = slice[0]?.page ?? null;
  const endsOn = slice.at(-1)?.page ?? null;
  if (isStrictPrefixOrSuffix(modelTokens, documentTokens, window)) return "truncated" as const;
  if (startsOn !== null && endsOn !== null && startsOn !== endsOn) return "cross_page" as const;
  if (isTableLike(sourceWindow, slice, localTableContext)) return "table_derived" as const;
  // This includes low-overlap paraphrases and model reconstructions that share
  // terms but are not verbatim. Neither condition changes quote acceptance.
  return "paraphrase" as const;
}

function diagnosticForEdge(edge: GraphEdge, graph: GraphData, reportText: string, documentTokens: DocumentToken[]): RejectedQuoteDiagnostic {
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const modelTokens = tokenizeValue(edge.source_quote);
  const candidate = bestMatchingWindow(modelTokens, documentTokens);
  // A window below the floor is intentionally treated as absent. We still keep
  // its score so the operator can distinguish no lexical evidence from a close
  // reconstruction, but we do not pretend it is a useful source match.
  const window = candidate && candidate.score >= NOT_FOUND_FLOOR ? candidate : null;
  const windowTokens = window ? documentTokens.slice(window.start, window.start + window.length) : [];
  const sourceWindow = windowTokens.length > 0
    ? reportText.slice(windowTokens[0]!.start, windowTokens.at(-1)!.end).replace(/\s+/g, " ").trim()
    : null;
  const contextTokens = window
    ? documentTokens.slice(Math.max(0, window.start - window.length), Math.min(documentTokens.length, window.start + (window.length * 3)))
    : [];
  const localTableContext = contextTokens.length > 0
    ? {
      text: reportText.slice(contextTokens[0]!.start, contextTokens.at(-1)!.end).replace(/\s+/g, " ").trim(),
      tokens: contextTokens,
    }
    : { text: "", tokens: [] };
  const score = candidate ? Number(candidate.score.toFixed(3)) : 0;
  return {
    model_quote: edge.source_quote,
    claimed_page: edge.source_page,
    entity_labels: { source: labels.get(edge.source) ?? edge.source, target: labels.get(edge.target) ?? edge.target },
    best_matching_window: sourceWindow,
    similarity_score: score,
    reason_bucket: bucketFor(modelTokens, documentTokens, window, sourceWindow, localTableContext),
    best_match_start_page: windowTokens[0]?.page ?? null,
    best_match_end_page: windowTokens.at(-1)?.page ?? null,
  };
}

/**
 * Measures rejected quotes after strict validation has already dropped them.
 * This diagnostic is intentionally side-effect free and is never consulted by
 * `validateGraphQuotes` or any claim-approval path.
 */
export function diagnoseRejectedQuotes(graph: GraphData, rejectedEdges: readonly GraphEdge[], reportText: string): RejectedQuoteDiagnostic[] {
  const documentTokens = tokenizeDocument(reportText);
  return rejectedEdges.map((edge) => diagnosticForEdge(edge, graph, reportText, documentTokens));
}

export function countQuoteMismatchBuckets(entries: readonly RejectedQuoteDiagnostic[]) {
  return quoteMismatchBuckets.reduce<Record<QuoteMismatchBucket, number>>((counts, bucket) => {
    counts[bucket] = entries.filter((entry) => entry.reason_bucket === bucket).length;
    return counts;
  }, {
    table_derived: 0,
    cross_page: 0,
    truncated: 0,
    paraphrase: 0,
    not_found: 0,
  });
}

/**
 * A retry is another observation of the same immutable document. Keep earlier
 * rejected evidence available for analysis instead of replacing it when a later
 * model response happens to omit that edge. Exact repeats are collapsed only to
 * keep the operator report readable.
 */
export function mergeRejectedQuoteDiagnostics(
  previous: readonly RejectedQuoteDiagnostic[],
  current: readonly RejectedQuoteDiagnostic[],
) {
  const seen = new Set<string>();
  return [...previous, ...current].filter((entry) => {
    const key = JSON.stringify([
      entry.model_quote,
      entry.claimed_page,
      entry.entity_labels.source,
      entry.entity_labels.target,
      entry.best_matching_window,
      entry.reason_bucket,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
