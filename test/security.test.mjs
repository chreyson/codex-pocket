import assert from "node:assert/strict";
import test from "node:test";
import { createAccessToken, parseCookies, safeTokenEqual } from "../src/security.mjs";

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
