import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jsQR from "jsqr";
import { createServer } from "node:http";
import { once } from "node:events";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({
  headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
});
const base = process.env.POCKET_TEST_URL || "http://127.0.0.1:4173";
const output = new URL("../.data/qa/qr/", import.meta.url);
const root = fileURLToPath(new URL("../public/", import.meta.url));
const key = "synthetic-qr-key-0123456789abcdef";
const publicUrl = "https://long-generated-hostname-for-pocket-preview.example.test/";
const connectionUrl = `${publicUrl}#token=${key}`;
await fs.mkdir(output, { recursive: true });

try {
  for (const [name, width, height, colorScheme] of [
    ["desktop", 960, 640, "light"], ["small", 760, 520, "light"],
    ["phone", 390, 844, "light"], ["dark", 960, 640, "dark"],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ connectionUrl, publicUrl, key }) => {
      window.qrState = { phase: "running", publicUrl, accessKey: key,
        connectionUrl, status: "Connected", busy: false, error: "" };
      window.qrCopied = [];
      window.pywebview = { api: {
        get_state: async () => window.qrState,
        copy_qr_image: async (url, png) => { window.qrCopied.push({ url, png }); return true; },
        stop_service: async () => (window.qrState = { phase: "stopped", publicUrl: "", accessKey: "", connectionUrl: "", busy: false }),
      } };
    }, { connectionUrl, publicUrl, key });
    await page.goto(`${base}/desktop/index.html`);
    const qr = page.locator("#connection-qr");
    const dialog = page.locator("#qr-dialog");
    const show = page.locator("#show-qr");
    assert.equal(await dialog.isVisible(), false);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-main.png`, output)) });
    await show.click();
    await qr.waitFor({ state: "visible" });
    assert.equal(await page.locator("#scan-label").evaluate((el) => el === document.activeElement), true);
    const closeStyle = await page.locator("#close-qr").evaluate((el) => ({
      outline: getComputedStyle(el).outlineStyle, background: getComputedStyle(el).backgroundColor,
    }));
    assert.equal(closeStyle.outline, "none");
    assert.equal(closeStyle.background, "rgba(0, 0, 0, 0)");
    const pixels = await qr.evaluate(async (img) => {
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.getBoundingClientRect().width);
      canvas.height = Math.round(img.getBoundingClientRect().height);
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return { width: canvas.width, height: canvas.height,
        data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
    });
    assert.equal(jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)?.data, connectionUrl);
    assert.equal(await page.locator(".qr-frame").evaluate((el) => getComputedStyle(el).backgroundColor), "rgb(255, 255, 255)");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
    await page.locator("#copy-qr").click();
    await page.waitForFunction(() => window.qrCopied.length === 1);
    const copied = await page.evaluate(() => window.qrCopied[0]);
    assert.equal(copied.url, connectionUrl);
    assert.match(copied.png, /^data:image\/png;base64,/);
    const clipboardPixels = await page.evaluate(async (png) => {
      const img = new Image();
      img.src = png;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      return { width: canvas.width, height: canvas.height,
        data: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data) };
    }, copied.png);
    assert.equal(jsQR(new Uint8ClampedArray(clipboardPixels.data), clipboardPixels.width, clipboardPixels.height)?.data, connectionUrl);
    assert.equal(await page.locator("#qr-copy-status").innerText(), "二维码已复制");
    await page.locator("#close-qr").click();
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await show.evaluate((el) => el === document.activeElement), true);
    await show.click();
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), false);
    await show.click();
    await page.mouse.click(4, 4);
    assert.equal(await dialog.isVisible(), false);
    await show.click();
    // macOS WebKit uses Option+Tab to include buttons in keyboard navigation.
    await page.keyboard.press(process.platform === "darwin" && process.env.PLAYWRIGHT_BROWSER === "webkit" ? "Alt+Tab" : "Tab");
    assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
    assert.equal(await page.locator("#copy-qr").evaluate((el) => el === document.activeElement && el.matches(":focus-visible")), true);
    const oldImage = await qr.getAttribute("src");
    await page.evaluate(() => { window.qrState = { ...window.qrState, phase: "starting", publicUrl: "", connectionUrl: "" }; });
    await qr.waitFor({ state: "hidden" });
    assert.equal(await qr.getAttribute("src"), null);
    assert.equal(await page.locator("#copy-qr").isDisabled(), true);
    assert.equal(await dialog.isVisible(), false);
    assert.equal(await show.isDisabled(), true);
    await page.evaluate(() => { window.qrState = { ...window.qrState, phase: "running", publicUrl: "https://new.example.test/", connectionUrl: "https://new.example.test/#token=replacement" }; });
    await show.click();
    await qr.waitFor({ state: "visible" });
    assert.notEqual(await qr.getAttribute("src"), oldImage);
    await page.locator("#close-qr").click();
    await page.locator("#service-button").click();
    await qr.waitFor({ state: "hidden" });
    assert.equal(await qr.getAttribute("src"), null);
    assert.equal(await page.locator("#copy-qr").isDisabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // Real HTTP checks cookie delivery; WebKit route interception precedes cookie headers.
  for (const valid of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const page = await context.newPage();
    let sessions = 0;
    let authorized = false;
    const sessionServer = createServer(async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/api/session") {
        sessions += 1;
        assert.equal(request.headers.authorization, `Bearer ${valid ? key : "expired"}`);
        response.writeHead(valid ? 200 : 401, { "Content-Type": "application/json",
          ...(valid ? { "Set-Cookie": `codex_pocket_session=${key}; HttpOnly; SameSite=Strict; Path=/` } : {}) });
        return response.end(JSON.stringify(valid ? { ok: true } : { error: "Expired key" }));
      }
      if (url.pathname.startsWith("/api/")) {
        authorized = request.headers.cookie?.includes(`codex_pocket_session=${key}`) || false;
        response.writeHead(authorized ? 200 : 401, { "Content-Type": "application/json" });
        return response.end(JSON.stringify({ status: { state: "ready" }, transports: ["poll"], threads: [], events: [] }));
      }
      const file = path.resolve(root, url.pathname === "/" ? "index.html" : `.${url.pathname}`);
      assert.ok(file.startsWith(root));
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
      try {
        const body = await fs.readFile(file);
        response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
        response.end(body);
      } catch { response.writeHead(404).end(); }
    });
    sessionServer.listen(0, "127.0.0.1");
    await once(sessionServer, "listening");
    try {
      await page.goto(`http://127.0.0.1:${sessionServer.address().port}/#token=${valid ? key : "expired"}`);
      await page.locator(valid ? "#app" : "#auth-screen").waitFor({ state: "visible" });
      assert.equal(new URL(page.url()).hash, "");
      assert.equal(sessions, 1);
      assert.equal(authorized, valid);
      if (valid) {
        await page.reload();
        await page.locator("#app").waitFor({ state: "visible" });
        assert.equal(sessions, 1);
      }
    } finally {
      await context.close();
      sessionServer.closeAllConnections();
      await new Promise((resolve) => sessionServer.close(resolve));
    }
  }
  console.log("QR passed: pixel decoding, local rendering, copy, recovery, stop, mobile automatic login, expired links and session reuse.");
} finally {
  await browser.close();
}
