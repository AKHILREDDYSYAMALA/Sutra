export const backupTableOrder = [
  "users",
  "companies",
  "documents",
  "entities",
  "entity_aliases",
  "entity_merges",
  "claims",
  "entity_merge_rejections",
] as const;

export const countedTables = [
  ...backupTableOrder,
  "portfolios",
  "portfolio_holdings",
  "watchlists",
  "alerts",
  "user_reads",
  "company_requests",
  "events",
  "event_entities",
] as const;

export type BackupTable = (typeof backupTableOrder)[number];
export type CountedTable = (typeof countedTables)[number];
