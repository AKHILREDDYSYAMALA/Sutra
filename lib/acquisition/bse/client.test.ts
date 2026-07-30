import assert from "node:assert/strict";
import test from "node:test";

import fixtures from "./fixtures/announcements.json";
import { BseClient, parseAnnouncement } from "./client";
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

test("BSE client never uses browser-impersonation headers", async () => {
  let requestHeaders: Headers | undefined;
  const client = new BseClient({
    minRequestIntervalMs: 0,
    fetch: async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ Table: [], Table1: [{ ROWCNT: 0 }] }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.announcements({
    scripCode: "532500",
    from: new Date("2026-07-29T00:00:00Z"),
    to: new Date("2026-07-30T00:00:00Z"),
  });

  assert.equal(requestHeaders?.get("user-agent"), "Sutra BSE watcher/1.0 (+https://github.com/AKHILREDDYSYAMALA/Sutra)");
  assert.equal(requestHeaders?.get("accept"), "application/json");
  assert.equal(requestHeaders?.get("origin"), null);
  assert.equal(requestHeaders?.get("referer"), null);
  assert.equal(requestHeaders?.get("accept-language"), null);
});
