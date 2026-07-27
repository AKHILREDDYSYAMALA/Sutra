import assert from "node:assert/strict";
import test from "node:test";

import { classifyDocument } from "./classify";
import { sourceForUrl } from "./ingest";

test("India Ratings rationale substance beats an upgraded-rating opening", async () => {
  const classification = await classifyDocument({
    title: "India Ratings Upgrades Olectra Greentech’s Bank Loan Facilities to ‘IND A’/Stable",
    url: "https://www.indiaratings.co.in/pressrelease/d4dyewhkruehkcepzsxoa5jy",
    text: `[[PAGE 1]]
India Ratings and Research (Ind-Ra) has upgraded Olectra Greentech Limited's (OGL) bank loan facilities long-term rating to 'IND A' from 'IND A-'.
Analytical Approach
Detailed Rationale of the Rating Action
List of Key Rating Drivers
Detailed Description of Key Rating Drivers
Liquidity
Rating Sensitivities
About the Company
Key Financial Indicators
Rating History
Bank wise Facilities Details
[[PAGE 2]]
The detailed analysis of the company follows.`,
  });

  assert.equal(classification.docType, "rating_rationale");
  assert.equal(classification.decisionPath, "rationale_substance_precedes_intimation");
  assert.equal(classification.signals.ratingIntimation, true);
  assert.ok(classification.signals.rationaleSubstanceHeadings.includes("Analytical Approach"));
  assert.ok(classification.signals.rationaleSubstanceHeadings.includes("Detailed Rationale of the Rating Action"));
  assert.equal(sourceForUrl("https://www.indiaratings.co.in/pressrelease/d4dyewhkruehkcepzsxoa5jy"), "india_ratings");
  assert.equal(sourceForUrl("https://ratings.ind-ra.example/report.pdf"), "india_ratings");
});

test("short rating intimation without rationale substance remains an intimation", async () => {
  const classification = await classifyDocument({
    title: "Rating Intimation",
    text: "ICRA has reaffirmed the long-term rating of Example Limited at ICRA A. The outlook is Stable. This is a rating action notice.",
  });

  assert.equal(classification.docType, "rating_intimation");
  assert.equal(classification.decisionPath, "intimation_without_rationale_substance");
  assert.equal(classification.signals.rationaleSubstanceHeadings.length, 0);
  assert.equal(classification.signals.multiPage, false);
});

test("earnings-call transcripts are deterministically excluded before extraction", async () => {
  const classification = await classifyDocument({
    title: "Q4 FY26 Earnings Call Transcript",
    url: "https://example.test/investor/earnings-call-transcript.pdf",
    text: "Welcome to the quarterly earnings conference call. We will now open the floor for analyst questions and answers.",
  });

  assert.equal(classification.docType, "other");
  assert.equal(classification.decisionPath, "earnings_transcript");
  assert.equal(classification.confidence, "deterministic");
});
