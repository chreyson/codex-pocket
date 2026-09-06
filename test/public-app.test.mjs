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
  "connection-mode-warning",
  "conversation-title",
  "conversation-meta",
  "conversation-actions",
  "conversation-placeholder",
  "placeholder-title",
  "placeholder-detail",
  "message-list",
  "approval-tray",
  "composer",
  "queued-message-list",
  "composer-menu",
  "composer-extras",
  "extras-button",
  "extras-skills",
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
  "permission-control",
  "permission-label",
  "effort-label",
  "composer-status",
  "continue-web",
  "interrupt-button",
  "send-button",
  "back-button",
  "refresh-button",
  "network-banner",
  "network-message",
  "reconnect-button",
  "latest-button",
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
    this.style = { setProperty(name, value) { this[name] = value; } };
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

  prepend(...children) {
    this.children.unshift(...children);
  }

  contains(element) {
    return this === element || this.children.some((child) => child.contains?.(element));
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

async function createHarness(fetchImpl, { storedSelection, storage = new Map(), coarse = false } = {}) {
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
  elements["interrupt-button"].hidden = true;
  elements["interrupt-button"].setAttribute("aria-label", "中断任务");
  elements["skill-count"].hidden = true;
  elements["composer-extras"].hidden = true;
  elements["image-viewer"].hidden = true;
  for (const mode of ["default", "plan", "goal"]) {
    const button = new FakeElement("button");
    button.dataset.mode = mode;
    button.setAttribute("aria-checked", String(mode === "default"));
    elements["mode-control"].append(button);
  }

  const document = {
    visibilityState: "visible",
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
  const browserListeners = new Map();
  if (storedSelection !== undefined) storage.set("codex-pocket-composer-v1", storedSelection);
  const navigator = { onLine: true };
  const context = vm.createContext({
    // Rendering and sanitization run against a real DOM in the browser suite.
    renderMarkdown: (element, text) => { element.textContent = text; },
    AbortController,
    document,
    EventSource: FakeEventSource,
    EventTarget,
    MessageEvent,
    fetch: fetchImpl,
    history: { replaceState() {} },
    location: { hash: "", pathname: "/", search: "" },
    URLSearchParams,
    requestAnimationFrame,
    cancelAnimationFrame,
    clearTimeout,
    setTimeout,
    setImmediate,
    navigator,
    matchMedia: () => ({ matches: coarse }),
    addEventListener: (type, handler) => browserListeners.set(type, handler),
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  });
  const source = (await fs.readFile(APP_SOURCE_URL, "utf8"))
    .replace('import { renderMarkdown } from "./markdown.js";', "")
    .replace('import { createRequestTray } from "./user-requests.js";',
      (await fs.readFile(new URL("../public/user-requests.js", import.meta.url), "utf8")).replace("export function createRequestTray", "function createRequestTray"));
  const hooks = `\n;globalThis.__appTest = {
    selectThread,
    createProjectThread,
    sendMessage,
    continueInWeb,
    interruptTurn,
    connectEvents,
    syncSelectedThread,
    reconnect,
    saveDraft,
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
    }),
  };`;
  vm.runInContext(`"use strict";\n${source}${hooks}`, context, { filename: "public/app.js" });
  await eventually(() => !elements.app.hidden);
  return {
    elements,
    eventSources: FakeEventSource.instances,
    hooks: context.__appTest,
    storage,
    navigator,
    browserListeners,
    flushAnimationFrames,
    pendingAnimationFrames: () => animationFrames.size,
  };
}

function mobileFetch(url) {
  if (url === "/api/bootstrap") return jsonResponse(200, {
    transports: ["sse", "poll"],
    status: { state: "ready" }, threads: [threadSummary("A"), threadSummary("B")],
  });
  const id = url.split("/").at(-1);
  return jsonResponse(200, threadDetail(id, `Conversation ${id}`));
}

test("a successful HTTP response with invalid JSON is not treated as a delivered message", async () => {
  const harness = await createHarness((url) => url.endsWith("/messages")
    ? { ok: true, status: 200, json: async () => { throw new SyntaxError("bad JSON"); } }
    : mobileFetch(url));
  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "preserve uncertain delivery";
  await harness.hooks.sendMessage({ preventDefault() {} });
  assert.equal(harness.elements["message-input"].value, "preserve uncertain delivery");
  assert.equal(harness.hooks.getState().pendingMessage, null);
});

test("text drafts survive A to B navigation and a page reload", async () => {
  const storage = new Map();
  const first = await createHarness(mobileFetch, { storage });
  await first.hooks.selectThread("A");
  first.elements["message-input"].value = "A 的未发送草稿\n第二行";
  await first.hooks.selectThread("B");
  assert.equal(first.elements["message-input"].value, "");
  first.elements["message-input"].value = "B 的未发送草稿";
  await first.hooks.selectThread("A");
  assert.equal(first.elements["message-input"].value, "A 的未发送草稿\n第二行");
  const reloaded = await createHarness(mobileFetch, { storage });
  await eventually(() => reloaded.hooks.getState().currentThread?.id === "A");
  assert.equal(reloaded.elements["message-input"].value, "A 的未发送草稿\n第二行");
});

test("expired and malformed drafts are not restored", async () => {
  const storage = new Map([["codex-pocket-drafts-v1", JSON.stringify([
    ["A", { text: "expired", updatedAt: Date.now() - 8 * 86400000 }],
    ["B", { text: {}, updatedAt: Date.now() }],
  ])]]);
  const harness = await createHarness(mobileFetch, { storage });
  await harness.hooks.selectThread("A");
  assert.equal(harness.elements["message-input"].value, "");
  await harness.hooks.selectThread("B");
  assert.equal(harness.elements["message-input"].value, "");
});

test("refresh synchronizes in place without discarding text or attachments", async () => {
  const harness = await createHarness(async (url) => url === "/api/uploads"
    ? jsonResponse(200, { image: { id: "image-1", src: "/api/images/image-1" } })
    : mobileFetch(url));
  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "keep this draft";
  await harness.hooks.addPendingImages([{ name: "test.png", type: "image/png", size: 10 }]);
  const epoch = harness.hooks.getState().selectionEpoch;
  await harness.hooks.syncSelectedThread();
  assert.equal(harness.elements["message-input"].value, "keep this draft");
  assert.equal(harness.hooks.getState().pendingImages.length, 1);
  assert.equal(harness.hooks.getState().selectionEpoch, epoch);
});

test("a successful HTTP probe cannot falsely mark a broken event stream as connected", async () => {
  const harness = await createHarness(mobileFetch);
  await harness.hooks.selectThread("A");
  await harness.eventSources.at(-1).onerror();
  assert.equal(harness.elements["connection-state"].dataset.state, "disconnected");
  assert.equal(harness.elements["network-banner"].hidden, false);
  harness.hooks.showAuth();
});

test("SSE failure switches to snapshot synchronization while preserving the draft", async (t) => {
  const harness = await createHarness((url) => url.startsWith("/api/sync")
    ? jsonResponse(200, { events: [
      { event: "thread", value: threadDetail("A", "HTTPS recovered output") },
      { event: "status", value: { state: "ready" } },
    ] }) : mobileFetch(url));
  t.after(() => harness.hooks.showAuth());
  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "keep working draft";
  await harness.eventSources.at(-1).onerror();
  assert.equal(harness.elements["connection-state"].dataset.state, "ready");
  assert.equal(harness.elements["message-input"].value, "keep working draft");
  assert.equal(harness.hooks.getState().eventSource.url, "/api/sync?threadId=A");
  assert.match(harness.elements["message-list"].textContent, /HTTPS recovered output/);
});

test("offline editing saves a draft, blocks sends and reconnects without replaying them", async () => {
  let posts = 0;
  const harness = await createHarness((url, options) => {
    if (options?.method === "POST") posts++;
    return mobileFetch(url);
  });
  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "offline draft";
  harness.navigator.onLine = false;
  harness.browserListeners.get("offline")();
  await harness.hooks.sendMessage({ preventDefault() {} });
  assert.equal(posts, 0);
  assert.equal(harness.elements["send-button"].disabled, true);
  assert.equal(harness.elements["message-input"].disabled, false);
  harness.navigator.onLine = true;
  harness.browserListeners.get("online")();
  assert.equal(posts, 0);
  assert.equal(harness.elements["message-input"].value, "offline draft");
  assert.equal(harness.eventSources.at(-1).url, "/api/events?threadId=A");
});

test("mobile Return inserts a newline while desktop Return sends, and IME never submits", async () => {
  for (const coarse of [true, false]) {
    const harness = await createHarness(mobileFetch, { coarse });
    let submits = 0;
    harness.elements.composer.requestSubmit = () => submits++;
    const handler = harness.elements["message-input"].listeners.get("keydown")[0];
    handler({ key: "Enter", isComposing: true, preventDefault() {} });
    assert.equal(submits, 0);
    handler({ key: "Enter", preventDefault() {} });
    assert.equal(submits, coarse ? 0 : 1);
    handler({ key: "Enter", metaKey: true, preventDefault() {} });
    assert.equal(submits, coarse ? 1 : 2);
  }
});

test("a failed send retains its draft after navigating to another thread", async () => {
  const response = deferred();
  const harness = await createHarness((url) => url.endsWith("/messages") ? response.promise : mobileFetch(url));
  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "do not lose this";
  const sending = harness.hooks.sendMessage({ preventDefault() {} });
  await harness.hooks.selectThread("B");
  response.resolve(jsonResponse(503, { error: "offline" }));
  await sending;
  await harness.hooks.selectThread("A");
  assert.equal(harness.elements["message-input"].value, "do not lose this");
});

test("writer conflicts offer an explicit Web continuation and preserve the draft", async () => {
  let forks = 0;
  let sends = 0;
  const harness = await createHarness((url) => {
    if (url.endsWith("/messages")) {
      sends++;
      return jsonResponse(409, { code: "THREAD_CONTINUATION_REQUIRED", error: "保留历史创建续接会话" });
    }
    if (url.endsWith("/continue")) { forks++; return jsonResponse(201, { thread: { id: "B", title: "Web continuation" } }); }
    return mobileFetch(url);
  });
  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "continue my work";
  await harness.hooks.sendMessage({ preventDefault() {} });
  assert.equal(forks, 0);
  assert.equal(harness.elements["continue-web"].hidden, false);
  assert.equal(harness.elements["message-input"].value, "continue my work");
  await harness.hooks.continueInWeb();
  assert.equal(forks, 1);
  assert.equal(sends, 1);
  assert.equal(harness.hooks.getState().selectedThreadId, "B");
  assert.equal(harness.elements["message-input"].value, "continue my work");
  assert.equal(harness.elements["continue-web"].hidden, true);
  await harness.hooks.selectThread("A");
  assert.equal(harness.elements["message-input"].value, "continue my work");
});

test("Web continuation retains uploaded images and ignores repeated clicks", async () => {
  const response = deferred();
  let forks = 0;
  const image = { id: `img_${"a".repeat(32)}`, src: "/api/images/upload", mimeType: "image/png" };
  const harness = await createHarness((url) => {
    if (url === "/api/uploads") return jsonResponse(201, { image });
    if (url.endsWith("/messages")) return jsonResponse(409, { code: "THREAD_CONTINUATION_REQUIRED", error: "continue" });
    if (url.endsWith("/continue")) { forks++; return response.promise; }
    return mobileFetch(url);
  });
  await harness.hooks.selectThread("A");
  await harness.hooks.addPendingImages([{ name: "screen.png", type: "image/png", size: 128 }]);
  await harness.hooks.sendMessage({ preventDefault() {} });
  const continuing = harness.hooks.continueInWeb();
  await harness.hooks.continueInWeb();
  response.resolve(jsonResponse(201, { thread: { id: "B", title: "Continuation" } }));
  await continuing;
  assert.equal(forks, 1);
  assert.equal(harness.hooks.getState().pendingImages[0].id, image.id);
  assert.equal(harness.elements["composer-images"].hidden, false);
});

test("uploads finish in the originating task while another task is open", async () => {
  const response = deferred();
  let deletions = 0;
  const harness = await createHarness((url, options) => {
    if (url === "/api/uploads") return response.promise;
    if (options?.method === "DELETE") { deletions++; return jsonResponse(200, {}); }
    return mobileFetch(url);
  });
  await harness.hooks.selectThread("A");
  const upload = harness.hooks.addPendingImages([{ name: "screen.png", type: "image/png", size: 128 }]);
  await harness.hooks.selectThread("B");
  response.resolve(jsonResponse(201, { image: { id: "image-a", src: "/api/images/image-a" } }));
  await upload;
  assert.equal(harness.hooks.getState().pendingImages.length, 0);
  await harness.hooks.selectThread("A");
  assert.equal(harness.hooks.getState().pendingImages[0].id, "image-a");
  assert.equal(harness.hooks.getState().pendingImages[0].status, "ready");
  assert.equal(deletions, 0);
});

test("opening a task restores its actual desktop model and mode", async () => {
  const harness = await createHarness((url) => {
    if (url === "/api/threads/A") return jsonResponse(200, {
      ...threadDetail("A", "history"),
      composerOptions: {
        models: [{ id: "desktop-model", efforts: [{ id: "high" }], defaultEffort: "high" }],
        modes: ["default", "plan"], skills: [],
        currentSelection: { model: "desktop-model", effort: "high", mode: "plan" },
      },
    });
    return mobileFetch(url);
  });
  await harness.hooks.selectThread("A");
  const selection = harness.hooks.getState().composerSelection;
  assert.equal(selection.model, "desktop-model");
  assert.equal(selection.effort, "high");
  assert.equal(selection.mode, "plan");
});

test("refresh picks up model settings changed on desktop", async () => {
  let model = "first";
  const harness = await createHarness((url) => {
    if (url === "/api/threads/A") return jsonResponse(200, {
      ...threadDetail("A", "history"),
      composerOptions: {
        models: ["first", "second"].map((id) => ({ id, efforts: [{ id: "high" }], defaultEffort: "high" })),
        modes: ["default"], skills: [],
        currentSelection: { model, effort: "high", mode: "default" },
      },
    });
    return mobileFetch(url);
  });
  await harness.hooks.selectThread("A");
  model = "second";
  await harness.hooks.syncSelectedThread();
  assert.equal(harness.hooks.getState().composerSelection.model, "second");
});

test("returning to an in-flight send does not resurrect an acknowledged draft", async () => {
  const response = deferred();
  const harness = await createHarness((url) => url.endsWith("/messages") ? response.promise : mobileFetch(url));
  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "send this once";
  const sending = harness.hooks.sendMessage({ preventDefault() {} });
  await harness.hooks.selectThread("B");
  await harness.hooks.selectThread("A");
  response.resolve(jsonResponse(200, { turnId: "turn-1", control: { busy: true } }));
  await sending;
  assert.equal(harness.elements["message-input"].value, "");
  assert.equal(JSON.parse(harness.storage.get("codex-pocket-drafts-v1")).length, 0);
});

test("stale refresh failures cannot mark a newly selected thread disconnected", async () => {
  let defer = false;
  const response = deferred();
  const harness = await createHarness((url) => defer && url === "/api/threads/A" ? response.promise : mobileFetch(url));
  await harness.hooks.selectThread("A");
  defer = true;
  const refreshing = harness.hooks.syncSelectedThread();
  await harness.hooks.selectThread("B");
  response.resolve(jsonResponse(500, { error: "stale error" }));
  await refreshing;
  assert.notEqual(harness.elements["connection-state"].dataset.state, "disconnected");
  assert.equal(harness.hooks.getState().currentThread.id, "B");
});

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

test("sidebar shows one row per task ID across initial load and live catalog refresh", async () => {
  const a = { ...threadSummary("A"), title: "Same title", project: "Shared project" };
  const b = { ...a, id: "B" };
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") return jsonResponse(200, { status: { state: "ready" }, threads: [a, b, { ...a, project: "Obsolete project" }] });
    if (url === "/api/threads/A") return jsonResponse(200, threadDetail("A", ""));
    throw new Error(`Unexpected fetch: ${url}`);
  });
  assert.equal(harness.elements["thread-list"].children.length, 1);
  assert.equal(harness.elements["thread-list"].children[0].children[1].children.length, 2);
  await harness.hooks.selectThread("A");
  emitSse(harness.eventSources.at(-1), "threads", [a, b, a]);
  const rows = harness.elements["thread-list"].children[0].children[1].children.map((row) => row.children[0]);
  assert.deepEqual(rows.map((row) => row.dataset.threadId), ["A", "B"]);
  assert.equal(rows.filter((row) => row.getAttribute("aria-current") === "true").length, 1);
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
      { id: "old-thinking", role: "assistant", kind: "reasoning", activityStatus: "completed", text: "Past internal detail" },
      { id: "file-1", role: "system", kind: "activity", label: "文件", activityType: "command", activityActions: ["read"], activityStatus: "completed", text: "读取 app.js", timestamp: 1 },
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
  assert.equal(rendered.length, 2);
  const activity = rendered[0].children[1].children[1];
  assert.equal(activity.dataset.kind, "activityGroup");
  const disclosure = activity.children[0];
  assert.equal(disclosure.tagName, "DETAILS");
  assert.equal(disclosure.open, false);
  assert.equal(disclosure.children[0].textContent, "已读取文件、运行了命令");
  assert.doesNotMatch(rendered[0].textContent, /已思考|Past internal detail|项操作/);
  assert.doesNotMatch(disclosure.children[0].textContent, /rg|app\.js/);
  assert.match(activity.textContent, /运行 rg -n renderThread public\/app\.js/);
  assert.match(activity.textContent, /×2/);
  assert.match(activity.textContent, /读取 app\.js/);
  disclosure.open = true;
  emitSse(harness.eventSources.at(-1), "thread", {
    ...detail,
    messages: detail.messages.map((message) => message.id === "file-1"
      ? { ...message, text: "读取 styles.css" } : message),
  });
  assert.equal(disclosure.open, true);
});

test("completed processes collapse while every request and conclusion stays visible", async () => {
  const summary = threadSummary("A");
  const detail = {
    ...summary,
    messages: [
      { id: "old-user", turnId: "turn-old", role: "user", kind: "message", text: "检查旧问题", timestamp: 1 },
      { id: "old-progress", turnId: "turn-old", role: "assistant", kind: "commentary", text: "正在检查", timestamp: 1 },
      { id: "old-answer", turnId: "turn-old", role: "assistant", kind: "message", text: "旧问题已处理", timestamp: 1 },
      { id: "new-user", turnId: "turn-new", role: "user", kind: "message", text: "继续新任务", timestamp: 2 },
      { id: "new-progress", turnId: "turn-new", role: "assistant", kind: "commentary", text: "正在读取", timestamp: 2 },
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
  assert.equal(rendered.length, 6);
  assert.equal(rendered[1].tagName, "DETAILS");
  assert.equal(rendered[1].open, false);
  assert.match(rendered[1].children[0].textContent, /执行过程/);
  assert.deepEqual([rendered[0], rendered[2], rendered[3], rendered[5]].map((node) => node.dataset.role), ["user", "assistant", "user", "assistant"]);

  rendered[1].open = true;
  rendered[1].listeners.get("toggle")[0]();
  emitSse(harness.eventSources.at(-1), "thread", {
    ...detail,
    messages: detail.messages.map((message) => message.id === "new-answer"
      ? { ...message, text: "新任务已更新" }
      : message),
  });
  rendered = harness.elements["message-list"].children;
  assert.equal(rendered[1].open, true);
  assert.match(rendered.at(-1).textContent, /新任务已更新/);
});

test("desktop timing fills a completed process without losing older measured durations", async () => {
  const detail = {
    ...threadSummary("A"),
    turns: [{ id: "older", durationMs: 30000 }, { id: "turn-1", durationMs: null }],
    messages: [
      { id: "user-1", turnId: "turn-1", role: "user", kind: "message", text: "检查任务" },
      { id: "progress-1", turnId: "turn-1", role: "assistant", kind: "commentary", text: "正在检查" },
      { id: "answer-1", turnId: "turn-1", role: "assistant", kind: "message", text: "已完成" },
    ],
    control: { busy: false, requests: [] },
  };
  const harness = await createHarness(async (url) => {
    if (url === "/api/bootstrap") return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    throw new Error(`Unexpected fetch: ${url}`);
  });
  await harness.hooks.selectThread("A");
  const process = harness.elements["message-list"].children[1];
  assert.equal(process.children[0].textContent, "执行过程");
  process.open = true;
  const source = harness.eventSources.at(-1);
  emitSse(source, "desktopThread", {
    id: "A", turns: [{ id: "turn-1", durationMs: 442502 }], messages: [],
  });
  assert.equal(process.children[0].textContent, "用时 7分23秒");
  assert.equal(process.open, true);
  emitSse(source, "desktopThread", {
    id: "A", turns: [{ id: "turn-1", durationMs: null }], messages: [],
  });
  assert.equal(process.children[0].textContent, "用时 7分23秒");
  const timings = harness.hooks.getState().currentThread.turns;
  assert.equal(timings.find((turn) => turn.id === "older").durationMs, 30000);
  assert.equal(timings.find((turn) => turn.id === "turn-1").durationMs, 442502);
});

test("each user command keeps its own process even when raw turn ids disagree", async () => {
  const summary = threadSummary("A");
  const firstCommand = "First command keeps its complete prompt in the history heading, including this tail marker";
  const detail = {
    ...summary,
    messages: [
      { id: "command-1", turnId: "shared-turn", role: "user", kind: "message", text: firstCommand, timestamp: 1 },
      { id: "answer-1", turnId: "shared-turn", role: "assistant", kind: "message", text: "First response", timestamp: 1 },
      { id: "command-2", turnId: "shared-turn", role: "user", kind: "message", text: "Steer command", timestamp: 2 },
      { id: "activity-2", turnId: "different-turn", role: "system", kind: "activity", label: "Tool", activityType: "tool", activityStatus: "completed", text: "Tool output", timestamp: 2 },
      { id: "answer-2", turnId: "different-turn", role: "assistant", kind: "message", text: "Second response", timestamp: 2 },
      { id: "command-3", turnId: "latest-turn", role: "user", kind: "message", text: "Latest command", timestamp: 3 },
      { id: "answer-3", turnId: "latest-turn", role: "assistant", kind: "message", text: "Latest response", timestamp: 3 },
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
  const rendered = harness.elements["message-list"].children;
  assert.equal(rendered.length, 7);
  assert.match(rendered[0].textContent, /tail marker/);
  assert.equal(rendered[3].tagName, "DETAILS");
  assert.match(rendered[3].children[1].textContent, /Tool output/);
  assert.doesNotMatch(rendered[3].textContent, /Steer command|Second response/);
  assert.deepEqual(rendered.slice(4).map((node) => node.dataset.role), ["assistant", "user", "assistant"]);
});

test("errors and conclusions stay visible even without a preceding user command", async () => {
  const summary = threadSummary("A");
  const detail = {
    ...summary,
    messages: [
      { id: "orphan-error", turnId: "orphan-a", role: "system", kind: "error", text: "Earlier failure", timestamp: 1 },
      { id: "orphan-answer", turnId: "orphan-b", role: "assistant", kind: "message", text: "Earlier continuation", timestamp: 2 },
      { id: "command-old", turnId: "turn-old", role: "user", kind: "message", text: "Visible old command", timestamp: 3 },
      { id: "answer-old", turnId: "turn-old", role: "assistant", kind: "message", text: "Visible old response", timestamp: 3 },
      { id: "command-new", turnId: "turn-new", role: "user", kind: "message", text: "Latest command", timestamp: 4 },
      { id: "answer-new", turnId: "turn-new", role: "assistant", kind: "message", text: "Latest response", timestamp: 4 },
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
  const rendered = harness.elements["message-list"].children;
  assert.equal(rendered.length, 6);
  assert.match(rendered[0].textContent, /Earlier failure/);
  assert.match(rendered[1].textContent, /Earlier continuation/);
  assert.deepEqual(rendered.slice(2).map((node) => node.dataset.role), ["user", "assistant", "user", "assistant"]);
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

test("effort slider follows fractional drags, snaps, and restores Ultra styling", async () => {
  const catalog = composerOptions();
  catalog.models[0].efforts = ["low", "medium", "high", "xhigh", "max", "ultra"].map((id) => ({ id }));
  const detail = { ...threadDetail("A", "ready"), composerOptions: catalog };
  const harness = await createHarness(async (url) => jsonResponse(200,
    url === "/api/bootstrap" ? { status: { state: "ready" }, threads: [threadSummary("A")] } : detail));
  await harness.hooks.selectThread("A");
  harness.elements["model-control"].listeners.get("click")[0]();
  const panel = harness.elements["composer-menu"].children[0];
  const track = panel.children[2];
  const slider = track.children[3];
  slider.listeners.get("pointerdown")[0]();
  slider.value = "3.65";
  slider.listeners.get("input")[0]();
  assert.equal(slider.value, "3.65");
  assert.equal(track.style["--effort-progress"], "0.73");
  assert.equal(harness.hooks.getState().composerSelection.effort, "max");
  slider.listeners.get("change")[0]();
  assert.equal(slider.value, "4");
  assert.equal(track.dataset.dragging, "false");
  slider.listeners.get("keydown")[0]({ key: "End", preventDefault() {} });
  assert.equal(slider.value, "5");
  assert.equal(panel.dataset.effort, "ultra");
  assert.equal(slider.getAttribute("aria-valuetext"), "Ultra");
  slider.listeners.get("keydown")[0]({ key: "ArrowLeft", preventDefault() {} });
  assert.equal(slider.value, "4");
  assert.equal(panel.dataset.effort, "max");
  panel.children[1].listeners.get("click")[0]();
  assert.equal(slider.value, "0");
  assert.equal(panel.dataset.effort, "low");
});

test("all skills expand and collapse inside the existing extras menu", async () => {
  const catalog = composerOptions();
  catalog.skills = Array.from({ length: 9 }, (_, index) => ({ name: `skill-${index}`, enabled: index < 8 }));
  const detail = { ...threadDetail("A", "ready"), composerOptions: catalog };
  const harness = await createHarness(async (url) => jsonResponse(200,
    url === "/api/bootstrap" ? { status: { state: "ready" }, threads: [threadSummary("A")] } : detail));
  await harness.hooks.selectThread("A");
  const { elements } = harness;
  const open = () => elements["extras-button"].listeners.get("click")[0]();
  const toggle = () => elements["skill-control"].listeners.get("click")[0]();
  open();
  assert.equal(elements["extras-skills"].children.length, 6);
  elements["composer-extras"].scrollTop = 72;
  toggle();
  assert.equal(elements["composer-extras"].hidden, false);
  assert.equal(elements["composer-menu"].hidden, true);
  assert.equal(elements["extras-skills"].children.length, 8);
  assert.equal(elements["composer-extras"].scrollTop, 72);
  assert.equal(elements["skill-control"].getAttribute("aria-expanded"), "true");
  assert.equal(elements["skill-label"].textContent, "收起技能");
  toggle();
  assert.equal(elements["extras-skills"].children.length, 6);
  assert.equal(elements["skill-control"].getAttribute("aria-expanded"), "false");
  toggle();
  elements["extras-skills"].children[7].listeners.get("click")[0]();
  assert.deepEqual(Array.from(harness.hooks.getState().composerSelection.skillNames), ["skill-7"]);
  assert.equal(elements["composer-extras"].hidden, true);
  open();
  assert.equal(elements["extras-skills"].children.length, 6);
});

test("message actions copy the latest text and show the provided message time", async () => {
  const detail = threadDetail("A", "First answer");
  detail.messages[0].timestamp = 1788605100;
  const harness = await createHarness(async (url) => jsonResponse(200,
    url === "/api/bootstrap" ? { status: { state: "ready" }, threads: [threadSummary("A")] } : detail));
  const copied = [];
  harness.navigator.clipboard = { async writeText(value) { copied.push(value); } };
  await harness.hooks.selectThread("A");
  const article = harness.elements["message-list"].children[0];
  const actions = article.children.find((child) => child.className === "message-actions");
  const [copy, time, status] = actions.children;
  assert.equal(actions.hidden, false);
  assert.match(time.textContent, /^\d{2}:\d{2}$/);
  assert.equal(time.dateTime, new Date(detail.messages[0].timestamp * 1000).toISOString());
  await copy.listeners.get("click")[0]();
  assert.deepEqual(copied, ["First answer"]);
  assert.equal(status.textContent, "已复制");
  detail.messages[0].text = "Updated **answer**";
  await harness.hooks.syncSelectedThread();
  await copy.listeners.get("click")[0]();
  assert.deepEqual(copied, ["First answer", "Updated **answer**"]);
  assert.equal(copy.getAttribute("aria-label"), "已复制");
  harness.navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied"); };
  await copy.listeners.get("click")[0]();
  assert.equal(copy.dataset.state, "error");
  assert.equal(status.textContent, "复制失败");
});

test("one response footer copies all answer parts without process text or another request", async () => {
  const detail = threadDetail("A", "");
  const item = (id, role, kind, text) => ({ id, role, kind, text, turnId: "shared-source-turn", timestamp: 1788605100 });
  detail.messages = [
    item("request-one", "user", "message", "First request"),
    item("progress", "assistant", "commentary", "Checking files"),
    item("answer-one", "assistant", "message", "First paragraph"),
    item("answer-two", "assistant", "message", "Second paragraph"),
    item("request-two", "user", "message", "Next request"),
    item("next-answer", "assistant", "message", "Separate answer"),
  ];
  const harness = await createHarness(async (url) => jsonResponse(200,
    url === "/api/bootstrap" ? { status: { state: "ready" }, threads: [threadSummary("A")] } : detail));
  const copied = [];
  harness.navigator.clipboard = { async writeText(value) { copied.push(value); } };
  await harness.hooks.selectThread("A");
  const [, process, firstPart, lastPart, , nextAnswer] = harness.elements["message-list"].children;
  const actions = (article) => article.children.find((child) => child.className === "message-actions");
  assert.equal(actions(process.children[1].children[0]).hidden, true);
  assert.equal(actions(firstPart).hidden, true);
  assert.equal(actions(lastPart).hidden, false);
  assert.equal(actions(nextAnswer).hidden, false);
  firstPart.listeners.get("pointerenter")[0]({ pointerType: "mouse" });
  assert.equal(lastPart.dataset.responseHovered, "true");
  firstPart.listeners.get("pointerleave")[0]();
  assert.equal(lastPart.dataset.responseHovered, undefined);
  firstPart.listeners.get("pointerup")[0]({ pointerType: "touch", target: firstPart });
  assert.equal(lastPart.dataset.actionsActive, "true");
  await actions(lastPart).children[0].listeners.get("click")[0]();
  await actions(nextAnswer).children[0].listeners.get("click")[0]();
  assert.deepEqual(copied, ["First paragraph\n\nSecond paragraph", "Separate answer"]);
  detail.messages[3].text = "Updated second paragraph";
  await harness.hooks.syncSelectedThread();
  await actions(lastPart).children[0].listeners.get("click")[0]();
  assert.equal(copied.at(-1), "First paragraph\n\nUpdated second paragraph");
});

test("touch selects only one message action row and unknown timestamps stay hidden", async () => {
  const detail = threadDetail("A", "First");
  detail.messages.push({ id: "next-request", role: "user", kind: "message", text: "Continue" });
  detail.messages.push({ ...detail.messages[0], id: "second", text: "Second", timestamp: null });
  const harness = await createHarness(async (url) => jsonResponse(200,
    url === "/api/bootstrap" ? { status: { state: "ready" }, threads: [threadSummary("A")] } : detail));
  await harness.hooks.selectThread("A");
  const [first, , second] = harness.elements["message-list"].children;
  first.listeners.get("pointerup")[0]({ pointerType: "touch", target: first });
  assert.equal(first.dataset.actionsActive, "true");
  second.listeners.get("pointerup")[0]({ pointerType: "touch", target: second });
  assert.equal(first.dataset.actionsActive, undefined);
  assert.equal(second.dataset.actionsActive, "true");
  second.listeners.get("pointerup")[0]({ pointerType: "touch", target: second });
  assert.equal(second.dataset.actionsActive, undefined);
  assert.equal(second.children.find((child) => child.className === "message-actions").children[1].hidden, true);
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
  harness.elements["composer-menu"].children[0].children[0].listeners.get("click")[0]();
  const modelList = harness.elements["composer-menu"].children[1];
  modelList.children[1].listeners.get("click")[0]();
  assert.equal(harness.elements["model-label"].textContent, "GPT Terra");
  assert.equal(harness.elements["effort-label"].textContent, "中");

  harness.elements["extras-button"].listeners.get("click")[0]();
  const skillList = harness.elements["extras-skills"];
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

test("desktop snapshots show current thinking status but omit past thinking and its content", async () => {
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
  assert.doesNotMatch(harness.elements["message-list"].textContent, /正在检查消息链路/);
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

  assert.doesNotMatch(harness.elements["message-list"].textContent, /已思考|思考中|消息链路检查完成/);
  assert.doesNotMatch(harness.elements["message-list"].textContent, /进行中/);
  assert.equal(harness.hooks.getState().currentThread.control.busy, false);
});

test("an older in-progress thinking record never replaces the latest completed thinking", async () => {
  const detail = { ...threadDetail("A", "Ready"), control: { busy: true, turnId: "active", requests: [] }, messages: [
    { id: "r1", turnId: "active", role: "assistant", kind: "reasoning", activityStatus: "inProgress", text: "Old thinking" },
    { id: "r2", turnId: "active", role: "assistant", kind: "reasoning", activityStatus: "completed", text: "Current completed thinking" },
    { id: "tool", turnId: "active", role: "system", kind: "activity", activityType: "command", activityStatus: "running", text: "Running test" },
  ] };
  const harness = await createHarness(async (url) => url === "/api/bootstrap"
    ? jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] })
    : jsonResponse(200, detail));
  await harness.hooks.selectThread("A");
  assert.doesNotMatch(harness.elements["message-list"].textContent, /思考|thinking/);
  assert.match(harness.elements["message-list"].textContent, /正在运行命令/);
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
  emitSse(harness.eventSources.at(-1), "desktopThread", {
    ...threadSummary("A"),
    partial: true,
    messages: [],
    control: { busy: false, phase: "idle", turnId: null },
  });
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
  assert.equal(harness.hooks.getState().currentThread.control.busy, true);
});

test("a rejected send restores the draft instead of showing delivered", async () => {
  const errorMessage = "Codex Desktop 持有这个会话，当前无法从 Web 端转交图片";
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
  assert.equal(harness.elements["composer-status"].textContent, "");
  assert.equal(harness.elements["interrupt-button"].hidden, true);
  assert.equal(harness.elements["send-button"].disabled, false);
  assert.equal(harness.elements["send-button"].dataset.action, "stop");
  assert.equal(harness.elements["send-button"].getAttribute("aria-label"), "停止");
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
    composerOptions: { ...composerOptions(), followUpQueueMode: "steer" },
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
  assert.equal(harness.hooks.getState().pendingMessage, null);
  assert.match(harness.elements["queued-message-list"].textContent, /完成后继续测试/);
  assert.equal(harness.elements["send-button"].disabled, false);
  assert.equal(harness.elements["send-button"].dataset.action, "stop");
  assert.equal(harness.elements["composer-status"].textContent, "");
  harness.elements["message-input"].value = "下一条";
  harness.elements["message-input"].listeners.get("input")[0]();
  assert.equal(harness.elements["send-button"].disabled, false);
});

test("adjust direction sends only the chosen waiting message and keeps new input in queue mode", async () => {
  let sentBody;
  const detail = {
    ...threadDetail("A", "正在执行"),
    status: "active",
    control: { busy: true, phase: "running", turnId: "turn-1", requests: [], queue: [{ id: "queued-1", text: "先检查失败日志" }] },
    composerOptions: composerOptions(),
  };
  detail.messages[0].turnId = "turn-1";
  const harness = await createHarness(async (url, options = {}) => {
    if (url === "/api/bootstrap") {
      return jsonResponse(200, { status: { state: "ready" }, threads: [threadSummary("A")] });
    }
    if (url === "/api/threads/A") return jsonResponse(200, detail);
    if (url === "/api/threads/A/queue/queued-1") {
      sentBody = JSON.parse(options.body);
      detail.control.queue = [];
      return jsonResponse(202, {
        control: detail.control,
      });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  await harness.hooks.selectThread("A");
  assert.equal(sentBody, undefined);
  const steer = harness.elements["queued-message-list"].children[0].children[2].children[0];
  assert.equal(steer.textContent, "调整方向");
  harness.elements["message-input"].value = "之后检查其他日志";
  harness.elements["message-input"].listeners.get("input")[0]();
  steer.listeners.get("click")[0]();
  await eventually(() => sentBody);
  assert.deepEqual(sentBody, { action: "send" });
  assert.equal(harness.elements["message-input"].value, "之后检查其他日志");
  assert.equal(harness.elements["send-button"].dataset.action, "queue");
  assert.equal(harness.elements["send-button"].getAttribute("aria-label"), "加入等待");
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
  assert.equal(rendered[0].dataset.role, "assistant");
  assert.match(rendered[0].textContent, /earlier message/);
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

test("an SSE fallback that receives unauthorized returns to sign-in", async () => {
  let bootstrapCalls = 0;
  const harness = await createHarness(async (url) => {
    if (url !== "/api/bootstrap" && url !== "/api/sync") throw new Error(`Unexpected fetch: ${url}`);
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

test("an idle snapshot closes a missed completion without losing text or replaying old deltas", async () => {
  const idle = { ...emptyThreadDetail("A"), control: { busy: false, turnId: null, requests: [] }, turns: [{ id: "turn-1", status: "completed" }] };
  const harness = await createHarness(async (url) => jsonResponse(200, url === "/api/bootstrap"
    ? { status: { state: "ready" }, threads: [threadSummary("A")] } : idle));
  await harness.hooks.selectThread("A");
  const source = harness.eventSources.at(-1);
  emitSse(source, "thread", { ...idle, turns: [{ id: "turn-1", status: "inProgress" }], control: { busy: true, turnId: "turn-1", requests: [] } });
  const live = { threadId: "A", turnId: "turn-1", itemId: "live-1", text: "完整回复", kind: "message" };
  emitSse(source, "messageStart", live);
  emitSse(source, "messageDelta", { ...live, delta: "过期增量" });
  emitSse(source, "thread", idle);
  harness.flushAnimationFrames();
  assert.equal(harness.hooks.getState().currentThread.control.busy, false);
  assert.equal(harness.elements["interrupt-button"].hidden, true);
  assert.match(harness.elements["message-list"].textContent, /完整回复/);
  assert.doesNotMatch(harness.elements["message-list"].textContent, /过期增量/);
  emitSse(source, "messageStart", live);
  emitSse(source, "messageDelta", { ...live, delta: "重放增量" });
  emitSse(source, "queueStarted", { threadId: "A", turnId: "turn-1" });
  harness.flushAnimationFrames();
  assert.equal(harness.hooks.getState().currentThread.control.busy, false);
  harness.elements["message-input"].value = "继续";
  harness.elements["message-input"].listeners.get("input")[0]();
  assert.equal(harness.elements["send-button"].disabled, false);
  assert.equal(harness.elements["send-button"].dataset.action, "start");
  emitSse(source, "thread", { ...idle, messages: [{ id: "live-1", turnId: "turn-1", role: "assistant", kind: "message", text: "完整回复以及最后一段" }] });
  emitSse(source, "messageDone", live);
  assert.match(harness.elements["message-list"].textContent, /完整回复以及最后一段/);
});

test("a lagging idle snapshot does not stop a newer live turn", async () => {
  const idle = { ...emptyThreadDetail("A"), control: { busy: false, requests: [] }, turns: [{ id: "old", status: "completed" }] };
  const harness = await createHarness(async (url) => jsonResponse(200, url === "/api/bootstrap"
    ? { status: { state: "ready" }, threads: [threadSummary("A")] } : idle));
  await harness.hooks.selectThread("A");
  const source = harness.eventSources.at(-1);
  emitSse(source, "messageStart", { threadId: "A", turnId: "new", itemId: "new-answer", text: "Working" });
  emitSse(source, "thread", idle);
  assert.equal(harness.hooks.getState().currentThread.control.busy, true);
  assert.equal(harness.hooks.getState().currentThread.control.turnId, "new");
});

test("completion before a send response keeps normal send available", async () => {
  const response = deferred();
  const detail = emptyThreadDetail("A");
  const harness = await createHarness(async (url) => {
    if (url.endsWith("/messages")) return response.promise;
    return jsonResponse(200, url === "/api/bootstrap"
      ? { status: { state: "ready" }, threads: [threadSummary("A")] } : detail);
  });
  await harness.hooks.selectThread("A");
  harness.elements["message-input"].value = "test";
  const sending = harness.hooks.sendMessage({ preventDefault() {} });
  emitSse(harness.eventSources.at(-1), "thread", { ...detail, turns: [{ id: "fast", status: "completed" }] });
  response.resolve(jsonResponse(202, { delivery: "app-server", turnId: "fast", control: { busy: true, turnId: "fast" } }));
  await sending;
  assert.equal(harness.hooks.getState().currentThread.control.busy, false);
});

test("waiting messages stay ordered outside history and can be cancelled individually", async () => {
  let queue = [{ id: "one", text: "第一条" }, { id: "two", text: "第二条" }];
  const calls = [];
  const detail = () => ({ ...emptyThreadDetail("A"), control: { busy: true, turnId: "active", queued: queue.length > 0, queue, requests: [] } });
  const harness = await createHarness(async (url, options = {}) => {
    if (url === "/api/threads/A/queue/one") {
      calls.push(JSON.parse(options.body));
      queue = queue.slice(1);
      return jsonResponse(200, { control: detail().control });
    }
    return jsonResponse(200, url === "/api/bootstrap"
      ? { status: { state: "ready" }, threads: [threadSummary("A")] } : detail());
  });
  await harness.hooks.selectThread("A");
  const list = harness.elements["queued-message-list"];
  assert.match(list.textContent, /第一条调整方向.*第二条调整方向/);
  assert.doesNotMatch(harness.elements["message-list"].textContent, /第一条|第二条/);
  list.children[0].children[2].children[1].listeners.get("click")[0]();
  await eventually(() => list.children.length === 1);
  assert.deepEqual(calls, [{ action: "remove" }]);
  assert.match(list.textContent, /第二条/);
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
