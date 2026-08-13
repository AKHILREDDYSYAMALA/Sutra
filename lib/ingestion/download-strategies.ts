import path from "node:path";

import { getBseClient, type BseClient } from "@/lib/acquisition/bse/client";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export type DownloadSource = "bse" | "nse" | "crisil" | "icra" | "care" | "india_ratings" | "user_upload" | "manual";
export type PdfInput = { bytes: Buffer; title: string; url: string | null };
export type DownloadResponse = { response: Response; url: string };

export type DownloadStrategy = {
  id: "default" | "bse";
  fetch: (input: { url: string; signal: AbortSignal }) => Promise<DownloadResponse>;
};

export type DownloadStrategyRegistry = ReadonlyMap<DownloadSource, DownloadStrategy>;

/** A permanent HTTP response from a document host, distinct from a socket failure. */
export class DownloadHttpError extends Error {
  constructor(readonly status: number) {
    super(`Download failed with HTTP ${status}.`);
    this.name = "DownloadHttpError";
  }
}

function assertPdf(bytes: Buffer) {
  if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) throw new Error("PDF must be non-empty and no larger than 10MB.");
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("The source is not a PDF.");
}

export function defaultDownloadStrategy(fetchImplementation: typeof fetch = fetch): DownloadStrategy {
  return {
    id: "default",
    fetch: async ({ url, signal }) => ({
      response: await fetchImplementation(url, {
        signal,
        headers: { "user-agent": "Sutra document ingestion/1.0 (+https://sutra.local)" },
        redirect: "follow",
      }),
      url,
    }),
  };
}

export function bseDownloadStrategy(client: BseClient = getBseClient()): DownloadStrategy {
  return {
    id: "bse",
    fetch: ({ url, signal }) => client.downloadAttachmentWithPath(url, { signal }),
  };
}

/** Source-specific networking stays at this boundary; the default is plain fetch. */
export function createDownloadStrategyRegistry(input: { bseClient?: BseClient } = {}): DownloadStrategyRegistry {
  return new Map([["bse", bseDownloadStrategy(input.bseClient)]]);
}

export function strategyForSource(
  source: DownloadSource,
  registry: DownloadStrategyRegistry = createDownloadStrategyRegistry(),
  fallback: DownloadStrategy = defaultDownloadStrategy(),
) {
  return registry.get(source) ?? fallback;
}

async function readPdfResponse(download: DownloadResponse): Promise<PdfInput> {
  const { response, url } = download;
  if (!response.ok) throw new DownloadHttpError(response.status);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/pdf")) throw new Error(`Expected application/pdf, received ${contentType || "no content type"}.`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_FILE_BYTES) throw new Error("PDF is larger than 10MB.");
  if (!response.body) throw new Error("Download returned no response body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    length += value.byteLength;
    if (length > MAX_FILE_BYTES) {
      await reader.cancel();
      throw new Error("PDF is larger than 10MB.");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks);
  assertPdf(bytes);
  const disposition = response.headers.get("content-disposition") ?? "";
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(disposition)?.[1];
  return { bytes, title: decodeURIComponent(named ?? (path.basename(new URL(url).pathname) || "Untitled PDF")), url };
}

export async function downloadPdfForSource(input: {
  source: DownloadSource;
  url: string;
  registry?: DownloadStrategyRegistry;
  fallback?: DownloadStrategy;
}): Promise<PdfInput> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const strategy = strategyForSource(input.source, input.registry, input.fallback);
    return await readPdfResponse(await strategy.fetch({ url: input.url, signal: controller.signal }));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Download timed out after 30 seconds.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function assertPdfInput(bytes: Buffer) {
  assertPdf(bytes);
}
