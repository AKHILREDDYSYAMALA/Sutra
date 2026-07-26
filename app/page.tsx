import { SutraWorkspace } from "@/components/sutra-workspace";
import { buildCorpusIndex } from "@/lib/domain/corpus";
import { buildGraphFromClaims } from "@/lib/domain/graph";
import {
  getCompanyGraph,
  getDb,
  listEntityAliases,
  listEntityMerges,
  listVerifiedCompanies,
} from "@/lib/db";

export const revalidate = 300;

/** The client receives rendered ledger data only; all database access stays here. */
export default async function Home() {
  const db = getDb();
  const summaries = await listVerifiedCompanies(db);
  const ledgers = (await Promise.all(summaries.map((company) => getCompanyGraph(db, company.slug))))
    .filter((ledger): ledger is NonNullable<typeof ledger> => ledger !== null);
  const [merges, aliases] = await Promise.all([
    listEntityMerges(db),
    listEntityAliases(db),
  ]);
  const summaryById = new Map(summaries.map((company) => [company.id, company]));
  const companies = ledgers.flatMap((ledger) => {
    const summary = summaryById.get(ledger.company.id);
    if (!summary) return [];
    const rendered = buildGraphFromClaims(ledger);
    return [{
      id: summary.slug,
      name: summary.name,
      agency: rendered.graph.agency,
      graph: rendered.graph,
      verificationTiers: rendered.verificationTiers,
      excludedClaimCount: rendered.excludedClaimCount,
    }];
  });

  return <SutraWorkspace companies={companies} corpus={buildCorpusIndex(ledgers, merges, aliases)} />;
}
