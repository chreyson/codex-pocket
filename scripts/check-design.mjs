import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { permissionCatalog } from "../src/permissions.mjs";
import { connectionDescription } from "../src/desktop-connection.mjs";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const base = process.env.POCKET_TEST_URL || "http://127.0.0.1:4173";
const output = new URL("../.data/qa/design/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const errors = [];
const thread = {
  id: "design-task", title: "对齐手机端与桌面端的使用体验", project: "Codex Pocket", status: "idle",
  control: { busy: false, requests: [] },
  turns: [{ id: "design-turn", durationMs: 253000 }],
  composerOptions: { models: [{ id: "test", name: "GPT-6-Astra", defaultEffort: "high", efforts: [{ id: "high" }] }], features: { skills: true }, skills: [], permissions: {
    ...permissionCatalog({ supported: true, profiles: [":workspace", ":danger-full-access"].map((id) => ({ id, allowed: true })) }), current: "ask",
  } },
  messages: [
    { id: "u", role: "user", kind: "message", text: "把手机和桌面窗口调整得更舒适一些，运行细节也默认收起。" },
    { id: "p", role: "assistant", kind: "commentary", text: "我会统一两端的字体、灰阶和控件间距。运行细节将收起为简短摘要，需要时可以展开查看。" },
    ...Array.from({ length: 4 }, (_, i) => ({ id: `tool-${i}`, role: "system", kind: "activity", activityType: i === 3 ? "file" : "command", ...(i === 0 ? { activityActions: ["read"] } : {}), activityStatus: i === 2 ? "failed" : "completed", text: `运行 /bin/zsh -lc 'inspect-design --file public/example-${i}.css'` })),
    { id: "r", role: "assistant", kind: "reasoning", activityStatus: "inProgress", text: "Internal reasoning detail should remain collapsed." },
    { id: "a", role: "assistant", kind: "message", text: "界面已更新。\n\n现在会优先显示对话、任务结果和需要你处理的事项。工具操作和思考内容保留在折叠区域中。" },
  ].map((message) => ({ ...message, turnId: "design-turn" })),
};
async function shot(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal overflow`);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
}
try {
  for (const [name, width, height, colorScheme] of [
    ["web", 1440, 900, "light"], ["web-dark", 1440, 900, "dark"],
    ["phone", 390, 844, "light"], ["phone-small", 320, 640, "light"], ["phone-dark", 390, 844, "dark"],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 720, isMobile: width < 720, colorScheme });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.designSource = this; setTimeout(() => { this.onopen?.(); this.dispatchEvent(new MessageEvent("status", { data: '{"state":"ready"}' })); }, 20); }
        close() {}
      };
    });
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(route.request().url().endsWith("bootstrap") ? { status: { state: "ready" }, threads: [thread, { ...thread, id: "other", title: "检查最新发布结果" }] } : thread) }));
    await page.goto(base);
    await shot(page, `${name}-sidebar`);
    await page.locator('[data-thread-id="design-task"]').click();
    await page.locator(".activity-summary").waitFor({ state: "attached" });
    assert.equal((await page.locator(".turn-process-summary").innerText()).trim(), "用时 4分13秒");
    assert.equal(await page.locator('.message[data-kind="commentary"]').isVisible(), false);
    assert.equal(await page.locator('#message-list > .message[data-role="assistant"]').isVisible(), true);
    await page.locator('#connection-state[data-state="ready"]').waitFor({ state: "attached", timeout: 5_000 });
    assert.equal(await page.locator(".activity-list").isVisible(), false);
    assert.equal(await page.locator(".reasoning-body").isVisible(), false);
    assert.equal((await page.locator(".activity-summary").textContent()).trim(), "编辑了文件、已读取文件、运行命令");
    assert.equal(await page.locator('[data-kind="reasoning"]').count(), 0);
    await shot(page, name);
    const header = page.locator(".conversation-header");
    const actions = page.locator("#conversation-actions");
    const summary = actions.locator("summary");
    assert.equal(await page.locator("#conversation-meta").isVisible(), false);
    assert.equal(Math.round((await header.boundingBox()).height), width < 720 ? 57 : 40);
    await summary.click();
    assert.match(await page.locator("#conversation-meta").innerText(), /Codex Pocket/);
    await shot(page, `${name}-header-menu`);
    await page.keyboard.press("Escape");
    assert.equal(await actions.evaluate((element) => element.open), false);
    assert.equal(await summary.evaluate((element) => element === document.activeElement), true);
    await summary.click();
    await page.locator("#message-input").click();
    assert.equal(await actions.evaluate((element) => element.open), false);
    await page.evaluate((value) => window.designSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), {
      ...thread, title: thread.title.repeat(5),
    });
    await shot(page, `${name}-long-title`);
    const titleBox = await page.locator("#conversation-title").boundingBox();
    const actionBox = await summary.boundingBox();
    assert.ok(titleBox.x + titleBox.width <= actionBox.x);
    await page.evaluate(() => window.designSource.dispatchEvent(new MessageEvent("threadError", { data: '{"message":"Test sync error"}' })));
    await page.locator("#conversation-meta").filter({ hasText: "Test sync error" }).waitFor();
    assert.equal(await actions.evaluate((element) => element.open), true);
    await page.keyboard.press("Escape");
    await page.evaluate((value) => window.designSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), thread);
    const messageFont = await page.locator('.message[data-role="assistant"] .message-body').first().evaluate((element) => getComputedStyle(element).fontSize);
    assert.equal(messageFont, "14px");
    const typography = await page.evaluate(() => {
      const read = (selector) => {
        const style = getComputedStyle(document.querySelector(selector));
        return { size: style.fontSize, weight: style.fontWeight, color: style.color };
      };
      return {
        body: read('.message[data-role="assistant"] .message-body'),
        user: read('.message[data-role="user"] .message-body'),
        thread: read(".thread-title"),
        section: read(".thread-section-label"),
        header: read("#conversation-title"),
        process: read(".turn-process-summary"),
        activity: read(".activity-summary"),
        composer: read("#message-input"),
        model: read("#model-control"),
      };
    });
    for (const key of ["body", "user", "thread", "section", "process", "activity", "composer", "model"]) {
      assert.equal(typography[key].weight, "430", `${name}: ${key} default weight`);
    }
    assert.equal(typography.header.weight, "500");
    assert.equal(typography.body.color, colorScheme === "dark" ? "rgb(229, 229, 229)" : "rgb(26, 28, 31)");
    assert.equal(typography.user.color, typography.body.color);
    assert.notEqual(typography.process.color, typography.body.color);
    assert.notEqual(typography.model.color, typography.body.color);
    assert.equal(typography.composer.size, width < 720 ? "16px" : "14px");
    await fs.writeFile(new URL(`${name}-typography.json`, output), JSON.stringify(typography, null, 2));
    assert.equal(await page.locator("#message-input").getAttribute("placeholder"), "随心输入");
    assert.equal(await page.locator("#mode-control").isVisible(), false);
    await page.locator("#extras-button").click();
    assert.equal(await page.locator("#mode-control").isVisible(), true);
    assert.equal(await page.locator("#image-upload-button").isVisible(), true);
    await shot(page, `${name}-composer-menu`);
    assert.equal(await page.locator("#skill-control").isVisible(), false);
    assert.equal(await page.locator("#composer-extras").isVisible(), true);
    assert.equal(await page.locator("#composer-menu").isVisible(), false);
    await page.locator("#message-input").click();
    await page.locator("#message-input").fill("继续处理这个任务");
    assert.equal(await page.locator("#send-button").isDisabled(), false);
    await page.locator(".composer-box").screenshot({ path: fileURLToPath(new URL(`${name}-composer.png`, output)), animations: "disabled" });
    await page.locator("#message-input").fill("");
    await page.locator(".turn-process-summary").click();
    await page.locator(".activity-summary").click();
    assert.equal(await page.locator(".activity-list").isVisible(), true);
    await page.evaluate((value) => window.designSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), {
      ...thread, messages: thread.messages.map((message) => message.id === "tool-0" ? { ...message, text: "Changed tool detail" } : message),
    });
    assert.equal(await page.locator(".activity-disclosure").evaluate((element) => element.open), true);
    assert.equal(await page.locator(".turn-process").evaluate((element) => element.open), true);
    await shot(page, `${name}-details`);
    await page.evaluate(() => { window.resultArticle = document.querySelector('#message-list > .message[data-role="assistant"]'); });
    await page.evaluate((value) => window.designSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), {
      ...thread, control: { busy: true, turnId: "design-turn", requests: [] },
    });
    assert.equal(await page.locator('.message[data-kind="commentary"]').isVisible(), true);
    assert.equal((await page.locator(".thinking-status").innerText()).trim(), "思考中");
    assert.equal(await page.locator(".thinking-status").count(), 1);
    await page.locator(".activity-summary").click();
    await page.locator(".thinking-status").scrollIntoViewIfNeeded();
    await shot(page, `${name}-thinking`);
    await page.evaluate((value) => window.designSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), thread);
    assert.equal(await page.locator(".turn-process").evaluate((element) => element.open), false);
    assert.equal(await page.locator(".thinking-status").count(), 0);
    assert.equal(await page.evaluate(() => window.resultArticle === document.querySelector('#message-list > .message[data-role="assistant"]')), true);
    await shot(page, `${name}-completed`);
    await page.evaluate((value) => window.designSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), {
      ...thread, control: { busy: true, turnId: "approval-turn", requests: [{
        token: "synthetic-request", type: "command", title: "命令需要批准", detail: "npm run build", reason: "构建当前项目", responding: false,
      }] },
    });
    await page.locator(".approval-request").waitFor();
    assert.equal(await page.locator("#latest-button").isVisible(), false);
    await shot(page, `${name}-approval`);
    await context.close();
  }
  for (const [name, width, height, colorScheme] of [
    ["auth", 1440, 900, "light"], ["auth-phone", 390, 844, "light"], ["auth-dark", 390, 844, "dark"], ["auth-keyboard", 390, 380, "light"],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme });
    const page = await context.newPage();
    await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "" }) }));
    await page.goto(base);
    await page.locator("#auth-screen").waitFor();
    await shot(page, name);
    await context.close();
  }
  for (const [name, width, height, colorScheme] of [
    ["controller", 960, 640, "light"], ["controller-small", 760, 520, "light"],
    ["controller-dark", 960, 640, "dark"], ["controller-wide", 1440, 900, "light"],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((desktopConnection) => {
      window.designState = { phase: "running", connectionMode: "shared", desktopConnection, status: "服务运行中", publicUrl: "https://your-pocket-connection.trycloudflare.com", accessKey: "example-access-key-not-a-real-credential", busy: false, error: "" };
      window.designConnects = 0;
      window.pywebview = { api: {
        get_theme: async () => "system",
        set_theme: async (theme) => theme,
        get_state: async () => window.designState,
        copy_text: async () => true,
        stop_service: async () => (window.designState = { phase: "stopped", status: "服务已停止", publicUrl: "", accessKey: "", busy: false, error: "" }),
        start_service: async () => window.designState,
        connect_desktop: async () => { window.designConnects++; return window.designState; },
      } };
    }, connectionDescription("independent", "win32"));
    await page.goto(`${base}/desktop/index.html`);
    await page.locator('#desktop-app[data-phase="running"]').waitFor();
    assert.equal(await page.locator("#connection-description").innerText(), "连接已就绪");
    const mode = page.locator("#connection-mode");
    assert.equal(await mode.innerText(), "正在切换");
    assert.equal(await page.evaluate(() => window.designConnects), 0);
    const bounds = await mode.boundingBox();
    assert.ok(bounds.width >= 48 && bounds.height <= 28, "mode label must remain on one line");
    const headerBefore = await page.locator(".section-intro").boundingBox();
    await shot(page, `${name}-mode`);
    await page.locator(".connection-mode-details > summary").click();
    await page.locator(".connection-mode-help").waitFor({ state: "visible" });
    assert.deepEqual(await page.locator(".section-intro").boundingBox(), headerBefore, "help must not shift the header");
    const help = await page.locator(".connection-mode-help").boundingBox();
    assert.ok(help.x >= 0 && help.x + help.width <= width);
    await shot(page, `${name}-mode-help`);
    await page.locator("#connect-desktop").click();
    assert.equal(await page.evaluate(() => window.designConnects), 1);
    await page.evaluate((connection) => { window.designState.desktopConnection = connection; }, connectionDescription("shared"));
    await page.waitForFunction(() => document.querySelector("#connection-mode").textContent === "已共享");
    assert.equal(await page.locator("#connect-desktop").isVisible(), false);
    await page.locator(".connection-mode-details > summary").click();
    await page.locator("#copy-url").click();
    await page.locator("#copy-toast[data-visible=true]").waitFor();
    await shot(page, name);
    await page.locator("#service-button").click();
    assert.equal(await page.locator("#connection-description").innerText(), "服务未开启");
    assert.equal(await page.locator("#copy-key").isDisabled(), true);
    await shot(page, `${name}-stopped`);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log("Design checks passed: collapsed details, expansion persistence, desktop states, copy feedback, responsive layouts and dark mode.");
} finally { await browser.close(); }
