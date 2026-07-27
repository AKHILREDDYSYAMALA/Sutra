import assert from "node:assert/strict";
import test from "node:test";

import { classifyDocument } from "./classify";

test("earnings-call transcripts are deterministically excluded before extraction", async () => {
  const classification = await classifyDocument({
    title: "Q4 FY26 Earnings Call Transcript",
    url: "https://example.test/investor/earnings-call-transcript.pdf",
    text: "Welcome to the quarterly earnings conference call. We will now open the floor for analyst questions and answers.",
  });

  assert.deepEqual(classification, {
    docType: "other",
    confidence: "deterministic",
    reason: "earnings-call transcript, not a credit rating rationale",
  });
});
