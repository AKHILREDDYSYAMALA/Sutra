import postgres from "postgres";

import { requiredDirectUrl } from "./env";

type EntityUsage = {
  id: string;
  canonical_name: string;
  normalized_name: string;
  claim_count: number;
  documents: string[];
};

type Candidate = {
  left: EntityUsage;
  right: EntityUsage;
  confidence: number;
  signals: string[];
};

const TOKEN_OVERLAP_THRESHOLD = 0.8;

function tokens(value: string) {
  return value.split(" ").filter(Boolean);
}

function overlapRatio(left: string[], right: string[]) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union === 0 ? 0 : intersection / union;
}

function hasMatchingEdgeTrim(left: string[], right: string[]) {
  if (left.length < 2 || right.length < 2) return false;
  const forms = (value: string[]) => [value.slice(1), value.slice(0, -1)].filter((form) => form.length >= 2).map((form) => form.join(" "));
  const leftForms = new Set(forms(left));
  return forms(right).some((form) => leftForms.has(form))
    || leftForms.has(right.join(" "))
    || new Set(forms(right)).has(left.join(" "));
}

function candidateFor(left: EntityUsage, right: EntityUsage): Candidate | null {
  const leftTokens = tokens(left.normalized_name);
  const rightTokens = tokens(right.normalized_name);
  const shorter = left.normalized_name.length <= right.normalized_name.length ? left : right;
  const longer = shorter === left ? right : left;
  const signals: string[] = [];
  let confidence = 0;

  if (shorter.normalized_name.length >= 4 && longer.normalized_name.includes(shorter.normalized_name)) {
    signals.push("normalized name is a prefix or substring");
    confidence = Math.max(confidence, 0.95);
  }

  const overlap = overlapRatio(leftTokens, rightTokens);
  if (overlap >= TOKEN_OVERLAP_THRESHOLD) {
    signals.push(`token overlap ${(overlap * 100).toFixed(0)}%`);
    confidence = Math.max(confidence, Math.min(0.92, 0.7 + overlap / 4));
  }

  if (hasMatchingEdgeTrim(leftTokens, rightTokens)) {
    signals.push("identical after removing one leading or trailing token");
    confidence = Math.max(confidence, 0.88);
  }

  return signals.length > 0 ? { left, right, confidence, signals } : null;
}

function suggestedCanonical(candidate: Candidate) {
  if (candidate.left.claim_count !== candidate.right.claim_count) {
    return candidate.left.claim_count > candidate.right.claim_count ? candidate.left : candidate.right;
  }
  return candidate.left.canonical_name.localeCompare(candidate.right.canonical_name) <= 0 ? candidate.left : candidate.right;
}

function summarizeDocuments(documents: string[]) {
  return documents.length === 0 ? "none" : documents.join(" | ");
}

async function main() {
  const client = postgres(requiredDirectUrl(), { max: 1, prepare: false });

  try {
    const entities = await client<EntityUsage[]>`
      with endpoints as (
        select source_entity_resolved as entity_id, document_id from claims_resolved
        union all
        select target_entity_resolved as entity_id, document_id from claims_resolved
      )
      select
        entities.id,
        entities.canonical_name,
        entities.normalized_name,
        count(endpoints.document_id)::int as claim_count,
        coalesce(
          array_agg(distinct coalesce(documents.title, documents.id::text))
            filter (where documents.id is not null),
          array[]::text[]
        ) as documents
      from entities
      left join endpoints on endpoints.entity_id = entities.id
      left join documents on documents.id = endpoints.document_id
      where entities.entity_type <> 'unnamed'
        and not exists (
          select 1
          from entity_merges
          where entity_merges.from_entity_id = entities.id
            and entity_merges.reverted_at is null
        )
      group by entities.id, entities.canonical_name, entities.normalized_name
      order by entities.canonical_name
    `;

    const rejectedPairs = new Set((await client<{ entity_a_id: string; entity_b_id: string }[]>`
      select entity_a_id, entity_b_id from entity_merge_rejections
    `).map((pair) => [pair.entity_a_id, pair.entity_b_id].sort().join("\u0000")));

    const candidates = entities.flatMap((left, leftIndex) =>
      entities.slice(leftIndex + 1).flatMap((right) => {
        if (rejectedPairs.has([left.id, right.id].sort().join("\u0000"))) return [];
        const candidate = candidateFor(left, right);
        return candidate ? [candidate] : [];
      }),
    ).sort((left, right) => right.confidence - left.confidence || (right.left.claim_count + right.right.claim_count) - (left.left.claim_count + left.right.claim_count));

    if (candidates.length === 0) {
      console.log("No conservative duplicate candidates found. No database changes were made.");
      return;
    }

    for (const candidate of candidates) {
      const suggested = suggestedCanonical(candidate);
      const duplicate = suggested.id === candidate.left.id ? candidate.right : candidate.left;
      console.log(`\n${candidate.left.canonical_name}  <->  ${candidate.right.canonical_name}`);
      console.log(`  confidence: ${candidate.confidence.toFixed(2)} (${candidate.signals.join("; ")})`);
      console.log(`  ${candidate.left.canonical_name}: ${candidate.left.claim_count} resolved claim endpoint(s); documents: ${summarizeDocuments(candidate.left.documents)}`);
      console.log(`  ${candidate.right.canonical_name}: ${candidate.right.claim_count} resolved claim endpoint(s); documents: ${summarizeDocuments(candidate.right.documents)}`);
      console.log(`  suggested canonical: ${suggested.canonical_name}`);
      console.log(`  human-reviewed merge command: npm run db:merge-entities -- --from ${duplicate.id} --into ${suggested.id}`);
    }

    console.log(`\n${candidates.length} candidate pair(s). This report is read-only; no entities were merged.`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
