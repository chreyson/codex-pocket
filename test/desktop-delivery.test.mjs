import assert from "node:assert/strict";
import test from "node:test";

import {
  sendDesktopTurn,
  startTurnWithDesktopFallback,
} from "../src/desktop-delivery.mjs";

function desktopThread(turns = []) {
  return {
    schemaVersion: 1,
    thread: { id: "thread-1", status: { type: "active" } },
    turns,
  };
}

test("App Server starts remain the primary delivery path", async () => {
  const expected = { turn: { id: "turn-app-server" } };
  const codex = { startTurn: async () => expected };
  const desktopBridge = {
    readThread: async () => assert.fail("desktop fallback should not be inspected"),
  };

  assert.deepEqual(await startTurnWithDesktopFallback({
    codex,
    desktopBridge,
    threadId: "thread-1",
    text: "continue",
  }), {
    delivery: "app-server",
    result: expected,
  });
});

test("an idle Desktop writer receives the follow-up through the native app tool", async () => {
  const calls = [];
  const conflict = new Error("thread already has an active writer");
  const codex = { startTurn: async () => { throw conflict; } };
  const desktopResult = { success: true };
  const desktopBridge = {
    readThread: async () => desktopThread([
      { id: "turn-complete", status: "completed", items: [] },
    ]),
    sendMessage: async (...args) => {
      calls.push(args);
      return desktopResult;
    },
  };

  const result = await startTurnWithDesktopFallback({
    codex,
    desktopBridge,
    threadId: "thread-1",
    text: "continue",
    options: {
      model: "gpt-test",
      effort: "high",
      mode: "default",
      skills: [{ name: "browser", path: "C:\\skills\\browser" }],
    },
  });

  assert.deepEqual(result, { delivery: "codex-app", result: desktopResult });
  assert.deepEqual(calls, [[
    "thread-1",
    "$browser\ncontinue",
    { model: "gpt-test", effort: "high" },
  ]]);
});

test("a genuinely running Desktop turn is not started a second time", async () => {
  let sends = 0;
  const desktopBridge = {
    readThread: async () => desktopThread([
      { id: "turn-running", status: "inProgress", items: [] },
    ]),
    sendMessage: async () => { sends += 1; },
  };

  await assert.rejects(
    sendDesktopTurn({ desktopBridge, threadId: "thread-1", text: "duplicate" }),
    (error) => error.code === "TURN_ACTIVE" && error.status === 409,
  );
  assert.equal(sends, 0);
});

test("Desktop fallback rejects inputs the native follow-up tool cannot preserve", async (t) => {
  for (const [name, options, pattern] of [
    ["images", { images: [{ path: "screen.png" }] }, /图片/],
    ["plan mode", { mode: "plan" }, /计划模式/],
  ]) {
    await t.test(name, async () => {
      const desktopBridge = {
        readThread: async () => desktopThread(),
        sendMessage: async () => assert.fail("unsupported input must not be sent"),
      };
      await assert.rejects(
        sendDesktopTurn({
          desktopBridge,
          threadId: "thread-1",
          text: "continue",
          options,
        }),
        (error) => error.code === "DESKTOP_DELIVERY_UNSUPPORTED"
          && error.status === 409
          && pattern.test(error.message),
      );
    });
  }
});

test("unrelated App Server failures do not fall back to Desktop", async () => {
  const expected = new Error("App Server is unavailable");
  const codex = { startTurn: async () => { throw expected; } };
  const desktopBridge = {
    readThread: async () => assert.fail("unrelated failures must not use Desktop"),
  };

  await assert.rejects(
    startTurnWithDesktopFallback({
      codex,
      desktopBridge,
      threadId: "thread-1",
      text: "continue",
    }),
    (error) => error === expected,
  );
});
