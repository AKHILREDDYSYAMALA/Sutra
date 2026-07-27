import OpenAI from "openai";

import { extractionConfig } from "@/lib/extraction-config";

export type DocumentType = "rating_rationale" | "rating_intimation" | "annual_report" | "rpt_schedule" | "order_win" | "drhp" | "other";

export type ClassificationSignals = {
  characterCount: number;
  pageCount: number;
  multiPage: boolean;
  ratingRationaleLabel: boolean;
  ratingIntimation: boolean;
  rationaleSubstanceHeadings: string[];
  earningsCallTranscript: boolean;
  annualReport: boolean;
  relatedPartySchedule: boolean;
  orderAnnouncement: boolean;
  drhp: boolean;
};

export type DocumentClassification = {
  docType: DocumentType;
  confidence: "deterministic" | "llm";
  reason: string;
  decisionPath: string;
  signals: ClassificationSignals;
};

const RATIONALE_LABEL = /\b(rating rationale|credit rationale|rationale report|rating\s+report)\b/i;
const RATING_INTIMATION = /\b(rating intimation|rating action|rating reaffirmed|credit rating(?:s)?\s+(?:assigned|reaffirmed|revised|upgraded|downgraded|affirmed))\b|\b(?:has|have)\s+(?:assigned|reaffirmed|revised|upgraded|downgraded|affirmed)\b[\s\S]{0,140}\brating\b/i;
const ANNUAL = /\bannual report\b/i;
const RPT = /\brelated party transaction|rpt schedule\b/i;
const ORDER = /\b(?:order win|order received|letter of award)\b/i;
const DRHP = /\b(?:draft red herring prospectus|drhp)\b/i;
const EARNINGS_CALL_TRANSCRIPT = /\b(?:earnings|investor|results)\s+(?:call|conference call|transcript)\b|\b(?:analyst|participant)\s+(?:q&a|questions?)\b/i;

// Keep labels agency-neutral. The India Ratings/Ind-Ra variants are explicitly
// included because their reports open with rating-action language before evidence.
const RATIONALE_SUBSTANCE_HEADINGS = [
  "Key Rating Drivers",
  "List of Key Rating Drivers",
  "Detailed Description of Key Rating Drivers",
  "Detailed Rationale of the Rating Action",
  "Analytical Approach",
  "Credit Strengths",
  "Credit Challenges",
  "Liquidity Position",
  "Liquidity",
  "Rating Sensitivities",
  "About the Company",
  "Key Financial Indicators",
  "Rating History",
  "Bank Wise Facilities Details",
] as const;

function normalizeHeading(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pageCount(text: string) {
  const pageMarkers = text.match(/\[\[\s*page\s+\d+\s*\]\]/gi);
  return pageMarkers?.length ?? 1;
}

export function collectClassificationSignals(input: { title?: string | null; url?: string | null; text: string }): ClassificationSignals {
  const value = `${input.title ?? ""}\n${input.url ?? ""}\n${input.text}`;
  const normalized = normalizeHeading(value);
  const rationaleSubstanceHeadings = RATIONALE_SUBSTANCE_HEADINGS.filter((heading) => normalized.includes(normalizeHeading(heading)));
  const pages = pageCount(input.text);
  return {
    characterCount: input.text.length,
    pageCount: pages,
    multiPage: pages > 2 || input.text.length >= 12_000,
    ratingRationaleLabel: RATIONALE_LABEL.test(value),
    ratingIntimation: RATING_INTIMATION.test(value),
    rationaleSubstanceHeadings: [...rationaleSubstanceHeadings],
    earningsCallTranscript: EARNINGS_CALL_TRANSCRIPT.test(value),
    annualReport: ANNUAL.test(value),
    relatedPartySchedule: RPT.test(value),
    orderAnnouncement: ORDER.test(value),
    drhp: DRHP.test(value),
  };
}

function deterministicClassification(signals: ClassificationSignals): DocumentClassification | null {
  if (signals.earningsCallTranscript) {
    return { docType: "other", confidence: "deterministic", reason: "earnings-call transcript, not a credit rating rationale", decisionPath: "earnings_transcript", signals };
  }
  // Substance wins over every action/intimation phrase. Rating rationales commonly
  // open with “assigned”, “reaffirmed”, or “upgraded” before their analysis sections.
  if (signals.rationaleSubstanceHeadings.length > 0) {
    return {
      docType: "rating_rationale",
      confidence: "deterministic",
      reason: `rationale substance found: ${signals.rationaleSubstanceHeadings.join(", ")}`,
      decisionPath: "rationale_substance_precedes_intimation",
      signals,
    };
  }
  if (signals.ratingRationaleLabel) {
    return { docType: "rating_rationale", confidence: "deterministic", reason: "rating rationale label found", decisionPath: "rationale_label", signals };
  }
  if (signals.ratingIntimation) {
    const lengthSignal = signals.multiPage ? "multi-page/long notice but no rationale substance" : "short notice signal";
    return { docType: "rating_intimation", confidence: "deterministic", reason: `rating intimation language found; ${lengthSignal}`, decisionPath: "intimation_without_rationale_substance", signals };
  }
  if (signals.annualReport) return { docType: "annual_report", confidence: "deterministic", reason: "annual report language found", decisionPath: "annual_report", signals };
  if (signals.relatedPartySchedule) return { docType: "rpt_schedule", confidence: "deterministic", reason: "related-party schedule language found", decisionPath: "related_party_schedule", signals };
  if (signals.orderAnnouncement) return { docType: "order_win", confidence: "deterministic", reason: "order announcement language found", decisionPath: "order_announcement", signals };
  if (signals.drhp) return { docType: "drhp", confidence: "deterministic", reason: "DRHP language found", decisionPath: "drhp", signals };
  return null;
}

/**
 * Rules run before the classifier model. `signals` is deliberately persisted by
 * the caller, making a future classification decision inspectable without rerun.
 */
export async function classifyDocument(input: { title?: string | null; url?: string | null; text: string }): Promise<DocumentClassification> {
  const signals = collectClassificationSignals(input);
  const rule = deterministicClassification(signals);
  if (rule) return rule;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || apiKey === "YOUR_OPENAI_API_KEY") {
    return { docType: "other", confidence: "deterministic", reason: "ambiguous document; no classifier credentials", decisionPath: "ambiguous_without_classifier", signals };
  }

  try {
    const client = new OpenAI({ apiKey, maxRetries: 0 });
    const completion = await client.chat.completions.create({
      model: extractionConfig.model,
      temperature: 0,
      max_tokens: 80,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "Classify this financial PDF. Return only JSON {\"doc_type\": one of rating_rationale,rating_intimation,annual_report,rpt_schedule,order_win,drhp,other}. A rating rationale contains analytical sections and evidence; a rating intimation is a short notice without that substance.",
        },
        { role: "user", content: `Title: ${input.title ?? "unknown"}\nURL: ${input.url ?? "unknown"}\n\n${input.text.slice(0, 12_000)}` },
      ],
    }, { timeout: extractionConfig.timeoutMs, maxRetries: 0 });
    const raw = completion.choices[0]?.message.content;
    const value = raw ? JSON.parse(raw) as { doc_type?: unknown } : {};
    const docType = value.doc_type;
    if (docType === "rating_rationale" || docType === "rating_intimation" || docType === "annual_report" || docType === "rpt_schedule" || docType === "order_win" || docType === "drhp" || docType === "other") {
      return { docType, confidence: "llm", reason: "ambiguous document classified by model", decisionPath: "llm_fallback", signals };
    }
  } catch (error) {
    console.warn("Sutra document classification fallback failed", { message: error instanceof Error ? error.message : String(error) });
  }

  return { docType: "other", confidence: "deterministic", reason: "ambiguous document excluded conservatively", decisionPath: "ambiguous_conservative_exclusion", signals };
}
