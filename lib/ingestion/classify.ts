import OpenAI from "openai";

import { extractionConfig } from "@/lib/extraction-config";

export type DocumentClassification = {
  docType: "rating_rationale" | "rating_intimation" | "annual_report" | "rpt_schedule" | "order_win" | "drhp" | "other";
  confidence: "deterministic" | "llm";
  reason: string;
};

const RATIONALE = /\b(rating rationale|credit rationale|rationale report|rating\s+(?:rationale|report))\b/i;
const RATING_INTIMATION = /\b(rating intimation|rating action|rating reaffirmed|credit rating(?:s)? (?:assigned|reaffirmed|revised))\b/i;
const ANNUAL = /\bannual report\b/i;
const RPT = /\brelated party transaction|rpt schedule\b/i;
const ORDER = /\b(?:order win|order received|letter of award)\b/i;
const DRHP = /\b(?:draft red herring prospectus|drhp)\b/i;

function ruleBasedClassification(value: string): DocumentClassification | null {
  if (RATIONALE.test(value)) return { docType: "rating_rationale", confidence: "deterministic", reason: "rating rationale language found" };
  if (RATING_INTIMATION.test(value)) return { docType: "rating_intimation", confidence: "deterministic", reason: "rating intimation language found" };
  if (ANNUAL.test(value)) return { docType: "annual_report", confidence: "deterministic", reason: "annual report language found" };
  if (RPT.test(value)) return { docType: "rpt_schedule", confidence: "deterministic", reason: "related-party schedule language found" };
  if (ORDER.test(value)) return { docType: "order_win", confidence: "deterministic", reason: "order announcement language found" };
  if (DRHP.test(value)) return { docType: "drhp", confidence: "deterministic", reason: "DRHP language found" };
  return null;
}

/**
 * Classification remains deliberately conservative. The small LLM fallback is only
 * used when filename and document text are ambiguous; it never extracts claims.
 */
export async function classifyDocument(input: { title?: string | null; url?: string | null; text: string }): Promise<DocumentClassification> {
  const rule = ruleBasedClassification(`${input.title ?? ""}\n${input.url ?? ""}\n${input.text.slice(0, 20_000)}`);
  if (rule) return rule;

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || apiKey === "YOUR_OPENAI_API_KEY") {
    return { docType: "other", confidence: "deterministic", reason: "ambiguous document; no classifier credentials" };
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
          content: "Classify this financial PDF. Return only JSON {\"doc_type\": one of rating_rationale,rating_intimation,annual_report,rpt_schedule,order_win,drhp,other}. Choose rating_rationale only for a detailed agency credit-rating rationale.",
        },
        { role: "user", content: `Title: ${input.title ?? "unknown"}\nURL: ${input.url ?? "unknown"}\n\n${input.text.slice(0, 12_000)}` },
      ],
    }, { timeout: extractionConfig.timeoutMs, maxRetries: 0 });
    const raw = completion.choices[0]?.message.content;
    const value = raw ? JSON.parse(raw) as { doc_type?: unknown } : {};
    const docType = value.doc_type;
    if (docType === "rating_rationale" || docType === "rating_intimation" || docType === "annual_report" || docType === "rpt_schedule" || docType === "order_win" || docType === "drhp" || docType === "other") {
      return { docType, confidence: "llm", reason: "ambiguous document classified by model" };
    }
  } catch (error) {
    console.warn("Sutra document classification fallback failed", { message: error instanceof Error ? error.message : String(error) });
  }

  return { docType: "other", confidence: "deterministic", reason: "ambiguous document excluded conservatively" };
}
