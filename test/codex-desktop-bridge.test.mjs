import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  CodexDesktopBridge,
  discoverCodexAppPipePaths,
  encodeNativeFrame,
  requestNativePipe,
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

test("native pipe calls reject valid JSON that is not an RPC response", async () => {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.write = () => {
    const payload = Buffer.from("null", "utf8");
    const frame = Buffer.alloc(payload.length + 4);
    frame.writeUInt32LE(payload.length, 0);
    payload.copy(frame, 4);
    queueMicrotask(() => socket.emit("data", frame));
  };

  await assert.rejects(
    requestNativePipe("test-pipe", "tools/list", {}, {
      timeoutMs: 100,
      createConnection: () => {
        queueMicrotask(() => socket.emit("connect"));
        return socket;
      },
    }),
    (error) => error.code === "DESKTOP_BRIDGE_PROTOCOL",
  );
});

test("read-only desktop calls reconnect once after a timeout", async () => {
  let toolCalls = 0;
  let discoveries = 0;
  const payload = {
    schemaVersion: 1,
    thread: { id: "thread-1", status: { type: "idle" } },
    turns: [],
  };
  const bridge = new CodexDesktopBridge({
    discover: async () => {
      discoveries += 1;
      return ["desktop-pipe"];
    },
    request: async (_pipePath, method) => {
      if (method === "tools/list") {
        return {
          tools: [
            { name: "read_thread", namespace: "codex_app" },
          ],
        };
      }
      toolCalls += 1;
      if (toolCalls === 1) {
        throw Object.assign(new Error("stale pipe"), {
          code: "DESKTOP_BRIDGE_TIMEOUT",
        });
      }
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify(payload) }],
      };
    },
  });

  assert.deepEqual(await bridge.readThread("thread-1"), payload);
  assert.equal(toolCalls, 2);
  assert.equal(discoveries, 2);
});

test("desktop thread reads use the App-owned read tool and parse its JSON payload", async () => {
  const calls = [];
  const payload = {
    schemaVersion: 1,
    thread: { id: "thread-1", status: { type: "active" } },
    turns: [{ id: "turn-1", status: "inProgress", items: [] }],
  };
  const bridge = new CodexDesktopBridge({
    discover: async () => ["desktop-pipe"],
    request: async (_pipePath, method, params) => {
      calls.push({ method, params });
      if (method === "tools/list") {
        return {
          tools: [
            { name: "read_thread", namespace: "codex_app" },
          ],
        };
      }
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify(payload) }],
      };
    },
  });

  assert.deepEqual(await bridge.readThread("thread-1"), payload);
  const toolCall = calls.find((call) => call.method === "tools/call");
  assert.equal(toolCall.params.tool, "read_thread");
  assert.deepEqual(toolCall.params.arguments, {
    threadId: "thread-1",
    turnLimit: 2,
    includeOutputs: false,
    maxOutputCharsPerItem: 20_000,
  });
});

test("desktop discovery selects an endpoint that supports the requested tool", async () => {
  const calls = [];
  const payload = {
    schemaVersion: 1,
    thread: { id: "thread-1", status: { type: "idle" } },
    turns: [],
  };
  const bridge = new CodexDesktopBridge({
    discover: async () => ["list-only", "read-capable"],
    request: async (pipePath, method) => {
      calls.push({ pipePath, method });
      if (method === "tools/list") {
        return {
          tools: pipePath === "list-only"
            ? [{ name: "list_threads", namespace: "codex_app" }]
            : [{ name: "read_thread", namespace: "codex_app" }],
        };
      }
      return {
        success: true,
        contentItems: [{ type: "inputText", text: JSON.stringify(payload) }],
      };
    },
  });

  assert.deepEqual(await bridge.readThread("thread-1"), payload);
  assert.equal(
    calls.find((call) => call.method === "tools/call").pipePath,
    "read-capable",
  );
});

test("desktop follow-ups use the App-owned send tool with model and effort", async () => {
  const calls = [];
  const bridge = new CodexDesktopBridge({
    discover: async () => ["desktop-pipe"],
    request: async (_pipePath, method, params) => {
      calls.push({ method, params });
      if (method === "tools/list") {
        return {
          tools: [
            { name: "send_message_to_thread", namespace: "codex_app" },
          ],
        };
      }
      return { success: true, contentItems: [] };
    },
  });

  const result = await bridge.sendMessage("thread-1", "continue", {
    model: "gpt-test",
    effort: "high",
  });

  assert.equal(result.success, true);
  const toolCall = calls.find((call) => call.method === "tools/call");
  assert.equal(toolCall.params.tool, "send_message_to_thread");
  assert.deepEqual(toolCall.params.arguments, {
    threadId: "thread-1",
    prompt: "continue",
    model: "gpt-test",
    thinking: "high",
  });
});

test("desktop follow-ups are not retried after an ambiguous timeout", async () => {
  let toolCalls = 0;
  const bridge = new CodexDesktopBridge({
    discover: async () => ["desktop-pipe"],
    request: async (_pipePath, method) => {
      if (method === "tools/list") {
        return {
          tools: [
            { name: "send_message_to_thread", namespace: "codex_app" },
          ],
        };
      }
      toolCalls += 1;
      throw Object.assign(new Error("delivery result unknown"), {
        code: "DESKTOP_BRIDGE_TIMEOUT",
      });
    },
  });

  await assert.rejects(
    bridge.sendMessage("thread-1", "send once"),
    (error) => error.code === "DESKTOP_BRIDGE_DELIVERY_UNKNOWN"
      && /避免重复发送/.test(error.message),
  );
  assert.equal(toolCalls, 1);
});
