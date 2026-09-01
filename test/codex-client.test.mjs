import assert from "node:assert/strict";
import test from "node:test";

import {
  appServerLaunchSpec,
  CodexAppServer,
  MAX_LIVE_MESSAGE_COUNT,
} from "../src/codex-client.mjs";


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

test("App Server launch avoids shell argument concatenation on Windows", () => {
  assert.deepEqual(
    appServerLaunchSpec("C:\\Tools\\Codex App\\codex.exe", {
      platform: "win32",
      comspec: "cmd.exe",
    }),
    {
      command: "C:\\Tools\\Codex App\\codex.exe",
      args: ["app-server", "--stdio"],
      shell: false,
    },
  );
  assert.deepEqual(
    appServerLaunchSpec("C:\\Tools\\Codex App\\codex.cmd", {
      platform: "win32",
      comspec: "C:\\Windows\\System32\\cmd.exe",
    }),
    {
      command: "\"C:\\Tools\\Codex App\\codex.cmd\" app-server --stdio",
      args: [],
      shell: "C:\\Windows\\System32\\cmd.exe",
    },
  );
  assert.throws(
    () => appServerLaunchSpec("codex.cmd\" & whoami", { platform: "win32" }),
    /unsupported characters/,
  );
});

test("composer catalog reads paginated thread metadata without turns", async () => {
  const client = new CodexAppServer();
  let threadRead;
  client.start = async () => {};
  client.request = async (method, params) => {
    if (method !== "thread/read") assert.fail(`Unexpected request: ${method}`);
    threadRead = params;
    return { thread: { id: "thread-1", cwd: "C:\\repo" } };
  };
  client.listModels = async () => [];
  client.listSkills = async () => [];
  client.listCollaborationModes = async () => [];
  client.getGoal = async () => null;

  await client.composerCatalog("thread-1");

  assert.deepEqual(threadRead, {
    threadId: "thread-1",
    includeTurns: false,
  });
});

test("composer catalog reuses supplied thread metadata", async () => {
  const client = new CodexAppServer();
  let skillCwd = "";
  client.readThread = async () => assert.fail("thread metadata should not be read twice");
  client.listModels = async () => [];
  client.listSkills = async (cwd) => {
    skillCwd = cwd;
    return [];
  };
  client.listCollaborationModes = async () => [];
  client.getGoal = async () => null;

  await client.composerCatalog("thread-1", {
    thread: Promise.resolve({ id: "thread-1", cwd: "C:\\cached-repo" }),
  });

  assert.equal(skillCwd, "C:\\cached-repo");
});

test("concurrent requests wait for the same App Server initialization", async () => {
  const client = new CodexAppServer();
  let starts = 0;
  let release;
  client._startProcess = async () => {
    starts += 1;
    await new Promise((resolve) => {
      release = resolve;
    });
  };

  const first = client.start();
  const second = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  release();
  await Promise.all([first, second]);
});

test("failed App Server startup cleans up before a later retry", async () => {
  const client = new CodexAppServer();
  let attempts = 0;
  let stops = 0;
  client._startProcess = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("initialize failed");
  };
  client.stop = () => {
    stops += 1;
  };

  await assert.rejects(client.start(), /initialize failed/);
  await client.start();

  assert.equal(attempts, 2);
  assert.equal(stops, 1);
});

test("malformed App Server lines are ignored without corrupting request state", () => {
  const client = new CodexAppServer();
  const diagnostics = [];
  client.on("diagnostic", (message) => diagnostics.push(message));

  assert.doesNotThrow(() => client._handleLine("null"));
  assert.doesNotThrow(() => client._handleLine("[]"));
  assert.match(diagnostics.at(-1), /malformed App Server message/);
});

test("a stale child exit cannot reset a replacement App Server process", () => {
  const client = new CodexAppServer();
  const staleProcess = {};
  const currentProcess = {};
  client.proc = currentProcess;
  client.loadedThreads.add("thread-1");

  assert.equal(client._handleProcessExit(staleProcess, 1, null), false);
  assert.equal(client.proc, currentProcess);
  assert.equal(client.loadedThreads.has("thread-1"), true);

  assert.equal(client._handleProcessExit(currentProcess, 1, null), true);
  assert.equal(client.proc, null);
  assert.equal(client.loadedThreads.size, 0);
});

test("thread reads synchronize active turn state without clearing metadata-only reads", async () => {
  const client = new CodexAppServer();
  const snapshots = [
    { thread: { id: "thread-1", turns: [{ id: "turn-1", status: "running" }] } },
    { thread: { id: "thread-1", turns: [{ id: "turn-1", status: "completed" }] } },
    { thread: { id: "thread-1" } },
  ];
  client.start = async () => {};
  client.request = async () => snapshots.shift();

  await client.readThread("thread-1");
  assert.equal(client.threadControlState("thread-1").turnId, "turn-1");

  client.interruptingThreads.add("thread-1");
  await client.readThread("thread-1");
  assert.deepEqual(client.threadControlState("thread-1"), {
    busy: false,
    phase: "idle",
    turnId: null,
  });

  client.activeTurns.set("thread-1", "turn-2");
  await client.readThread("thread-1", { includeTurns: false });
  assert.equal(client.threadControlState("thread-1").turnId, "turn-2");
});

test("model pagination stops when the server repeats a cursor", async () => {
  const client = new CodexAppServer();
  let calls = 0;
  client.start = async () => {};
  client.request = async (method) => {
    assert.equal(method, "model/list");
    calls += 1;
    if (calls > 2) throw new Error("repeated cursor was requested again");
    return { data: [{ model: "same-model" }], nextCursor: "same-cursor" };
  };

  assert.deepEqual(await client.listModels(), [{ model: "same-model" }]);
  assert.equal(calls, 2);
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
  assert.deepEqual(calls[1].params.input, [{
    type: "text",
    text: "运行测试",
    text_elements: [],
  }]);
  assert.equal(client.threadControlState("thread-1").busy, true);

  client._handleLine(JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
  }));
  assert.equal(client.threadControlState("thread-1").busy, false);
});

test("starting a turn sends local images and a stable client message id", async () => {
  const client = new CodexAppServer();
  const calls = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") return { thread: { id: "thread-1", turns: [] } };
    return { turn: { id: "turn-image", status: "inProgress" } };
  };

  await client.startTurn("thread-1", "检查截图", {
    clientMessageId: "web-image-message",
    images: [{ path: "C:\\data\\images\\screen.png", detail: "high" }],
  });

  const params = calls.find((call) => call.method === "turn/start").params;
  assert.equal(params.clientUserMessageId, "web-image-message");
  assert.deepEqual(params.input, [
    {
      type: "localImage",
      path: "C:\\data\\images\\screen.png",
      detail: "high",
    },
    { type: "text", text: "检查截图", text_elements: [] },
  ]);
});

test("starting an advanced turn sends model effort mode and structured skills", async () => {
  const client = new CodexAppServer();
  const calls = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") {
      return {
        thread: { id: "thread-1", turns: [] },
        model: "gpt-5.6-sol",
        reasoningEffort: "low",
      };
    }
    return { turn: { id: "turn-1", status: "inProgress" } };
  };

  await client.startTurn("thread-1", "制定方案", {
    model: "gpt-5.6-sol",
    effort: "high",
    mode: "plan",
    skills: [{ name: "docs", path: "C:\\skills\\docs\\SKILL.md" }],
  });

  const params = calls.find((call) => call.method === "turn/start").params;
  assert.equal(params.model, "gpt-5.6-sol");
  assert.equal(params.effort, "high");
  assert.deepEqual(params.collaborationMode, {
    mode: "plan",
    settings: {
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      developer_instructions: null,
    },
  });
  assert.deepEqual(params.input, [
    { type: "skill", name: "docs", path: "C:\\skills\\docs\\SKILL.md" },
    { type: "text", text: "制定方案", text_elements: [] },
  ]);
});

test("starting a persistent thread uses the selected project cwd", async () => {
  const client = new CodexAppServer();
  const calls = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {
      thread: { id: "thread-new", turns: [] },
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
    };
  };

  await client.startThread({ cwd: "C:\\work\\sample" });

  assert.deepEqual(calls, [{
    method: "thread/start",
    params: { ephemeral: false, cwd: "C:\\work\\sample" },
  }]);
  assert.equal(client.loadedThreads.has("thread-new"), true);
  assert.equal(client.threadSettings.get("thread-new").model, "gpt-5.6-sol");
});

test("invalid thread lifecycle responses never pollute loaded session state", async () => {
  const client = new CodexAppServer();
  client.start = async () => {};
  client.request = async (method) => method === "thread/resume"
    ? { thread: { id: "thread-unexpected", turns: [] } }
    : { thread: null };

  await assert.rejects(
    () => client.resumeThread("thread-expected"),
    (error) => error.code === "INVALID_THREAD_RESPONSE",
  );
  assert.equal(client.loadedThreads.size, 0);
  assert.equal(client.threadSettings.size, 0);

  await assert.rejects(
    () => client.startThread({ cwd: "C:\\work\\sample" }),
    (error) => error.code === "INVALID_THREAD_RESPONSE",
  );
  assert.equal(client.loadedThreads.size, 0);
});

test("Steer targets the expected active turn with structured input", async () => {
  const client = new CodexAppServer();
  const calls = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };
  client.activeTurns.set("thread-1", "turn-active");

  await client.steerTurn("thread-1", "检查失败日志", {
    turnId: "turn-active",
    clientMessageId: "web-steer-1",
    skills: [{ name: "review", path: "C:\\skills\\review\\SKILL.md" }],
    images: [{ path: "C:\\data\\error.png" }],
  });

  assert.deepEqual(calls, [{
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-active",
      clientUserMessageId: "web-steer-1",
      input: [
        { type: "skill", name: "review", path: "C:\\skills\\review\\SKILL.md" },
        { type: "localImage", path: "C:\\data\\error.png", detail: "auto" },
        { type: "text", text: "检查失败日志", text_elements: [] },
      ],
    },
  }]);
});

test("interrupting an active turn uses the official turn id and stays busy until completion", async () => {
  const client = new CodexAppServer();
  const calls = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    return {};
  };
  client.activeTurns.set("thread-1", "turn-1");

  const result = await client.interruptTurn("thread-1");

  assert.deepEqual(calls, [{
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-1" },
  }]);
  assert.equal(result.turnId, "turn-1");
  assert.deepEqual(client.threadControlState("thread-1"), {
    busy: true,
    phase: "interrupting",
    turnId: "turn-1",
  });

  client._handleLine(JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
  }));
  assert.deepEqual(client.threadControlState("thread-1"), {
    busy: false,
    phase: "idle",
    turnId: null,
  });
});

test("interrupting without an active turn is rejected before sending a request", async () => {
  const client = new CodexAppServer();
  client.start = async () => {};
  client.request = async () => assert.fail("request should not be called");

  await assert.rejects(
    client.interruptTurn("thread-1"),
    (error) => error.code === "NO_ACTIVE_TURN",
  );
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

test("live message buffering is capped and still clears against a long snapshot", () => {
  const client = new CodexAppServer();
  const deltas = [];
  client.on("messageDelta", (value) => deltas.push(value.delta));

  client._handleLine(JSON.stringify({
    method: "item/started",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "long-item", type: "agentMessage", text: "" },
    },
  }));
  client._handleLine(JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "long-item",
      delta: "x".repeat(80_010),
    },
  }));
  client._handleLine(JSON.stringify({
    method: "item/agentMessage/delta",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "long-item",
      delta: "ignored",
    },
  }));

  assert.equal(deltas.length, 1);
  assert.equal(deltas[0].length, 80_000);
  assert.equal(
    client.liveAgentMessagesForThread("thread-1")[0].value.text.length,
    80_000,
  );

  const finalText = `${"x".repeat(80_010)}final`;
  client._handleLine(JSON.stringify({
    method: "item/completed",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "long-item", type: "agentMessage", text: finalText },
    },
  }));
  assert.equal(
    client.liveAgentMessagesForThread("thread-1")[0].value.text.length,
    80_000,
  );
  assert.equal(client.confirmLiveAgentMessageSnapshot("thread-1", [{
    id: "long-item",
    role: "assistant",
    text: finalText,
  }]), 1);
});

test("live message replay cache evicts old records at a fixed bound", () => {
  const client = new CodexAppServer();
  for (let index = 0; index <= MAX_LIVE_MESSAGE_COUNT; index += 1) {
    client._handleLine(JSON.stringify({
      method: "item/started",
      params: {
        threadId: "thread-1",
        turnId: `turn-${index}`,
        item: { id: `item-${index}`, type: "agentMessage", text: "" },
      },
    }));
  }

  const records = client.liveAgentMessagesForThread("thread-1");
  assert.equal(records.length, MAX_LIVE_MESSAGE_COUNT);
  assert.equal(records.some((record) => record.value.itemId === "item-0"), false);
  assert.equal(records.at(-1).value.itemId, `item-${MAX_LIVE_MESSAGE_COUNT}`);
});
