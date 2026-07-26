import { SutraWorkspace } from "@/components/sutra-workspace";
import { unstable_cache } from "next/cache";
import { buildCorpusIndex } from "@/lib/domain/corpus";
import { buildGraphFromClaims } from "@/lib/domain/graph";
import {
  getCompanyGraph,
  getDb,
  listEntityAliases,
  listEntityMerges,
  listVerifiedCompanies,
} from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The page always renders at request time. The ledger payload is explicitly cached
// for five minutes, so `next build` never opens a database connection.
const getWorkspaceData = unstable_cache(
  async () => {
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

    return { companies, corpus: buildCorpusIndex(ledgers, merges, aliases) };
  },
  ["sutra-workspace-ledger-v1"],
  { revalidate: 300 },
);

/** The client receives serialized ledger data only; all database access stays here. */
export default async function Home() {
  try {
    const { companies, corpus } = await getWorkspaceData();
    return <SutraWorkspace companies={companies} corpus={corpus} />;
  } catch (error) {
    // Keep database diagnostics server-side while giving visitors a stable screen.
    console.error("Sutra workspace ledger read failed", error);
    return <SutraUnavailable />;
  }
}

function SutraUnavailable() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#07101f] px-6 text-slate-100">
      <section className="max-w-md rounded-2xl border border-amber-300/20 bg-slate-950/85 p-7 shadow-2xl shadow-black/30">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-amber-200">Sutra</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">Sutra is temporarily unavailable</h1>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">We can&apos;t reach the verified-claims ledger right now. Please refresh in a moment.</p>
      </section>
    </main>
  );
}
