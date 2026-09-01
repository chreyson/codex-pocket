import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeDesktopThreadSnapshot,
  sanitizeThreadDetail,
  sanitizeThreadSummary,
} from "../src/transform.mjs";

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
  assert.deepEqual(detail.messages.map((message) => message.turnId), Array(4).fill("turn-1"));
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

test("desktop snapshots expose reasoning and restore chronological turn order", () => {
  const snapshot = sanitizeDesktopThreadSnapshot({
    thread: {
      id: "thread-1",
      title: "实时任务",
      cwd: "C:\\work\\sample-app",
      status: { type: "active" },
      updatedAt: 300,
    },
    page: { order: "newest_first" },
    turns: [
      {
        id: "turn-new",
        status: "inProgress",
        startedAt: 200,
        items: [{
          id: "reasoning-live",
          type: "reasoning",
          summary: ["**Inspecting realtime state**"],
        }],
      },
      {
        id: "turn-old",
        status: "completed",
        startedAt: 100,
        items: [{
          id: "answer-old",
          type: "agentMessage",
          text: "上一轮完成",
        }],
      },
    ],
  });

  assert.deepEqual(snapshot.messages.map((message) => message.id), [
    "answer-old",
    "reasoning-live",
  ]);
  assert.deepEqual(snapshot.messages.map((message) => message.turnId), ["turn-old", "turn-new"]);
  assert.equal(snapshot.messages[1].kind, "reasoning");
  assert.equal(snapshot.messages[1].text, "Inspecting realtime state");
  assert.equal(snapshot.messages[1].activityStatus, "inProgress");
  assert.equal(snapshot.title, "实时任务");
  assert.equal(snapshot.control.busy, true);
  assert.equal(snapshot.control.turnId, "turn-new");
  assert.equal(snapshot.partial, true);
});

test("malformed turn collections degrade without breaking the conversation", () => {
  assert.deepEqual(
    sanitizeThreadDetail({
      id: "thread-malformed",
      title: "Malformed",
      turns: [null, { id: "turn-1", items: { unexpected: true } }],
    }).messages,
    [],
  );
  assert.equal(sanitizeThreadSummary(null).title, "未命名会话");
});

test("malformed desktop records receive stable ids and safe timestamps", () => {
  const snapshot = sanitizeDesktopThreadSnapshot({
    thread: {
      id: "thread-malformed",
      title: "Malformed desktop thread",
      status: { type: "idle" },
      updatedAt: "not-a-timestamp",
    },
    turns: [
      null,
      {
        startedAt: "invalid",
        items: [
          null,
          { type: "userMessage", content: [{ type: "text", text: "hello" }] },
          { type: "agentMessage", text: "world" },
        ],
      },
    ],
  });

  assert.deepEqual(snapshot.messages.map((message) => message.id), [
    "turn-0-item-1",
    "turn-0-item-2",
  ]);
  assert.deepEqual(snapshot.messages.map((message) => message.timestamp), [null, null]);
  assert.equal(snapshot.updatedAt, 0);
  assert.equal(snapshot.control.busy, false);
});

test("a stale active thread status without a running turn stays idle", () => {
  const snapshot = sanitizeDesktopThreadSnapshot({
    thread: {
      id: "thread-stale-active",
      status: { type: "active" },
    },
    turns: [{ id: "turn-complete", status: "completed", items: [] }],
  });

  assert.equal(snapshot.control.busy, false);
  assert.equal(snapshot.control.turnId, null);
});

test("thread detail exposes safe image descriptors without local paths", () => {
  const sources = [];
  const detail = sanitizeThreadDetail({
    id: "thread-images",
    cwd: "C:\\work\\sample-app",
    turns: [{
      id: "turn-images",
      status: "completed",
      items: [
        {
          id: "user-images",
          clientId: "web-image-message",
          type: "userMessage",
          content: [
            { type: "localImage", path: "C:\\private\\camera.png" },
            { type: "text", text: "检查这张图" },
          ],
        },
        {
          id: "agent-images",
          type: "agentMessage",
          text: "结果如下\n![预览](C:\\private\\result.png)",
        },
        { id: "view-image", type: "imageView", path: "C:\\private\\view.png" },
        {
          id: "generated-image",
          type: "imageGeneration",
          result: "generated-base64",
          revisedPrompt: "生成预览",
        },
      ],
    }],
  }, {
    resolveImage(source) {
      sources.push(source);
      return {
        src: `/api/images/asset_${String(sources.length).padStart(32, "0")}`,
        alt: source.alt,
      };
    },
  });

  assert.equal(detail.messages.length, 4);
  assert.equal(detail.messages[0].clientId, "web-image-message");
  assert.equal(detail.messages[0].text, "检查这张图");
  assert.equal(detail.messages[0].images.length, 1);
  assert.equal(detail.messages[1].text, "结果如下");
  assert.equal(detail.messages[1].images.length, 1);
  assert.equal(detail.messages[2].kind, "image");
  assert.equal(detail.messages[3].kind, "image");
  assert.deepEqual(sources.map((source) => source.type), ["local", "local", "local", "data"]);
  assert.doesNotMatch(JSON.stringify(detail), /C:\\\\private/);
});
