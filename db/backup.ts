import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import postgres from "postgres";

import { backupTableOrder, type BackupTable } from "./ledger-tables";
import { requiredDirectUrl } from "./env";

type BackupPayload = {
  format: "sutra-ledger-backup-v1";
  createdAt: string;
  tables: Record<BackupTable, unknown[]>;
};

async function main() {
  const client = postgres(requiredDirectUrl(), { max: 1, prepare: false });
  try {
    const tables = {} as BackupPayload["tables"];
    for (const table of backupTableOrder) {
      tables[table] = await client.unsafe(`SELECT * FROM public."${table}" ORDER BY 1`);
    }
    const payload: BackupPayload = {
      format: "sutra-ledger-backup-v1",
      createdAt: new Date().toISOString(),
      tables,
    };
    const backupsDirectory = path.join(process.cwd(), "backups");
    await mkdir(backupsDirectory, { recursive: true });
    const destination = path.join(backupsDirectory, `sutra-ledger-${payload.createdAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
    await writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`Backup written: ${destination}`);
    for (const table of backupTableOrder) console.log(`  ${table}: ${payload.tables[table].length}`);
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
