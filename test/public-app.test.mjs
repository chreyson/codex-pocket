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
  }

  get textContent() {
    return this._textContent + this.children.map((child) => child.textContent || "").join("");
  }

  set textContent(value) {
    this._textContent = String(value ?? "");
    this.children = [];
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
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
    requestAnimationFrame(callback) {
      callback();
    },
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
    }),
  };`;
  vm.runInContext(source + hooks, context, { filename: "public/app.js" });
  await eventually(() => !elements.app.hidden);
  return { elements, eventSources: FakeEventSource.instances, hooks: context.__appTest };
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
