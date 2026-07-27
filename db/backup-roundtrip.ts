import { spawn } from "node:child_process";

import { requiredDirectUrl } from "./env";

function projectRef(connectionString: string) {
  const parsed = new URL(connectionString);
  const fromUser = /^postgres\.([a-z0-9-]+)$/i.exec(decodeURIComponent(parsed.username))?.[1];
  const fromHost = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(parsed.hostname)?.[1];
  return fromUser ?? fromHost ?? parsed.host;
}

function runNpm(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("npm", args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output) : reject(new Error(`npm ${args.join(" ")} exited ${code ?? "unknown"}.`)));
  });
}

async function main() {
  const sourceUrl = requiredDirectUrl();
  const scratchUrl = process.env.SCRATCH_DIRECT_URL?.trim();
  if (!scratchUrl) throw new Error("SCRATCH_DIRECT_URL is required for a backup round-trip.");
  if (!process.env.PRODUCTION_SUPABASE_PROJECT_REF?.trim()) {
    throw new Error("PRODUCTION_SUPABASE_PROJECT_REF is required before a scratch reset can run.");
  }
  if (projectRef(sourceUrl) === projectRef(scratchUrl)) {
    throw new Error("SCRATCH_DIRECT_URL resolves to the source project; refusing a destructive round-trip.");
  }

  const sourceEnv = { ...process.env, DIRECT_URL: sourceUrl };
  const backupOutput = await runNpm(["run", "db:backup"], sourceEnv);
  const backupPath = /^Backup written: (.+)$/m.exec(backupOutput)?.[1];
  if (!backupPath) throw new Error("Could not identify the backup file produced by db:backup.");

  const scratchEnv = { ...process.env, DIRECT_URL: scratchUrl, ALLOW_DESTRUCTIVE: "1" };
  await runNpm(["run", "db:reset", "--", "--confirm", "RESET SUTRA DATABASE"], scratchEnv);
  await runNpm(["run", "db:restore", "--", "--file", backupPath], scratchEnv);
  await runNpm(["run", "db:verify-import"], scratchEnv);
  await runNpm(["run", "verify:parity"], scratchEnv);
  console.log("Backup round-trip passed on the configured scratch database.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
