const BSE_ANNOUNCEMENTS_URL = "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";
const BSE_SITE = "https://www.bseindia.com";
const BSE_ANNOUNCEMENTS_PAGE = `${BSE_SITE}/corporates/ann.html`;

export const BSE_MIN_REQUEST_INTERVAL_MS = 3_000;
export const BSE_MAX_REQUESTS_PER_RUN = 100;
export const BSE_MAX_CONSECUTIVE_FAILURES = 3;
export const BSE_MIN_POLL_INTERVAL_MS = 30 * 60 * 1_000;

const DEFAULT_BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

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

export class BseRequestError extends Error {
  readonly status: number | null;
  readonly attempts: number;

  constructor(message: string, input: { status?: number | null; attempts?: number } = {}) {
    super(message);
    this.name = "BseRequestError";
    this.status = input.status ?? null;
    this.attempts = input.attempts ?? 1;
  }
}

/** A block response is never retried or worked around. */
export class BseBlockedError extends BseRequestError {
  constructor(status: 403 | 429) {
    super(`BSE returned HTTP ${status}; source must remain disabled.`, { status });
    this.name = "BseBlockedError";
  }
}

export class BseRequestLimitError extends Error {
  constructor() {
    super(`BSE request cap of ${BSE_MAX_REQUESTS_PER_RUN} per run reached.`);
    this.name = "BseRequestLimitError";
  }
}

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

function setCookieValues(headers: Headers): string[] {
  const headersWithGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headersWithGetSetCookie.getSetCookie === "function") return headersWithGetSetCookie.getSetCookie();
  const combined = headers.get("set-cookie");
  // `Expires` contains a comma, so split only when the next token is a cookie pair.
  return combined ? combined.split(/,(?=\s*[^;,\s]+=[^;,]*)/) : [];
}

/**
 * Low-volume BSE adapter. It first loads the public announcements page and keeps
 * its cookies for the JSON call, matching the ordinary browser session flow.
 * A 403 or 429 is a hard stop, never something to route around.
 */
export class BseClient {
  private lastRequestAt = 0;
  private requestCount = 0;
  private sessionEstablished = false;
  private readonly cookies = new Map<string, string>();
  private readonly request: typeof fetch;
  private readonly minRequestIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly userAgent: string;

  constructor(options: BseClientOptions = {}) {
    this.request = options.fetch ?? fetch;
    // Callers may choose a slower rate or fewer retries, never a looser limit.
    this.minRequestIntervalMs = Math.max(BSE_MIN_REQUEST_INTERVAL_MS, options.minRequestIntervalMs ?? BSE_MIN_REQUEST_INTERVAL_MS);
    this.maxAttempts = Math.min(BSE_MAX_CONSECUTIVE_FAILURES, Math.max(1, options.maxAttempts ?? BSE_MAX_CONSECUTIVE_FAILURES));
    this.userAgent = options.userAgent ?? DEFAULT_BROWSER_USER_AGENT;
  }

  get requestsMade() {
    return this.requestCount;
  }

  async announcements(input: { scripCode: string; from: Date; to: Date; maxPages?: number }): Promise<Announcement[]> {
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
      if (pageRows.length === 0 || pageRows.length < 50 || (input.maxPages !== undefined && page >= input.maxPages)) break;
      page += 1;
    }
    return results;
  }

  private cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  private rememberCookies(response: Response) {
    for (const setCookie of setCookieValues(response.headers)) {
      const pair = setCookie.split(";", 1)[0];
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }

  private async waitForRequestSlot() {
    if (this.requestCount >= BSE_MAX_REQUESTS_PER_RUN) throw new BseRequestLimitError();
    const wait = this.minRequestIntervalMs - (Date.now() - this.lastRequestAt);
    if (wait > 0) await delay(wait);
    this.lastRequestAt = Date.now();
    this.requestCount += 1;
  }

  private async send(url: URL | string, headers: Record<string, string>) {
    await this.waitForRequestSlot();
    const response = await this.request(url, { headers });
    this.rememberCookies(response);
    return response;
  }

  private documentHeaders(): Record<string, string> {
    return {
      "user-agent": this.userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
    };
  }

  private xhrHeaders(): Record<string, string> {
    const cookie = this.cookieHeader();
    return {
      "user-agent": this.userAgent,
      accept: "application/json",
      "accept-language": "en-US,en;q=0.9",
      origin: BSE_SITE,
      referer: BSE_ANNOUNCEMENTS_PAGE,
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      ...(cookie ? { cookie } : {}),
    };
  }

  private errorForStatus(operation: string, status: number) {
    if (status === 403 || status === 429) return new BseBlockedError(status);
    return new BseRequestError(`${operation} HTTP ${status}.`, { status });
  }

  private async establishSession() {
    if (this.sessionEstablished) return;
    const response = await this.send(BSE_ANNOUNCEMENTS_PAGE, this.documentHeaders());
    if (response.status !== 200) throw this.errorForStatus("BSE announcements session", response.status);
    this.sessionEstablished = true;
  }

  private async requestPage(input: { scripCode: string; from: Date; to: Date; page: number }): Promise<BseResponse> {
    const url = new URL(BSE_ANNOUNCEMENTS_URL);
    url.search = new URLSearchParams({
      pageno: String(input.page), strCat: "-1", subcategory: "-1", strPrevDate: dateParam(input.from),
      strToDate: dateParam(input.to), strSearch: "P", strscrip: input.scripCode, strType: "C",
    }).toString();
    let lastError: BseRequestError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        await this.establishSession();
        const response = await this.send(url, this.xhrHeaders());
        if (response.status !== 200) throw this.errorForStatus("BSE announcements", response.status);
        const body: unknown = await response.json();
        if (!body || typeof body !== "object") throw new BseRequestError("BSE announcements response was not an object.");
        return body as BseResponse;
      } catch (error) {
        if (error instanceof BseBlockedError || error instanceof BseRequestLimitError) throw error;
        lastError = error instanceof BseRequestError ? error : new BseRequestError(String(error));
        if (attempt < this.maxAttempts) await delay(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
      }
    }
    throw new BseRequestError(`BSE announcements failed after ${this.maxAttempts} attempt(s): ${lastError?.message ?? "unknown error"}`, {
      status: lastError?.status,
      attempts: this.maxAttempts,
    });
  }
}
