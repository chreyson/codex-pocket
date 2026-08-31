import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MESSAGE_LENGTH,
  parseApprovalPayload,
  parseMessagePayload,
  sanitizeServerRequest,
} from "../src/control.mjs";

test("message payloads are trimmed and bounded", () => {
  assert.deepEqual(parseMessagePayload({ text: "  继续执行  " }), { text: "继续执行" });
  assert.throws(
    () => parseMessagePayload({ text: "x".repeat(MAX_MESSAGE_LENGTH + 1) }),
    (error) => error.status === 413,
  );
  assert.throws(() => parseMessagePayload({ text: "   " }), (error) => error.status === 400);
});

test("approval payloads only accept documented decisions", () => {
  assert.deepEqual(parseApprovalPayload({ decision: "accept" }), { decision: "accept" });
  assert.throws(
    () => parseApprovalPayload({ decision: "alwaysAllowEverything" }),
    (error) => error.status === 400,
  );
});

test("approval requests expose only the information needed by mobile UI", () => {
  const request = sanitizeServerRequest({
    token: "request-1",
    responding: false,
    message: {
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        cwd: "C:\\work\\sample-app",
        command: "npm test",
        reason: "需要验证修改",
      },
    },
  });

  assert.equal(request.type, "command");
  assert.equal(request.project, "sample-app");
  assert.equal(request.detail, "npm test");
  assert.equal("threadId" in request, false);
});
