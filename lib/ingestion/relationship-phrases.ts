/**
 * Captures document wording that does not yet have a dedicated ledger taxonomy
 * type. It deliberately reads only the verbatim evidence quote; `relationLabel`
 * remains a model-facing summary and is never substituted for source wording.
 */
const relationshipPhrasePatterns = [
  /\bassociate company\b/gi,
  /\bjoint venture\b/gi,
  /\b(?:acquisition of (?:a )?majority stake|acquir(?:ed|es|ing)? (?:a )?majority stake|majority stake acquisition)\b/gi,
];

export function rawRelationshipPhraseFromQuote(quote: string) {
  const phrases = relationshipPhrasePatterns.flatMap((pattern) => [...quote.matchAll(pattern)].map((match) => match[0]));
  const unique = [...new Map(phrases.map((phrase) => [phrase.toLocaleLowerCase(), phrase])).values()];
  return unique.length > 0 ? unique.join("; ") : null;
}
