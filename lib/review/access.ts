import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";

function safelyMatchesToken(candidate: string | null, expected: string | undefined) {
  if (!candidate || !expected) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Day 5's temporary server-only gate. Day 6 replaces this with authenticated users. */
export async function hasReviewAccess() {
  if (process.env.NODE_ENV !== "production") return true;
  const requestHeaders = await headers();
  const bearer = requestHeaders.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  return safelyMatchesToken(requestHeaders.get("x-admin-token"), process.env.ADMIN_TOKEN)
    || safelyMatchesToken(bearer, process.env.ADMIN_TOKEN);
}
