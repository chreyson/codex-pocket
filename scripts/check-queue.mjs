import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const playwright = await import("playwright");
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const output = new URL("../.data/qa/queue/", import.meta.url);
await fs.mkdir(output, { recursive: true });
try {
  for (const [name, width, height, colorScheme] of [
    ["desktop", 1440, 900, "light"], ["phone", 390, 844, "light"], ["small-dark", 320, 640, "dark"],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let queue = [{ id: "one", text: "完成后检查 Windows、Linux 和 macOS 的连接状态" }, { id: "two", text: "再检查手机切回任务后的输入体验" }];
    let busy = true;
    const thread = () => ({
      id: "queue", title: "跨设备继续工作", project: "Pocket", status: busy ? "active" : "idle",
      turns: [{ id: "turn", status: busy ? "inProgress" : "completed" }],
      messages: [{ id: "request", turnId: "turn", role: "user", kind: "message", text: "检查任务的连接状态" }],
      control: { busy, phase: busy ? "running" : "idle", turnId: busy ? "turn" : null, queued: Boolean(queue.length), queue, requests: [] },
      composerOptions: { models: [], modes: ["default"], features: {}, followUpQueueMode: "steer" },
    });
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.queueSource = this; }
        close() {}
      };
    });
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      let body = thread();
      if (url.pathname.endsWith("/bootstrap")) body = { status: { state: "ready" }, threads: [thread()] };
      if (url.pathname.includes("/queue/")) {
        const id = url.pathname.split("/").at(-1);
        const payload = route.request().postDataJSON();
        const item = queue.find((item) => item.id === id);
        if (payload.action === "edit") item.editing = true;
        else if (payload.action === "update") { item.text = payload.text; item.editing = false; }
        else if (payload.action === "cancelEdit") item.editing = false;
        else queue = queue.filter((item) => item.id !== id);
        body = { control: thread().control };
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    const emit = async (event, value) => page.evaluate(({ event, value }) =>
      window.queueSource.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(value) })), { event, value });
    await page.goto(process.env.POCKET_TEST_URL);
    await page.locator('[data-thread-id="queue"]').click();
    await page.locator("#message-input").fill("继续检查");
    assert.equal(await page.locator("#send-button").isDisabled(), false);
    assert.equal(await page.locator("#send-button").getAttribute("data-action"), "queue");
    assert.equal(await page.locator("#delivery-control").count(), 0);
    assert.equal(await page.locator("#composer-status").innerText(), "");
    assert.equal(await page.locator(".queued-message").count(), 2);
    assert.equal(await page.locator(".queued-remove img").first().evaluate((img) => img.complete && img.naturalWidth > 0), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const rows = await page.locator("#queued-message-list").boundingBox();
    const box = await page.locator(".composer-box").boundingBox();
    assert.ok(Math.abs(rows.width - box.width) < 1);
    assert.ok(Math.abs(rows.x - box.x) < 1);
    assert.ok((await page.locator(".queued-message").last().boundingBox()).y < box.y);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-waiting.png`, output)) });
    await page.locator(".queued-menu > summary").first().click();
    await page.locator(".queued-menu[open] .queued-edit").waitFor({ state: "visible" });
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-menu.png`, output)) });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".queued-menu[open]").count(), 0);
    await page.locator(".queued-menu > summary").first().click();
    await page.getByRole("button", { name: /^编辑消息：完成后/ }).click();
    const editor = page.getByRole("textbox", { name: "编辑等待消息" });
    await editor.fill("修改后继续检查 Windows 和手机体验");
    await emit("thread", thread());
    assert.equal(await editor.inputValue(), "修改后继续检查 Windows 和手机体验");
    assert.equal(await page.locator("#message-input").inputValue(), "继续检查");
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-editing.png`, output)) });
    await page.getByRole("button", { name: /^保存消息：/ }).click();
    await editor.waitFor({ state: "detached" });
    assert.deepEqual(queue.map((item) => item.id), ["one", "two"]);
    assert.equal(await page.locator(".queued-message-text").first().innerText(), "修改后继续检查 Windows 和手机体验");
    await page.locator(".queued-menu > summary").first().click();
    await page.getByRole("button", { name: /^编辑消息：修改后/ }).click();
    await editor.fill("取消这次修改");
    await page.getByRole("button", { name: /^取消编辑：/ }).click();
    await editor.waitFor({ state: "detached" });
    assert.equal(queue[0].text, "修改后继续检查 Windows 和手机体验");
    await page.getByRole("button", { name: /^取消等待：修改后/ }).click();
    await page.waitForFunction(() => document.querySelectorAll(".queued-message").length === 1);
    await page.getByRole("button", { name: /^调整方向：再检查/ }).click();
    await page.waitForFunction(() => document.querySelector("#queued-message-list").hidden);
    assert.equal(await page.locator("#composer-status").innerText(), "");
    assert.equal(await page.locator("#send-button").getAttribute("data-action"), "queue");
    await emit("messageStart", { threadId: "queue", turnId: "turn", itemId: "answer", kind: "message", text: "检查已完成。" });
    busy = false;
    await emit("thread", thread());
    assert.equal(await page.locator("#delivery-control").count(), 0);
    assert.equal(await page.locator("#interrupt-button").isVisible(), false);
    assert.equal(await page.locator("#send-button").getAttribute("data-action"), "start");
    assert.equal(await page.locator("#send-button").isDisabled(), false);
    assert.equal(await page.locator("#composer-status").innerText(), "");
    assert.match(await page.locator("#message-list").innerText(), /检查已完成/);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-completed.png`, output)) });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Queue UI passed: desktop/phone/dark, composer width, menus, edit/save/cancel, draft preservation, Steer and completion.");
} finally { await browser.close(); }
