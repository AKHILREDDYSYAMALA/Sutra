"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CompanyList } from "@/components/company-picker";
import { DependencyReadCard } from "@/components/dependency-read";
import { RelationshipGraph } from "@/components/relationship-graph";
import { staticSandboxCompanies, type SandboxCompany } from "@/lib/company-data";
import {
  formatCorpusExposure,
  getCorpusEntity,
  getGraphRelationshipsForEntity,
  getOtherStaticCorpusRelationships,
  getSessionCorpusRelationships,
  graphReportIdentity,
  type CorpusRelationship,
} from "@/lib/corpus";
import { getDependencyRead, type DependencyReadLine } from "@/lib/dependency-read";
import { analysisResponseSchema, graphDataSchema, type AnalysisMeta, type GraphData, type GraphEdge, type GraphNode } from "@/lib/graph-data";
import { getReportProvenance } from "@/lib/report-provenance";

const initialCompanyId = "mtar-technologies";
const isDevelopment = process.env.NODE_ENV === "development";
const liveSessionStorageKey = "sutra.live-graphs.v1";
const emptyAnalysisMeta: AnalysisMeta = { excluded: [] };

const edgeRiskLabel: Record<NonNullable<GraphEdge["risk_flag"]>, string> = {
  high: "High risk",
  medium: "Medium risk",
  low: "Low risk",
};

export function SutraWorkspace() {
  const [companyId, setCompanyId] = useState<string | null>(initialCompanyId);
  const [graph, setGraph] = useState<GraphData>(() => staticSandboxCompanies.find((company) => company.id === initialCompanyId)!.graph);
  const [sandboxCompanies, setSandboxCompanies] = useState<SandboxCompany[]>(staticSandboxCompanies);
  const [sessionGraphs, setSessionGraphs] = useState<GraphData[]>([]);
  const [selectedEvidenceEdges, setSelectedEvidenceEdges] = useState<GraphEdge[]>([]);
  const [selectedEntityNode, setSelectedEntityNode] = useState<GraphNode | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [isSavingToSandbox, setIsSavingToSandbox] = useState(false);
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [isRiskPanelOpen, setIsRiskPanelOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sandboxMessage, setSandboxMessage] = useState<string | null>(null);
  const [analysisMeta, setAnalysisMeta] = useState<AnalysisMeta>(emptyAnalysisMeta);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedEdge = selectedEvidenceEdges[0] ?? null;
  const dependencyRead = useMemo(() => getDependencyRead(graph, companyId === null ? analysisMeta : undefined), [analysisMeta, companyId, graph]);
  const isWorkspacePanelOpen = isLeftPanelOpen || companyId === null;
  const selectedCompanyName = sandboxCompanies.find((company) => company.id === companyId)?.name ?? graph.target_company;
  const selectedCorpusEntity = useMemo(() => (selectedEntityNode ? getCorpusEntity(selectedEntityNode.label) : null), [selectedEntityNode]);
  const currentReportRelationships = useMemo(
    () => (selectedEntityNode ? getGraphRelationshipsForEntity(graph, selectedEntityNode.id) : []),
    [graph, selectedEntityNode],
  );
  const otherCorpusRelationships = useMemo(() => {
    if (!selectedEntityNode) return [];
    const relationships = [
      ...getOtherStaticCorpusRelationships(selectedEntityNode.label, graph),
      ...getSessionCorpusRelationships(sessionGraphs, selectedEntityNode.label, graph),
    ];
    return relationships.filter(
      (relationship, index) =>
        relationships.findIndex(
          (candidate) =>
            candidate.report_company === relationship.report_company &&
            candidate.report_date === relationship.report_date &&
            candidate.entity_label === relationship.entity_label &&
            candidate.counterparty_label === relationship.counterparty_label &&
            candidate.source_quote === relationship.source_quote,
        ) === index,
    );
  }, [graph, selectedEntityNode, sessionGraphs]);
  const panelState = useMemo(
    () => ({
      leftPanelOpen: isWorkspacePanelOpen,
      riskPanelOpen: isRiskPanelOpen,
      evidencePanelOpen: Boolean(selectedEdge),
      entityPanelOpen: Boolean(selectedEntityNode),
    }),
    [isRiskPanelOpen, isWorkspacePanelOpen, selectedEdge, selectedEntityNode],
  );

  useEffect(() => {
    if (!isDevelopment) return;
    let cancelled = false;

    void fetch("/api/sandbox")
      .then(async (response) => {
        if (!response.ok) throw new Error("sandbox unavailable");
        const payload: unknown = await response.json();
        const candidates = typeof payload === "object" && payload && "companies" in payload && Array.isArray(payload.companies) ? payload.companies : [];
        const verifiedCompanies = candidates.flatMap((candidate) => {
          if (!candidate || typeof candidate !== "object" || !("id" in candidate) || !("name" in candidate) || !("graph" in candidate)) return [];
          const parsedGraph = graphDataSchema.safeParse(candidate.graph);
          if (!parsedGraph.success || typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
          return [{ id: candidate.id, name: candidate.name, agency: parsedGraph.data.agency, graph: parsedGraph.data }];
        });
        if (!cancelled) setSandboxCompanies(verifiedCompanies);
      })
      .catch(() => {
        // The pre-bundled verified graphs remain available when the local endpoint is unavailable.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const savedGraphs = window.sessionStorage.getItem(liveSessionStorageKey);
      if (!savedGraphs) return;
      const parsed = JSON.parse(savedGraphs) as unknown;
      if (!Array.isArray(parsed)) return;
      setSessionGraphs(parsed.flatMap((candidate) => {
        const graph = graphDataSchema.safeParse(candidate);
        return graph.success ? [graph.data] : [];
      }));
    } catch {
      // Session corpus data is a convenience layer; a malformed value must never block the app.
    }
  }, []);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(liveSessionStorageKey, JSON.stringify(sessionGraphs));
    } catch {
      // A full or unavailable session store should not interfere with live analysis.
    }
  }, [sessionGraphs]);

  function closeEvidence() {
    setSelectedEvidenceEdges([]);
  }

  function openEvidence(edges: GraphEdge[]) {
    if (edges.length === 0) return;
    setSelectedEntityNode(null);
    setSelectedEvidenceEdges(edges);
  }

  function loadCompany(id: string) {
    const company = sandboxCompanies.find((entry) => entry.id === id);
    if (!company) return;
    setCompanyId(id);
    setGraph(company.graph);
    setAnalysisMeta(emptyAnalysisMeta);
    closeEvidence();
    setSelectedEntityNode(null);
    setError(null);
  }

  async function analysePdf(file: File) {
    if (file.size > 10 * 1024 * 1024) {
      setError("This PDF is larger than 10MB. Please upload a smaller rating report.");
      return;
    }
    if (file.type && file.type !== "application/pdf") {
      setError("Please upload a PDF rating report.");
      return;
    }

    setError(null);
    setSandboxMessage(null);
    setIsAnalysing(true);
    closeEvidence();
    setSelectedEntityNode(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/analyze", { method: "POST", body: formData });
      const payload: unknown = await response.json();

      if (!response.ok) {
        const message = typeof payload === "object" && payload && "error" in payload ? String(payload.error) : "Unable to analyse this report.";
        throw new Error(message);
      }

      const parsedResponse = analysisResponseSchema.safeParse(payload);
      if (!parsedResponse.success) throw new Error("The analysis returned an invalid graph. Please try another report.");

      setGraph(parsedResponse.data.graph);
      setAnalysisMeta(parsedResponse.data.meta);
      setSessionGraphs((currentGraphs) => {
        const nextGraphs = currentGraphs.filter((currentGraph) => graphReportIdentity(currentGraph) !== graphReportIdentity(parsedResponse.data.graph));
        return [...nextGraphs, parsedResponse.data.graph];
      });
      setCompanyId(null);
      setIsLeftPanelOpen(false);
      setSandboxMessage(null);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to analyse this report.");
    } finally {
      setIsAnalysing(false);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files.item(0);
    if (file) void analysePdf(file);
  }

  async function saveToSandbox() {
    if (!isDevelopment || companyId !== null) return;
    setIsSavingToSandbox(true);
    setSandboxMessage(null);

    try {
      const response = await fetch("/api/sandbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ graph }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = typeof payload === "object" && payload && "error" in payload ? String(payload.error) : "Unable to save this graph to the sandbox.";
        throw new Error(message);
      }
      setSandboxMessage("Saved as unverified. Set verified: true in its JSON file, then refresh to add it to Instant sandbox.");
    } catch (caughtError) {
      setSandboxMessage(caughtError instanceof Error ? caughtError.message : "Unable to save this graph to the sandbox.");
    } finally {
      setIsSavingToSandbox(false);
    }
  }

  return (
    <main className="relative h-[100dvh] min-h-[680px] overflow-hidden bg-[#07101f] text-slate-100">
      <RelationshipGraph
        graph={graph}
        onSelectEdge={(edge) => openEvidence([edge])}
        onSelectNode={(node) => {
          closeEvidence();
          setSelectedEntityNode(node);
        }}
        panelState={panelState}
        highlightedEdges={selectedEvidenceEdges}
      />
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(8,145,178,0.08),transparent_38%),linear-gradient(180deg,rgba(2,6,23,0.2),rgba(2,6,23,0.45))]" />

      <header className="absolute inset-x-0 top-0 z-20 flex h-16 items-center justify-between border-b border-white/10 bg-slate-950/55 px-4 backdrop-blur-xl sm:px-7">
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg border border-cyan-300/30 bg-cyan-400/10 text-sm font-bold text-cyan-200">S</div>
          <div>
            <p className="font-semibold tracking-tight text-white">Sutra</p>
            <p className="hidden text-[10px] uppercase tracking-[0.14em] text-slate-500 sm:block">Dependencies &amp; counterparties</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-emerald-300/15 bg-emerald-300/5 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-200">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Evidence-first
        </div>
      </header>

      <section
        className={`absolute top-28 z-10 rounded-2xl border border-white/10 bg-slate-950/85 shadow-2xl shadow-black/30 backdrop-blur-xl transition-[width,height,padding] duration-300 ease-out ${isWorkspacePanelOpen ? "left-3 right-3 flex max-h-[calc(100dvh-8rem)] flex-col overflow-hidden p-4 sm:left-6 sm:right-auto sm:w-[365px] sm:p-5" : "left-3 h-11 w-[min(calc(100vw-1.5rem),340px)] overflow-hidden p-1 sm:left-6 sm:w-[320px]"}`}
      >
        {isWorkspacePanelOpen ? (
          <div className="flex min-h-0 flex-1 flex-col animate-in fade-in duration-200">
            <div className="shrink-0">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300">Dependencies &amp; counterparties</p>
                  <h1 className="text-lg font-semibold tracking-tight text-white">See who a company depends on — and why.</h1>
                </div>
                {companyId && (
                  <button
                    type="button"
                    onClick={() => setIsLeftPanelOpen(false)}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-white/10 hover:text-white"
                    aria-label="Collapse workspace controls"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1">
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">Map the dependencies and counterparties hidden in Indian credit-rating reports, with evidence on every edge.</p>

              <div className="mt-5">
                <CompanyList companies={sandboxCompanies} selectedId={companyId} onSelect={loadCompany} />
              </div>

              <div className="my-4 flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-600">
                <span className="h-px flex-1 bg-white/10" /> or analyse a report <span className="h-px flex-1 bg-white/10" />
              </div>

              <div
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={`rounded-xl border border-dashed p-4 text-center transition ${isDragging ? "border-cyan-300 bg-cyan-300/10" : "border-white/15 bg-slate-900/60 hover:border-cyan-300/45"}`}
              >
                <p className="text-sm font-medium text-slate-200">Drop a rating report</p>
                <p className="mt-1 text-xs text-slate-500">PDF only · up to 10MB · no account needed</p>
                <button
                  type="button"
                  disabled={isAnalysing}
                  onClick={() => fileInputRef.current?.click()}
                  className="mt-3 rounded-lg border border-cyan-300/25 bg-cyan-400/10 px-3 py-1.5 text-xs font-semibold text-cyan-100 transition hover:bg-cyan-400/20 disabled:cursor-wait disabled:opacity-70"
                >
                  {isAnalysing ? "Reading report… mapping relationships…" : "Choose PDF"}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,.pdf"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void analysePdf(file);
                    event.currentTarget.value = "";
                  }}
                />
              </div>
              {error && <p className="mt-3 rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-xs leading-relaxed text-rose-200">{error}</p>}
            </div>

            {isDevelopment && companyId === null && (
              <div className="sticky bottom-0 z-10 mt-3 shrink-0 rounded-xl border border-violet-300/20 bg-slate-950/95 p-3 shadow-[0_-8px_20px_rgba(2,6,23,0.5)] backdrop-blur-xl">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-violet-100">Development sandbox</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">Persist this live graph locally for your manual evidence review.</p>
                  </div>
                  <button
                    type="button"
                    disabled={isSavingToSandbox}
                    onClick={() => void saveToSandbox()}
                    className="shrink-0 rounded-lg border border-violet-300/30 bg-violet-300/10 px-3 py-1.5 text-xs font-semibold text-violet-100 transition hover:bg-violet-300/20 disabled:cursor-wait disabled:opacity-65"
                  >
                    {isSavingToSandbox ? "Saving…" : "Save to sandbox"}
                  </button>
                </div>
                {sandboxMessage && <p className="mt-2 text-[11px] leading-relaxed text-violet-100">{sandboxMessage}</p>}
              </div>
            )}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsLeftPanelOpen(true)}
            className="flex h-full w-full items-center gap-2 rounded-xl px-2 text-left text-cyan-100 transition hover:bg-cyan-400/10"
            aria-label={`Expand controls for ${selectedCompanyName}`}
          >
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-cyan-300/30 bg-cyan-400/10 text-xs font-bold">S</span>
            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100">{compactCompanyName(selectedCompanyName)}</span>
            <span className="shrink-0 text-sm text-cyan-200">▾</span>
          </button>
        )}
      </section>

      <section aria-label="How to read Sutra" className="absolute inset-x-0 top-16 z-20 flex h-8 items-center justify-center border-b border-white/10 bg-slate-950/90 px-2 backdrop-blur-xl">
        <div className="flex items-center justify-center gap-x-1.5 whitespace-nowrap text-[9px] font-medium text-slate-300 sm:gap-x-3 sm:text-[10px]">
          <span className="hidden font-semibold uppercase tracking-[0.12em] text-slate-500 lg:inline">How to read</span>
          <LegendDot className="bg-cyan-300" label="Target" />
          <LegendDot className="bg-emerald-300" label="Customer" />
          <LegendDot className="bg-rose-300" label="Supplier" />
          <LegendDot className="bg-violet-300" label="Lender" />
          <LegendDot className="bg-amber-300" label="Group" />
          <LegendDot label="Unnamed" ghost />
        </div>
      </section>

      <div className="absolute right-5 top-28 z-10 hidden w-[340px] lg:block">
        {isRiskPanelOpen ? (
          <DependencyReadCard
            read={dependencyRead}
            provenance={getReportProvenance(graph)}
            onCollapse={() => setIsRiskPanelOpen(false)}
            onSelectLine={(line: DependencyReadLine) => openEvidence(line.edges)}
          />
        ) : (
          <button
            type="button"
            onClick={() => setIsRiskPanelOpen(true)}
            className={`flex w-full items-center justify-between gap-3 rounded-full border bg-slate-950/85 px-4 py-3 text-left shadow-xl shadow-black/25 backdrop-blur-xl transition hover:bg-slate-900 ${dependencyRead.tone === "high" ? "border-rose-300/20 hover:border-rose-300/45" : dependencyRead.tone === "medium" ? "border-amber-300/20 hover:border-amber-300/45" : "border-emerald-300/20 hover:border-emerald-300/45"}`}
            aria-label="Expand dependency read"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dependencyRead.tone === "high" ? "bg-rose-300" : dependencyRead.tone === "medium" ? "bg-amber-300" : "bg-emerald-300"}`} />
              <span className="min-w-0 truncate text-xs font-semibold text-slate-100">{dependencyRead.headline}</span>
            </span>
            <span className="shrink-0 text-base leading-none text-cyan-200">›</span>
          </button>
        )}
      </div>

      {selectedEntityNode && (
        <aside className="absolute bottom-5 right-4 z-20 flex max-h-[calc(100dvh-6rem)] w-[min(470px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-cyan-300/20 bg-slate-950/95 shadow-2xl shadow-black/50 backdrop-blur-xl sm:right-5">
          <div className="flex items-start justify-between gap-3 border-b border-white/10 p-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">Reverse intelligence</p>
              <p className="mt-1 text-sm font-semibold leading-snug text-slate-100">
                {selectedCorpusEntity?.canonical_label ?? selectedEntityNode.label}
              </p>
              {selectedCorpusEntity && (
                <span className="mt-2 inline-flex rounded-full border border-cyan-300/25 bg-cyan-300/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-cyan-100">
                  {selectedCorpusEntity.report_count} {selectedCorpusEntity.report_count === 1 ? "report" : "reports"}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setSelectedEntityNode(null)}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-white/10 hover:text-white"
              aria-label="Close corpus view"
            >
              ×
            </button>
          </div>

          <div className="space-y-5 overflow-y-auto p-4">
            <section>
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">In this report</p>
                  <p className="mt-0.5 text-[11px] text-slate-500">{graph.target_company}{graph.agency ? ` · ${graph.agency}` : ""}</p>
                </div>
                <span className="rounded-full border border-cyan-300/20 bg-cyan-300/5 px-2 py-0.5 text-[9px] font-semibold text-cyan-100">{currentReportRelationships.length}</span>
              </div>
              {currentReportRelationships.length > 0 ? (
                <div className="space-y-3">
                  {currentReportRelationships.map((relationship, index) => (
                    <RelationshipRecord key={`current-${relationship.counterparty_label}-${relationship.relation}-${index}`} relationship={relationship} />
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-white/10 bg-slate-900/55 p-3 text-xs leading-relaxed text-slate-400">No linked relationship is available for this entity in the current report.</p>
              )}
            </section>

            <section className="border-t border-white/10 pt-5">
              <div className="mb-2">
                <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">Across Sutra&apos;s corpus</p>
                <p className="mt-0.5 text-[11px] text-slate-500">Other verified reports and this browser session</p>
              </div>
              {otherCorpusRelationships.length > 0 ? (
                <div className="space-y-3">
                  {otherCorpusRelationships.map((relationship, index) => (
                    <RelationshipRecord key={`corpus-${relationship.report_company}-${relationship.counterparty_label}-${relationship.relation}-${index}`} relationship={relationship} />
                  ))}
                </div>
              ) : (
                <p className="rounded-xl border border-white/10 bg-slate-900/55 p-3 text-xs leading-relaxed text-slate-400">This entity hasn&apos;t appeared in any other analysed report yet.</p>
              )}
            </section>
          </div>
        </aside>
      )}

      {selectedEdge && (
        <aside className="absolute bottom-5 right-4 z-20 flex max-h-[calc(100dvh-6rem)] w-[min(390px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-cyan-300/20 bg-slate-950/95 p-4 shadow-2xl shadow-black/50 backdrop-blur-xl sm:right-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">Source evidence</p>
              <p className="mt-1 text-sm font-semibold leading-snug text-slate-100">
                {selectedEvidenceEdges.length === 1 ? selectedEdge.relation : `${selectedEvidenceEdges.length} report excerpts support this read`}
              </p>
            </div>
            <button
              type="button"
              onClick={closeEvidence}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-white/10 hover:text-white"
              aria-label="Close source evidence"
            >
              ×
            </button>
          </div>
          <div className="mt-4 space-y-4 overflow-y-auto pr-1">
            {selectedEvidenceEdges.map((edge, index) => (
              <div key={`${edge.source}-${edge.target}-${edge.relation}-${index}`} className={index > 0 ? "border-t border-white/10 pt-4" : ""}>
                {selectedEvidenceEdges.length > 1 && <p className="mb-2 text-xs font-semibold leading-snug text-slate-100">{edge.relation}</p>}
                <blockquote className="border-l-2 border-cyan-300/70 bg-cyan-300/5 px-3 py-2.5 font-serif text-sm leading-relaxed text-slate-200">
                  “{edge.source_quote}”
                </blockquote>
                <div className="mt-3 flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.13em] text-slate-500">
                  <span>{edge.source_page ? `Page ${edge.source_page}` : "Page unavailable"}</span>
                  <span className="text-slate-700">•</span>
                  <span>{edge.confidence} confidence</span>
                  {edge.risk_flag && (
                    <>
                      <span className="text-slate-700">•</span>
                      <span className={edge.risk_flag === "high" ? "text-rose-300" : "text-amber-200"}>{edgeRiskLabel[edge.risk_flag]}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}

      <div className="absolute bottom-5 right-20 z-10 rounded-full border border-white/10 bg-slate-950/70 px-3 py-1.5 text-[10px] font-medium text-slate-500 backdrop-blur-xl">
        {companyId ? "Verified static report data" : "Live report analysis"}
      </div>
    </main>
  );
}

function RelationshipRecord({ relationship }: { relationship: CorpusRelationship }) {
  const exposure = formatCorpusExposure(relationship);

  return (
    <article className="rounded-xl border border-white/10 bg-slate-900/65 p-3">
      <p className="text-xs font-semibold leading-snug text-slate-100">{relationship.perspective}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-400">Reported relation · {relationship.relation}</p>
      {exposure && <p className="mt-1 text-[11px] font-medium text-cyan-100">{exposure}</p>}
      <blockquote className="mt-3 border-l-2 border-cyan-300/60 bg-cyan-300/5 px-2.5 py-2 font-serif text-xs leading-relaxed text-slate-200">
        “{relationship.source_quote}”
      </blockquote>
      <p className="mt-2 text-[10px] font-medium leading-relaxed text-slate-500">
        per {relationship.report_company} rating report, {relationship.agency ?? "agency unavailable"}
        {relationship.source_page ? ` · Page ${relationship.source_page}` : ""}
      </p>
    </article>
  );
}

function compactCompanyName(name: string) {
  return name.replace(/\bLimited\b/g, "Ltd").replace(/\bPrivate\b/g, "Pvt");
}

function LegendDot({ className = "", label, ghost = false }: { className?: string; label: string; ghost?: boolean }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={ghost ? "h-2 w-2 rounded-sm border border-dashed border-slate-400/80" : `h-1.5 w-1.5 rounded-full ${className}`} />
      {label}
    </span>
  );
}
