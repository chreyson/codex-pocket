import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const output = new URL("../.data/qa/sidebar/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const projects = ["Codex Pocket", "植物大战僵尸", "杂七杂八", "SMTP发送邮件", "制作skill", "持续学习", "修服务器"];
const serverTitles = ["检测全球 DNS 可达性", "排查海外注册间歇性失败", "修复邮件HTML上传KL", "检查 Codex app 升级", "添加鸟类品种到宠物品种库", "Run project test", "配置服务器连接", "查看发布结果"];
const threads = projects.flatMap((project, index) => (project === "修服务器" ? serverTitles : [index ? "继续项目工作" : "拉取 codex-pocket 仓库"]).map((title, i) => ({
  id: `${index}-${i}`, project, title, preview: "", status: "idle", messages: [], control: { busy: false, requests: [] },
})));
try {
  for (const [name, width, height, colorScheme] of [["desktop", 1440, 900, "light"], ["desktop-dark", 1440, 900, "dark"], ["phone", 390, 844, "light"], ["small-phone", 320, 640, "light"]]) {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 720, isMobile: width < 720, colorScheme });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.sidebarSource = this; setTimeout(() => { this.onopen?.(); this.dispatchEvent(new MessageEvent("status", { data: '{"state":"ready"}' })); }, 10); }
        close() {}
      };
    });
    await page.route("**/api/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const body = pathname.endsWith("bootstrap") ? { status: { state: "ready" }, threads: [...threads, threads[0]] }
        : threads.find((thread) => pathname.endsWith(thread.id));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto(process.env.POCKET_TEST_URL || "http://127.0.0.1:4175");
    const server = page.locator('.project-group[aria-label="修服务器"]');
    await page.locator(".project-group").first().waitFor();
    assert.equal(await page.locator('[data-thread-id="0-0"]').count(), 1);
    assert.equal(await server.locator(".project-threads").isVisible(), false);
    await server.locator(".project-toggle").click();
    assert.equal(await server.locator(".thread-row").count(), 5);
    await server.getByRole("button", { name: "展开显示：修服务器", exact: true }).click();
    assert.equal(await server.locator(".thread-row").count(), 8);
    await page.evaluate((value) => window.sidebarSource.dispatchEvent(new MessageEvent("threads", { data: JSON.stringify(value) })), [...threads, threads[0]].map((item) => ({ ...item, updatedAt: 2 })));
    assert.equal(await page.locator('[data-thread-id="0-0"]').count(), 1);
    assert.equal(await server.locator(".thread-row").count(), 8);
    await server.getByRole("button", { name: "收起显示：修服务器", exact: true }).click();
    await page.locator("#thread-search").fill("查看发布结果");
    assert.equal(await page.locator(".thread-row").count(), 1);
    assert.equal(await page.locator('[data-thread-id="6-7"]').isVisible(), true);
    await page.locator("#thread-search").fill("");
    await page.locator('[data-thread-id="0-0"]').click();
    if (width < 720) await page.locator("#back-button").click();
    await page.mouse.move(width - 1, 1);
    assert.equal(await page.locator('.project-toggle[aria-expanded="true"]').count(), 2);
    assert.equal(await page.locator('.thread-row[aria-current="true"]').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator("#thread-list").evaluate((element) => { element.scrollTop = 0; });
    await page.locator(".thread-pane").screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Sidebar passed: compact groups, five-row preview, expansion, search, selection, streaming and mobile layout.");
} finally { await browser.close(); }
