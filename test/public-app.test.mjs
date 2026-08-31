import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";


const APP_SOURCE_URL = new URL("../public/app.js", import.meta.url);
const ELEMENT_IDS = [
  "boot-screen",
  "auth-screen",
  "auth-form",
  "auth-submit",
  "auth-error",
  "token-input",
  "app",
  "thread-list",
  "thread-empty",
  "thread-empty-title",
  "thread-empty-detail",
  "thread-search",
  "connection-state",
  "connection-label",
  "conversation-title",
  "conversation-meta",
  "conversation-placeholder",
  "placeholder-title",
  "placeholder-detail",
  "message-list",
  "approval-tray",
  "composer",
  "message-input",
  "composer-status",
  "send-button",
  "back-button",
  "refresh-button",
];

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) this.values.add(name);
  }

  remove(...names) {
    for (const name of names) this.values.delete(name);
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.scrollHeight = 100;
    this.scrollTop = 0;
    this.clientHeight = 100;
    this._textContent = "";
    this.textContentWrites = 0;
    this.replaceChildrenCalls = 0;
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || "").join("");
  }

  set textContent(value) {
    this.textContentWrites += 1;
    this._textContent = String(value ?? "");
    this.children = [];
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.replaceChildrenCalls += 1;
    this.children = [...children];
    this._textContent = "";
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus() {
    this.focused = true;
  }

  requestSubmit() {
    for (const listener of this.listeners.get("submit") || []) {
      listener({ preventDefault() {} });
    }
  }
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  close() {
    this.closed = true;
  }
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function threadSummary(id) {
  return {
    id,
    title: `Thread ${id}`,
    preview: "",
    project: `Project ${id}`,
    status: "idle",
    updatedAt: 1,
  };
}

function threadDetail(id, text) {
  return {
    ...threadSummary(id),
    messages: [{
      id: `${id}-message`,
      role: "assistant",
      kind: "message",
      text,
      timestamp: 1,
    }],
    control: { busy: false, requests: [] },
  };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for app state");
}

async function createHarness(fetchImpl) {
  FakeEventSource.instances = [];
  const animationFrames = new Map();
  let nextAnimationFrameId = 1;
  const requestAnimationFrame = (callback) => {
    const id = nextAnimationFrameId++;
    animationFrames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id) => {
    animationFrames.delete(id);
  };
  const flushAnimationFrames = () => {
    const callbacks = [...animationFrames.values()];
    animationFrames.clear();
    for (const callback of callbacks) callback();
    return callbacks.length;
  };
  const elements = Object.fromEntries(ELEMENT_IDS.map((id) => [id, new FakeElement()]));
  elements["auth-screen"].hidden = true;
  elements.app.hidden = true;
  elements["thread-empty"].hidden = true;
  elements["message-list"].hidden = true;
  elements["approval-tray"].hidden = true;
  elements.composer.hidden = true;

  const document = {
    querySelector(selector) {
      return elements[selector.replace(/^#/, "")];
    },
    createElement(tagName) {
      return new FakeElement(tagName);
    },
    createElementNS(_namespace, tagName) {
      return new FakeElement(tagName);
    },
  };
  const context = vm.createContext({
    document,
    EventSource: FakeEventSource,
    fetch: fetchImpl,
    history: { replaceState() {} },
    location: { hash: "", pathname: "/", search: "" },
    URLSearchParams,
    requestAnimationFrame,
    cancelAnimationFrame,
    setImmediate,
  });
  const source = await fs.readFile(APP_SOURCE_URL, "utf8");
  const hooks = `\n;globalThis.__appTest = {
    selectThread,
    sendMessage,
    connectEvents,
    getState: () => ({
      threads,
      selectedThreadId,
      currentThread,
      pendingMessage,
      sendingThreads: [...sendingThreads],
      eventSource,
      selectionEpoch,
      liveMessages: [...liveMessages.values()].map((live) => ({
        id: live.message.id,
        text: live.message.text,
        completed: live.completed,
      })),
      queuedDeltaCount: queuedMessageDeltas.size,
    }),
  };`;
  vm.runInContext(`"use strict";\n${source}${hooks}`, context, { filename: "public/app.js" });
  await eventually(() => !elements.app.hidden);
  return {
    elements,
    eventSources: FakeEventSource.instances,
    hooks: context.__appTest,
    flushAnimationFrames,
    pendingAnimationFrames: () => animationFrames.size,
  };
}

function emitSse(source, event, value) {
  source.listeners.get(event)({ data: JSON.stringify(value) });
}

function emptyThreadDetail(id) {
  return {
    ...threadSummary(id),
    messages: [],
    control: { busy: true, requests: [] },
  };
}

test("thread navigation groups conversations by project and search opens matching groups", async () => {
  const sharedA = { ...threadSummary("A"), project: "Shared project", preview: "ordinary work" };
  const sharedB = { ...threadSummary("B"), project: "Shared project", preview: "needle summary", status: "active" };
  const separate = { ...threadSummary("C"), project: "Separate project" };
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [sharedA, sharedB, separate] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  assert.equal(harness.elements["thread-list"].children.length, 2);
  const sharedGroup = harness.elements["thread-list"].children[0];
  const [sharedHeader, sharedItems] = sharedGroup.children;
  assert.match(sharedHeader.textContent, /Shared project/);
  assert.equal(sharedItems.children.length, 2);
  assert.equal(sharedHeader.getAttribute("aria-expanded"), "true");

  sharedHeader.listeners.get("click")[0]();
  assert.equal(sharedItems.hidden, true);
  assert.equal(sharedHeader.getAttribute("aria-expanded"), "false");

  harness.elements["thread-search"].value = "needle";
  harness.elements["thread-search"].listeners.get("input")[0]();
  assert.equal(harness.elements["thread-list"].children.length, 1);
  const [matchingHeader, matchingItems] = harness.elements["thread-list"].children[0].children;
  assert.equal(matchingHeader.getAttribute("aria-expanded"), "true");
  assert.equal(matchingItems.hidden, false);
  assert.equal(matchingItems.children.length, 1);
  assert.match(matchingItems.textContent, /Thread B/);
});

test("consecutive tool activity renders as one compact group and merges duplicates", async () => {
  const summary = threadSummary("A");
  const detail = {
    ...threadDetail("A", "unused"),
    messages: [
      { id: "progress", role: "assistant", kind: "commentary", text: "先检查代码。", timestamp: 1 },
      { id: "command-1", role: "system", kind: "activity", label: "终端", activityType: "command", activityStatus: "completed", text: "运行 rg -n renderThread public/app.js", timestamp: 1 },
      { id: "command-2", role: "system", kind: "activity", label: "终端", activityType: "command", activityStatus: "completed", text: "运行 rg -n renderThread public/app.js", timestamp: 1 },
      { id: "file-1", role: "system", kind: "activity", label: "文件", activityType: "file", activityStatus: "completed", text: "读取 app.js", timestamp: 1 },
      { id: "done", role: "assistant", kind: "message", text: "检查完成。", timestamp: 2 },
    ],
  };
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") return jsonResponse(200, { status: { state: "ready" }, threads: [summary] });
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  const rendered = harness.elements["message-list"].children;
  assert.equal(rendered.length, 3);
  assert.equal(rendered[1].dataset.kind, "activityGroup");
  assert.match(rendered[1].textContent, /运行 rg -n renderThread public\/app\.js/);
  assert.match(rendered[1].textContent, /×2/);
  assert.match(rendered[1].textContent, /读取 app\.js/);
});

test("a send completing after navigation cannot pollute the current thread", async () => {
  const sendResult = deferred();
  const calls = [];
  const harness = await createHarness(async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET" });
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A"), threadSummary("B")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, threadDetail("A", "message from A"));
    if (url === "/api/threads/B") return jsonResponse(200, threadDetail("B", "message from B"));
    if (url === "/api/threads/A/messages") return sendResult.promise;
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "pending for A";
  const sending = harness.hooks.sendMessage({ preventDefault() {} });
  await eventually(() => harness.hooks.getState().sendingThreads.includes("A"));

  await harness.hooks.selectThread("B");
  sendResult.resolve(jsonResponse(202, { control: { busy: true } }));
  await sending;

  const state = harness.hooks.getState();
  assert.equal(state.selectedThreadId, "B");
  assert.equal(state.currentThread.id, "B");
  assert.equal(state.pendingMessage, null);
  assert.match(harness.elements["message-list"].textContent, /message from B/);
  assert.doesNotMatch(harness.elements["message-list"].textContent, /pending for A|message from A/);
  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => call.url), ["/api/threads/A/messages"]);
});

test("an SSE message arriving before the send response does not leave a duplicate pending bubble", async () => {
  const sendResult = deferred();
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, threadDetail("A", "existing message"));
    if (url === "/api/threads/A/messages") return sendResult.promise;
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "sent once";
  const sending = harness.hooks.sendMessage({ preventDefault() {} });
  await eventually(() => harness.hooks.getState().sendingThreads.includes("A"));

  const source = harness.eventSources.at(-1);
  source.listeners.get("thread")({
    data: JSON.stringify({
      ...threadDetail("A", "existing message"),
      messages: [
        ...threadDetail("A", "existing message").messages,
        { id: "persisted-user-message", role: "user", kind: "message", text: "sent once", timestamp: 2 },
      ],
      control: { busy: true, requests: [] },
    }),
  });
  sendResult.resolve(jsonResponse(202, { control: { busy: true } }));
  await sending;

  assert.equal(harness.hooks.getState().pendingMessage, null);
  assert.equal(harness.elements["message-list"].textContent.match(/sent once/g)?.length, 1);
});

test("an optimistic user message stays before live replies that beat the send response", async () => {
  const sendResult = deferred();
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, {
        status: { state: "ready" },
        threads: [threadSummary("A")],
      });
    }
    if (url === "/api/threads/A") {
      return jsonResponse(200, threadDetail("A", "earlier message"));
    }
    if (url === "/api/threads/A/messages") return sendResult.promise;
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  harness.flushAnimationFrames();
  harness.elements["message-input"].value = "test";
  const sending = harness.hooks.sendMessage({ preventDefault() {} });
  await eventually(() => harness.hooks.getState().sendingThreads.includes("A"));

  let rendered = harness.elements["message-list"].children;
  assert.deepEqual(
    rendered.map((article) => article.dataset.role),
    ["assistant", "user"],
  );
  assert.equal(rendered[1].children[1].textContent, "test");

  const source = harness.eventSources.at(-1);
  emitSse(source, "messageStart", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "reply-1",
    kind: "message",
    text: "我在，继续即可。",
    timestamp: 2,
  });
  harness.flushAnimationFrames();

  rendered = harness.elements["message-list"].children;
  assert.deepEqual(
    rendered.map((article) => article.dataset.role),
    ["assistant", "user", "assistant"],
  );
  assert.deepEqual(
    rendered.map((article) => article.children[1].textContent),
    ["earlier message", "test", "我在，继续即可。"],
  );

  sendResult.resolve(jsonResponse(202, { control: { busy: true } }));
  await sending;
  rendered = harness.elements["message-list"].children;
  assert.deepEqual(
    rendered.map((article) => article.children[1].textContent),
    ["earlier message", "test", "我在，继续即可。"],
  );
});

test("a stale thread load failure cannot replace the newer conversation", async () => {
  const staleLoad = deferred();
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A"), threadSummary("B")] });
    }
    if (url === "/api/threads/A") return staleLoad.promise;
    if (url === "/api/threads/B") return jsonResponse(200, threadDetail("B", "newer conversation"));
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const selectingA = harness.hooks.selectThread("A");
  await harness.hooks.selectThread("B");
  staleLoad.resolve(jsonResponse(500, { error: "old load failed" }));
  await selectingA;

  assert.equal(harness.hooks.getState().selectedThreadId, "B");
  assert.equal(harness.elements["conversation-title"].textContent, "Thread B");
  assert.match(harness.elements["conversation-meta"].textContent, /Project B/);
  assert.doesNotMatch(harness.elements["conversation-meta"].textContent, /old load failed/);
  assert.equal(harness.elements["conversation-placeholder"].hidden, true);
  assert.equal(harness.elements["message-list"].hidden, false);
  assert.match(harness.elements["message-list"].textContent, /newer conversation/);
});

test("an SSE error that probes as unauthorized returns to sign-in", async () => {
  let bootstrapCalls = 0;
  const harness = await createHarness(async (url) => {
    if (url !== "/api/bootstrap") throw new Error(`Unexpected fetch: ${url}`);
    bootstrapCalls += 1;
    if (bootstrapCalls === 1) {
      return jsonResponse(200, { status: { state: "ready" }, threads: [] });
    }
    return jsonResponse(401, { error: "Unauthorized" });
  });

  const source = harness.eventSources.at(-1);
  await source.onerror();

  assert.equal(harness.elements["auth-screen"].hidden, false);
  assert.equal(harness.elements.app.hidden, true);
  assert.equal(harness.elements["auth-error"].textContent, "会话已过期，请重新输入访问密钥。");
  assert.equal(harness.hooks.getState().selectedThreadId, "");
  assert.equal(source.closed, true);
});

test("agent deltas batch into one frame and update one existing message node", async () => {
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, {
        status: { state: "ready" },
        threads: [threadSummary("A")],
      });
    }
    if (url === "/api/threads/A") {
      return jsonResponse(200, emptyThreadDetail("A"));
    }
    throw new Error("Unexpected fetch: " + url);
  });

  await harness.hooks.selectThread("A");
  harness.flushAnimationFrames();
  const source = harness.eventSources.at(-1);
  emitSse(source, "messageStart", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    kind: "message",
    text: "",
    timestamp: 1,
  });
  harness.flushAnimationFrames();

  const article = harness.elements["message-list"].children[0];
  const body = article.children[1];
  const textWrites = body.textContentWrites;
  const listReconciles = harness.elements["message-list"].replaceChildrenCalls;
  emitSse(source, "messageDelta", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    delta: "实",
  });
  emitSse(source, "messageDelta", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    delta: "时",
  });
  emitSse(source, "messageDelta", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    delta: "输出",
  });

  assert.equal(harness.pendingAnimationFrames(), 1);
  assert.equal(body.textContent, "");
  harness.flushAnimationFrames();
  assert.equal(body.textContent, "实时输出");
  assert.equal(body.textContentWrites, textWrites + 1);
  assert.equal(harness.elements["message-list"].children[0], article);
  assert.equal(
    harness.elements["message-list"].replaceChildrenCalls,
    listReconciles,
  );
  assert.equal(harness.elements["message-list"].children.length, 1);
});

test("lagging snapshots and queued deltas cannot regress a completed message", async () => {
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, {
        status: { state: "ready" },
        threads: [threadSummary("A")],
      });
    }
    if (url === "/api/threads/A") {
      return jsonResponse(200, emptyThreadDetail("A"));
    }
    throw new Error("Unexpected fetch: " + url);
  });

  await harness.hooks.selectThread("A");
  harness.flushAnimationFrames();
  const source = harness.eventSources.at(-1);
  const snapshot = (text) => ({
    ...threadSummary("A"),
    messages: [{
      id: "live-1",
      role: "assistant",
      kind: "message",
      text,
      timestamp: 1,
    }],
    control: { busy: true, requests: [] },
  });

  emitSse(source, "messageStart", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    kind: "message",
    text: "实时",
    timestamp: 1,
  });
  harness.flushAnimationFrames();
  emitSse(source, "messageDelta", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    delta: "输出",
  });
  harness.flushAnimationFrames();
  emitSse(source, "thread", snapshot("实"));
  assert.match(harness.elements["message-list"].textContent, /实时输出/);
  harness.flushAnimationFrames();

  emitSse(source, "thread", snapshot("实时输出完成"));
  assert.match(harness.elements["message-list"].textContent, /实时输出完成/);
  harness.flushAnimationFrames();
  emitSse(source, "messageDelta", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    delta: "不应出现",
  });
  assert.equal(harness.pendingAnimationFrames(), 1);
  emitSse(source, "messageDone", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    kind: "message",
    text: "最终文本",
    timestamp: 1,
  });
  assert.equal(harness.hooks.getState().queuedDeltaCount, 0);
  harness.flushAnimationFrames();
  assert.match(harness.elements["message-list"].textContent, /最终文本/);
  assert.doesNotMatch(harness.elements["message-list"].textContent, /不应出现/);

  emitSse(source, "thread", snapshot("最终"));
  assert.match(harness.elements["message-list"].textContent, /最终文本/);
  emitSse(source, "thread", snapshot("最终文本"));
  assert.equal(harness.hooks.getState().liveMessages.length, 0);
  assert.equal(harness.elements["message-list"].children.length, 1);
});

test("queued output and stale A to B to A loads cannot pollute the current view", async () => {
  const firstALoad = deferred();
  let aLoads = 0;
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, {
        status: { state: "ready" },
        threads: [threadSummary("A"), threadSummary("B")],
      });
    }
    if (url === "/api/threads/A") {
      aLoads += 1;
      if (aLoads === 1) return firstALoad.promise;
      return jsonResponse(200, threadDetail("A", "new A"));
    }
    if (url === "/api/threads/B") {
      return jsonResponse(200, threadDetail("B", "message B"));
    }
    throw new Error("Unexpected fetch: " + url);
  });

  const firstSelection = harness.hooks.selectThread("A");
  const oldSource = harness.eventSources.at(-1);
  emitSse(oldSource, "messageStart", {
    threadId: "A",
    turnId: "turn-old",
    itemId: "old-live",
    kind: "message",
    text: "old",
    timestamp: 1,
  });
  harness.flushAnimationFrames();
  emitSse(oldSource, "messageDelta", {
    threadId: "A",
    turnId: "turn-old",
    itemId: "old-live",
    delta: " queued",
  });
  assert.equal(harness.pendingAnimationFrames(), 1);

  await harness.hooks.selectThread("B");
  await harness.hooks.selectThread("A");
  harness.flushAnimationFrames();
  firstALoad.resolve(jsonResponse(200, threadDetail("A", "old A")));
  await firstSelection;

  emitSse(oldSource, "messageStart", {
    threadId: "A",
    turnId: "turn-old",
    itemId: "late-old",
    kind: "message",
    text: "late old source",
    timestamp: 1,
  });
  emitSse(oldSource, "messageDelta", {
    threadId: "A",
    turnId: "turn-old",
    itemId: "late-old",
    delta: " ignored",
  });
  harness.flushAnimationFrames();

  assert.equal(harness.hooks.getState().selectedThreadId, "A");
  assert.equal(harness.hooks.getState().currentThread.messages[0].text, "new A");
  assert.match(harness.elements["message-list"].textContent, /new A/);
  assert.doesNotMatch(
    harness.elements["message-list"].textContent,
    /old A|old queued|late old source|ignored/,
  );
  assert.equal(harness.hooks.getState().queuedDeltaCount, 0);
});

test("live output follows the bottom without taking over after the user scrolls up", async () => {
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, {
        status: { state: "ready" },
        threads: [threadSummary("A")],
      });
    }
    if (url === "/api/threads/A") {
      return jsonResponse(200, emptyThreadDetail("A"));
    }
    throw new Error("Unexpected fetch: " + url);
  });

  await harness.hooks.selectThread("A");
  harness.flushAnimationFrames();
  const source = harness.eventSources.at(-1);
  emitSse(source, "messageStart", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    kind: "message",
    text: "a",
    timestamp: 1,
  });
  harness.flushAnimationFrames();

  const list = harness.elements["message-list"];
  list.dataset.rendered = "true";
  list.scrollHeight = 1000;
  list.clientHeight = 300;
  list.scrollTop = 100;
  emitSse(source, "messageDelta", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    delta: "b",
  });
  harness.flushAnimationFrames();
  assert.equal(list.scrollTop, 100);

  list.scrollTop = 650;
  emitSse(source, "messageDelta", {
    threadId: "A",
    turnId: "turn-1",
    itemId: "live-1",
    delta: "c",
  });
  harness.flushAnimationFrames();
  assert.equal(list.scrollTop, 1000);
  assert.match(list.textContent, /abc/);
});
