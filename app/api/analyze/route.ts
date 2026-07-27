import { NextResponse } from "next/server";

import { ExtractionError, extract } from "@/lib/extraction/extract";

export const runtime = "nodejs";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function statusFor(error: ExtractionError) {
  switch (error.code) {
    case "not_configured": return 503;
    case "unreadable_pdf":
    case "not_rating_report": return 422;
    case "timeout": return 504;
    case "service_unavailable": return 503;
    default: return 502;
  }
}

/** Live uploads deliberately use the same shared extraction path as ingestion. */
export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "Please upload a PDF rating report." }, { status: 400 });
    if (file.size === 0 || file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "Please upload a non-empty PDF smaller than 10MB." }, { status: 413 });
    }
    if (file.type && file.type !== "application/pdf") {
      return NextResponse.json({ error: "Only PDF rating reports are supported." }, { status: 415 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      return NextResponse.json({ error: "Only PDF rating reports are supported." }, { status: 415 });
    }
    const extracted = await extract(bytes);
    return NextResponse.json({ graph: extracted.graph, meta: extracted.meta });
  } catch (error) {
    if (error instanceof ExtractionError) return NextResponse.json({ error: error.message }, { status: statusFor(error) });
    // Never include a request, a PDF, or an SDK object in the response body.
    console.error("Sutra PDF analysis failed.", error);
    return NextResponse.json({ error: "We could not analyse this PDF. Please try another text-based rating report." }, { status: 500 });
  }
}
