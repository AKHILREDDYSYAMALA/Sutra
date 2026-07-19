"use client";

import type { DependencyRead, DependencyReadLine } from "@/lib/dependency-read";

type DependencyReadCardProps = {
  read: DependencyRead;
  provenance: string;
  onCollapse: () => void;
  onSelectLine: (line: DependencyReadLine) => void;
};

const toneClasses: Record<DependencyRead["tone"], { dot: string; border: string }> = {
  high: { dot: "bg-rose-300", border: "border-rose-300/20" },
  medium: { dot: "bg-amber-300", border: "border-amber-300/20" },
  low: { dot: "bg-emerald-300", border: "border-emerald-300/20" },
};

const lineTone: Record<DependencyReadLine["tone"], string> = {
  high: "text-rose-100",
  medium: "text-amber-100",
  low: "text-slate-300",
};

export function DependencyReadCard({ read, provenance, onCollapse, onSelectLine }: DependencyReadCardProps) {
  const theme = toneClasses[read.tone];

  return (
    <aside className={`rounded-2xl border ${theme.border} bg-slate-950/90 p-4 shadow-2xl shadow-black/30 backdrop-blur-xl transition-opacity duration-300`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-200">
          <span className={`h-1.5 w-1.5 rounded-full ${theme.dot}`} /> Dependency read
        </div>
        <button
          type="button"
          onClick={onCollapse}
          className="grid h-6 w-6 place-items-center rounded-md text-slate-400 transition hover:bg-white/10 hover:text-white"
          aria-label="Collapse dependency read"
        >
          ×
        </button>
      </div>
      <p className="mt-2 border-l-2 border-cyan-300/45 pl-2 text-[10px] font-medium leading-relaxed text-slate-400">{provenance}</p>
      <p className="mt-2 text-sm font-semibold leading-snug text-slate-100">{read.headline}</p>
      <div className="mt-3 space-y-1.5 border-t border-white/10 pt-2.5">
        {read.lines.map((line) => {
          const isLinked = line.edges.length > 0;
          const content = (
            <>
              <span className="shrink-0 text-[9px] font-semibold uppercase tracking-[0.12em] text-slate-500">{line.label}</span>
              <span className={`min-w-0 text-right text-[11px] leading-snug ${lineTone[line.tone]}`}>{line.text}</span>
              {isLinked && <span className="shrink-0 text-sm leading-none text-cyan-200">›</span>}
            </>
          );

          return isLinked ? (
            <button
              key={line.id}
              type="button"
              onClick={() => onSelectLine(line)}
              className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left transition hover:bg-cyan-300/8 focus:outline-none focus:ring-2 focus:ring-cyan-400/50"
              aria-label={`Show evidence for ${line.label.toLowerCase()}`}
            >
              {content}
            </button>
          ) : (
            <div key={line.id} className="flex items-start gap-2 px-1.5 py-1">
              {content}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
