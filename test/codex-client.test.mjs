import assert from "node:assert/strict";
import test from "node:test";

import { CodexAppServer } from "../src/codex-client.mjs";


test("thread listing uses the App Server interactive-source default", async () => {
  const client = new CodexAppServer();
  let captured;
  client.start = async () => {};
  client.request = async (method, params) => {
    captured = { method, params };
    return { data: [] };
  };

  await client.listThreads({ limit: 12 });

  assert.equal(captured.method, "thread/list");
  assert.equal(captured.params.limit, 12);
  assert.equal(captured.params.sourceKinds, undefined);
  assert.equal(captured.params.sortKey, "updated_at");
});

test("starting a turn resumes the thread and sends text input", async () => {
  const client = new CodexAppServer();
  const calls = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") return { thread: { id: "thread-1", turns: [] } };
    return { turn: { id: "turn-1", status: "inProgress" } };
  };

  const result = await client.startTurn("thread-1", "运行测试");

  assert.equal(result.turn.id, "turn-1");
  assert.deepEqual(calls.map((call) => call.method), ["thread/resume", "turn/start"]);
  assert.deepEqual(calls[1].params.input, [{ type: "text", text: "运行测试" }]);
  assert.equal(client.threadControlState("thread-1").busy, true);

  client._handleLine(JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  }));
  assert.equal(client.threadControlState("thread-1").busy, false);
});

test("a second turn is rejected while the thread is active", async () => {
  const client = new CodexAppServer();
  client.activeTurns.set("thread-1", "turn-1");

  await assert.rejects(
    client.startTurn("thread-1", "重复消息"),
    (error) => error.code === "TURN_ACTIVE",
  );
});

test("server approval requests can be listed and resolved", () => {
  const client = new CodexAppServer();
  let written;
  client._write = (message) => {
    written = message;
  };

  client._handleLine(JSON.stringify({
    id: 41,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1" },
  }));

  const [request] = client.pendingServerRequests("thread-1");
  assert.equal(request.message.id, 41);
  client.respondToServerRequest(request.token, { decision: "accept" });
  assert.deepEqual(written, { id: 41, result: { decision: "accept" } });
  assert.equal(request.responding, true);

  client._handleLine(JSON.stringify({
    method: "serverRequest/resolved",
    params: { requestId: 41, threadId: "thread-1" },
  }));
  assert.equal(client.pendingServerRequests("thread-1").length, 0);
});

test("agent message notifications are tracked and emitted as a live stream", () => {
  const client = new CodexAppServer();
  const events = [];
  client.on("messageStart", (value) => events.push({ event: "messageStart", value }));
  client.on("messageDelta", (value) => events.push({ event: "messageDelta", value }));
  client.on("messageDone", (value) => events.push({ event: "messageDone", value }));

  client._handleLine(JSON.stringify({
    method: "item/started",
    emittedAtMs: 1_700_000_000_000,
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 1_700_000_001_000,
      item: { id: "item-1", type: "agentMessage", phase: "commentary", text: "先" },
    },
  }));
  client._handleLine(JSON.stringify({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "检查" },
  }));
  client._handleLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 1_700_000_002_000,
      item: { id: "item-1", type: "agentMessage", phase: "commentary", text: "先检查完成" },
    },
  }));

  assert.deepEqual(events, [
    {
      event: "messageStart",
      value: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        kind: "commentary",
        text: "先",
        timestamp: 1_700_000_001,
      },
    },
    {
      event: "messageDelta",
      value: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "检查",
      },
    },
    {
      event: "messageDone",
      value: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        kind: "commentary",
        text: "先检查完成",
        timestamp: 1_700_000_001,
      },
    },
  ]);
  assert.deepEqual(client.liveAgentMessagesForThread("thread-1"), [events.at(-1)]);
});

test("live message replay survives reconnects until a complete snapshot is confirmed", () => {
  const client = new CodexAppServer();
  client._handleLine(JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      startedAtMs: 2_000,
      item: { id: "live-item", type: "agentMessage", phase: "final_answer", text: "流" },
    },
  }));
  client._handleLine(JSON.stringify({
    method: "item/agentMessage/delta",
    params: { threadId: "thread-1", turnId: "turn-1", itemId: "live-item", delta: "式" },
  }));

  assert.deepEqual(client.liveAgentMessagesForThread("thread-1"), [{
    event: "messageStart",
    value: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "live-item",
      kind: "message",
      text: "流式",
      timestamp: 2,
    },
  }]);
  assert.equal(client.confirmLiveAgentMessageSnapshot("thread-1", [{
    id: "live-item", role: "assistant", text: "流式",
  }]), 0);

  client._handleLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      completedAtMs: 3_000,
      item: { id: "live-item", type: "agentMessage", phase: "final_answer", text: "流式完成" },
    },
  }));

  assert.equal(client.confirmLiveAgentMessageSnapshot("thread-1", [{
    id: "live-item", role: "assistant", text: "旧快照",
  }]), 0);
  assert.equal(client.liveAgentMessagesForThread("thread-1")[0].event, "messageDone");
  assert.equal(client.confirmLiveAgentMessageSnapshot("thread-1", [{
    id: "live-item", role: "assistant", text: "流式完成",
  }]), 1);
  assert.deepEqual(client.liveAgentMessagesForThread("thread-1"), []);
});

test("reasoning and tool notifications never enter the live message cache", () => {
  const client = new CodexAppServer();
  const events = [];
  client.on("messageStart", (value) => events.push(value));
  client.on("messageDelta", (value) => events.push(value));
  client.on("messageDone", (value) => events.push(value));

  for (const message of [
    {
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        startedAtMs: 1_000,
        item: { id: "reasoning-1", type: "reasoning", summary: [], content: [] },
      },
    },
    {
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-1", turnId: "turn-1", itemId: "reasoning-1", summaryIndex: 0, delta: "hidden",
      },
    },
    {
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        completedAtMs: 2_000,
        item: { id: "command-1", type: "commandExecution", status: "completed" },
      },
    },
  ]) client._handleLine(JSON.stringify(message));

  assert.deepEqual(events, []);
  assert.deepEqual(client.liveAgentMessagesForThread("thread-1"), []);
});
