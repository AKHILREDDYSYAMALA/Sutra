import { NextResponse } from "next/server";

// The local JSON sandbox was retired when verified graphs moved to the ledger.
export function GET() {
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export const POST = GET;
