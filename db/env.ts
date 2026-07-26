import { config } from "dotenv";

config({ path: ".env.local" });
config();

export function requiredDirectUrl(): string {
  const directUrl = process.env.DIRECT_URL;

  if (!directUrl) {
    throw new Error(
      "DIRECT_URL is required. Set the Supabase session-pooler URL (port 5432) in .env.local.",
    );
  }

  return directUrl;
}
