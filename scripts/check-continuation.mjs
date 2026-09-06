import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";

const browser = await (process.env.PLAYWRIGHT_BROWSER === "webkit" ? webkit : chromium).launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const output = new URL("../.data/qa/continuation/", import.meta.url);
await mkdir(output, { recursive: true });
const base = process.env.POCKET_TEST_URL || "http://127.0.0.1:4175";
try {
  for (const [name, width, height, colorScheme] of [["desktop", 1440, 900, "light"], ["phone", 390, 844, "light"], ["small-dark", 320, 640, "dark"]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme });
    const page = await context.newPage();
    const errors = [];
    let forkCount = 0;
    let sent = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); setTimeout(() => { this.onopen?.(); this.dispatchEvent(new MessageEvent("status", { data: '{"state":"ready"}' })); }, 20); }
        close() {}
      };
    });
    const thread = { id: "locked", title: "继续现有工作", project: "Codex Pocket", status: "idle", control: { busy: false, requests: [] },
      composerOptions: { models: [], skills: [] },
      messages: [{ id: "result", turnId: "done", role: "assistant", kind: "message", text: "上一轮的工作结果。" }] };
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      let body = thread;
      let status = 200;
      if (url.pathname === "/api/bootstrap") body = { status: { state: "ready" }, threads: [thread] };
      else if (url.pathname === "/api/threads/locked/messages") {
        status = 409;
        body = { error: "桌面端仍持有此会话的写入连接。可保留历史，在 Web 新建续接会话。", code: "THREAD_CONTINUATION_REQUIRED" };
      } else if (url.pathname.endsWith("/continue")) { forkCount++; status = 201; body = { thread: { ...thread, id: "continuation" } }; }
      else if (url.pathname === "/api/threads/continuation") body = { ...thread, id: "continuation" };
      else if (url.pathname === "/api/threads/continuation/messages") { sent++; status = 202; body = { control: { busy: true }, delivery: "app-server", turnId: "new" }; }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(base);
    await page.locator('[data-thread-id="locked"]').click();
    await page.locator('#connection-state[data-state="ready"]').waitFor({ state: "attached" });
    await page.locator("#message-input").fill("接着完成这项工作");
    await page.locator("#send-button").click();
    await page.locator("#continue-web").waitFor({ state: "visible" });
    assert.equal(forkCount, 0);
    assert.equal(await page.locator("#message-input").inputValue(), "接着完成这项工作");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
    await page.locator("#continue-web").click();
    await page.locator('[data-thread-id="continuation"][aria-current="true"]').waitFor({ state: "attached" });
    await page.locator("#message-input:not([disabled])").waitFor();
    assert.equal(await page.locator("#message-input").inputValue(), "接着完成这项工作");
    assert.match(await page.locator("#message-list").innerText(), /上一轮的工作结果/);
    assert.equal(forkCount, 1);
    assert.equal(sent, 0);
    await page.locator("#send-button").click();
    await page.locator('#send-button[data-action="queue"]').waitFor({ state: "attached" });
    assert.equal(await page.locator("#composer-status").innerText(), "");
    assert.equal(sent, 1);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Continuation UI passed: explicit action, retained draft/history, subsequent send, desktop/mobile, light/dark.");
} finally { await browser.close(); }
