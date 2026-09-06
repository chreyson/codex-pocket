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
  "connection-description",
  "connection-mode",
  "connection-mode-current",
  "connection-mode-advice",
  "connect-desktop",
  "connection-qr",
  "qr-placeholder",
  "copy-qr",
  "show-qr",
  "close-qr",
  "qr-dialog",
  "qr-copy-status",
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

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "src") this.src = "";
  }

  async decode() {}

  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
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
  const imageCopies = [];
  const bridge = {
    async get_state() {
      return {
        phase: "running",
        status: "服务运行中",
        publicUrl: "https://example.trycloudflare.com",
        accessKey: "secret-key",
        connectionUrl: "https://example.trycloudflare.com#token=secret-key",
        busy: false,
        error: "",
        connectionMode: "shared",
      };
    },
    async copy_text(value) {
      copied.push(value);
      return copyResult;
    },
    async copy_qr_image(url, png) {
      imageCopies.push({ url, png });
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
    createElement() {
      return { getContext: () => ({ drawImage() {} }), toDataURL: () => "data:image/png;base64,test-png" };
    },
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
  vm.runInContext(await fs.readFile(new URL("../public/vendor/qrcode.js", import.meta.url), "utf8"), context);
  window.qrcode = context.qrcode;
  vm.runInContext(source, context, { filename: "public/desktop/app.js" });
  await eventually(() => !elements["copy-url"].disabled);
  return { copied, imageCopies, elements, timers, renderState(state) {
    context.stateUpdate = state;
    vm.runInContext("render(stateUpdate)", context);
  } };
}

test("shared backend alone cannot claim desktop attachment and stopped state clears it", async () => {
  const harness = await createHarness();
  assert.equal(harness.elements["connection-mode"].textContent, "待确认");
  harness.renderState({ desktopConnection: { state: "independent", label: "正在切换", advice: "Pocket 会自动切换" } });
  assert.equal(harness.elements["connection-mode"].textContent, "正在切换");
  assert.equal(harness.elements["connect-desktop"].hidden, false);
  harness.renderState({ desktopConnection: { state: "shared", label: "已共享", advice: "已确认" } });
  assert.equal(harness.elements["connection-mode"].textContent, "已共享");
  assert.equal(harness.elements["connect-desktop"].hidden, true);
  harness.renderState({ phase: "stopped" });
  assert.equal(harness.elements["connection-mode"].textContent, "未连接");
});

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

test("QR copying sends an image and clears the QR during recovery and stop", async () => {
  const harness = await createHarness();
  const qr = harness.elements["connection-qr"];
  const button = harness.elements["copy-qr"];
  assert.equal(qr.hidden, false);
  assert.match(qr.src, /^data:image\/gif;base64,/);
  const original = qr.src;
  button.listeners.get("click")[0]();
  await eventually(() => harness.imageCopies.length === 1);
  assert.equal(harness.imageCopies[0].url, "https://example.trycloudflare.com#token=secret-key");
  assert.match(harness.imageCopies[0].png, /^data:image\/png;base64,/);
  assert.equal(harness.copied.length, 0);
  harness.renderState({ phase: "starting", connectionUrl: "" });
  assert.equal(qr.hidden, true);
  assert.equal(qr.src, "");
  assert.equal(button.disabled, true);
  harness.renderState({ phase: "running", connectionUrl: "https://recovered.trycloudflare.com#token=new-key" });
  assert.equal(qr.hidden, false);
  assert.notEqual(qr.src, original);
  harness.renderState({ phase: "stopping" });
  assert.equal(qr.hidden, true);
  assert.equal(button.disabled, true);
  button.listeners.get("click")[0]();
  assert.equal(harness.imageCopies.length, 1);
});

test("image clipboard failures show an error and allow retry", async () => {
  const harness = await createHarness(false);
  const button = harness.elements["copy-qr"];
  await button.listeners.get("click")[0]();
  assert.equal(harness.elements["qr-copy-status"].textContent, "二维码复制失败");
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.copied, undefined);
});

test("QR dialog opens on demand and closes when the connection becomes unavailable", async () => {
  const harness = await createHarness();
  const show = harness.elements["show-qr"];
  const dialog = harness.elements["qr-dialog"];
  assert.ok(!dialog.open);
  show.listeners.get("click")[0]();
  assert.equal(dialog.open, true);
  harness.elements["close-qr"].listeners.get("click")[0]();
  assert.equal(dialog.open, false);
  show.listeners.get("click")[0]();
  harness.renderState({ phase: "starting", connectionUrl: "" });
  assert.equal(dialog.open, false);
  assert.equal(show.disabled, true);
  show.listeners.get("click")[0]();
  assert.equal(dialog.open, false);
});
