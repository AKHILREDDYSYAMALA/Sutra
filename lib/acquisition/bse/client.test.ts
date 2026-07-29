import assert from "node:assert/strict";
import test from "node:test";

import fixtures from "./fixtures/announcements.json";
import { parseAnnouncement } from "./client";
import { bseCompanyNameMatches, isRatingAnnouncement } from "./watcher";

test("parseAnnouncement maps saved BSE announcement payloads", () => {
  const parsed = fixtures.map(parseAnnouncement);
  assert.deepEqual(parsed.map(({ bseAnnouncementId, scripCode, headline, attachmentUrl }) => ({ bseAnnouncementId, scripCode, headline, attachmentUrl })), [
    { bseAnnouncementId: "6fb57b5e-a05f-4e05-b2da-6e2b5bfe32ae", scripCode: "517397", headline: "PAN ELECTRONICS INDIA LTD. - 517397 - Compliances-Reg. 39 (3) - Details of Loss of Certificate / Duplicate Certificate", attachmentUrl: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/aab502e1-3e05-4fdc-bc10-ecbb436cab8d.pdf" },
    { bseAnnouncementId: "202607290002", scripCode: "532500", headline: "Reaffirmation of credit ratings", attachmentUrl: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/b2c3d4.pdf" },
    { bseAnnouncementId: "202607290003", scripCode: "500000", headline: "Company update", attachmentUrl: null },
  ]);
  assert.equal(parsed[0]?.announcementDate.getTime(), new Date("2023-10-20T23:44:22.95").getTime());
});

test("rating relevance is conservative and keeps non-rating announcements auditable", () => {
  assert.equal(isRatingAnnouncement({ headline: "India Ratings rating action", category: "Company Update", subCategory: null }), true);
  assert.equal(isRatingAnnouncement({ headline: "Issuance of duplicate share certificate", category: null, subCategory: null }), false);
});

test("BSE scrip guard accepts normalised names but rejects a different company", () => {
  assert.equal(bseCompanyNameMatches("Sona BLW Precision Forgings Limited", "SONA BL W PRECISION FORGINGS LIMITED"), true);
  assert.equal(bseCompanyNameMatches("Syrma SGS Technology Limited", "SYRMA SG S TECHNOLOGY LIMITED"), true);
  assert.equal(bseCompanyNameMatches("PTC Industries Limited", "PTC INDUSTRIES LIMITED"), true);
  assert.equal(bseCompanyNameMatches("Sona BLW Precision Forgings Limited", "Tata Motors Limited"), false);
});
