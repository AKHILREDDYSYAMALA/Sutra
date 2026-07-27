import Link from "next/link";
import { notFound } from "next/navigation";

import { ReviewWorkspace } from "@/components/review-workspace";
import { buildGraphFromClaims } from "@/lib/domain/graph";
import { getDb } from "@/lib/db";
import { getReviewDocument } from "@/lib/db/review";
import { hasReviewAccess } from "@/lib/review/access";
import { createDocumentSignedUrl } from "@/lib/ingestion/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function ReviewDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  if (!await hasReviewAccess()) return <main className="grid min-h-screen place-items-center bg-[#07101f] p-6 text-slate-300">Review access required.</main>;
  const { id } = await params;
  const document = await getReviewDocument(getDb(), id);
  if (!document) notFound();
  let signedPdfUrl: string | null = null;
  if (document.document.storagePath) {
    try {
      signedPdfUrl = await createDocumentSignedUrl(document.document.storagePath);
    } catch (error) {
      console.error("Sutra review signed-PDF request failed", { documentId: id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const rendered = buildGraphFromClaims(document.ledger);
  return (
    <main className="min-h-screen bg-[#07101f] text-slate-100">
      <header className="border-b border-white/10 bg-slate-950/70 px-5 py-4 sm:px-8"><Link href="/review" className="text-xs font-semibold text-cyan-200 hover:text-cyan-100">← Review queue</Link></header>
      <ReviewWorkspace document={document.document} claims={document.ledger.claims} graph={rendered.graph} verificationTiers={rendered.verificationTiers} signedPdfUrl={signedPdfUrl} />
    </main>
  );
}
