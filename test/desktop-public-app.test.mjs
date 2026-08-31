import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const APP_SOURCE_URL = new URL("../public/desktop/app.js", import.meta.url);
const ELEMENT_IDS = [
  "desktop-app",
  "service-button",
  "status-dot",
  "status-text",
  "public-url",
  "access-key",
  "copy-url",
  "open-url",
  "copy-key",
  "error-banner",
  "error-text",
  "dismiss-error",
  "copy-toast",
  "copy-toast-text",
];

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    if (force) this.values.add(name);
    else this.values.delete(name);
  }
}

class FakeElement {
  constructor() {
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.listeners = new Map();
    this.textContent = "";
    this.title = "";
    this.label = null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  querySelector(selector) {
    return selector === "span" ? this.label : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("Timed out waiting for desktop UI state");
}

async function createHarness(copyResult = true) {
  const elements = Object.fromEntries(
    ELEMENT_IDS.map((id) => [id, new FakeElement()]),
  );
  elements["service-button"].label = new FakeElement();
  elements["copy-toast"].hidden = true;
  const copied = [];
  const bridge = {
    async get_state() {
      return {
        phase: "running",
        status: "服务运行中",
        publicUrl: "https://example.trycloudflare.com",
        accessKey: "secret-key",
        busy: false,
        error: "",
      };
    },
    async copy_text(value) {
      copied.push(value);
      return copyResult;
    },
    async open_url() {},
    async start_service() {},
    async stop_service() {},
    async dismiss_error() {},
  };
  const timers = new Map();
  let nextTimerId = 1;
  const setTimer = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const document = {
    querySelector(selector) {
      return elements[selector.replace(/^#/, "")];
    },
  };
  const window = {
    pywebview: { api: bridge },
    addEventListener() {},
  };
  const context = vm.createContext({
    clearInterval: clearTimer,
    clearTimeout: clearTimer,
    document,
    requestAnimationFrame(callback) {
      callback();
    },
    setImmediate,
    setInterval: setTimer,
    setTimeout: setTimer,
    window,
  });
  const source = await fs.readFile(APP_SOURCE_URL, "utf8");
  vm.runInContext(source, context, { filename: "public/desktop/app.js" });
  await eventually(() => !elements["copy-url"].disabled);
  return { copied, elements, timers };
}

test("copy buttons show specific success feedback", async () => {
  const harness = await createHarness();
  harness.elements["copy-url"].listeners.get("click")[0]();
  await eventually(
    () => harness.elements["copy-toast-text"].textContent === "公网链接已复制",
  );

  assert.deepEqual(harness.copied, ["https://example.trycloudflare.com"]);
  assert.equal(harness.elements["copy-toast"].hidden, false);
  assert.equal(harness.elements["copy-toast"].dataset.visible, "true");
  assert.equal(harness.elements["copy-toast"].dataset.tone, "success");
  assert.equal(harness.elements["copy-url"].dataset.copied, "true");
  assert.equal(
    harness.elements["copy-url"].attributes.get("aria-label"),
    "公网链接已复制",
  );

  harness.elements["copy-key"].listeners.get("click")[0]();
  await eventually(
    () => harness.elements["copy-toast-text"].textContent === "访问密钥已复制",
  );
  assert.deepEqual(harness.copied, [
    "https://example.trycloudflare.com",
    "secret-key",
  ]);
  assert.equal(harness.elements["copy-key"].dataset.copied, "true");
});

test("copy failures show an error without marking the button successful", async () => {
  const harness = await createHarness(false);
  harness.elements["copy-key"].listeners.get("click")[0]();
  await eventually(
    () => harness.elements["copy-toast-text"].textContent === "访问密钥复制失败",
  );

  assert.equal(harness.elements["copy-toast"].dataset.tone, "error");
  assert.equal(harness.elements["copy-key"].dataset.copied, undefined);
  assert.equal(
    harness.elements["copy-key"].attributes.get("aria-label"),
    undefined,
  );
});
