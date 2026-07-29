"use client";

import { useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";

import { RelationshipGraph } from "@/components/relationship-graph";
import { VerificationTierPill } from "@/components/verification-tier-pill";
import type { CorpusIndex } from "@/lib/domain/corpus";
import type { LedgerGraph } from "@/lib/domain/graph";
import type { GraphData, GraphEdge, GraphNode } from "@/lib/graph-data";

const emptyCorpus: CorpusIndex = { entities: {}, normalizedLookup: {}, document_count: 0 };
type Claim = LedgerGraph["claims"][number];
type Decision = "approve" | "reject";
type DecisionMethod = "individual" | "bulk";

type Props = {
  document: { id: string; title: string | null; url: string | null; agency: string | null; rating: string | null; publishedDate: string | null; metadata: unknown; status: string };
  claims: Claim[];
  graph: GraphData;
  verificationTiers: Record<string, Claim["verificationTier"]>;
  signedPdfUrl: string | null;
};

function riskRank(claim: Claim) {
  return claim.riskFlag === "high" ? 0 : claim.riskFlag === "medium" ? 1 : claim.riskFlag === "low" ? 2 : 3;
}

function orderedClaims(claims: Claim[]) {
  return [...claims].sort((left, right) => {
    const risk = riskRank(left) - riskRank(right);
    if (risk !== 0) return risk;
    const exposure = Number(right.exposurePct ?? -1) - Number(left.exposurePct ?? -1);
    if (exposure !== 0) return exposure;
    return left.id.localeCompare(right.id);
  });
}

function groupClaimsByQuote(claims: Claim[]) {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) groups.set(claim.quote, [...(groups.get(claim.quote) ?? []), claim]);
  return [...groups.entries()].map(([quote, groupedClaims]) => ({ quote, claims: groupedClaims }));
}

function extractedText(metadata: unknown) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as { extractedText?: unknown }).extractedText;
  return typeof value === "string" && value.trim() ? value : null;
}

function sentenceContext(text: string, quote: string, page: number | null) {
  const markers = [...text.matchAll(/\[\[PAGE\s+(\d+)\]\]/gi)];
  const pageIndex = page ? markers.findIndex((marker) => Number(marker[1]) === page) : -1;
  const start = pageIndex >= 0 ? markers[pageIndex]!.index! + markers[pageIndex]![0].length : 0;
  const end = pageIndex >= 0 && markers[pageIndex + 1] ? markers[pageIndex + 1]!.index : text.length;
  const scope = text.slice(start, end).trim() || text;
  const sentences = scope.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  const probe = quote.replace(/\s+/g, " ").trim().slice(0, 72).toLowerCase();
  const index = sentences.findIndex((sentence) => sentence.toLowerCase().includes(probe));
  if (index >= 0) return sentences.slice(Math.max(0, index - 1), index + 2).join(" ");

  const quoteIndex = scope.toLowerCase().indexOf(probe);
  if (quoteIndex >= 0) return scope.slice(Math.max(0, quoteIndex - 260), Math.min(scope.length, quoteIndex + quote.length + 260)).replace(/\s+/g, " ").trim();
  return null;
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || target instanceof HTMLButtonElement;
}

export function ReviewWorkspace({ document, claims: initialClaims, graph, verificationTiers, signedPdfUrl }: Props) {
  const [claims, setClaims] = useState(initialClaims);
  const [tiers, setTiers] = useState(verificationTiers);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [activeClaimId, setActiveClaimId] = useState<string | null>(initialClaims.find((claim) => claim.verificationTier === "machine_validated")?.id ?? null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [rejectClaimId, setRejectClaimId] = useState<string | null>(null);
  const [secondLookClaimId, setSecondLookClaimId] = useState<string | null>(null);
  const [bulkApproveOpen, setBulkApproveOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});

  const ordered = useMemo(() => orderedClaims(claims), [claims]);
  const pending = useMemo(() => ordered.filter((claim) => claim.verificationTier === "machine_validated"), [ordered]);
  const groups = useMemo(() => groupClaimsByQuote(ordered), [ordered]);
  const reviewed = claims.length - pending.length;
  const secondLookCount = pending.filter((claim) => claim.reviewState === "needs_second_look").length;
  const activeClaim = pending.find((claim) => claim.id === activeClaimId) ?? pending[0] ?? null;
  const sourceText = useMemo(() => extractedText(document.metadata), [document.metadata]);

  useEffect(() => {
    if (!activeClaim || activeClaim.id === activeClaimId) return;
    setActiveClaimId(activeClaim.id);
  }, [activeClaim, activeClaimId]);

  useEffect(() => {
    if (!activeClaimId) return;
    const card = cardRefs.current[activeClaimId];
    if (!card) return;
    card.focus({ preventScroll: true });
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeClaimId]);

  function setGraphTier(claimIds: string[], nextTier: Claim["verificationTier"]) {
    setTiers((current) => {
      const next = { ...current };
      initialClaims.filter((claim) => claimIds.includes(claim.id)).forEach((claim) => {
        graph.edges.filter((edge) => edge.source_quote === claim.quote && edge.relation === claim.relationLabel).forEach((edge) => {
          next[`${edge.source}\u0000${edge.target}\u0000${edge.relation}\u0000${edge.source_quote}`] = nextTier;
        });
      });
      return next;
    });
  }

  function focusAfterDecision(claimId: string) {
    const index = pending.findIndex((claim) => claim.id === claimId);
    const next = pending[index + 1] ?? pending[index - 1] ?? null;
    setActiveClaimId(next?.id ?? null);
  }

  async function decide(action: Decision, claimIds: string[], decisionMethod: DecisionMethod, reason?: string, bulkConfirmation?: string) {
    if (claimIds.length === 0) return;
    if (decisionMethod === "individual") focusAfterDecision(claimIds[0]!);
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/review/${document.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, claimIds, reason, decisionMethod, bulkConfirmation }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Review action failed.");
      const nextTier = action === "approve" ? "human_verified" : "excluded";
      setClaims((current) => current.map((claim) => claimIds.includes(claim.id) ? {
        ...claim,
        verificationTier: nextTier,
        reviewState: "decided",
        decisionMethod,
      } : claim));
      setGraphTier(claimIds, nextTier);
      setMessage(`${claimIds.length} claim${claimIds.length === 1 ? "" : "s"} ${action === "approve" ? "approved" : "rejected"}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Review action failed.");
    } finally {
      setBusy(false);
    }
  }

  async function requestSecondLook(claimId: string, note: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/review/${document.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "second_look", claimId, note }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not park the claim.");
      setClaims((current) => current.map((claim) => claim.id === claimId ? { ...claim, reviewState: "needs_second_look", reviewNote: note } : claim));
      setMessage("Claim parked for a second look. It will continue blocking publication.");
      setActiveClaimId(claimId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not park the claim.");
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (pending.length > 0 || !window.confirm("Publish this fully reviewed document to the public corpus?")) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/review/${document.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "publish" }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Publish failed.");
      setMessage("Published. The public workspace will refresh from the ledger cache shortly.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Publish failed.");
    } finally {
      setBusy(false);
    }
  }

  function moveFocus(direction: 1 | -1) {
    if (pending.length === 0) return;
    const current = Math.max(0, pending.findIndex((claim) => claim.id === activeClaim?.id));
    const next = (current + direction + pending.length) % pending.length;
    setActiveClaimId(pending[next]!.id);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || busy || rejectClaimId || secondLookClaimId || bulkApproveOpen) return;
      const key = event.key.toLowerCase();
      if (key === "?") { event.preventDefault(); setShowHelp(true); return; }
      if (key === "j") { event.preventDefault(); moveFocus(1); return; }
      if (key === "k") { event.preventDefault(); moveFocus(-1); return; }
      if (key === "a" && activeClaim) { event.preventDefault(); void decide("approve", [activeClaim.id], "individual"); return; }
      if (key === "r" && activeClaim) { event.preventDefault(); setRejectClaimId(activeClaim.id); return; }
      if (key === "s" && activeClaim) { event.preventDefault(); setSecondLookClaimId(activeClaim.id); return; }
      if (key === "p" && pending.length === 0) { event.preventDefault(); void publish(); }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeClaim, bulkApproveOpen, busy, pending.length, rejectClaimId, secondLookClaimId]);

  return (
    <main className="mx-auto max-w-6xl px-5 py-6 lg:px-8">
      <section className="rounded-2xl border border-white/10 bg-slate-950/75 p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">Human decision</p><h1 className="mt-1 text-2xl font-semibold">{graph.target_company}</h1><p className="mt-1 text-sm text-slate-400">{document.agency ?? "Agency unavailable"} · {document.rating ?? "rating unavailable"} · {document.publishedDate ?? "date unavailable"}</p><p className="mt-2 text-sm text-slate-400">{reviewed} decided · {pending.length} still require a decision{secondLookCount ? ` · ${secondLookCount} need a second look` : ""}</p></div>
          <div className="flex flex-wrap gap-2"><button type="button" onClick={() => setShowHelp(true)} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/5">? Shortcuts</button>{signedPdfUrl ? <a href={signedPdfUrl} target="_blank" rel="noreferrer" className="rounded-lg border border-cyan-300/30 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-300/10">Open source PDF</a> : <span className="self-center text-xs text-slate-500">Source PDF unavailable</span>}</div>
        </div>
        {message && <p aria-live="polite" className="mt-4 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">{message}</p>}

        <div className="mt-6 space-y-5">
          {groups.map((group, groupIndex) => <EvidenceGroup key={group.quote} index={groupIndex} quote={group.quote} claims={group.claims} sourceText={sourceText} signedPdfUrl={signedPdfUrl} busy={busy} activeClaimId={activeClaim?.id ?? null} cardRefs={cardRefs} onActivate={setActiveClaimId} onApprove={(claim) => void decide("approve", [claim.id], "individual")} onReject={(claim) => setRejectClaimId(claim.id)} onSecondLook={(claim) => setSecondLookClaimId(claim.id)} />)}
        </div>

        <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-white/10 pt-5">
          <button disabled={busy || pending.length !== 0} onClick={() => void publish()} className="rounded-lg border border-cyan-300/40 px-3 py-2 text-xs font-semibold text-cyan-100 hover:bg-cyan-300/10 disabled:opacity-40">Publish reviewed document <span className="text-cyan-300/70">P</span></button>
          <button disabled={busy || pending.length < 2} onClick={() => setBulkApproveOpen(true)} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-40">Bulk approve pending…</button>
          <span className="text-xs text-slate-500">Bulk approval is recorded separately and requires typed confirmation.</span>
        </div>
        <ValidationExclusions metadata={document.metadata} />
      </section>

      <section className="mt-6 rounded-2xl border border-white/10 bg-slate-950/65">
        <button type="button" onClick={() => setGraphOpen((open) => !open)} aria-expanded={graphOpen} className="flex w-full items-center justify-between px-5 py-4 text-left"><span><span className="block text-xs font-semibold uppercase tracking-[0.16em] text-cyan-200">Relationship graph</span><span className="mt-1 block text-sm text-slate-400">Open the full-width graph when you need structural context.</span></span><span className="text-sm text-cyan-100">{graphOpen ? "Hide" : "Expand"}</span></button>
        {graphOpen && <div className="border-t border-white/10 p-4"><div className="relative h-[620px] overflow-hidden rounded-xl border border-white/10 bg-slate-950"><RelationshipGraph graph={graph} corpus={emptyCorpus} compact panelState={{ leftPanelOpen: false, riskPanelOpen: false, evidencePanelOpen: Boolean(selectedEdge), entityPanelOpen: false }} verificationTiers={tiers} onSelectNode={(_node: GraphNode) => undefined} onSelectEdge={setSelectedEdge} /></div>{selectedEdge && <article className="mt-4 rounded-xl border border-cyan-300/20 bg-cyan-300/5 p-4"><VerificationTierPill tier={tiers[`${selectedEdge.source}\u0000${selectedEdge.target}\u0000${selectedEdge.relation}\u0000${selectedEdge.source_quote}`] ?? "machine_validated"} /><blockquote className="mt-3 border-l-2 border-cyan-300/70 pl-3 font-serif text-sm leading-relaxed text-slate-200">“{selectedEdge.source_quote}”</blockquote></article>}</div>}
      </section>

      {rejectClaimId && <RejectDialog busy={busy} onClose={() => setRejectClaimId(null)} onSubmit={(reason) => { const claim = claims.find((candidate) => candidate.id === rejectClaimId); setRejectClaimId(null); if (claim) void decide("reject", [claim.id], "individual", reason); }} />}
      {secondLookClaimId && <SecondLookDialog busy={busy} onClose={() => setSecondLookClaimId(null)} onSubmit={(note) => { const claim = claims.find((candidate) => candidate.id === secondLookClaimId); setSecondLookClaimId(null); if (claim) void requestSecondLook(claim.id, note); }} />}
      {bulkApproveOpen && <BulkApproveDialog count={pending.length} busy={busy} onClose={() => setBulkApproveOpen(false)} onSubmit={(confirmation) => { setBulkApproveOpen(false); void decide("approve", pending.map((claim) => claim.id), "bulk", undefined, confirmation); }} />}
      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
    </main>
  );
}

function EvidenceGroup({ index, quote, claims, sourceText, signedPdfUrl, busy, activeClaimId, cardRefs, onActivate, onApprove, onReject, onSecondLook }: { index: number; quote: string; claims: Claim[]; sourceText: string | null; signedPdfUrl: string | null; busy: boolean; activeClaimId: string | null; cardRefs: MutableRefObject<Record<string, HTMLElement | null>>; onActivate: (id: string) => void; onApprove: (claim: Claim) => void; onReject: (claim: Claim) => void; onSecondLook: (claim: Claim) => void }) {
  const page = claims.find((claim) => claim.page)?.page ?? null;
  const context = sourceText ? sentenceContext(sourceText, quote, page) : null;
  return <section className="overflow-hidden rounded-xl border border-white/10 bg-slate-900/35"><div className="border-b border-white/10 bg-cyan-300/[0.035] px-4 py-3"><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-100">Shared evidence {index + 1} · {claims.length} claim{claims.length === 1 ? "" : "s"}</p><blockquote className="mt-2 border-l-2 border-cyan-300/70 pl-3 font-serif text-sm leading-relaxed text-slate-200">“{quote}”</blockquote>{context && <details className="mt-3 text-xs text-slate-400"><summary className="cursor-pointer font-semibold text-cyan-200">Show surrounding sentence</summary><p className="mt-2 rounded-md bg-slate-950/60 p-3 leading-relaxed">{context}</p></details>}</div><div className="divide-y divide-white/10">{claims.map((claim) => <ClaimDecisionRow key={claim.id} claim={claim} busy={busy} focused={claim.id === activeClaimId} signedPdfUrl={signedPdfUrl} cardRef={(node) => { cardRefs.current[claim.id] = node; }} onActivate={() => onActivate(claim.id)} onApprove={() => onApprove(claim)} onReject={() => onReject(claim)} onSecondLook={() => onSecondLook(claim)} />)}</div></section>;
}

function ClaimDecisionRow({ claim, busy, focused, signedPdfUrl, cardRef, onActivate, onApprove, onReject, onSecondLook }: { claim: Claim; busy: boolean; focused: boolean; signedPdfUrl: string | null; cardRef: (node: HTMLElement | null) => void; onActivate: () => void; onApprove: () => void; onReject: () => void; onSecondLook: () => void }) {
  const pageHref = signedPdfUrl && claim.page ? `${signedPdfUrl}#page=${claim.page}` : signedPdfUrl;
  return <article ref={cardRef} tabIndex={-1} onFocus={onActivate} className={`scroll-mt-5 p-4 outline-none transition ${focused ? "bg-cyan-300/[0.06] ring-2 ring-inset ring-cyan-300/80" : ""}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold text-slate-100">{claim.relationLabel}</p><p className="mt-1 text-xs text-slate-500">{claim.sourceLabel} → {claim.targetLabel}</p></div><div className="flex items-center gap-2"><VerificationTierPill tier={claim.verificationTier} />{claim.reviewState === "needs_second_look" && <span className="rounded-full border border-violet-300/30 bg-violet-300/10 px-2 py-1 text-[10px] font-semibold text-violet-100">Needs second look</span>}</div></div><dl className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400"><span>Exposure: {claim.exposurePct ?? "not stated"}{claim.exposurePct ? "%" : ""}</span><span>Risk: {claim.riskFlag ?? "not stated"}</span><span>Confidence: {claim.extractionConfidence ?? "unavailable"}</span></dl>{claim.reviewNote && <p className="mt-3 rounded-md border border-violet-300/20 bg-violet-300/5 px-3 py-2 text-xs text-violet-100">Second-look note: {claim.reviewNote}</p>}<div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">{pageHref ? <a href={pageHref} target="_blank" rel="noreferrer" className="font-semibold text-cyan-200 hover:text-cyan-100">Page {claim.page ?? "source"}</a> : <span>Page {claim.page ?? "unavailable"}</span>}<span>·</span><span>{claim.observedDate}</span>{claim.decisionMethod && <><span>·</span><span>{claim.decisionMethod} decision</span></>}</div>{claim.verificationTier === "machine_validated" && <div className="mt-4 flex flex-wrap gap-2"><button disabled={busy} onClick={onApprove} className="rounded-md bg-emerald-300 px-2.5 py-1.5 text-xs font-semibold text-emerald-950 disabled:opacity-40">Approve <span className="opacity-60">A</span></button><button disabled={busy} onClick={onReject} className="rounded-md border border-rose-300/40 px-2.5 py-1.5 text-xs font-semibold text-rose-100 disabled:opacity-40">Reject <span className="opacity-60">R</span></button><button disabled={busy || claim.reviewState === "needs_second_look"} onClick={onSecondLook} className="rounded-md border border-violet-300/35 px-2.5 py-1.5 text-xs font-semibold text-violet-100 disabled:opacity-40">Needs second look <span className="opacity-60">S</span></button></div>}</article>;
}

function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-5"><section className="w-full max-w-md rounded-2xl border border-white/15 bg-slate-900 p-5 shadow-2xl"><div className="flex items-start justify-between gap-4"><h2 className="text-lg font-semibold text-slate-100">{title}</h2><button onClick={onClose} className="text-sm text-slate-400 hover:text-slate-100">Esc</button></div>{children}</section></div>;
}

function RejectDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("quote does not support this relationship");
  const [other, setOther] = useState("");
  const finalReason = reason === "other" ? other.trim() : reason;
  return <Dialog title="Reject claim" onClose={onClose}><form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); if (finalReason) onSubmit(finalReason); }}><label className="block text-sm text-slate-300">Reason<select autoFocus value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-sm text-slate-100"><option value="quote does not support this relationship">Quote does not support this relationship</option><option value="wrong relationship">Wrong relationship</option><option value="unresolved endpoint">Endpoint is unresolved</option><option value="other">Other</option></select></label>{reason === "other" && <label className="block text-sm text-slate-300">Explain<textarea required value={other} onChange={(event) => setOther(event.target.value)} className="mt-2 min-h-24 w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-sm text-slate-100" /></label>}<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-slate-300">Cancel</button><button disabled={busy || !finalReason} className="rounded-lg bg-rose-300 px-3 py-2 text-xs font-semibold text-rose-950 disabled:opacity-40">Reject claim</button></div></form></Dialog>;
}

function SecondLookDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState("");
  return <Dialog title="Needs a second look" onClose={onClose}><form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); if (note.trim()) onSubmit(note.trim()); }}><label className="block text-sm text-slate-300">What needs checking?<textarea autoFocus required value={note} onChange={(event) => setNote(event.target.value)} className="mt-2 min-h-28 w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-sm text-slate-100" /></label><p className="text-xs leading-relaxed text-slate-500">This keeps the claim pending and blocks publishing until a final decision is recorded.</p><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-slate-300">Cancel</button><button disabled={busy || !note.trim()} className="rounded-lg border border-violet-300/40 px-3 py-2 text-xs font-semibold text-violet-100 disabled:opacity-40">Park claim</button></div></form></Dialog>;
}

function BulkApproveDialog({ count, busy, onClose, onSubmit }: { count: number; busy: boolean; onClose: () => void; onSubmit: (confirmation: string) => void }) {
  const [confirmation, setConfirmation] = useState("");
  const expected = `approve ${count} claims`;
  return <Dialog title="Bulk approve pending claims" onClose={onClose}><form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); if (confirmation.trim().toLowerCase() === expected) onSubmit(confirmation); }}><p className="text-sm leading-relaxed text-slate-400">This records a distinct bulk decision for all {count} pending claims. Carefully review each shared-evidence block first.</p><label className="block text-sm text-slate-300">Type <code className="rounded bg-slate-950 px-1.5 py-1 text-cyan-100">{expected}</code><input autoFocus value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-3 w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-sm text-slate-100" /></label><div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border border-white/15 px-3 py-2 text-xs font-semibold text-slate-300">Cancel</button><button disabled={busy || confirmation.trim().toLowerCase() !== expected} className="rounded-lg border border-white/20 px-3 py-2 text-xs font-semibold text-slate-100 disabled:opacity-40">Record bulk approval</button></div></form></Dialog>;
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  return <Dialog title="Keyboard shortcuts" onClose={onClose}><dl className="mt-5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm text-slate-300"><kbd className="rounded border border-white/15 bg-slate-950 px-2 py-1 text-center text-cyan-100">A</kbd><dd>Approve focused claim</dd><kbd className="rounded border border-white/15 bg-slate-950 px-2 py-1 text-center text-cyan-100">R</kbd><dd>Reject focused claim</dd><kbd className="rounded border border-white/15 bg-slate-950 px-2 py-1 text-center text-cyan-100">S</kbd><dd>Needs a second look</dd><kbd className="rounded border border-white/15 bg-slate-950 px-2 py-1 text-center text-cyan-100">J / K</kbd><dd>Next / previous pending claim</dd><kbd className="rounded border border-white/15 bg-slate-950 px-2 py-1 text-center text-cyan-100">P</kbd><dd>Publish when every claim is decided</dd><kbd className="rounded border border-white/15 bg-slate-950 px-2 py-1 text-center text-cyan-100">?</kbd><dd>Show this help</dd></dl><button autoFocus onClick={onClose} className="mt-6 rounded-lg border border-cyan-300/35 px-3 py-2 text-xs font-semibold text-cyan-100">Close</button></Dialog>;
}

function ValidationExclusions({ metadata }: { metadata: unknown }) {
  const excluded = metadata && typeof metadata === "object" && "excluded" in metadata && Array.isArray((metadata as { excluded?: unknown }).excluded)
    ? (metadata as { excluded: Array<{ label?: unknown; reason?: unknown }> }).excluded
    : [];
  if (excluded.length === 0) return null;
  return <section className="mt-6 border-t border-white/10 pt-5"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">Excluded by validation</p><p className="mt-1 text-xs text-slate-500">Read-only: these edges never became claims.</p><ul className="mt-3 space-y-2 text-xs text-slate-300">{excluded.map((entry, index) => <li key={`${String(entry.label)}-${index}`} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">{typeof entry.label === "string" ? entry.label : "Unnamed entity"} · {typeof entry.reason === "string" ? entry.reason.replaceAll("_", " ") : "validation failed"}</li>)}</ul></section>;
}
