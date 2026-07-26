import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });
config();

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: {
    // Migrations must use Supabase's session pooler (port 5432), never DATABASE_URL.
    url: process.env.DIRECT_URL!,
  },
  strict: true,
  verbose: true,
});
