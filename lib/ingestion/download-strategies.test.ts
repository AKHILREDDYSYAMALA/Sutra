import assert from "node:assert/strict";
import test from "node:test";

import { downloadPdfForSource, type DownloadStrategy } from "./download-strategies";

const pdfResponse = () => new Response("%PDF-fixture", { headers: { "content-type": "application/pdf" } });

test("a BSE-source document routes through the BSE strategy while user uploads use default fetch", async () => {
  const calls: string[] = [];
  const bse: DownloadStrategy = {
    id: "bse",
    fetch: async () => {
      calls.push("bse");
      return pdfResponse();
    },
  };
  const fallback: DownloadStrategy = {
    id: "default",
    fetch: async () => {
      calls.push("default");
      return pdfResponse();
    },
  };
  const registry = new Map([["bse" as const, bse]]);

  const bsePdf = await downloadPdfForSource({ source: "bse", url: "https://www.bseindia.com/xml-data/corpfiling/AttachLive/fixture.pdf", registry, fallback });
  const uploadPdf = await downloadPdfForSource({ source: "user_upload", url: "https://uploads.example/fixture.pdf", registry, fallback });

  assert.equal(bsePdf.bytes.toString(), "%PDF-fixture");
  assert.equal(uploadPdf.bytes.toString(), "%PDF-fixture");
  assert.deepEqual(calls, ["bse", "default"]);
});
