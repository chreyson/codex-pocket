import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const baseURL = process.env.POCKET_TEST_URL || "http://127.0.0.1:4173";
const output = new URL("../.data/qa/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const errors = [];
const summaries = [
  { id: "mobile-a", title: "移动端会话恢复与弱网体验优化", project: "Codex Pocket", status: "active", updatedAt: 1788600000 },
  { id: "mobile-b", title: "核对上线前的检查结果", project: "Codex Pocket", status: "idle", updatedAt: 1788599000 },
];
const catalog = {
  models: [{ id: "test-model", name: "Codex Test Model", isDefault: true, defaultEffort: "high", efforts: [{ id: "high" }] }],
  skills: [], features: {},
};
const detail = (id) => ({
  ...summaries.find((thread) => thread.id === id),
  composerOptions: catalog,
  control: { busy: false, requests: [] },
  messages: Array.from({ length: 32 }, (_, i) => ({
    id: `${id}-${i}`, turnId: `turn-${Math.floor(i / 2)}`, role: i % 2 ? "assistant" : "user", kind: "message",
    timestamp: 1788600000 + i,
    text: i % 2 ? "已检查会话状态，正在验证网络恢复后的同步结果。\n".repeat(i === 31 ? 45 : 3) : `第 ${Math.floor(i / 2) + 1} 项检查：保持草稿和阅读位置`,
  })),
});

try {
  for (const [name, width, height, colorScheme] of [
    ["mobile", 390, 844, "light"], ["narrow", 320, 700, "light"],
    ["desktop", 1440, 900, "light"], ["dark", 390, 844, "dark"],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 720, hasTouch: width < 720, colorScheme });
    await context.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor(url) {
          super(); this.url = url; window.testSource = this;
          setTimeout(() => {
            if (this.closed) return;
            this.onopen?.();
            this.dispatchEvent(new MessageEvent("status", { data: JSON.stringify({ state: "ready" }) }));
          }, 30);
        }
        close() { this.closed = true; }
      };
      window.testEmit = (name, value) => window.testSource.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(value) }));
    });
    let mutations = 0;
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() !== "GET") mutations++;
      const body = path === "/api/bootstrap" ? { status: { state: "ready" }, threads: summaries }
        : detail(path.split("/").at(-1));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
    await page.goto(baseURL);
    await page.locator('[data-thread-id="mobile-a"]').click();
    await page.locator("#message-input").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#connection-state").dataset.state === "ready");
    await page.locator("#message-input").fill("这段草稿要在刷新、锁屏返回和切换会话后保留。\n下一步继续检查。 ");
    await page.locator("#conversation-actions summary").click();
    await page.locator("#refresh-button").click();
    await page.waitForFunction(() => document.querySelector("#connection-state").dataset.state === "ready");
    assert.match(await page.locator("#message-input").inputValue(), /这段草稿/);

    await page.evaluate(() => { window.savedArticle = document.querySelector(".message-list > .message:last-child"); });
    await page.evaluate((thread) => window.testEmit("thread", thread), detail("mobile-a"));
    assert.equal(await page.evaluate(() => window.savedArticle === document.querySelector(".message-list > .message:last-child")), true);

    await page.locator("#message-list").evaluate((list) => { list.scrollTop = 0; list.dispatchEvent(new Event("scroll")); });
    await page.locator("#latest-button").waitFor({ state: "visible" });
    const topBefore = await page.locator("#message-list").evaluate((list) => list.scrollTop);
    await page.evaluate(() => {
      window.testEmit("messageStart", { threadId: "mobile-a", itemId: "live-1", turnId: "turn-15", text: "继续验证" });
      for (let i = 0; i < 100; i++) window.testEmit("messageDelta", { threadId: "mobile-a", itemId: "live-1", delta: "更新 " });
    });
    await page.waitForFunction(() => document.querySelector("#message-list").textContent.includes("更新 更新"));
    assert.equal(await page.locator("#message-list").evaluate((list) => list.scrollTop), topBefore);
    await page.locator("#latest-button").click();
    await page.locator("#latest-button").waitFor({ state: "hidden" });

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false, `${name}: horizontal overflow`);
    const composer = await page.locator("#composer").boundingBox();
    assert.ok(composer.y + composer.height <= height + 1, `${name}: composer is clipped`);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });

    await context.setOffline(true);
    await page.locator('#network-banner[data-state="offline"]').waitFor({ state: "visible" });
    assert.equal(await page.locator("#send-button").isDisabled(), true);
    assert.equal(await page.locator("#message-input").isDisabled(), false);
    await page.locator("#message-input").fill("离线编辑的草稿");
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-offline.png`, output)) });
    await context.setOffline(false);
    await page.waitForFunction(() => document.querySelector("#connection-state").dataset.state === "ready");
    assert.equal(await page.locator("#message-input").inputValue(), "离线编辑的草稿");
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
    await page.reload();
    await page.locator("#message-input").waitFor({ state: "visible" });
    assert.equal(await page.locator("#message-input").inputValue(), "离线编辑的草稿");
    if (width < 720) {
      await page.setViewportSize({ width, height: 430 });
      await page.locator("#message-input").focus();
      await page.keyboard.press("Enter");
      assert.equal(mutations, 0, "mobile Return must not submit");
      await page.waitForFunction(() => {
        const input = document.querySelector("#message-input").getBoundingClientRect();
        const send = document.querySelector("#send-button").getBoundingClientRect();
        return input.top >= 0 && send.bottom <= 431;
      });
      await page.screenshot({ path: fileURLToPath(new URL(`${name}-keyboard.png`, output)) });
    }
    console.log(`${name}: drafts, refresh, streaming, offline recovery and layout passed`);
    await context.close();
  }
  assert.deepEqual(errors, [], "browser errors");
} finally {
  await browser.close();
}
