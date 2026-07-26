import assert from "node:assert/strict";
import postgres from "postgres";

import { requiredDirectUrl } from "./env";
import { resolveEntity, type EntityMerge } from "../lib/domain/entity-resolution";

type ResolvedEndpoint = {
  source_entity_id: string;
  target_entity_id: string;
  source_entity_resolved: string;
  target_entity_resolved: string;
};

type MultiDocumentEntity = {
  canonical_name: string;
  document_count: number;
};

async function main() {
  const client = postgres(requiredDirectUrl(), { max: 1, prepare: false });

  try {
    const [merges, endpoints, multiDocumentEntities] = await Promise.all([
      client<EntityMerge[]>`
        select
          from_entity_id as "fromEntityId",
          into_entity_id as "intoEntityId",
          reverted_at as "revertedAt"
        from entity_merges
      `,
      client<ResolvedEndpoint[]>`
        select
          source_entity_id,
          target_entity_id,
          source_entity_resolved,
          target_entity_resolved
        from claims_resolved
      `,
      client<MultiDocumentEntity[]>`
        with endpoints as (
          select source_entity_resolved as entity_id, document_id from claims_resolved
          union all
          select target_entity_resolved as entity_id, document_id from claims_resolved
        )
        select entities.canonical_name, count(distinct endpoints.document_id)::int as document_count
        from endpoints
        inner join entities on entities.id = endpoints.entity_id
        group by entities.id, entities.canonical_name
        having count(distinct endpoints.document_id) >= 2
        order by entities.canonical_name
      `,
    ]);

    for (const endpoint of endpoints) {
      assert.equal(
        endpoint.source_entity_resolved,
        resolveEntity(endpoint.source_entity_id, merges),
        `source resolution mismatch for ${endpoint.source_entity_id}`,
      );
      assert.equal(
        endpoint.target_entity_resolved,
        resolveEntity(endpoint.target_entity_id, merges),
        `target resolution mismatch for ${endpoint.target_entity_id}`,
      );
    }

    const names = new Set(multiDocumentEntities.map((entity) => entity.canonical_name));
    assert.ok(names.has("Hindustan Aeronautics Limited"), "claims_resolved must retain Hindustan Aeronautics across documents");
    assert.ok(names.has("Samsung Electronics"), "claims_resolved must retain Samsung Electronics across documents");

    console.table(multiDocumentEntities);
    console.log(`Resolution view matches lib/domain/resolveEntity for ${endpoints.length} claim row(s).`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
