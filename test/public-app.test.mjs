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
  "thread-action-status",
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
  "composer-menu",
  "mode-control",
  "skill-control",
  "skill-label",
  "skill-count",
  "selected-skills",
  "goal-banner",
  "goal-objective",
  "goal-complete",
  "goal-clear",
  "composer-images",
  "image-input",
  "image-upload-button",
  "message-input",
  "model-control",
  "model-label",
  "effort-control",
  "effort-label",
  "composer-status",
  "delivery-control",
  "interrupt-button",
  "send-button",
  "back-button",
  "refresh-button",
  "image-viewer",
  "image-viewer-image",
  "image-viewer-caption",
  "image-viewer-close",
  "image-viewer-prev",
  "image-viewer-next",
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
      turnId: `${id}-turn`,
      role: "assistant",
      kind: "message",
      text,
      timestamp: 1,
    }],
    control: { busy: false, requests: [] },
  };
}

function composerOptions({ goal = null } = {}) {
  return {
    models: [
      {
        id: "gpt-sol",
        name: "GPT Sol",
        description: "Deep coding work",
        specialty: "Quality",
        isDefault: true,
        defaultEffort: "low",
        efforts: [
          { id: "low", description: "Fast" },
          { id: "high", description: "Deep" },
        ],
      },
      {
        id: "gpt-terra",
        name: "GPT Terra",
        description: "Balanced work",
        specialty: "Balanced",
        isDefault: false,
        defaultEffort: "medium",
        efforts: [{ id: "medium", description: "Balanced" }],
      },
    ],
    skills: [
      { name: "docs", description: "Read docs", scope: "system", enabled: true },
      { name: "disabled", description: "Unavailable", scope: "system", enabled: false },
    ],
    modes: ["default", "plan"],
    defaultModel: "gpt-sol",
    defaultEffort: "low",
    goal,
    features: { plan: true, goal: true, skills: true },
  };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for app state");
}

async function createHarness(fetchImpl, { storedSelection } = {}) {
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
  elements["thread-action-status"].hidden = true;
  elements["message-list"].hidden = true;
  elements["approval-tray"].hidden = true;
  elements.composer.hidden = true;
  elements["composer-menu"].hidden = true;
  elements["selected-skills"].hidden = true;
  elements["composer-images"].hidden = true;
  elements["goal-banner"].hidden = true;
  elements["delivery-control"].hidden = true;
  elements["interrupt-button"].hidden = true;
  elements["interrupt-button"].setAttribute("aria-label", "中断任务");
  elements["skill-count"].hidden = true;
  elements["image-viewer"].hidden = true;
  for (const mode of ["default", "plan", "goal"]) {
    const button = new FakeElement("button");
    button.dataset.mode = mode;
    button.setAttribute("aria-checked", String(mode === "default"));
    elements["mode-control"].append(button);
  }
  for (const action of ["queue", "steer"]) {
    const button = new FakeElement("button");
    button.dataset.action = action;
    button.setAttribute("aria-checked", String(action === "queue"));
    elements["delivery-control"].append(button);
  }

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
    AbortController,
    document,
    EventSource: FakeEventSource,
    fetch: fetchImpl,
    history: { replaceState() {} },
    location: { hash: "", pathname: "/", search: "" },
    URLSearchParams,
    requestAnimationFrame,
    cancelAnimationFrame,
    clearTimeout,
    setTimeout,
    setImmediate,
    ...(storedSelection === undefined ? {} : {
      localStorage: {
        getItem: () => storedSelection,
        setItem() {},
      },
    }),
  });
  const source = await fs.readFile(APP_SOURCE_URL, "utf8");
  const hooks = `\n;globalThis.__appTest = {
    selectThread,
    createProjectThread,
    sendMessage,
    interruptTurn,
    connectEvents,
    fetchJsonWithTimeout,
    showAuth,
    addPendingImages,
    removePendingImage,
    openImageViewer,
    closeImageViewer,
    getState: () => ({
      threads,
      selectedThreadId,
      currentThread,
      pendingMessage,
      sendingThreads: [...sendingThreads],
      interruptingThreads: [...interruptingThreads],
      interruptRequestThreads: [...interruptRequestThreads],
      creatingProjects: [...creatingProjects],
      expandedTurns: [...expandedTurns],
      resolvingRequests: [...resolvingRequests],
      goalUpdating,
      eventSource,
      selectionEpoch,
      liveMessages: [...liveMessages.values()].map((live) => ({
        id: live.message.id,
        text: live.message.text,
        completed: live.completed,
      })),
      queuedDeltaCount: queuedMessageDeltas.size,
      composerCatalog,
      composerSelection: {
        ...composerSelection,
        skillNames: [...(composerSelection.skillNames || [])],
      },
      composerMenuKind,
      pendingImages: pendingImages.map((image) => ({
        id: image.id,
        name: image.name,
        src: image.src,
        status: image.status,
        localId: image.localId,
      })),
      viewerImages: [...viewerImages],
      viewerImageIndex,
      runningMessageAction,
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

test("malformed persisted composer settings degrade to safe defaults", async () => {
  const harness = await createHarness(async () => jsonResponse(200, {
    status: { state: "ready" },
    threads: [],
  }), {
    storedSelection: JSON.stringify({
      model: { unexpected: true },
      effort: 42,
      mode: "unsupported",
      skillNames: { not: "iterable" },
    }),
  });

  const selection = harness.hooks.getState().composerSelection;
  assert.equal(selection.model, "");
  assert.equal(selection.effort, "");
  assert.equal(selection.mode, "default");
  assert.equal(selection.skillNames.length, 0);
});

test("request timeouts remain active while a JSON response body is stalled", async () => {
  const harness = await createHarness(async (url, options) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [] });
    }
    return {
      status: 200,
      ok: true,
      json: () => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      }),
    };
  });

  await assert.rejects(
    harness.hooks.fetchJsonWithTimeout("/stalled", {}, 5),
    /请求超时/,
  );
});

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
  const [sharedToggle, sharedCreate] = sharedHeader.children;
  assert.match(sharedHeader.textContent, /Shared project/);
  assert.equal(sharedCreate.getAttribute("aria-label"), "在 Shared project 中新建会话");
  assert.equal(sharedItems.children.length, 2);
  assert.equal(sharedToggle.getAttribute("aria-expanded"), "true");

  sharedToggle.listeners.get("click")[0]();
  assert.equal(sharedItems.hidden, true);
  assert.equal(sharedToggle.getAttribute("aria-expanded"), "false");

  harness.elements["thread-search"].value = "needle";
  harness.elements["thread-search"].listeners.get("input")[0]();
  assert.equal(harness.elements["thread-list"].children.length, 1);
  const [matchingHeader, matchingItems] = harness.elements["thread-list"].children[0].children;
  const [matchingToggle] = matchingHeader.children;
  assert.equal(matchingToggle.getAttribute("aria-expanded"), "true");
  assert.equal(matchingItems.hidden, false);
  assert.equal(matchingItems.children.length, 1);
  assert.match(matchingItems.textContent, /Thread B/);
});

test("a project can create and open a new conversation without exposing its cwd", async () => {
  const calls = [];
  const created = {
    ...threadSummary("NEW"),
    title: "New conversation",
    project: "Shared project",
  };
  const harness = await createHarness(async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body });
    if (url === "/api/bootstrap") {
      return jsonResponse(200, {
        status: { state: "ready" },
        threads: [{ ...threadSummary("A"), project: "Shared project" }],
      });
    }
    if (url === "/api/threads" && options.method === "POST") {
      return jsonResponse(201, { ok: true, thread: created });
    }
    if (url === "/api/threads/NEW") {
      return jsonResponse(200, { ...threadDetail("NEW", ""), ...created, messages: [] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.createProjectThread("Shared project", "A");

  const createCall = calls.find((call) => call.url === "/api/threads");
  assert.deepEqual(JSON.parse(createCall.body), { projectThreadId: "A" });
  assert.equal(harness.hooks.getState().selectedThreadId, "NEW");
  assert.equal(harness.elements["conversation-title"].textContent, "New conversation");
  assert.equal(harness.elements["thread-action-status"].hidden, true);
  assert.equal(createCall.body.includes("cwd"), false);
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

test("completed history turns collapse while the latest turn stays expanded", async () => {
  const summary = threadSummary("A");
  const detail = {
    ...summary,
    messages: [
      { id: "old-user", turnId: "turn-old", role: "user", kind: "message", text: "检查旧问题", timestamp: 1 },
      { id: "old-answer", turnId: "turn-old", role: "assistant", kind: "message", text: "旧问题已处理", timestamp: 1 },
      { id: "new-user", turnId: "turn-new", role: "user", kind: "message", text: "继续新任务", timestamp: 2 },
      { id: "new-answer", turnId: "turn-new", role: "assistant", kind: "message", text: "正在继续", timestamp: 2 },
    ],
    control: { busy: false, requests: [] },
  };
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [summary] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  let rendered = harness.elements["message-list"].children;
  assert.equal(rendered.length, 3);
  assert.equal(rendered[0].tagName, "DETAILS");
  assert.equal(rendered[0].open, false);
  assert.match(rendered[0].children[0].textContent, /检查旧问题/);
  assert.deepEqual(rendered.slice(1).map((node) => node.dataset.role), ["user", "assistant"]);

  rendered[0].open = true;
  rendered[0].listeners.get("toggle")[0]();
  emitSse(harness.eventSources.at(-1), "thread", {
    ...detail,
    messages: detail.messages.map((message) => message.id === "new-answer"
      ? { ...message, text: "新任务已更新" }
      : message),
  });
  rendered = harness.elements["message-list"].children;
  assert.equal(rendered[0].open, true);
  assert.match(rendered.at(-1).textContent, /新任务已更新/);
});

test("the first authoritative conversation snapshot lands at the bottom immediately", async () => {
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, threadDetail("A", "最后一条消息"));
    throw new Error(`Unexpected fetch: ${url}`);
  });
  harness.elements["message-list"].scrollHeight = 1_240;

  await harness.hooks.selectThread("A");

  assert.equal(harness.elements["message-list"].scrollTop, 1_240);
  assert.equal(harness.elements["message-list"].dataset.rendered, "true");
  assert.equal(harness.pendingAnimationFrames(), 0);
});

test("composer controls send the selected model effort mode and skills", async () => {
  let sentBody;
  const detail = {
    ...threadDetail("A", "ready"),
    composerOptions: composerOptions(),
  };
  const harness = await createHarness(async (url, options = {}) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    if (url === "/api/threads/A/messages") {
      sentBody = JSON.parse(options.body);
      return jsonResponse(202, { delivery: "app-server", control: { busy: true } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  assert.equal(harness.elements["model-label"].textContent, "GPT Sol");
  assert.equal(harness.elements["effort-label"].textContent, "低");

  harness.elements["model-control"].listeners.get("click")[0]();
  const modelList = harness.elements["composer-menu"].children[1];
  modelList.children[1].listeners.get("click")[0]();
  assert.equal(harness.elements["model-label"].textContent, "GPT Terra");
  assert.equal(harness.elements["effort-label"].textContent, "中");

  harness.elements["skill-control"].listeners.get("click")[0]();
  const skillList = harness.elements["composer-menu"].children[2];
  skillList.children[0].listeners.get("click")[0]();
  assert.equal(harness.elements["skill-count"].textContent, "1");
  assert.match(harness.elements["selected-skills"].textContent, /\$docs/);

  await harness.elements["mode-control"].children[1].listeners.get("click")[0]();
  assert.equal(harness.hooks.getState().composerSelection.mode, "plan");

  harness.elements["message-input"].value = "制定实现计划";
  await harness.hooks.sendMessage({ preventDefault() {} });
  assert.match(sentBody.clientMessageId, /^(?:[0-9a-f-]{36}|web-)/);
  assert.deepEqual({
    text: sentBody.text,
    model: sentBody.model,
    effort: sentBody.effort,
    mode: sentBody.mode,
    skillNames: sentBody.skillNames,
    imageIds: sentBody.imageIds,
  }, {
    text: "制定实现计划",
    model: "gpt-terra",
    effort: "medium",
    mode: "plan",
    skillNames: ["docs"],
    imageIds: [],
  });
});

test("goal mode creates an active goal and can clear it from the composer", async () => {
  const calls = [];
  const detail = {
    ...threadDetail("A", "ready"),
    composerOptions: composerOptions(),
  };
  const harness = await createHarness(async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body });
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    if (url === "/api/threads/A/messages") {
      return jsonResponse(202, {
        delivery: "codex-app",
        goal: { objective: "完成 Web 对齐", status: "active" },
        control: { busy: true },
      });
    }
    if (url === "/api/threads/A/goal" && options.method === "DELETE") {
      return jsonResponse(200, { ok: true, cleared: true });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  await harness.elements["mode-control"].children[2].listeners.get("click")[0]();
  harness.elements["message-input"].value = "完成 Web 对齐";
  await harness.hooks.sendMessage({ preventDefault() {} });

  const send = calls.find((call) => call.url === "/api/threads/A/messages");
  assert.equal(JSON.parse(send.body).mode, "goal");
  assert.equal(harness.elements["goal-banner"].hidden, false);
  assert.equal(harness.elements["goal-objective"].textContent, "完成 Web 对齐");

  harness.hooks.getState().currentThread.control.busy = false;
  await harness.elements["goal-clear"].listeners.get("click")[0]();
  assert.equal(harness.elements["goal-banner"].hidden, true);
  assert.equal(harness.hooks.getState().composerSelection.mode, "default");
  assert.equal(calls.some((call) => call.url === "/api/threads/A/goal" && call.method === "DELETE"), true);
});

test("image attachments upload, preview, and send as structured ids", async () => {
  const uploadId = `img_${"a".repeat(32)}`;
  let sentBody;
  let uploadOptions;
  const detail = {
    ...threadDetail("A", "ready"),
    composerOptions: composerOptions(),
  };
  const harness = await createHarness(async (url, options = {}) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    if (url === "/api/uploads") {
      uploadOptions = options;
      return jsonResponse(201, {
        image: {
          id: uploadId,
          src: `/api/images/${uploadId}`,
          alt: "screen.png",
          mimeType: "image/png",
        },
      });
    }
    if (url === "/api/threads/A/messages") {
      sentBody = JSON.parse(options.body);
      return jsonResponse(202, { delivery: "app-server", control: { busy: true } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  await harness.hooks.addPendingImages([{
    name: "screen.png",
    type: "image/png",
    size: 128,
  }]);

  assert.equal(uploadOptions.method, "POST");
  assert.equal(uploadOptions.headers["Content-Type"], "image/png");
  assert.equal(harness.hooks.getState().pendingImages[0].status, "ready");
  assert.equal(harness.elements["composer-images"].hidden, false);
  assert.equal(harness.elements["send-button"].disabled, false);

  await harness.hooks.sendMessage({ preventDefault() {} });
  assert.equal(sentBody.text, "");
  assert.deepEqual(sentBody.imageIds, [uploadId]);
  assert.match(sentBody.clientMessageId, /^(?:[0-9a-f-]{36}|web-)/);
  assert.equal(harness.hooks.getState().pendingImages.length, 0);
  assert.equal(harness.hooks.getState().pendingMessage.images[0].src, `/api/images/${uploadId}`);
});

test("conversation images open in the full-screen viewer", async () => {
  const imageId = `asset_${"b".repeat(32)}`;
  const detail = {
    ...threadDetail("A", "unused"),
    messages: [{
      id: "image-message",
      role: "assistant",
      kind: "image",
      text: "检查结果",
      images: [{ src: `/api/images/${imageId}`, alt: "结果截图" }],
      timestamp: 1,
    }],
  };
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  const article = harness.elements["message-list"].children[0];
  const media = article.children.find((child) => child.className === "message-media");
  assert.ok(media);
  assert.equal(media.children[0].children[0].src, `/api/images/${imageId}`);
  media.children[0].listeners.get("click")[0]();
  assert.equal(harness.elements["image-viewer"].hidden, false);
  assert.equal(harness.elements["image-viewer-image"].src, `/api/images/${imageId}`);
  assert.equal(harness.elements["image-viewer-caption"].textContent, "结果截图");
  harness.hooks.closeImageViewer();
  assert.equal(harness.elements["image-viewer"].hidden, true);
});

test("desktop snapshots render live thinking and tool state without replacing history", async () => {
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, threadDetail("A", "已有记录"));
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  const source = harness.eventSources.at(-1);
  emitSse(source, "desktopThread", {
    ...threadSummary("A"),
    partial: true,
    messages: [
      {
        id: "reasoning-live",
        role: "assistant",
        kind: "reasoning",
        text: "正在检查消息链路",
        activityStatus: "inProgress",
        timestamp: 2,
      },
      {
        id: "command-live",
        role: "system",
        kind: "activity",
        label: "终端",
        activityType: "command",
        activityStatus: "inProgress",
        text: "正在运行 npm test",
        timestamp: 2,
      },
    ],
    control: { busy: true, phase: "running" },
  });

  assert.match(harness.elements["message-list"].textContent, /已有记录/);
  assert.match(harness.elements["message-list"].textContent, /思考中/);
  assert.match(harness.elements["message-list"].textContent, /正在检查消息链路/);
  assert.match(harness.elements["message-list"].textContent, /正在运行 npm test/);
  assert.match(harness.elements["message-list"].textContent, /进行中/);
  assert.equal(harness.hooks.getState().currentThread.control.busy, true);

  emitSse(source, "desktopThread", {
    ...threadSummary("A"),
    partial: true,
    messages: [
      {
        id: "reasoning-live",
        role: "assistant",
        kind: "reasoning",
        text: "消息链路检查完成",
        activityStatus: "completed",
        timestamp: 2,
      },
      {
        id: "command-live",
        role: "system",
        kind: "activity",
        label: "终端",
        activityType: "command",
        activityStatus: "completed",
        text: "运行 npm test",
        timestamp: 2,
      },
    ],
    control: { busy: false, phase: "idle" },
  });

  assert.match(harness.elements["message-list"].textContent, /已思考/);
  assert.match(harness.elements["message-list"].textContent, /消息链路检查完成/);
  assert.doesNotMatch(harness.elements["message-list"].textContent, /进行中/);
  assert.equal(harness.hooks.getState().currentThread.control.busy, false);
});

test("optimistic messages show sending and delivered receipts", async () => {
  const sendResult = deferred();
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, threadDetail("A", "已有消息"));
    if (url === "/api/threads/A/messages") return sendResult.promise;
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "马上开始";
  const sending = harness.hooks.sendMessage({ preventDefault() {} });
  await eventually(() => harness.hooks.getState().sendingThreads.includes("A"));
  let userMessage = harness.elements["message-list"].children.at(-1);
  assert.equal(userMessage.children[2].textContent, "发送中");

  sendResult.resolve(jsonResponse(202, {
    delivery: "codex-app",
    control: { busy: true, phase: "starting" },
  }));
  await sending;
  userMessage = harness.elements["message-list"].children.at(-1);
  assert.equal(userMessage.children[2].textContent, "已送达");
  assert.equal(harness.hooks.getState().pendingMessage.deliveryState, "sent");
});

test("a rejected desktop-owned send restores the draft instead of showing delivered", async () => {
  const errorMessage = "这个任务正由 Codex Desktop 占用，Web 端无法可靠写入";
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, threadDetail("A", "已有消息"));
    if (url === "/api/threads/A/messages") {
      return jsonResponse(409, { error: errorMessage });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "继续执行";
  await harness.hooks.sendMessage({ preventDefault() {} });

  assert.equal(harness.hooks.getState().pendingMessage, null);
  assert.equal(harness.elements["message-input"].value, "继续执行");
  assert.equal(harness.elements["composer-status"].textContent, errorMessage);
  assert.doesNotMatch(harness.elements["message-list"].textContent, /继续执行|已送达/);
});

test("a running turn keeps the composer editable and exposes a separate stop action", async () => {
  const interruptResult = deferred();
  const calls = [];
  const detail = {
    ...threadDetail("A", "正在执行"),
    status: "active",
    control: {
      busy: true,
      phase: "running",
      turnId: "turn-1",
      requests: [],
    },
  };
  const harness = await createHarness(async (url, options = {}) => {
    calls.push({ url, method: options.method || "GET", body: options.body });
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    if (url === "/api/threads/A/interrupt") return interruptResult.promise;
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  assert.equal(harness.elements["message-input"].disabled, false);
  assert.equal(harness.elements["delivery-control"].hidden, false);
  assert.equal(harness.elements["interrupt-button"].hidden, false);
  assert.equal(harness.elements["send-button"].disabled, true);
  assert.equal(harness.elements["send-button"].dataset.action, "queue");
  assert.equal(harness.elements["send-button"].getAttribute("aria-label"), "加入等待");
  assert.equal(harness.elements["interrupt-button"].getAttribute("aria-label"), "中断任务");

  const interrupting = harness.hooks.interruptTurn({ preventDefault() {} });
  await eventually(() => harness.hooks.getState().interruptRequestThreads.includes("A"));
  assert.equal(harness.elements["composer-status"].textContent, "正在中断");
  assert.equal(harness.elements["interrupt-button"].disabled, true);
  assert.deepEqual(
    calls.filter((call) => call.method === "POST").map((call) => call.url),
    ["/api/threads/A/interrupt"],
  );

  interruptResult.resolve(jsonResponse(202, {
    interruption: "hard",
    control: { busy: true, phase: "interrupting", turnId: "turn-1" },
  }));
  await interrupting;
  assert.equal(harness.elements["composer-status"].textContent, "正在中断");
  assert.equal(harness.hooks.getState().interruptingThreads.includes("A"), true);

  emitSse(harness.eventSources.at(-1), "thread", {
    ...detail,
    status: "idle",
    control: { busy: false, phase: "idle", turnId: null, requests: [] },
  });
  assert.equal(harness.hooks.getState().interruptingThreads.includes("A"), false);
  assert.equal(harness.elements["message-input"].disabled, false);
  assert.equal(harness.elements["delivery-control"].hidden, true);
  assert.equal(harness.elements["interrupt-button"].hidden, true);
  assert.equal(harness.elements["send-button"].dataset.action, "start");
  assert.equal(harness.elements["composer-status"].textContent, "");

  harness.elements["message-input"].value = "继续处理下一步";
  harness.elements["message-input"].listeners.get("input")[0]();
  assert.equal(harness.elements["send-button"].disabled, false);
  assert.equal(harness.elements["send-button"].getAttribute("aria-label"), "发送消息");
});

test("a running turn queues a follow-up by default", async () => {
  let sentBody;
  const detail = {
    ...threadDetail("A", "正在执行"),
    status: "active",
    control: { busy: true, phase: "running", turnId: "turn-1", requests: [] },
    composerOptions: composerOptions(),
  };
  detail.messages[0].turnId = "turn-1";
  const harness = await createHarness(async (url, options = {}) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    if (url === "/api/threads/A/messages") {
      sentBody = JSON.parse(options.body);
      return jsonResponse(202, {
        delivery: "queued",
        turnId: null,
        control: {
          busy: true,
          phase: "running",
          turnId: "turn-1",
          queued: true,
          queue: { clientMessageId: sentBody.clientMessageId, text: sentBody.text },
        },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "完成后继续测试";
  harness.elements["message-input"].listeners.get("input")[0]();
  await harness.hooks.sendMessage({ preventDefault() {} });

  assert.equal(sentBody.action, "queue");
  assert.equal("expectedTurnId" in sentBody, false);
  assert.equal(harness.hooks.getState().pendingMessage.deliveryState, "queued");
  assert.equal(harness.elements["message-list"].children.at(-1).children[2].textContent, "等待中");
  assert.equal(harness.elements["send-button"].disabled, true);
  assert.match(harness.elements["composer-status"].textContent, /当前任务完成后发送/);
});

test("Steer sends input to the active turn with its expected turn id", async () => {
  let sentBody;
  const detail = {
    ...threadDetail("A", "正在执行"),
    status: "active",
    control: { busy: true, phase: "running", turnId: "turn-1", requests: [] },
    composerOptions: composerOptions(),
  };
  detail.messages[0].turnId = "turn-1";
  const harness = await createHarness(async (url, options = {}) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    if (url === "/api/threads/A/messages") {
      sentBody = JSON.parse(options.body);
      return jsonResponse(202, {
        delivery: "steered",
        turnId: "turn-1",
        control: { busy: true, phase: "running", turnId: "turn-1" },
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  const steer = harness.elements["delivery-control"].children[1];
  steer.listeners.get("click")[0]();
  harness.elements["message-input"].value = "先检查失败日志";
  harness.elements["message-input"].listeners.get("input")[0]();
  await harness.hooks.sendMessage({ preventDefault() {} });

  assert.equal(sentBody.action, "steer");
  assert.equal(sentBody.expectedTurnId, "turn-1");
  assert.equal(harness.hooks.getState().pendingMessage.deliveryState, "steered");
  assert.equal(harness.elements["send-button"].dataset.action, "steer");
  assert.equal(harness.elements["send-button"].getAttribute("aria-label"), "Steer 当前任务");
});

test("returning to authentication clears in-flight composer state", async () => {
  const sendResult = deferred();
  const detail = {
    ...threadDetail("A", "ready"),
    composerOptions: composerOptions(),
  };
  const harness = await createHarness(async (url, options = {}) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    if (url === "/api/threads/A/messages" && options.method === "POST") {
      return sendResult.promise;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "pending";
  const sending = harness.hooks.sendMessage({ preventDefault() {} });
  await eventually(() => harness.hooks.getState().sendingThreads.includes("A"));

  harness.hooks.showAuth("expired");

  const state = harness.hooks.getState();
  assert.equal(state.sendingThreads.length, 0);
  assert.equal(state.interruptingThreads.length, 0);
  assert.equal(state.interruptRequestThreads.length, 0);
  assert.equal(state.resolvingRequests.length, 0);
  assert.equal(state.goalUpdating, false);
  assert.equal(state.pendingMessage, null);
  assert.equal(harness.elements["auth-screen"].hidden, false);

  sendResult.resolve(jsonResponse(202, { control: { busy: true } }));
  await sending;
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
  assert.equal(rendered[0].tagName, "DETAILS");
  assert.equal(rendered[1].dataset.role, "user");
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
    rendered.slice(1).map((article) => article.dataset.role),
    ["user", "assistant"],
  );
  assert.deepEqual(
    rendered.slice(1).map((article) => article.children[1].textContent),
    ["test", "我在，继续即可。"],
  );

  sendResult.resolve(jsonResponse(202, { control: { busy: true } }));
  await sending;
  rendered = harness.elements["message-list"].children;
  assert.deepEqual(
    rendered.slice(1).map((article) => article.children[1].textContent),
    ["test", "我在，继续即可。"],
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
