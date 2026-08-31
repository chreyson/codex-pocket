import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexDesktopBridge,
  discoverCodexAppPipePaths,
  encodeNativeFrame,
} from "../src/codex-desktop-bridge.mjs";


test("Windows pipe discovery keeps an explicit path first and removes duplicates", async () => {
  const paths = await discoverCodexAppPipePaths({
    env: { CODEX_APP_TOOLS_PIPE_PATH: "\\\\.\\pipe\\codex-browser-use-explicit" },
    platform: "win32",
    readdir: async () => [
      "unrelated-pipe",
      "codex-browser-use-explicit",
      "codex-browser-use-secondary",
    ],
  });

  assert.deepEqual(paths, [
    "\\\\.\\pipe\\codex-browser-use-explicit",
    "\\\\.\\pipe\\codex-browser-use-secondary",
  ]);
});

test("native frames use the Codex App four-byte length prefix", () => {
  const message = { id: 1, jsonrpc: "2.0", method: "tools/list", params: {} };
  const frame = encodeNativeFrame(message);
  assert.equal(frame.readUInt32LE(0), frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4).toString("utf8")), message);
});

test("desktop sending probes pipes and calls the App-owned thread tool", async () => {
  const calls = [];
  const bridge = new CodexDesktopBridge({
    discover: async () => ["bad-pipe", "desktop-pipe"],
    request: async (pipePath, method, params) => {
      calls.push({ pipePath, method, params });
      if (pipePath === "bad-pipe") throw Object.assign(new Error("closed"), { code: "ENOENT" });
      if (method === "tools/list") {
        return { tools: [{ name: "send_message_to_thread", namespace: "codex_app" }] };
      }
      return { success: true, contentItems: [{ type: "inputText", text: "sent" }] };
    },
  });

  const result = await bridge.sendMessage("thread-1", "继续执行");

  assert.equal(result.delivery, "codex-app");
  const toolCall = calls.find((call) => call.method === "tools/call");
  assert.equal(toolCall.pipePath, "desktop-pipe");
  assert.equal(toolCall.params.tool, "send_message_to_thread");
  assert.equal(toolCall.params.threadId, "thread-1");
  assert.deepEqual(toolCall.params.arguments, { threadId: "thread-1", prompt: "继续执行" });
});

test("desktop tool failures remain failures instead of falling back to a second writer", async () => {
  const bridge = new CodexDesktopBridge({
    discover: async () => ["desktop-pipe"],
    request: async (_pipePath, method) => method === "tools/list"
      ? { tools: [{ name: "send_message_to_thread", namespace: "codex_app" }] }
      : { success: false, contentItems: [{ type: "inputText", text: "thread is busy" }] },
  });

  await assert.rejects(
    bridge.sendMessage("thread-1", "继续执行"),
    (error) => error.code === "DESKTOP_SEND_FAILED" && error.message === "thread is busy",
  );
});
