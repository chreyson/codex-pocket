import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeThreadDetail, sanitizeThreadSummary } from "../src/transform.mjs";

const sampleThread = {
  id: "thread-1",
  name: "修复登录问题",
  preview: "帮我检查登录失败",
  cwd: "C:\\work\\sample-app",
  status: { type: "active", activeFlags: [] },
  source: { appServer: {} },
  createdAt: 100,
  updatedAt: 200,
  turns: [
    {
      id: "turn-1",
      status: "completed",
      startedAt: 101,
      items: [
        {
          id: "user-1",
          type: "userMessage",
          content: [{ type: "text", text: "检查登录流程" }],
        },
        {
          id: "agent-1",
          type: "agentMessage",
          text: "我会先读取认证模块。",
        },
        {
          id: "command-1",
          type: "commandExecution",
          command: "curl -H 'Authorization: Bearer secret-token' https://example.test",
          status: "completed",
          exitCode: 0,
          aggregatedOutput: "secret output that must not be exposed",
        },
        {
          id: "file-1",
          type: "fileChange",
          status: "completed",
          changes: [{ path: "C:\\work\\sample-app\\src\\auth.js", kind: { update: {} }, diff: "secret diff" }],
        },
      ],
    },
  ],
};

test("thread summary exposes useful metadata without the full cwd", () => {
  const summary = sanitizeThreadSummary(sampleThread);
  assert.equal(summary.project, "sample-app");
  assert.equal(summary.status, "active");
  assert.equal(summary.title, "修复登录问题");
  assert.equal("cwd" in summary, false);
});

test("thread detail keeps conversation and redacts raw tool output", () => {
  const detail = sanitizeThreadDetail(sampleThread);
  assert.deepEqual(detail.messages.map((message) => message.role), ["user", "assistant", "system", "system"]);
  assert.match(detail.messages[2].text, /^运行 curl/);
  assert.match(detail.messages[2].text, /Authorization: Bearer \[已隐藏\]/);
  assert.equal(detail.messages[2].activityType, "command");
  assert.doesNotMatch(JSON.stringify(detail), /secret-token/);
  assert.doesNotMatch(JSON.stringify(detail), /secret output/);
  assert.doesNotMatch(JSON.stringify(detail), /secret diff/);
  assert.match(detail.messages[3].text, /auth\.js/);
  assert.equal(detail.messages[3].activityType, "file");
  assert.doesNotMatch(detail.messages[3].text, /\[object Object\]/);
});

test("failed commands are not labeled as running", () => {
  const detail = sanitizeThreadDetail({
    ...sampleThread,
    turns: [{
      id: "turn-failed",
      status: "failed",
      items: [{ id: "command-failed", type: "commandExecution", status: "failed" }],
    }],
  });

  assert.match(detail.messages[0].text, /命令执行失败/);
  assert.doesNotMatch(detail.messages[0].text, /命令执行中/);
});
