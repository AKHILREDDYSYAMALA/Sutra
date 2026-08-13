const retryableNetworkCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

type ErrorLike = { code?: unknown; status?: unknown; message?: unknown; cause?: unknown };

function errorLike(value: unknown): value is ErrorLike {
  return Boolean(value) && typeof value === "object";
}

export function errorCode(error: unknown): string | null {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!errorLike(current)) return null;
    if (typeof current.code === "string") return current.code;
    current = current.cause;
  }
  return null;
}

/** Socket failures and 5xx responses are transient; a 404 remains permanent. */
export function isRetryableNetworkError(error: unknown) {
  const code = errorCode(error);
  if (code && retryableNetworkCodes.has(code)) return true;
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!errorLike(current)) break;
    if (typeof current.status === "number" && current.status >= 500 && current.status <= 599) return true;
    if (typeof current.message === "string" && /socket hang up/i.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

export class FailureWindow {
  private readonly timestamps: number[] = [];

  constructor(private readonly limit = 5, private readonly windowMs = 60_000) {}

  record(now = Date.now()) {
    this.timestamps.push(now);
    while (this.timestamps[0] !== undefined && this.timestamps[0]! <= now - this.windowMs) this.timestamps.shift();
    return { count: this.timestamps.length, tripped: this.timestamps.length >= this.limit };
  }
}
