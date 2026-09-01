import assert from "node:assert/strict";
import test from "node:test";

import { boundedInteger, loopbackHost } from "../src/runtime-config.mjs";


test("bounded integer settings reject invalid values and clamp valid ranges", () => {
  const options = { min: 100, max: 5_000 };

  assert.equal(boundedInteger(undefined, 1_200, options), 1_200);
  assert.equal(boundedInteger("  ", 1_200, options), 1_200);
  assert.equal(boundedInteger("not-a-number", 1_200, options), 1_200);
  assert.equal(boundedInteger("250.9", 1_200, options), 250);
  assert.equal(boundedInteger("1", 1_200, options), 100);
  assert.equal(boundedInteger("999999", 1_200, options), 5_000);
});

test("server hosts are constrained to loopback interfaces", () => {
  assert.equal(loopbackHost("localhost"), "localhost");
  assert.equal(loopbackHost("::1"), "::1");
  assert.equal(loopbackHost("0.0.0.0"), "127.0.0.1");
  assert.equal(loopbackHost("example.com"), "127.0.0.1");
});
