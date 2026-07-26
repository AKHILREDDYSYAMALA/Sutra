import type { GraphData } from "@/lib/graph-data";

export type CompanyOption = {
  id: string;
  name: string;
  agency: GraphData["agency"];
};

export type SandboxCompany = CompanyOption & {
  graph: GraphData;
  verificationTiers: Record<string, "human_verified" | "machine_validated" | "excluded">;
  excludedClaimCount: number;
};
