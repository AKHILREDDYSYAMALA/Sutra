type VerificationTier = "human_verified" | "machine_validated" | "excluded";

const style: Record<VerificationTier, { label: string; className: string }> = {
  human_verified: { label: "Human-verified", className: "border-emerald-300/35 bg-emerald-300/10 text-emerald-100" },
  machine_validated: { label: "Machine-validated · not yet reviewed", className: "border-amber-300/35 bg-amber-300/10 text-amber-100" },
  excluded: { label: "Excluded", className: "border-slate-400/35 bg-slate-400/10 text-slate-300" },
};

/** One visual vocabulary for every evidence quote, including reverse intelligence. */
export function VerificationTierPill({ tier }: { tier: VerificationTier }) {
  const value = style[tier];
  const dot = tier === "human_verified" ? "bg-emerald-300" : tier === "machine_validated" ? "bg-amber-300" : "bg-slate-400";
  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.11em] ${value.className}`}><span className={`h-1.5 w-1.5 rounded-full ${dot}`} />{value.label}</span>;
}
