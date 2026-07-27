import { readFile } from "node:fs/promises";

import postgres from "postgres";

import { backupTableOrder, type BackupTable } from "./ledger-tables";
import { requiredDirectUrl } from "./env";

type BackupPayload = {
  format: "sutra-ledger-backup-v1";
  createdAt: string;
  tables: Record<BackupTable, unknown[]>;
};

function requiredFile() {
  const index = process.argv.indexOf("--file");
  const file = index === -1 ? undefined : process.argv[index + 1];
  if (!file || file.startsWith("--")) throw new Error("Usage: npm run db:restore -- --file <path/to/backup.json>");
  return file;
}

function parseBackup(value: unknown): BackupPayload {
  if (!value || typeof value !== "object") throw new Error("Backup is not a JSON object.");
  const backup = value as Partial<BackupPayload>;
  if (backup.format !== "sutra-ledger-backup-v1" || !backup.tables || typeof backup.tables !== "object") {
    throw new Error("This is not a Sutra ledger backup.");
  }
  for (const table of backupTableOrder) {
    if (!Array.isArray(backup.tables[table])) throw new Error(`Backup is missing table '${table}'.`);
  }
  return backup as BackupPayload;
}

async function main() {
  const payload = parseBackup(JSON.parse(await readFile(requiredFile(), "utf8")));
  const client = postgres(requiredDirectUrl(), { max: 1, prepare: false });
  try {
    const [existingClaims] = await client.unsafe<{ count: number }[]>("SELECT count(*)::int AS count FROM public.\"claims\"");
    if ((existingClaims?.count ?? 0) > 0) {
      throw new Error("Refusing to restore: claims exist. Restore only runs against an empty database.");
    }
    for (const table of backupTableOrder.filter((table) => table !== "claims")) {
      const [count] = await client.unsafe<{ count: number }[]>(`SELECT count(*)::int AS count FROM public."${table}"`);
      if ((count?.count ?? 0) > 0) {
        throw new Error(`Refusing to restore: ${table} already has rows. Restore only runs against an empty database.`);
      }
    }

    await client.begin(async (transaction) => {
      for (const table of backupTableOrder) {
        const rows = payload.tables[table];
        if (rows.length === 0) continue;
        await transaction.unsafe(
          `INSERT INTO public."${table}" SELECT * FROM jsonb_populate_recordset(NULL::public."${table}", $1::jsonb)`,
          [JSON.stringify(rows)],
        );
      }
    });
    console.log(`Restored ${payload.createdAt} into an empty database.`);
    for (const table of backupTableOrder) console.log(`  ${table}: ${payload.tables[table].length}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
