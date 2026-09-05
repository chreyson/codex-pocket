import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({
  headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
});
const base = process.env.POCKET_TEST_URL;
let revision = 0;
const summary = { id: "poll-task", title: "HTTPS synchronization", project: "Pocket", status: "active" };
const detail = () => ({
  ...summary, control: { busy: true, requests: [], turnId: "turn-1" },
  messages: [{ id: "reply", role: "assistant", kind: "message", text: `Update ${revision}`, turnId: "turn-1" }],
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    window.EventSource = class { constructor() { throw new Error("Quick Tunnel must not use SSE"); } };
  });
  await context.route("https://pocket-test.trycloudflare.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) {
      await route.fulfill({ response: await route.fetch({ url: `${base}${path}` }) });
      return;
    }
    assert.equal(route.request().method(), "GET", "Synchronization must not send a task");
    let body;
    if (path === "/api/sync") {
      revision++;
      body = { events: [
        { event: "threads", value: [summary] },
        { event: "thread", value: detail() },
        { event: "status", value: { state: "ready" } },
      ] };
    } else if (path === "/api/bootstrap") {
      body = { threads: [summary], status: { state: "ready" }, transports: ["sse", "poll"] };
    } else {
      body = detail();
    }
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("https://pocket-test.trycloudflare.com/");
  await page.locator('[data-thread-id="poll-task"]').click();
  await page.locator("#message-input").fill("Draft survives HTTPS synchronization");
  await page.waitForFunction(() => /Update [3-9]/.test(document.querySelector("#message-list").textContent));
  assert.equal(await page.locator("#message-input").inputValue(), "Draft survives HTTPS synchronization");
  await context.setOffline(true);
  await page.locator('#network-banner[data-state="offline"]').waitFor({ state: "visible" });
  await context.setOffline(false);
  await page.waitForFunction(() => document.querySelector("#connection-state").dataset.state === "ready");
  assert.equal(await page.locator("#message-input").inputValue(), "Draft survives HTTPS synchronization");
  await page.reload();
  await page.locator("#message-input").waitFor({ state: "visible" });
  assert.equal(await page.locator("#message-input").inputValue(), "Draft survives HTTPS synchronization");
  await fs.mkdir(new URL("../.data/qa/", import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL("../.data/qa/polling.png", import.meta.url)) });
  assert.deepEqual(errors, []);
  console.log("Quick Tunnel: HTTPS updates, offline recovery and drafts passed without SSE");
} finally {
  await browser.close();
}
