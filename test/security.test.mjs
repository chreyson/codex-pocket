import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccessToken,
  FixedWindowRateLimiter,
  normalizeAccessToken,
  parseCookies,
  requestToken,
  safeTokenEqual,
} from "../src/security.mjs";

test("access tokens are high entropy and URL-safe", () => {
  const token = createAccessToken();
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
});

test("token comparison accepts only an exact match", () => {
  assert.equal(safeTokenEqual("correct", "correct"), true);
  assert.equal(safeTokenEqual("correct", "incorrect"), false);
  assert.equal(safeTokenEqual("", "correct"), false);
});

test("cookie parser preserves values after the first equals sign", () => {
  assert.deepEqual(parseCookies("a=1; session=abc%3D123"), { a: "1", session: "abc=123" });
});

test("access token normalization rejects non-strings and trims persisted values", () => {
  assert.equal(normalizeAccessToken("  sample-token\n"), "sample-token");
  assert.equal(normalizeAccessToken(null), "");
  assert.equal(normalizeAccessToken({ token: "unexpected" }), "");
});

test("malformed cookies are ignored and bearer authentication is case-insensitive", () => {
  assert.deepEqual(parseCookies("broken=%E0%A4%A; valid=ok"), { valid: "ok" });
  assert.equal(requestToken({
    headers: { authorization: "bearer sample-token", cookie: "" },
  }), "sample-token");
});

test("fixed-window limiting is bounded and resets expired clients", () => {
  let now = 1_000;
  const limiter = new FixedWindowRateLimiter({
    limit: 2,
    windowMs: 100,
    maxEntries: 2,
    now: () => now,
  });

  assert.equal(limiter.allow("client-a"), true);
  assert.equal(limiter.allow("client-a"), true);
  assert.equal(limiter.allow("client-a"), false);
  assert.equal(limiter.allow("client-b"), true);
  assert.equal(limiter.allow("client-c"), false);
  assert.equal(limiter.attempts.size, 2);

  now += 100;
  assert.equal(limiter.allow("client-c"), true);
  assert.equal(limiter.attempts.size, 1);
});
