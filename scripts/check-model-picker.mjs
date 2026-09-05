import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const output = new URL("../.data/qa/model-picker/", import.meta.url);
await fs.mkdir(output, { recursive: true });
try {
  for (const [name, width, height, colorScheme] of [
    ["desktop", 1440, 900, "light"], ["phone", 390, 844, "light"],
    ["small-phone", 320, 640, "light"], ["dark", 390, 844, "dark"],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, isMobile: width < 720, hasTouch: width < 720 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const thread = {
      id: "model-picker", title: "调整模型与思考强度", project: "Pocket", messages: [],
      control: { busy: false, requests: [] },
      composerOptions: {
        models: [
          { id: "astra", name: "6 Astra", defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((id) => ({ id })) },
          { id: "single", name: "Single effort model with a long display name", defaultEffort: "medium", efforts: [{ id: "medium" }] },
          { id: "none", name: "No reasoning", efforts: [] },
        ],
        defaultModel: "astra", modes: ["default"], features: {},
      },
    };
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.pickerSource = this; }
        close() {}
      };
    });
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(route.request().url().endsWith("bootstrap") ? { status: { state: "ready" }, threads: [thread] } : thread) }));
    await page.goto(process.env.POCKET_TEST_URL || "http://127.0.0.1:4173");
    await page.locator('[data-thread-id="model-picker"]').click();
    const button = page.locator("#model-control");
    const slider = page.getByRole("slider", { name: "思考强度" });
    await button.click();
    assert.equal(await slider.getAttribute("max"), "5");
    assert.equal(await slider.inputValue(), "2");
    const menuBox = await page.locator("#composer-menu").boundingBox();
    const buttonBox = await button.boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width);
    assert.ok(menuBox.y + menuBox.height <= buttonBox.y);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await slider.inputValue(), "3");
    assert.equal(await page.locator("#effort-label").innerText(), await slider.getAttribute("aria-valuetext"));
    const track = await slider.boundingBox();
    await page.mouse.move(track.x + 18 + (track.width - 36) * .6, track.y + track.height / 2);
    await page.mouse.down();
    await page.mouse.move(track.x + 18 + (track.width - 36) * .73, track.y + track.height / 2);
    const movingValue = Number(await slider.inputValue());
    assert.ok(movingValue > 3.5 && movingValue < 3.8, "drag follows fractional positions between stops");
    await page.mouse.move(track.x + track.width - 18, track.y + track.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await slider.inputValue(), "5");
    assert.equal(await page.locator(".model-settings-panel").getAttribute("data-effort"), "ultra");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".model-picker-strength")).color === "rgb(128, 36, 237)");
    assert.equal(await page.locator(".model-picker-strength").evaluate((element) => getComputedStyle(element).getPropertyValue("--effort-accent").trim()), "#8024ed");
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-ultra.png`, output)), animations: "disabled" });
    await page.keyboard.press("Escape");
    assert.equal(await button.evaluate((element) => element === document.activeElement), true);
    await page.reload();
    await button.click();
    assert.equal(await slider.inputValue(), "5");
    await page.getByRole("button", { name: "恢复默认思考强度", exact: true }).click();
    assert.equal(await slider.inputValue(), "2");
    assert.equal(await page.locator(".model-settings-panel").getAttribute("data-effort"), "high");
    await page.waitForFunction(() => getComputedStyle(document.querySelector(".model-picker-strength")).color === "rgb(0, 107, 214)");
    assert.equal(await page.locator(".model-picker-strength").evaluate((element) => getComputedStyle(element).getPropertyValue("--effort-accent").trim()), "#006bd6");
    await page.getByRole("button", { name: "切换模型", exact: true }).click();
    await page.getByRole("radio", { name: /Single effort/ }).click();
    assert.equal(await slider.isDisabled(), true);
    assert.equal(await page.locator("#effort-label").innerText(), "中");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.getByRole("button", { name: "切换模型", exact: true }).click();
    await page.getByRole("radio", { name: "No reasoning" }).click();
    assert.equal(await slider.isDisabled(), true);
    await page.getByRole("button", { name: "切换模型", exact: true }).click();
    await page.getByRole("radio", { name: "6 Astra" }).click();
    await page.locator("#conversation-title").click();
    assert.equal(await page.locator("#composer-menu").isVisible(), false);
    await button.click();
    await button.click();
    assert.equal(await page.locator("#composer-menu").isVisible(), false);
    await button.click();
    await page.evaluate((value) => window.pickerSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), { ...thread, control: { busy: true, turnId: "running", requests: [] } });
    assert.equal(await button.isDisabled(), true);
    assert.equal(await slider.isDisabled(), true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Model picker passed: desktop/mobile/dark layout, drag, keyboard, persistence, reset, model switching and busy state.");
} finally { await browser.close(); }
