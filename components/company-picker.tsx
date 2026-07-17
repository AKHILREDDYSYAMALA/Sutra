"use client";

import { useMemo, useState } from "react";
import type { CompanyOption } from "@/lib/company-data";

type CompanyPickerProps = {
  companies: CompanyOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
};

export function CompanyPicker({ companies, selectedId, onSelect }: CompanyPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedCompany = companies.find((company) => company.id === selectedId);
  const matches = useMemo(
    () => companies.filter((company) => company.name.toLowerCase().includes(query.trim().toLowerCase())),
    [companies, query],
  );

  return (
    <div className="relative">
      <label className="mb-2 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full bg-cyan-300" />
        Instant sandbox
      </label>
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-slate-950/75 px-3.5 py-3 text-left text-sm text-slate-100 transition hover:border-cyan-300/40 hover:bg-slate-900 focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <span className="truncate">{selectedCompany?.name ?? "Search a pre-analysed company"}</span>
        <span className="ml-3 text-cyan-300">⌄</span>
      </button>

      {isOpen && (
        <div className="absolute z-30 mt-2 w-full overflow-hidden rounded-xl border border-white/10 bg-slate-950 p-2 shadow-2xl shadow-black/50">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search company…"
            className="mb-2 w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-300/50"
          />
          <div className="max-h-48 space-y-1 overflow-y-auto" role="listbox">
            {matches.length > 0 ? (
              matches.map((company) => (
                <button
                  key={company.id}
                  type="button"
                  onClick={() => {
                    onSelect(company.id);
                    setIsOpen(false);
                    setQuery("");
                  }}
                  className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-slate-200 transition hover:bg-cyan-400/10 hover:text-cyan-100"
                  role="option"
                  aria-selected={company.id === selectedId}
                >
                  <span>{company.name}</span>
                  {company.agency && <span className="text-[10px] font-medium text-slate-500">{company.agency}</span>}
                </button>
              ))
            ) : (
              <p className="px-3 py-4 text-sm text-slate-500">No sandbox company found.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
