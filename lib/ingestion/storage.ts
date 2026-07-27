const DOCUMENTS_BUCKET = "documents";

type StorageConfig = { url: string; serviceRoleKey: string };

function storageConfig(): StorageConfig {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the private documents storage bucket.");
  }
  return { url, serviceRoleKey };
}

function objectPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function headers(config: StorageConfig) {
  return { authorization: `Bearer ${config.serviceRoleKey}`, apikey: config.serviceRoleKey };
}

async function assertResponse(response: Response, operation: string, options: { duplicateIsSuccess?: boolean } = {}) {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  // Some Supabase Storage deployments wrap the underlying 409 in an HTTP 400.
  // A pre-existing private bucket/object is idempotent success, never an ingest error.
  if (options.duplicateIsSuccess && (response.status === 409 || /\bduplicate\b|already exists|statusCode\D*409/i.test(body))) return;
  throw new Error(`Supabase Storage ${operation} failed (${response.status}): ${body.slice(0, 300)}`);
}

async function ensureDocumentsBucket(config: StorageConfig) {
  const existing = await fetch(`${config.url}/storage/v1/bucket/${encodeURIComponent(DOCUMENTS_BUCKET)}`, {
    headers: headers(config),
  });
  if (existing.ok) return;
  if (existing.status !== 404) await assertResponse(existing, "bucket lookup");

  const response = await fetch(`${config.url}/storage/v1/bucket`, {
    method: "POST",
    headers: { ...headers(config), "content-type": "application/json" },
    body: JSON.stringify({ id: DOCUMENTS_BUCKET, name: DOCUMENTS_BUCKET, public: false }),
  });
  await assertResponse(response, "bucket creation", { duplicateIsSuccess: true });
}

/** Stores raw source PDFs privately. The stable hash path keeps retries idempotent. */
export async function uploadDocumentPdf(sha256: string, bytes: Buffer) {
  const config = storageConfig();
  await ensureDocumentsBucket(config);
  const path = `${sha256}.pdf`;
  const response = await fetch(`${config.url}/storage/v1/object/${DOCUMENTS_BUCKET}/${objectPath(path)}`, {
    method: "POST",
    headers: { ...headers(config), "content-type": "application/pdf", "x-upsert": "false" },
    body: bytes as unknown as BodyInit,
  });
  await assertResponse(response, "object upload", { duplicateIsSuccess: true });
  return path;
}

/** Reads an existing private raw PDF so an explicit retry does not need a new upload. */
export async function downloadDocumentPdf(storagePath: string): Promise<Buffer> {
  const config = storageConfig();
  const response = await fetch(`${config.url}/storage/v1/object/${DOCUMENTS_BUCKET}/${objectPath(storagePath)}`, {
    headers: headers(config),
  });
  await assertResponse(response, "object download");
  return Buffer.from(await response.arrayBuffer());
}

/** Generates a short-lived URL for the private review screen; never expose a public bucket. */
export async function createDocumentSignedUrl(storagePath: string, expiresIn = 5 * 60): Promise<string> {
  const config = storageConfig();
  const response = await fetch(`${config.url}/storage/v1/object/sign/${DOCUMENTS_BUCKET}/${objectPath(storagePath)}`, {
    method: "POST",
    headers: { ...headers(config), "content-type": "application/json" },
    body: JSON.stringify({ expiresIn }),
  });
  await assertResponse(response, "signed URL creation");
  const payload = await response.json() as { signedURL?: string; signedUrl?: string };
  const signedPath = payload.signedURL ?? payload.signedUrl;
  if (!signedPath) throw new Error("Supabase Storage did not return a signed URL.");
  return signedPath.startsWith("http") ? signedPath : `${config.url}/storage/v1${signedPath}`;
}
