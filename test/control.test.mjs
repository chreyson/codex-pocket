import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_MESSAGE_LENGTH,
  collectTrackedThreadIds,
  parseApprovalPayload,
  parseGoalPayload,
  parseMessagePayload,
  parseThreadCreatePayload,
  resolveMessageDispatch,
  sanitizeServerRequest,
} from "../src/control.mjs";

test("message payloads are trimmed and bounded", () => {
  assert.deepEqual(parseMessagePayload({ text: "  继\0续执行  " }), { text: "继续执行" });
  assert.throws(
    () => parseMessagePayload({ text: "x".repeat(MAX_MESSAGE_LENGTH + 1) }),
    (error) => error.status === 413,
  );
  assert.throws(() => parseMessagePayload({ text: "   " }), (error) => error.status === 400);
});

test("message payloads accept bounded Codex composer settings", () => {
  assert.deepEqual(parseMessagePayload({
    text: "  继续执行  ",
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "plan",
    skillNames: ["docs", "docs", "review"],
  }), {
    text: "继续执行",
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "plan",
    skillNames: ["docs", "review"],
  });
  assert.throws(
    () => parseMessagePayload({ text: "test", mode: "unrestricted" }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => parseMessagePayload({ text: "test", skillNames: Array(17).fill("docs") }),
    (error) => error.status === 400,
  );
});

test("message payloads accept image-only input and validate upload ids", () => {
  const first = `img_${"a".repeat(32)}`;
  const second = `img_${"b".repeat(32)}`;
  assert.deepEqual(parseMessagePayload({
    text: "",
    imageIds: [first, first, second],
    clientMessageId: "web-message-1",
  }), {
    text: "",
    imageIds: [first, second],
    clientMessageId: "web-message-1",
  });
  assert.throws(
    () => parseMessagePayload({ text: "", imageIds: ["../../secret.png"] }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => parseMessagePayload({
      text: "image flood",
      imageIds: Array.from({ length: 5 }, (_, index) => `img_${String(index).padStart(32, "0")}`),
    }),
    (error) => error.status === 400,
  );
});

test("message payloads validate waiting and Steer delivery metadata", () => {
  assert.deepEqual(parseMessagePayload({
    text: "先检查测试",
    action: "steer",
    expectedTurnId: "turn-42",
  }), {
    text: "先检查测试",
    action: "steer",
    expectedTurnId: "turn-42",
  });
  assert.deepEqual(parseMessagePayload({ text: "完成后继续", action: "queue" }), {
    text: "完成后继续",
    action: "queue",
  });
  assert.throws(
    () => parseMessagePayload({ text: "test", action: "interrupt" }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => parseMessagePayload({ text: "test", expectedTurnId: "" }),
    (error) => error.status === 400,
  );
});

test("new conversation payloads contain only a project thread id", () => {
  assert.deepEqual(parseThreadCreatePayload({ projectThreadId: " thread-1 " }), {
    projectThreadId: "thread-1",
  });
  assert.throws(
    () => parseThreadCreatePayload({ projectThreadId: "" }),
    (error) => error.status === 400,
  );
  assert.throws(
    () => parseThreadCreatePayload({ cwd: "C:\\secret\\project" }),
    (error) => error.status === 400,
  );
});

test("an idle thread is started even when its persisted status still says active", () => {
  assert.equal(resolveMessageDispatch("start", {
    status: "active",
    control: { busy: false },
  }), "start");
  assert.equal(resolveMessageDispatch("queue", {
    status: "active",
    control: { busy: false },
  }), "start");
  assert.equal(resolveMessageDispatch("queue", {
    status: "active",
    control: { busy: true },
  }), "queue");
  assert.equal(resolveMessageDispatch("steer", {
    control: { busy: true, turnId: "turn-1" },
  }), "steer");
  assert.throws(
    () => resolveMessageDispatch("start", { control: { busy: true, turnId: "turn-1" } }),
    (error) => error.status === 409 && error.code === "TURN_ACTIVE",
  );
  assert.throws(
    () => resolveMessageDispatch("steer", { control: { busy: false } }),
    (error) => error.status === 409 && error.code === "NO_ACTIVE_TURN",
  );
  assert.throws(
    () => resolveMessageDispatch("steer", { control: { busy: true, turnId: null } }),
    (error) => error.status === 409 && error.code === "TURN_STARTING",
  );
});

test("queued conversations remain tracked without a connected browser", () => {
  const clients = new Set([
    { threadId: "thread-visible" },
    { threadId: "thread-shared" },
    { threadId: "" },
  ]);
  assert.deepEqual(
    collectTrackedThreadIds(clients, ["thread-queued", "thread-shared", null]),
    ["thread-queued", "thread-shared", "thread-visible"],
  );
});

test("goal payloads require an objective or supported state transition", () => {
  assert.deepEqual(parseGoalPayload({ objective: "  完成交互对齐  " }), {
    objective: "完成交互对齐",
  });
  assert.deepEqual(parseGoalPayload({ status: "complete" }), { status: "complete" });
  assert.throws(() => parseGoalPayload({ status: "blocked" }), (error) => error.status === 400);
  assert.throws(() => parseGoalPayload({}), (error) => error.status === 400);
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

test("approval previews redact secrets and never expose full local paths", () => {
  const command = sanitizeServerRequest({
    token: "request-2",
    responding: false,
    message: {
      method: "item/commandExecution/requestApproval",
      params: {
        command: "curl -H 'Authorization: Bearer private' -H 'Cookie: session=cookie-secret' -H 'X-Api-Key: header-secret' https://example.test?token=query OPENAI_API_KEY=env-secret",
        reason: "uses password=reason-secret",
      },
    },
  });
  assert.doesNotMatch(command.detail, /private|cookie-secret|header-secret|query|env-secret/);
  assert.doesNotMatch(command.reason, /reason-secret/);
  assert.match(command.detail, /\[已隐藏\]/);

  const fileChange = sanitizeServerRequest({
    token: "request-3",
    responding: false,
    message: {
      method: "item/fileChange/requestApproval",
      params: { grantRoot: "C:\\Users\\private-user\\work\\sample-app" },
    },
  });
  assert.equal(fileChange.detail, "写入范围：sample-app");
  assert.doesNotMatch(fileChange.detail, /private-user/);
});
