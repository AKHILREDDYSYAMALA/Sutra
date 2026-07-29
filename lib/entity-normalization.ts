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
 * PDFs and OCR occasionally put a space inside an all-caps acronym ("BL W").
 * Rejoin only runs made of one- or two-letter uppercase tokens; ordinary words
 * and legal suffixes are left untouched.
 */
export function canonicalizeEntityName(raw: string): string {
  return raw
    .trim()
    .replace(/\b(?:[A-Z]{1,2}\s+){1,}[A-Z]\b/g, (acronym) => acronym.replace(/\s+/g, ""));
}

/**
 * Produces the stable identity key used by entities.normalized_name. It is
 * intentionally conservative: it removes legal suffixes, not meaningful name
 * tokens such as "electronics" or "defence".
 */
export function normalizeEntityName(raw: string): string {
  const normalized = canonicalizeEntityName(raw)
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
