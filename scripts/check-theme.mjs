import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const base = process.env.POCKET_TEST_URL || "http://127.0.0.1:4173";
const output = new URL("../.data/qa/theme/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const errors = [];

async function checkTheme(page, theme) {
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
  const style = await page.evaluate(() => ({
    scheme: getComputedStyle(document.documentElement).colorScheme,
    background: getComputedStyle(document.body).backgroundColor,
    overflow: document.documentElement.scrollWidth > innerWidth,
  }));
  assert.equal(style.scheme, theme);
  assert.equal(style.background, theme === "dark" ? "rgb(33, 33, 33)" : "rgb(255, 255, 255)");
  assert.equal(style.overflow, false);
}

async function screenshot(page, name) {
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)), animations: "disabled" });
}

try {
  for (const [surface, width, height] of [["web", 1440, 900], ["web", 390, 844], ["web", 320, 640], ["desktop", 960, 640], ["desktop", 760, 520]]) {
    const desktop = surface === "desktop";
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: "light" });
    await context.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() {
          super();
          setTimeout(() => this.onopen?.(), 0);
        }
        close() {}
      };
      window.pywebview = { api: {
        get_theme: async () => localStorage.getItem("native-theme-test") || "system",
        set_theme: async (theme) => localStorage.setItem("native-theme-test", theme),
        get_state: async () => ({ phase: "running", status: "服务运行中", publicUrl: "https://pocket.example.test", accessKey: "example-key", busy: false, error: "" }),
      } };
    });
    await context.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: { state: "ready" }, threads: [], projects: [] }) }));
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const url = `${base}${desktop ? "/desktop/index.html" : "/"}`;
    await page.goto(url);
    const opener = page.locator(desktop ? ".sidebar-status [data-settings-button]" : ".pane-footer [data-settings-button]");
    const picker = page.locator("[data-theme-picker]:checked");
    const choose = (value) => page.locator(`[data-theme-picker][value="${value}"]`).check();
    await opener.waitFor({ state: "visible" });
    assert.equal((await opener.innerText()).trim(), "");
    assert.equal(await opener.getAttribute("aria-label"), "设置");
    assert.equal(await picker.isVisible(), false);
    await screenshot(page, `${surface}-${width}-settings-entry`);
    await opener.click();
    await picker.waitFor({ state: "visible" });
    assert.equal(await page.locator("#settings-heading").evaluate((el) => el === document.activeElement), true);
    assert.equal(await page.locator("[data-settings-close]").evaluate((el) => getComputedStyle(el).outlineStyle), "none");
    await screenshot(page, `${surface}-${width}-initial-dialog`);
    await page.keyboard.press("Tab");
    assert.equal(await page.locator("[data-settings-close]").evaluate((el) => el === document.activeElement && el.matches(":focus-visible")), true);
    assert.equal(await picker.inputValue(), "system");
    await checkTheme(page, "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await checkTheme(page, "dark");
    await picker.focus();
    await page.keyboard.press("ArrowDown");
    await checkTheme(page, "light");
    await page.keyboard.press("ArrowUp");
    await checkTheme(page, "dark");
    await choose("light");
    await checkTheme(page, "light");
    await screenshot(page, `${surface}-${width}-light`);
    await page.reload();
    await checkTheme(page, "light");
    await opener.click();
    assert.equal(await picker.inputValue(), "light");
    await page.emulateMedia({ colorScheme: "light" });
    await choose("dark");
    await checkTheme(page, "dark");
    await screenshot(page, `${surface}-${width}-dark`);
    await page.reload();
    await checkTheme(page, "dark");
    await opener.click();
    assert.equal(await picker.inputValue(), "dark");
    if (!desktop) {
      const second = await context.newPage();
      await second.goto(url);
      await checkTheme(second, "dark");
      await choose("light");
      await checkTheme(second, "light");
      await second.close();
    }
    await choose("system");
    await checkTheme(page, "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await checkTheme(page, "dark");
    await page.keyboard.press("Escape");
    assert.equal(await picker.isVisible(), false);
    await opener.and(page.locator('[aria-expanded="false"]')).waitFor({ state: "visible" });
    assert.equal(await opener.getAttribute("aria-expanded"), "false");
    assert.equal(await opener.evaluate((element) => element === document.activeElement), true);
    await opener.click();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    assert.equal(await picker.isVisible(), false);
    await opener.click();
    await page.mouse.click(1, 1);
    assert.equal(await picker.isVisible(), false);
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
  await context.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"Unauthorized"}' }));
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await page.locator("#auth-screen").waitFor({ state: "visible" });
  await checkTheme(page, "dark");
  await page.locator("#auth-screen [data-settings-button]").click();
  await page.getByRole("radio", { name: "浅色", exact: true }).check();
  await checkTheme(page, "light");
  await screenshot(page, "auth-phone-light");
  await context.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage unavailable"); } });
  });
  await page.reload();
  await checkTheme(page, "dark");
  await page.locator("#auth-screen [data-settings-button]").click();
  await page.getByRole("radio", { name: "浅色", exact: true }).check();
  await checkTheme(page, "light");
  await page.locator("[data-theme-error]").waitFor({ state: "visible" });
  await context.close();
  assert.deepEqual(errors, []);
  console.log("Theme checks passed: settings open/close, focus return, manual overrides, live system changes, reload persistence, tab sync, auth, storage failure and responsive layouts.");
} finally {
  await browser.close();
}
