import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type HealthCounts = { companies: number; claims: number };

/** Lightweight runtime-only check for Vercel and external uptime monitors. */
export async function GET() {
  const startedAt = performance.now();

  try {
    const rows = await getDb().execute<HealthCounts>(sql`
      select
        (select count(*)::int from "companies") as "companies",
        (select count(*)::int from "claims") as "claims"
    `);
    const counts = rows[0];
    if (!counts) throw new Error("Health query returned no row.");

    return Response.json(
      {
        ok: true,
        dbLatencyMs: Math.round(performance.now() - startedAt),
        companies: Number(counts.companies),
        claims: Number(counts.claims),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Sutra health check failed", error);
    return Response.json(
      {
        ok: false,
        dbLatencyMs: null,
        companies: null,
        claims: null,
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
