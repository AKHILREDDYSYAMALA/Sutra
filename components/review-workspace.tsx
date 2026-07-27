"use client";

import { useMemo, useState } from "react";

import { RelationshipGraph } from "@/components/relationship-graph";
import { VerificationTierPill } from "@/components/verification-tier-pill";
import type { CorpusIndex } from "@/lib/domain/corpus";
import type { LedgerGraph } from "@/lib/domain/graph";
import type { GraphData, GraphEdge, GraphNode } from "@/lib/graph-data";

const emptyCorpus: CorpusIndex = { entities: {}, normalizedLookup: {} };
type Claim = LedgerGraph["claims"][number];

type Props = {
  document: { id: string; title: string | null; url: string | null; agency: string | null; rating: string | null; publishedDate: string | null; metadata: unknown; status: string };
  claims: Claim[];
  graph: GraphData;
  verificationTiers: Record<string, Claim["verificationTier"]>;
  signedPdfUrl: string | null;
};

export function ReviewWorkspace({ document, claims: initialClaims, graph, verificationTiers, signedPdfUrl }: Props) {
  const [claims, setClaims] = useState(initialClaims);
  const [tiers, setTiers] = useState(verificationTiers);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const pending = useMemo(() => claims.filter((claim) => claim.verificationTier === "machine_validated"), [claims]);
  const reviewed = claims.length - pending.length;

  async function act(action: "approve" | "reject" | "publish", claimIds: string[] = []) {
    let reason: string | undefined;
    if (action === "reject") {
      const entered = window.prompt("Why should these claims be rejected? This reason is recorded permanently.");
      if (!entered?.trim()) return;
      reason = entered.trim();
    }
    if (claimIds.length > 1 && !window.confirm(`${action === "approve" ? "Approve" : "Reject"} ${claimIds.length} claims? This records a final review decision.`)) return;
    if (action === "publish" && !window.confirm("Publish this reviewed document to the public corpus?")) return;
    setBusy(true); setMessage(null);
    try {
      const response = await fetch(`/api/review/${document.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action === "publish" ? { action } : { action, claimIds, reason }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Review action failed.");
      if (action === "publish") { setMessage("Published. The public workspace will refresh from the ledger cache shortly."); return; }
      const nextTier = action === "approve" ? "human_verified" : "excluded";
      setClaims((current) => current.map((claim) => claimIds.includes(claim.id) ? { ...claim, verificationTier: nextTier } : claim));
      setTiers((current) => {
        const next = { ...current };
        initialClaims.filter((claim) => claimIds.includes(claim.id)).forEach((claim) => {
          // Graph edge identities are based on immutable evidence. Rebuild the small
          // map from the graph rather than changing any claim substance.
          graph.edges.filter((edge) => edge.source_quote === claim.quote && edge.relation === claim.relationLabel).forEach((edge) => {
            next[`${edge.source}\u0000${edge.target}\u0000${edge.relation}\u0000${edge.source_quote}`] = nextTier;
          });
        });
        return next;
      });
      setMessage(`${claimIds.length} claim${claimIds.length === 1 ? "" : "s"} ${action === "approve" ? "approved" : "rejected"}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Review action failed.");
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto grid max-w-[1600px] gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(440px,0.95fr)] lg:px-8">
      <section className="min-w-0">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">Extracted relationship graph</p><h1 className="mt-1 text-2xl font-semibold">{graph.target_company}</h1><p className="mt-1 text-sm text-slate-400">{document.agency ?? "Agency unavailable"} · {document.rating ?? "rating unavailable"} · {document.publishedDate ?? "date unavailable"}</p></div><span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1.5 text-xs font-semibold text-amber-100">{pending.length} pending</span></div>
        <div className="relative h-[490px] overflow-hidden rounded-2xl border border-white/10 bg-slate-950/65"><RelationshipGraph graph={graph} corpus={emptyCorpus} compact panelState={{ leftPanelOpen: false, riskPanelOpen: false, evidencePanelOpen: Boolean(selectedEdge), entityPanelOpen: false }} verificationTiers={tiers} onSelectNode={(_node: GraphNode) => undefined} onSelectEdge={setSelectedEdge} /></div>
        {selectedEdge && <article className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-4"><VerificationTierPill tier={tiers[`${selectedEdge.source}\u0000${selectedEdge.target}\u0000${selectedEdge.relation}\u0000${selectedEdge.source_quote}`] ?? "machine_validated"} /><blockquote className="mt-3 border-l-2 border-cyan-300/70 pl-3 font-serif text-sm leading-relaxed text-slate-200">“{selectedEdge.source_quote}”</blockquote></article>}
      </section>
      <section className="min-w-0 rounded-2xl border border-white/10 bg-slate-950/75 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">Human decision</p><p className="mt-1 text-sm text-slate-400">{reviewed} decided · {pending.length} still require a decision</p></div>{signedPdfUrl ? <a href={signedPdfUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-cyan-300/30 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-300/10">Open source PDF</a> : <span className="text-xs text-slate-500">Source PDF unavailable</span>}</div>
        <div className="mt-5 flex flex-wrap gap-2"><button disabled={busy || pending.length === 0} onClick={() => void act("approve", pending.map((claim) => claim.id))} className="rounded-lg bg-emerald-300 px-3 py-2 text-xs font-semibold text-emerald-950 disabled:opacity-40">Approve all pending</button><button disabled={busy || pending.length === 0} onClick={() => void act("reject", pending.map((claim) => claim.id))} className="rounded-lg border border-rose-300/40 px-3 py-2 text-xs font-semibold text-rose-100 disabled:opacity-40">Reject all pending</button><button disabled={busy || pending.length !== 0} onClick={() => void act("publish")} className="rounded-lg border border-cyan-300/40 px-3 py-2 text-xs font-semibold text-cyan-100 disabled:opacity-40">Publish reviewed document</button></div>
        {message && <p className="mt-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">{message}</p>}
        <div className="mt-6 space-y-3">{claims.map((claim) => <ClaimCard key={claim.id} claim={claim} busy={busy} signedPdfUrl={signedPdfUrl} onApprove={() => void act("approve", [claim.id])} onReject={() => void act("reject", [claim.id])} />)}</div>
        <ValidationExclusions metadata={document.metadata} />
      </section>
    </div>
  );
}

function ClaimCard({ claim, busy, signedPdfUrl, onApprove, onReject }: { claim: Claim; busy: boolean; signedPdfUrl: string | null; onApprove: () => void; onReject: () => void }) {
  const pageHref = signedPdfUrl && claim.page ? `${signedPdfUrl}#page=${claim.page}` : signedPdfUrl;
  return <article className="rounded-xl border border-white/10 bg-slate-900/45 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold text-slate-100">{claim.relationLabel}</p><p className="mt-1 text-xs text-slate-500">{claim.sourceLabel} → {claim.targetLabel}</p></div><VerificationTierPill tier={claim.verificationTier} /></div><dl className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400"><span>Exposure: {claim.exposurePct ?? "not stated"}{claim.exposurePct ? "%" : ""}</span><span>Risk: {claim.riskFlag ?? "not stated"}</span><span>Confidence: {claim.extractionConfidence ?? "unavailable"}</span></dl><blockquote className="mt-3 border-l-2 border-cyan-300/70 bg-cyan-300/5 px-3 py-2.5 font-serif text-sm leading-relaxed text-slate-200">“{claim.quote}”</blockquote><div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">{pageHref ? <a href={pageHref} target="_blank" rel="noreferrer" className="font-semibold text-cyan-200 hover:text-cyan-100">Page {claim.page ?? "source"}</a> : <span>Page {claim.page ?? "unavailable"}</span>}<span>·</span><span>{claim.observedDate}</span></div>{claim.verificationTier === "machine_validated" && <div className="mt-3 flex gap-2"><button disabled={busy} onClick={onApprove} className="rounded-md bg-emerald-300 px-2.5 py-1.5 text-xs font-semibold text-emerald-950 disabled:opacity-40">Approve</button><button disabled={busy} onClick={onReject} className="rounded-md border border-rose-300/40 px-2.5 py-1.5 text-xs font-semibold text-rose-100 disabled:opacity-40">Reject</button></div>}</article>;
}

function ValidationExclusions({ metadata }: { metadata: unknown }) {
  const excluded = metadata && typeof metadata === "object" && "excluded" in metadata && Array.isArray((metadata as { excluded?: unknown }).excluded)
    ? (metadata as { excluded: Array<{ label?: unknown; reason?: unknown }> }).excluded
    : [];
  if (excluded.length === 0) return null;
  return <section className="mt-6 border-t border-white/10 pt-5"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Excluded by validation</p><p className="mt-1 text-xs text-slate-500">Read-only: these edges never became claims.</p><ul className="mt-3 space-y-2 text-xs text-slate-300">{excluded.map((entry, index) => <li key={`${String(entry.label)}-${index}`} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">{typeof entry.label === "string" ? entry.label : "Unnamed entity"} · {typeof entry.reason === "string" ? entry.reason.replaceAll("_", " ") : "validation failed"}</li>)}</ul></section>;
}
