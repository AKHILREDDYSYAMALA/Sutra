"use client";

import type { SandboxCompany } from "@/lib/company-data";
import { formatRating } from "@/lib/report-provenance";
import { getRiskVerdict } from "@/lib/risk-summary";

type CompanyListProps = {
  companies: SandboxCompany[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

const severityDot: Record<ReturnType<typeof getRiskVerdict>["tone"], string> = {
  high: "bg-rose-300 shadow-[0_0_8px_rgba(253,164,175,0.65)]",
  medium: "bg-amber-300 shadow-[0_0_8px_rgba(252,211,77,0.55)]",
  low: "bg-emerald-300 shadow-[0_0_8px_rgba(110,231,183,0.55)]",
};

export function CompanyList({ companies, selectedId, onSelect }: CompanyListProps) {
  const agencyLabel = (agency: SandboxCompany["agency"]) => agency ?? "Agency unavailable";

  return (
    <section aria-label="Instant sandbox">
      <p className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
        Instant sandbox
      </p>
      <div className="space-y-1.5">
        {companies.map((company) => {
          const selected = company.id === selectedId;
          const verdict = getRiskVerdict(company.graph);

          return (
            <button
              key={company.id}
              type="button"
              onClick={() => onSelect(company.id)}
              aria-pressed={selected}
              className={`flex w-full items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-cyan-400/60 ${
                selected
                  ? "border-cyan-300/65 bg-cyan-400/10 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.12)]"
                  : "border-white/10 bg-slate-950/65 hover:border-cyan-300/35 hover:bg-slate-900/90"
              }`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${severityDot[verdict.tone]}`} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-slate-100" title={company.name}>{company.name}</span>
                <span className="mt-0.5 block truncate text-[9px] font-medium text-slate-500" title={formatRating(company.graph.rating, company.agency)}>
                  {formatRating(company.graph.rating, company.agency)}
                </span>
                <span className="mt-1 block text-[9px] font-medium text-emerald-200/80">{company.graph.edges.length} claims · {company.verificationSummary.machineValidated === 0 ? "all human-verified" : `${company.verificationSummary.humanVerified} human-verified, ${company.verificationSummary.machineValidated} machine-validated`}</span>
              </span>
              <span className="shrink-0 rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-slate-400" title={agencyLabel(company.agency)}>
                {company.agency ?? "—"}
              </span>
            </button>
          );
        })}
      </div>
      {companies.length === 0 && <p className="rounded-xl border border-white/10 bg-slate-900/55 px-3 py-3 text-xs text-slate-500">No verified sandbox companies yet.</p>}
    </section>
  );
}
