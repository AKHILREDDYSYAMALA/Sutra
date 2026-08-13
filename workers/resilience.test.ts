import assert from "node:assert/strict";
import test from "node:test";

import { FailureWindow, isRetryableNetworkError } from "./resilience";

test("network failures and 5xx responses are retryable while 404 is not", () => {
  assert.equal(isRetryableNetworkError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), true);
  assert.equal(isRetryableNetworkError(new Error("BSE retry exhausted", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) })), true);
  assert.equal(isRetryableNetworkError(Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" })), true);
  assert.equal(isRetryableNetworkError(Object.assign(new Error("upstream failure"), { status: 503 })), true);
  assert.equal(isRetryableNetworkError(Object.assign(new Error("missing"), { status: 404 })), false);
});

test("the unhandled-error window trips only after repeated near-term failures", () => {
  const window = new FailureWindow(5, 60_000);
  for (let index = 0; index < 4; index += 1) assert.equal(window.record(index * 1_000).tripped, false);
  assert.deepEqual(window.record(4_000), { count: 5, tripped: true });

  const recovered = new FailureWindow(5, 60_000);
  for (let index = 0; index < 4; index += 1) recovered.record(index * 1_000);
  assert.deepEqual(recovered.record(60_001), { count: 4, tripped: false });
});
