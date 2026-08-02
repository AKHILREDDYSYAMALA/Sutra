import assert from "node:assert/strict";
import test from "node:test";

import fixtures from "./fixtures/announcements.json";
import { BseBlockedError, BseClient, parseAnnouncement } from "./client";
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

test("BSE scrip guard accepts normalised names and legal-suffix group markers", () => {
  assert.equal(bseCompanyNameMatches("Sona BLW Precision Forgings Limited", "SONA BL W PRECISION FORGINGS LIMITED"), true);
  assert.equal(bseCompanyNameMatches("Syrma SGS Technology Limited", "SYRMA SG S TECHNOLOGY LIMITED"), true);
  assert.equal(bseCompanyNameMatches("PTC Industries Limited", "PTC INDUSTRIES LIMITED"), true);
  assert.equal(bseCompanyNameMatches("Modison Limited", "Modison Ltd-$"), true);
  assert.equal(bseCompanyNameMatches("Avanti Feeds Limited", "Avanti Feeds Ltd-$"), true);
  assert.equal(bseCompanyNameMatches("Avanti Feeds Limited", "Avanti Feeds Ltd-*"), true);
});

test("BSE scrip guard remains strict on a genuinely different issuer", () => {
  assert.equal(bseCompanyNameMatches("Tata Motors Limited", "Tata Motors Passenger Vehicles Ltd"), false);
  assert.equal(bseCompanyNameMatches("Sona BLW Precision Forgings Limited", "Tata Motors Limited"), false);
});

test("BSE client establishes a session and carries its browser-equivalent XHR headers", async () => {
  const requestHeaders: Headers[] = [];
  const client = new BseClient({
    minRequestIntervalMs: 0,
    fetch: async (_input, init) => {
      requestHeaders.push(new Headers(init?.headers));
      if (requestHeaders.length === 1) {
        return new Response("", { headers: { "set-cookie": "bse_session=abc123; Path=/; HttpOnly" } });
      }
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

  const [sessionHeaders, xhrHeaders] = requestHeaders;
  assert.equal(requestHeaders.length, 2);
  assert.match(sessionHeaders?.get("user-agent") ?? "", /^Mozilla\/5\.0/);
  assert.match(sessionHeaders?.get("accept") ?? "", /^text\/html/);
  assert.equal(sessionHeaders?.get("sec-fetch-dest"), "document");
  assert.equal(xhrHeaders?.get("accept"), "application/json");
  assert.equal(xhrHeaders?.get("accept-language"), "en-US,en;q=0.9");
  assert.equal(xhrHeaders?.get("origin"), "https://www.bseindia.com");
  assert.equal(xhrHeaders?.get("referer"), "https://www.bseindia.com/corporates/ann.html");
  assert.equal(xhrHeaders?.get("sec-fetch-mode"), "cors");
  assert.equal(xhrHeaders?.get("sec-fetch-site"), "same-site");
  assert.equal(xhrHeaders?.get("cookie"), "bse_session=abc123");
});

test("BSE stops immediately instead of retrying a block response", async () => {
  let calls = 0;
  const client = new BseClient({
    fetch: async () => {
      calls += 1;
      return new Response("blocked", { status: 403 });
    },
  });

  await assert.rejects(
    client.announcements({ scripCode: "532500", from: new Date("2026-07-29T00:00:00Z"), to: new Date("2026-07-30T00:00:00Z") }),
    BseBlockedError,
  );
  assert.equal(calls, 1);
});
