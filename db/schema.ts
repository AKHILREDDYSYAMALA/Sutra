import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const documentStatuses = [
  "discovered",
  "fetched",
  "classified",
  "extracted",
  "validated",
  "resolved",
  "ready_for_review",
  "published",
  "failed",
  "excluded",
  "superseded_document",
] as const;

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)],
);

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    bseScripCode: text("bse_scrip_code"),
    nseSymbol: text("nse_symbol"),
    sector: text("sector"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("companies_slug_unique").on(table.slug),
    index("companies_bse_scrip_code_idx").on(table.bseScripCode),
    index("companies_nse_symbol_idx").on(table.nseSymbol),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    companyId: uuid("company_id").references(() => companies.id),
    source: text("source").notNull(),
    docType: text("doc_type"),
    title: text("title"),
    // Static graph imports have local PDFs only; hosted source URLs arrive with ingestion.
    url: text("url"),
    storagePath: text("storage_path"),
    sha256: text("sha256").notNull(),
    agency: text("agency"),
    rating: text("rating"),
    publishedDate: date("published_date"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    status: text("status").notNull().default("discovered"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => users.id),
    isPrivate: boolean("is_private").notNull().default(false),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex("documents_sha256_unique").on(table.sha256),
    index("documents_status_next_attempt_at_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("documents_company_id_idx").on(table.companyId),
    index("documents_published_date_idx").on(table.publishedDate),
    check(
      "documents_source_check",
      sql`${table.source} in ('bse', 'nse', 'crisil', 'icra', 'care', 'india_ratings', 'user_upload', 'manual')`,
    ),
    check(
      "documents_doc_type_check",
      sql`${table.docType} is null or ${table.docType} in ('rating_rationale', 'rating_intimation', 'annual_report', 'rpt_schedule', 'order_win', 'drhp', 'other')`,
    ),
    check(
      "documents_status_check",
      sql`${table.status} in ('discovered', 'fetched', 'classified', 'extracted', 'validated', 'resolved', 'ready_for_review', 'published', 'failed', 'excluded', 'superseded_document')`,
    ),
    check("documents_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
);

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    canonicalName: text("canonical_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    entityType: text("entity_type").notNull(),
    // Null denotes a clearly foreign entity whose precise country is not known yet.
    country: text("country").default("IN"),
    isListed: boolean("is_listed").notNull().default(false),
    companyId: uuid("company_id").references(() => companies.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("entities_normalized_name_unique").on(table.normalizedName),
    index("entities_company_id_idx").on(table.companyId),
    check(
      "entities_type_check",
      sql`${table.entityType} in ('company', 'government', 'institution', 'unnamed', 'other')`,
    ),
  ],
);

export const entityAliases = pgTable(
  "entity_aliases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    rawName: text("raw_name").notNull(),
    normalizedRaw: text("normalized_raw").notNull(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).notNull(),
    resolvedBy: text("resolved_by").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceDocumentId: uuid("source_document_id").references(() => documents.id),
  },
  (table) => [
    unique("entity_aliases_normalized_raw_entity_id_unique").on(
      table.normalizedRaw,
      table.entityId,
    ),
    index("entity_aliases_normalized_raw_idx").on(table.normalizedRaw),
    check(
      "entity_aliases_confidence_check",
      sql`${table.confidence} between 0 and 1`,
    ),
    check(
      "entity_aliases_resolved_by_check",
      sql`${table.resolvedBy} in ('deterministic', 'llm', 'human', 'user')`,
    ),
  ],
);

export const entityMerges = pgTable(
  "entity_merges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    fromEntityId: uuid("from_entity_id")
      .notNull()
      .references(() => entities.id),
    intoEntityId: uuid("into_entity_id")
      .notNull()
      .references(() => entities.id),
    performedBy: text("performed_by").notNull(),
    reason: text("reason"),
    evidence: jsonb("evidence"),
    performedAt: timestamp("performed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    revertedReason: text("reverted_reason"),
  },
  (table) => [
    check(
      "entity_merges_performed_by_check",
      sql`${table.performedBy} in ('human', 'llm', 'user')`,
    ),
    check(
      "entity_merges_distinct_entities_check",
      sql`${table.fromEntityId} <> ${table.intoEntityId}`,
    ),
    check(
      "entity_merges_reversal_reason_check",
      sql`${table.revertedAt} is null or ${table.revertedReason} is not null`,
    ),
  ],
);

/**
 * A human-declined merge is evidence too. Keeping the pair in normalized UUID
 * order makes (A, B) and (B, A) one durable, reversible decision surface.
 */
export const entityMergeRejections = pgTable(
  "entity_merge_rejections",
  {
    entityAId: uuid("entity_a_id")
      .notNull()
      .references(() => entities.id),
    entityBId: uuid("entity_b_id")
      .notNull()
      .references(() => entities.id),
    rejectedBy: text("rejected_by").notNull(),
    reason: text("reason").notNull(),
    rejectedAt: timestamp("rejected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.entityAId, table.entityBId] }),
    check(
      "entity_merge_rejections_normalized_order_check",
      sql`${table.entityAId} < ${table.entityBId}`,
    ),
  ],
);

export const claims = pgTable(
  "claims",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    sourceEntityId: uuid("source_entity_id")
      .notNull()
      .references(() => entities.id),
    targetEntityId: uuid("target_entity_id")
      .notNull()
      .references(() => entities.id),
    relationType: text("relation_type").notNull(),
    relationLabel: text("relation_label").notNull(),
    // Exact relationship wording recognised in the evidence quote. This is
    // deliberately separate from the finite, queryable relationType taxonomy.
    rawRelationshipPhrase: text("raw_relationship_phrase"),
    exposurePct: numeric("exposure_pct", { precision: 5, scale: 2 }),
    riskFlag: text("risk_flag"),
    quote: text("quote").notNull(),
    // Hash of normaliseForQuoteMatch(quote). The raw quote remains the evidence;
    // this bounded key makes reprocessing idempotent without indexing long text.
    quoteHash: text("quote_hash").notNull(),
    page: integer("page"),
    observedDate: date("observed_date").notNull(),
    lifecycleState: text("lifecycle_state").notNull().default("current"),
    supersededByClaimId: uuid("superseded_by_claim_id").references(
      (): AnyPgColumn => claims.id,
    ),
    verificationTier: text("verification_tier").notNull(),
    exclusionReason: text("exclusion_reason"),
    extractionConfidence: text("extraction_confidence"),
    modelVersion: text("model_version").notNull(),
    promptVersion: text("prompt_version").notNull(),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    // Review state and decision method are operational metadata, never claim
    // substance. They make human verification auditable without weakening the
    // append-only evidence guarantee.
    reviewState: text("review_state").notNull().default("pending"),
    reviewNote: text("review_note"),
    decisionMethod: text("decision_method"),
    createdAt: createdAt(),
  },
  (table) => [
    index("claims_company_lifecycle_state_idx").on(
      table.companyId,
      table.lifecycleState,
    ),
    index("claims_document_id_idx").on(table.documentId),
    index("claims_target_entity_id_idx").on(table.targetEntityId),
    index("claims_source_entity_id_idx").on(table.sourceEntityId),
    index("claims_verification_tier_idx").on(table.verificationTier),
    index("claims_quote_hash_idx").on(table.quoteHash),
    uniqueIndex("claims_document_relation_quote_hash_unique").on(
      table.documentId,
      table.sourceEntityId,
      table.targetEntityId,
      table.relationType,
      table.quoteHash,
    ),
    check(
      "claims_relation_type_check",
      sql`${table.relationType} in ('customer', 'supplier', 'lender', 'subsidiary', 'parent', 'group_company', 'unnamed_dependency')`,
    ),
    check(
      "claims_exposure_pct_check",
      sql`${table.exposurePct} is null or ${table.exposurePct} between 0 and 100`,
    ),
    check(
      "claims_risk_flag_check",
      sql`${table.riskFlag} is null or ${table.riskFlag} in ('high', 'medium', 'low')`,
    ),
    check("claims_page_positive_check", sql`${table.page} is null or ${table.page} > 0`),
    check(
      "claims_lifecycle_state_check",
      sql`${table.lifecycleState} in ('current', 'aging', 'superseded', 'not_restated')`,
    ),
    check(
      "claims_supersession_link_check",
      sql`(${table.lifecycleState} = 'superseded') = (${table.supersededByClaimId} is not null)`,
    ),
    check(
      "claims_not_self_superseding_check",
      sql`${table.supersededByClaimId} is null or ${table.supersededByClaimId} <> ${table.id}`,
    ),
    check(
      "claims_verification_tier_check",
      sql`${table.verificationTier} in ('human_verified', 'machine_validated', 'excluded')`,
    ),
    check(
      "claims_exclusion_reason_check",
      sql`${table.verificationTier} <> 'excluded' or ${table.exclusionReason} is not null`,
    ),
    check(
      "claims_excluded_requires_human_review_check",
      sql`${table.verificationTier} <> 'excluded' or (${table.reviewedBy} is not null and ${table.reviewedAt} is not null and ${table.reviewState} = 'decided')`,
    ),
    check(
      "claims_extraction_confidence_check",
      sql`${table.extractionConfidence} is null or ${table.extractionConfidence} in ('high', 'medium')`,
    ),
    check(
      "claims_review_state_check",
      sql`${table.reviewState} in ('pending', 'needs_second_look', 'decided')`,
    ),
    check(
      "claims_review_state_matches_tier_check",
      sql`(${table.verificationTier} = 'machine_validated' and ${table.reviewState} in ('pending', 'needs_second_look')) or (${table.verificationTier} in ('human_verified', 'excluded') and ${table.reviewState} = 'decided')`,
    ),
    check(
      "claims_second_look_note_check",
      sql`${table.reviewState} <> 'needs_second_look' or nullif(btrim(${table.reviewNote}), '') is not null`,
    ),
    check(
      "claims_decision_method_check",
      sql`${table.decisionMethod} is null or ${table.decisionMethod} in ('individual', 'bulk')`,
    ),
  ],
);

export const portfolios = pgTable("portfolios", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull().default("My portfolio"),
  createdAt: createdAt(),
});

export const portfolioHoldings = pgTable(
  "portfolio_holdings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").references(() => companies.id),
    rawInput: text("raw_input").notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("portfolio_holdings_portfolio_raw_input_unique").on(
      table.portfolioId,
      table.rawInput,
    ),
  ],
);

export const watchlists = pgTable(
  "watchlists",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    watchType: text("watch_type").notNull(),
    companyId: uuid("company_id").references(() => companies.id),
    entityId: uuid("entity_id").references(() => entities.id),
    createdAt: createdAt(),
  },
  (table) => [
    unique("watchlists_user_company_unique").on(table.userId, table.companyId),
    unique("watchlists_user_entity_unique").on(table.userId, table.entityId),
    check(
      "watchlists_type_check",
      sql`${table.watchType} in ('company', 'entity')`,
    ),
    check(
      "watchlists_target_matches_type_check",
      sql`(${table.watchType} = 'company' and ${table.companyId} is not null and ${table.entityId} is null) or (${table.watchType} = 'entity' and ${table.entityId} is not null and ${table.companyId} is null)`,
    ),
  ],
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    alertType: text("alert_type").notNull(),
    companyId: uuid("company_id").references(() => companies.id),
    entityId: uuid("entity_id").references(() => entities.id),
    claimId: uuid("claim_id").references(() => claims.id),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
    readAt: timestamp("read_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => [
    index("alerts_user_created_at_idx").on(table.userId, table.createdAt.desc()),
    check(
      "alerts_type_check",
      sql`${table.alertType} in ('new_claim', 'exposure_changed', 'not_restated', 'new_document', 'rating_action')`,
    ),
  ],
);

export const userReads = pgTable(
  "user_reads",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.companyId] })],
);

export const companyRequests = pgTable("company_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id),
  rawQuery: text("raw_query").notNull(),
  companyId: uuid("company_id").references(() => companies.id),
  createdAt: createdAt(),
  fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
});

/** One durable watermark and circuit-breaker state row for each acquisition source. */
export const watcherState = pgTable("watcher_state", {
  source: text("source").primaryKey(),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
  lastAnnouncementDate: timestamp("last_announcement_date", { withTimezone: true }),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  lastError: text("last_error"),
  updatedAt: updatedAt(),
});

/**
 * The exchange-announcement audit trail exists before a PDF is fetched, so its
 * unique external id—not a PDF hash—is the discovery idempotency boundary.
 */
export const discoveredAnnouncements = pgTable(
  "discovered_announcements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    scripCode: text("scrip_code").notNull(),
    companyId: uuid("company_id").references(() => companies.id),
    headline: text("headline").notNull(),
    category: text("category"),
    announcementDate: timestamp("announcement_date", { withTimezone: true }).notNull(),
    attachmentUrl: text("attachment_url"),
    rawPayload: jsonb("raw_payload").notNull(),
    documentId: uuid("document_id").references(() => documents.id),
    status: text("status").notNull().default("new"),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("discovered_announcements_source_external_id_unique").on(table.source, table.externalId),
    index("discovered_announcements_company_date_idx").on(table.companyId, table.announcementDate),
    check("discovered_announcements_status_check", sql`${table.status} in ('new', 'linked', 'ignored', 'failed')`),
  ],
);

export const events = pgTable("events", {
  id: uuid("id").defaultRandom().primaryKey(),
  headline: text("headline").notNull(),
  url: text("url"),
  source: text("source").notNull(),
  publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const eventEntities = pgTable(
  "event_entities",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id),
    linkConfidence: numeric("link_confidence", {
      precision: 3,
      scale: 2,
    }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.entityId] }),
    check(
      "event_entities_link_confidence_check",
      sql`${table.linkConfidence} between 0 and 1`,
    ),
  ],
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
