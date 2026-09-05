import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const output = new URL("../.data/qa/markdown/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const answer = [
  "在 **Cloudflare 后台的 Tunnel（隧道）里配置**。我核对了当前官方文档，入口是：",
  "[打开 Cloudflare 隧道管理](https://dash.cloudflare.com/?to=/:account/tunnels)",
  "按下面操作即可：",
  "1. **先把域名接入 Cloudflare**\n\n   如果你的域名已经在 Cloudflare 管理，就跳过这步。\n2. **创建固定隧道**\n\n   进入 **Tunnels → Create a tunnel**，名称填 `codex-pocket`。\n3. **给隧道绑定域名**\n\n   打开刚创建的隧道，进入 **Routes → Add route → Published application**。",
  "### 检查连接\n\n> 确认连接器已经上线。",
  "- [x] 域名已接入\n- [ ] 连接已验证",
  "| 项目 | 值 |\n| --- | --- |\n| 服务 | Codex Pocket |\n| 地址 | localhost:62639 |",
  "```sh\ncurl https://example.com/" + "long-path/".repeat(30) + "\necho '<ready>'\n```",
].join("\n\n");
try {
  for (const [name, width, height, colorScheme] of [["desktop", 1440, 1000, "light"], ["phone", 390, 844, "light"], ["small-phone", 320, 640, "light"], ["dark", 390, 844, "dark"]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, isMobile: width < 720, hasTouch: width < 720 });
    const page = await context.newPage();
    const errors = [];
    const remoteRequests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => { if (request.url().includes("blocked.example")) remoteRequests.push(request.url()); });
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); window.markdownSource = this; }
        close() {}
      };
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => { window.copiedCode = text; } }, configurable: true });
    });
    const thread = {
      id: "markdown", project: "Codex Pocket", title: "配置固定访问地址",
      control: { busy: false, requests: [] },
      messages: [
        { id: "user", role: "user", kind: "message", text: "怎么配置 **固定域名**？" },
        { id: "answer", role: "assistant", kind: "message", text: answer },
      ],
    };
    await page.route("**/api/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(route.request().url().endsWith("bootstrap") ? { threads: [thread], status: { state: "ready" } } : thread) }));
    await page.goto(process.env.POCKET_TEST_URL || "http://127.0.0.1:62639");
    await page.locator('[data-thread-id="markdown"]').click();
    const body = page.locator('.message[data-role="assistant"] .message-body').first();
    assert.equal(await body.locator("strong").first().innerText(), "Cloudflare 后台的 Tunnel（隧道）里配置");
    assert.equal(await body.locator("a").getAttribute("href"), "https://dash.cloudflare.com/?to=/:account/tunnels");
    assert.equal(await body.locator("a").getAttribute("rel"), "noopener noreferrer");
    assert.equal(await body.locator("ol > li").count(), 3);
    assert.equal(await body.locator("table th").count(), 2);
    assert.equal(await body.locator('input[type="checkbox"]').first().isDisabled(), true);
    assert.equal(await body.locator("h3").innerText(), "检查连接");
    assert.doesNotMatch(await body.innerText(), /\*\*|\]\(https|```/);
    assert.match(await page.locator('.message[data-role="user"] .message-body').innerText(), /\*\*固定域名\*\*/);
    await body.getByRole("button", { name: "复制代码", exact: true }).click();
    assert.equal(await page.evaluate(() => window.copiedCode), await body.locator("pre code").textContent());
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator("#message-list").evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
    await page.reload();
    await body.locator("strong").first().waitFor();
    const unsafe = '<img src="https://blocked.example/raw" onerror="window.markdownXss=1"><script>window.markdownXss=1</script>\n\n[bad](javascript:alert(1)) [data](data:text/html,test) ![remote](https://blocked.example/image)';
    await page.evaluate((value) => window.markdownSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), { ...thread, messages: [{ id: "unsafe", role: "assistant", kind: "message", text: unsafe }] });
    assert.equal(await body.locator("img, script, iframe, svg, [onerror], a[href]").count(), 0);
    assert.equal(await page.evaluate(() => window.markdownXss), undefined);
    assert.deepEqual(remoteRequests, []);
    await page.evaluate(() => window.markdownSource.dispatchEvent(new MessageEvent("messageStart", { data: JSON.stringify({ threadId: "markdown", turnId: "live", itemId: "stream", kind: "message", text: "**实时", timestamp: 1 }) })));
    await page.evaluate(() => window.markdownSource.dispatchEvent(new MessageEvent("messageDelta", { data: JSON.stringify({ threadId: "markdown", turnId: "live", itemId: "stream", delta: "加粗**与[链接](https://example.com)\n\n- 第一项" }) })));
    const live = page.locator('.message[data-role="assistant"] .message-body').last();
    await live.locator("strong").waitFor();
    assert.equal(await live.locator("strong").innerText(), "实时加粗");
    assert.equal(await live.locator("li").innerText(), "第一项");
    assert.equal(await live.isVisible(), true);
    await page.evaluate(() => window.markdownSource.dispatchEvent(new MessageEvent("messageDone", { data: JSON.stringify({ threadId: "markdown", turnId: "live", itemId: "stream", kind: "message", text: "**实时加粗**与[链接](https://example.com)\n\n- 第一项", timestamp: 1 }) })));
    assert.equal(await live.locator("strong").innerText(), "实时加粗");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Markdown passed: historical/live rendering, reload, links, lists, tables, code copy, literal user text, XSS protection and responsive layouts.");
} finally { await browser.close(); }
