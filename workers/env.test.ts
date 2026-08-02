import assert from "node:assert/strict";
import test from "node:test";

import { requiredWorkerEnvironment } from "./env";

test("worker environment validation reports every missing credential together", () => {
  assert.throws(
    () => requiredWorkerEnvironment({ DATABASE_URL: "postgresql://valid" }),
    /OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/,
  );
});

test("worker environment validation rejects example placeholders and returns runtime values", () => {
  assert.throws(
    () => requiredWorkerEnvironment({
      DATABASE_URL: "postgresql://postgres:[PASSWORD]@example",
      OPENAI_API_KEY: "YOUR_OPENAI_API_KEY",
      SUPABASE_URL: "https://[PROJECT-REF].supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "",
    }),
    /DATABASE_URL, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY/,
  );

  assert.deepEqual(requiredWorkerEnvironment({
    DATABASE_URL: "postgresql://runtime",
    OPENAI_API_KEY: "runtime-openai-key",
    SUPABASE_URL: "https://runtime.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "runtime-service-role-key",
  }), {
    databaseUrl: "postgresql://runtime",
    openAiApiKey: "runtime-openai-key",
    supabaseUrl: "https://runtime.supabase.co",
    supabaseServiceRoleKey: "runtime-service-role-key",
  });
});
