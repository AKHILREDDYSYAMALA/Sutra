import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { decideClaims, getDb, publishReviewedDocument } from "@/lib/db";
import { hasReviewAccess } from "@/lib/review/access";

export const runtime = "nodejs";

type ReviewAction =
  | { action: "approve" | "reject"; claimIds: string[]; reason?: string }
  | { action: "publish" };

export async function POST(request: Request, context: { params: Promise<{ documentId: string }> }) {
  if (!await hasReviewAccess()) return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  const { documentId } = await context.params;
  try {
    const body = await request.json() as Partial<ReviewAction>;
    const db = getDb();
    if (body.action === "approve" || body.action === "reject") {
      if (!Array.isArray(body.claimIds) || body.claimIds.some((id) => typeof id !== "string")) {
        return NextResponse.json({ error: "claimIds must be a list of claim identifiers." }, { status: 400 });
      }
      const result = await decideClaims(db, { documentId, claimIds: body.claimIds, decision: body.action, reason: typeof body.reason === "string" ? body.reason : undefined });
      revalidatePath("/");
      revalidatePath("/review");
      revalidatePath(`/review/${documentId}`);
      return NextResponse.json(result);
    }
    if (body.action === "publish") {
      await publishReviewedDocument(db, documentId);
      revalidatePath("/");
      revalidatePath("/review");
      return NextResponse.json({ published: true });
    }
    return NextResponse.json({ error: "Unknown review action." }, { status: 400 });
  } catch (error) {
    console.error("Sutra review action failed", { documentId, message: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Review action failed." }, { status: 400 });
  }
}
