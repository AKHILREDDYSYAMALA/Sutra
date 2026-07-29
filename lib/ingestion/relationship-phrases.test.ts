import assert from "node:assert/strict";
import test from "node:test";

import { rawRelationshipPhraseFromQuote } from "./relationship-phrases";

test("captures raw taxonomy-strain phrases from verbatim report evidence", () => {
  assert.equal(rawRelationshipPhraseFromQuote("Evey Trans is an associate company of Olectra."), "associate company");
  assert.equal(rawRelationshipPhraseFromQuote("KSolar e Energy is a joint venture."), "joint venture");
  assert.equal(rawRelationshipPhraseFromQuote("The acquisition of a majority stake in Elcome remains subject to approvals."), "acquisition of a majority stake");
  assert.equal(rawRelationshipPhraseFromQuote("The company has a diversified customer base."), null);
});
