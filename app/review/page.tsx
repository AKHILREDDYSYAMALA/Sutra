import Link from "next/link";

import { getDb, listReviewQueue } from "@/lib/db";
import { hasReviewAccess } from "@/lib/review/access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ReviewQueuePage() {
  if (!await hasReviewAccess()) return <Forbidden />;
  const queue = await listReviewQueue(getDb());
  return (
    <main className="min-h-screen bg-[#07101f] px-5 py-10 text-slate-100 sm:px-10">
      <div className="mx-auto max-w-4xl">
        <Link href="/" className="text-xs font-semibold text-cyan-200 hover:text-cyan-100">← Sutra workspace</Link>
        <p className="mt-8 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">Verification queue</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Claims ready for human review</h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">Nothing reaches the public corpus until every machine-validated claim has a recorded decision.</p>
        <div className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
          {queue.map((document) => (
            <Link key={document.id} href={`/review/${document.id}`} className="flex items-center justify-between gap-5 border-b border-white/10 px-5 py-4 transition hover:bg-cyan-300/5 last:border-b-0">
              <span className="min-w-0"><span className="block truncate font-medium text-slate-100">{document.companyName ?? document.title ?? "Unclassified document"}</span><span className="mt-1 block truncate text-xs text-slate-500">{document.agency ?? "Agency unavailable"} · {document.rating ?? "rating unavailable"} · {document.publishedDate ?? "date unavailable"}</span><span className="mt-1 block text-[11px] text-slate-600">{document.claimCount} claims · {document.excludedCount} validation exclusions · ingested {document.createdAt.toLocaleDateString("en-GB")}</span></span>
              <span className="shrink-0 rounded-full border border-amber-300/30 bg-amber-300/10 px-2.5 py-1 text-xs font-semibold text-amber-100">{document.pendingCount} pending</span>
            </Link>
          ))}
          {queue.length === 0 && <p className="px-5 py-10 text-sm text-slate-400">The review queue is empty.</p>}
        </div>
      </div>
    </main>
  );
}

function Forbidden() {
  return <main className="grid min-h-screen place-items-center bg-[#07101f] px-6 text-slate-100"><section className="max-w-md rounded-2xl border border-rose-300/20 bg-slate-950 p-7"><h1 className="text-xl font-semibold">Review access required</h1><p className="mt-3 text-sm leading-relaxed text-slate-400">Set a valid server-side ADMIN_TOKEN and send it in an Authorization bearer token or x-admin-token header.</p></section></main>;
}
