import type { GraphData } from "@/lib/graph-data";

export function getRiskVerdict(graph: GraphData) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const targetId = graph.nodes.find((node) => node.type === "target")?.id;
  const highRiskCustomerEdges = graph.edges.filter((edge) => {
    const counterparty = edge.source === targetId ? edge.target : edge.source;
    return edge.risk_flag === "high" && nodeById.get(counterparty)?.type === "customer";
  });
  const quantifiedHighRiskCustomerEdges = highRiskCustomerEdges.filter((edge) => typeof edge.exposure_pct === "number");

  const concentratedRevenue = quantifiedHighRiskCustomerEdges.reduce((total, edge) => total + (edge.exposure_pct ?? 0), 0);

  if (quantifiedHighRiskCustomerEdges.length > 0) {
    return {
      tone: "high" as const,
      label: `${concentratedRevenue}% of revenue concentrated in ${quantifiedHighRiskCustomerEdges.length} ${quantifiedHighRiskCustomerEdges.length === 1 ? "customer" : "customers"}`,
    };
  }

  if (highRiskCustomerEdges.length > 0) {
    return {
      tone: "high" as const,
      label: `Material revenue dependency across ${highRiskCustomerEdges.length} named ${highRiskCustomerEdges.length === 1 ? "customer" : "customers"}`,
    };
  }

  const highRiskEdges = graph.edges.filter((edge) => edge.risk_flag === "high");
  if (highRiskEdges.length > 0) {
    return { tone: "high" as const, label: `${highRiskEdges.length} high-risk counterparty relationships detected` };
  }

  if (graph.edges.some((edge) => edge.risk_flag === "medium")) {
    return { tone: "medium" as const, label: "Moderate dependency signals found in the report" };
  }

  return { tone: "low" as const, label: "No explicit high-risk counterparty concentration detected" };
}
