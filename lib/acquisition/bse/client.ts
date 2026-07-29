const BSE_ANNOUNCEMENTS_URL = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const BSE_SITE = "https://www.bseindia.com";

export type Announcement = {
  bseAnnouncementId: string;
  scripCode: string;
  companyName: string;
  headline: string;
  category: string | null;
  subCategory: string | null;
  announcementDate: Date;
  attachmentUrl: string | null;
  rawPayload: Record<string, unknown>;
};

type BseResponse = { Table?: unknown; Table1?: unknown };
export type BseClientOptions = {
  fetch?: typeof fetch;
  minRequestIntervalMs?: number;
  maxAttempts?: number;
  userAgent?: string;
};

function requiredString(value: unknown, field: string) {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`BSE announcement is missing ${field}.`);
  const text = String(value).trim();
  if (!text) throw new Error(`BSE announcement has an empty ${field}.`);
  return text;
}

function stringValue(raw: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return null;
}

function parseDate(raw: Record<string, unknown>) {
  const value = stringValue(raw, "DissemDT", "ANNOUNCEMENT_DATE", "NEWS_DT", "NEWS_DATE", "DT_TM");
  if (!value) throw new Error("BSE announcement is missing its announcement date.");
  const normalized = /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00+05:30`
    : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) throw new Error(`BSE announcement has an invalid announcement date: ${value}.`);
  return date;
}

function attachmentUrl(raw: Record<string, unknown>) {
  const value = stringValue(raw, "ATTACHMENTURL", "ATTACHMENT_URL", "ATTACHMENTNAME", "ATTACHMENT");
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return new URL(value, BSE_SITE).toString();
  return new URL(`/xml-data/corpfiling/AttachLive/${value}`, BSE_SITE).toString();
}

/** The single payload boundary: unknown BSE JSON becomes a typed internal announcement here. */
export function parseAnnouncement(payload: unknown): Announcement {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("BSE announcement must be an object.");
  const rawPayload = payload as Record<string, unknown>;
  return {
    bseAnnouncementId: requiredString(stringValue(rawPayload, "NEWSID", "NEWS_ID", "ANNOUNCEMENT_ID", "ID"), "announcement id"),
    scripCode: requiredString(stringValue(rawPayload, "SCRIP_CD", "SCRIPCODE", "SCRIP_CODE"), "scrip code"),
    companyName: requiredString(stringValue(rawPayload, "SLONGNAME", "SCRIP_NAME", "COMPANYNAME", "COMPANY_NAME"), "company name"),
    headline: requiredString(stringValue(rawPayload, "NEWSSUB", "HEADLINE", "SUBJECT", "NEWS_SUBJECT"), "headline"),
    category: stringValue(rawPayload, "CATEGORYNAME", "CATEGORY", "NEWS_CATEGORY"),
    subCategory: stringValue(rawPayload, "SUBCATNAME", "SUBCATEGORY", "SUB_CATEGORY"),
    announcementDate: parseDate(rawPayload),
    attachmentUrl: attachmentUrl(rawPayload),
    rawPayload,
  };
}

function dateParam(date: Date) {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Conservative, stateful client for BSE's undocumented website endpoint. */
export class BseClient {
  private lastRequestAt = 0;
  private readonly request: typeof fetch;
  private readonly minRequestIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly userAgent: string;

  constructor(options: BseClientOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 3_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.userAgent = options.userAgent ?? "Sutra BSE watcher/1.0 (+https://github.com/AKHILREDDYSYAMALA/Sutra)";
  }

  async announcements(input: { scripCode: string; from: Date; to: Date }): Promise<Announcement[]> {
    const results: Announcement[] = [];
    let page = 1;
    let total = Number.POSITIVE_INFINITY;
    while (results.length < total) {
      const response = await this.requestPage({ ...input, page });
      const rows = Array.isArray(response.Table) ? response.Table : [];
      const pageRows = rows.map(parseAnnouncement);
      results.push(...pageRows);
      const count = Array.isArray(response.Table1) && response.Table1[0] && typeof response.Table1[0] === "object"
        ? Number((response.Table1[0] as Record<string, unknown>).ROWCNT)
        : Number.NaN;
      total = Number.isFinite(count) ? count : results.length;
      if (pageRows.length === 0 || pageRows.length < 50) break;
      page += 1;
    }
    return results;
  }

  private async requestPage(input: { scripCode: string; from: Date; to: Date; page: number }): Promise<BseResponse> {
    const url = new URL(BSE_ANNOUNCEMENTS_URL);
    url.search = new URLSearchParams({
      pageno: String(input.page), strCat: "-1", subcategory: "-1", strPrevDate: dateParam(input.from),
      strToDate: dateParam(input.to), strSearch: "P", strscrip: input.scripCode, strType: "C",
    }).toString();
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const wait = this.minRequestIntervalMs - (Date.now() - this.lastRequestAt);
      if (wait > 0) await delay(wait);
      this.lastRequestAt = Date.now();
      try {
        const response = await this.request(url, {
          headers: {
            "user-agent": this.userAgent,
            accept: "application/json, text/plain, */*",
            "accept-language": "en-US,en;q=0.5",
            origin: BSE_SITE,
            referer: `${BSE_SITE}/corporates/ann.html`,
          },
        });
        if (!response.ok) throw new Error(`BSE announcements HTTP ${response.status}.`);
        const body: unknown = await response.json();
        if (!body || typeof body !== "object") throw new Error("BSE announcements response was not an object.");
        return body as BseResponse;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt < this.maxAttempts) await delay(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
      }
    }
    throw new Error(`BSE announcements failed after ${this.maxAttempts} attempt(s): ${lastError?.message ?? "unknown error"}`);
  }
}

export const BSE_MIN_POLL_INTERVAL_MS = 15 * 60 * 1_000;
