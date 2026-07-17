import amberEnterprises from "@/data/companies/amber-enterprises.json";
import dixonTechnologies from "@/data/companies/dixon-technologies.json";
import mtarTechnologies from "@/data/companies/mtar-technologies.json";
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

const staticEntries = {
  "mtar-technologies": sandboxGraphSchema.parse(mtarTechnologies),
  "dixon-technologies": sandboxGraphSchema.parse(dixonTechnologies),
  "amber-enterprises": sandboxGraphSchema.parse(amberEnterprises),
};

const companies: Record<string, GraphData> = Object.fromEntries(
  Object.entries(staticEntries)
    .filter(([, entry]) => entry.verified)
    .map(([id, entry]) => {
      const { verified: _verified, ...graph } = entry;
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
