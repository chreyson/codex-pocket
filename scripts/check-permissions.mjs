import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { permissionCatalog } from "../src/permissions.mjs";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const base = process.env.POCKET_TEST_URL;
const output = new URL("../.data/qa/permissions/", import.meta.url);
await fs.mkdir(output, { recursive: true });
try {
  for (const [name, width, height] of [["desktop", 1440, 900], ["phone", 390, 844], ["small-phone", 320, 640]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 720, isMobile: width < 720 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let permissions = permissionCatalog({ supported: true, profiles: [":workspace", ":danger-full-access"].map((id) => ({ id, allowed: true })) });
    permissions.current = "ask";
    const thread = {
      id: "permissions-test", title: "继续处理项目", project: "Pocket", messages: [],
      control: { busy: false, requests: [] },
      composerOptions: {
        models: [{ id: "gpt-6-astra", name: "GPT-6-Astra", defaultEffort: "low", efforts: [{ id: "low" }, { id: "ultra" }] }],
        defaultModel: "gpt-6-astra", modes: ["default"], features: {}, permissions,
      },
    };
    let rejectFull = true;
    const changes = [];
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.permissionSource = this; setTimeout(() => this.dispatchEvent(new MessageEvent("status", { data: '{"state":"ready"}' })), 10); }
        close() {}
      };
    });
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let body = thread;
      if (pathname.endsWith("bootstrap")) body = { status: { state: "ready" }, threads: [thread] };
      if (pathname.endsWith("permissions")) {
        assert.equal(route.request().method(), "POST");
        const { mode } = route.request().postDataJSON();
        changes.push(mode);
        if (mode === "full" && rejectFull) {
          await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "权限模式不可用" }) });
          return;
        }
        permissions = { ...permissions, current: mode };
        thread.composerOptions.permissions = permissions;
        body = { permissions };
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(base);
    await page.locator('[data-thread-id="permissions-test"]').click();
    await page.locator("#permission-label").filter({ hasText: "请求批准" }).waitFor();
    assert.equal(await page.locator("#model-label").innerText(), "6 Astra");
    await page.locator("#permission-control").click();
    assert.equal(await page.getByRole("menuitemradio", { name: /^请求批准/ }).getAttribute("aria-checked"), "true");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
    await page.getByRole("menuitemradio", { name: /帮我批准/ }).click();
    await page.locator("#permission-label").filter({ hasText: "帮我批准" }).waitFor();
    await page.locator("#permission-control").click();
    await page.getByRole("menuitemradio", { name: /完全访问权限/ }).click();
    await page.locator("#composer-status").filter({ hasText: "权限模式不可用" }).waitFor();
    assert.equal(await page.locator("#permission-label").innerText(), "帮我批准");
    rejectFull = false;
    await page.locator("#permission-control").click();
    await page.getByRole("menuitemradio", { name: /完全访问权限/ }).click();
    await page.locator("#permission-label").filter({ hasText: "完全访问" }).waitFor();
    await page.reload();
    await page.locator("#permission-label").filter({ hasText: "完全访问" }).waitFor();
    await page.evaluate((value) => window.permissionSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), { ...thread, control: { busy: true, turnId: "running", requests: [] } });
    assert.equal(await page.locator("#permission-control").isDisabled(), true);
    assert.deepEqual(changes, ["auto", "full", "full"]);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Permission UI passed: desktop/phone labels, GPT-6, policy changes, rejection, reload and busy state.");
} finally { await browser.close(); }
