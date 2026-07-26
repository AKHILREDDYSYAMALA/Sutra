const CORPORATE_SUFFIXES = new Set([
  "limited",
  "ltd",
  "private",
  "pvt",
  "plc",
  "inc",
  "incorporated",
  "corporation",
  "corp",
  "company",
  "co",
  "llp",
  "llc",
  "gmbh",
  "sa",
  "nv",
  "bv",
  "ag",
  "pte",
]);

/**
 * Produces the stable identity key used by entities.normalized_name. It is
 * intentionally conservative: it removes legal suffixes, not meaningful name
 * tokens such as "electronics" or "defence".
 */
export function normalizeEntityName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .trim()
    .replace(/[.,&'"]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = normalized ? normalized.split(" ") : [];
  let strippedSuffix = false;

  while (tokens.length > 0 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1]!)) {
    tokens.pop();
    strippedSuffix = true;
  }

  // "India" is part of many legitimate names. Remove it only where the legal
  // suffix proves it was a trailing jurisdiction marker (e.g. "India Pvt Ltd").
  if (strippedSuffix && tokens[tokens.length - 1] === "india") {
    tokens.pop();
  }

  return tokens.join(" ").replace(/\s+/g, " ").trim();
}
