import { config } from "dotenv";

// Match the database CLIs: local files fill only missing values, so deployment
// configuration supplied by the host environment always takes precedence.
config({ path: ".env.local" });
config();

const workerEnvironmentKeys = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type WorkerEnvironmentKey = (typeof workerEnvironmentKeys)[number];
type WorkerEnvironment = Partial<Record<WorkerEnvironmentKey, string | undefined>>;

function isMissingOrPlaceholder(value: string | undefined) {
  const trimmed = value?.trim();
  return !trimmed || trimmed.startsWith("YOUR_") || /\[[A-Z][A-Z_-]*\]/.test(trimmed);
}

/** Fail before claiming work so a misconfigured worker never creates partial pipeline state. */
export function requiredWorkerEnvironment(environment: WorkerEnvironment = process.env as WorkerEnvironment) {
  const missing = workerEnvironmentKeys.filter((key) => isMissingOrPlaceholder(environment[key]));
  if (missing.length > 0) {
    throw new Error(
      `Worker startup configuration is incomplete. Missing or placeholder values: ${missing.join(", ")}. `
      + "Set them in .env.local for local runs or in the deployment environment.",
    );
  }

  return {
    databaseUrl: environment.DATABASE_URL!.trim(),
    openAiApiKey: environment.OPENAI_API_KEY!.trim(),
    supabaseUrl: environment.SUPABASE_URL!.trim(),
    supabaseServiceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  };
}
