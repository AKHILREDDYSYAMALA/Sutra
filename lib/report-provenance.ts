import type { GraphData } from "@/lib/graph-data";

function formatReportDate(date: string | null) {
  if (!date) return "report date not stated";

  const isoMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const parsed = isoMatch
    ? new Date(Date.UTC(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])))
    : new Date(date);
  if (Number.isNaN(parsed.valueOf())) return date;

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

export function formatRating(rating: string | null, agency: GraphData["agency"]) {
  if (!rating) return "Rating not stated";

  const agencyMarker = agency ? new RegExp(`^\\[${agency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "i") : null;
  const withAgency = agencyMarker?.test(rating)
    ? rating.replace(agencyMarker, `${agency} `)
    : agency && !rating.toLowerCase().startsWith(agency.toLowerCase())
      ? `${agency} ${rating}`
      : rating;

  return withAgency
    .replace(/\s*;\s*stable/gi, "/Stable")
    .replace(/\s*\(stable\)/gi, "/Stable")
    .replace(/\s+/g, " ")
    .trim();
}

export function getReportProvenance(graph: Pick<GraphData, "rating" | "agency" | "report_date">) {
  const rating = formatRating(graph.rating, graph.agency);
  const agencySuffix = graph.rating || !graph.agency ? "" : ` · ${graph.agency}`;
  return `${rating}${agencySuffix} · rated ${formatReportDate(graph.report_date)}`;
}
