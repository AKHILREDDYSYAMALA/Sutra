import { verifiedCompanyManifest } from "@/lib/generated-company-manifest";
import { ensureGraphIntegrity } from "@/lib/graph-integrity";
import { sandboxGraphSchema, type GraphData } from "@/lib/graph-data";

export type CompanyOption = {
  id: string;
  name: string;
  agency: GraphData["agency"];
};

export type SandboxCompany = CompanyOption & {
  graph: GraphData;
};

const companies: Record<string, GraphData> = Object.fromEntries(
  verifiedCompanyManifest.map(({ id, data }) => {
    const { verified: _verified, ...graph } = sandboxGraphSchema.parse(data);
    return [id, ensureGraphIntegrity(graph).graph];
  }),
);

export const companyOptions: CompanyOption[] = Object.entries(companies).map(([id, graph]) => ({
  id,
  name: graph.target_company,
  agency: graph.agency,
}));

export const staticSandboxCompanies: SandboxCompany[] = companyOptions.map((company) => ({
  ...company,
  graph: companies[company.id],
}));

export function getCompanyGraph(id: string) {
  return companies[id] ?? null;
}
