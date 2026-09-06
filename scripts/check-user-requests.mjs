import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { sanitizeServerRequest } from "../src/control.mjs";

const root = fileURLToPath(new URL("../public/", import.meta.url));
let server;
let base = process.env.POCKET_TEST_URL;
if (!base) {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const file = path.resolve(root, pathname === "/" ? "index.html" : pathname.slice(1));
    if (!file.startsWith(root)) { response.writeHead(404).end(); return; }
    try {
      const body = await fs.readFile(file);
      const type = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" }[path.extname(file)];
      response.writeHead(200, { "Content-Type": `${type || "application/octet-stream"}; charset=utf-8` }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
}
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
let browser;
const output = fileURLToPath(new URL("../.data/qa/user-requests/", import.meta.url));
const request = (token, method, params) => sanitizeServerRequest({ token, message: { method, params: { threadId: "request-ui", turnId: "turn", ...params } } });
const question = () => request("question", "item/tool/requestUserInput", { isBlocking: true, questions: [
  { id: "area", header: "范围", question: "这次优先完善哪一部分？", options: [
    { label: "继续现有任务（推荐）", description: "保留当前上下文，完成正在进行的工作。" },
    { label: "处理新任务", description: "开始另一项工作。" },
  ] },
  { id: "note", header: "补充", question: "还有哪些需要注意的地方？", isSecret: true },
] });
try {
  browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  await fs.mkdir(output, { recursive: true });
  for (const [name, width, height, colorScheme] of [["desktop", 1440, 900, "light"], ["phone", 390, 844, "light"], ["small-phone", 320, 640, "light"], ["dark", 390, 844, "dark"]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, isMobile: width < 720, hasTouch: width < 720 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const thread = { id: "request-ui", title: "完善移动端体验", project: "Pocket", messages: [
      { id: "user", role: "user", kind: "message", text: "稳定顺畅地继续现有任务" },
      { id: "reply", role: "assistant", kind: "commentary", text: "我需要确认一下这次的处理范围。" },
    ], control: { busy: true, requests: [question()] } };
    const other = { id: "other-thread", title: "另一个任务", project: "Pocket", messages: [], control: { busy: false, requests: [] } };
    const submissions = [];
    let reject = true;
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() {
          super();
          window.requestSource = this;
          // Deliver initial readiness before the next simulated connection change.
          queueMicrotask(() => {
            if (!this.closed) this.dispatchEvent(new MessageEvent("status", { data: '{"state":"ready"}' }));
          });
        }
        close() { this.closed = true; }
      };
    });
    await page.route("**/api/**", async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      let body = thread;
      if (pathname.endsWith("bootstrap")) body = { status: { state: "ready" }, threads: [thread, other] };
      if (pathname.endsWith("/other-thread")) body = other;
      if (pathname.includes("/approvals/")) {
        submissions.push({ token: pathname.split("/").at(-1), payload: route.request().postDataJSON() });
        await route.fulfill({ status: reject ? 503 : 200, contentType: "application/json", body: JSON.stringify(reject ? { error: "连接暂时中断，请重试" } : { ok: true }) });
        return;
      }
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    });
    const emit = () => page.evaluate((value) => window.requestSource.dispatchEvent(new MessageEvent("thread", { data: JSON.stringify(value) })), thread);
    await page.goto(base);
    await page.locator('[data-thread-id="request-ui"]').click();
    const panel = page.locator('[data-token="question"]');
    await panel.getByText("这次优先完善哪一部分？", { exact: true }).waitFor();
    assert.equal(await panel.locator('input[type="radio"]').first().isChecked(), true);
    const answer = panel.locator("textarea");
    await answer.fill("先做好断线恢复");
    await emit();
    assert.equal(await answer.inputValue(), "先做好断线恢复");
    assert.equal(await answer.evaluate((node) => node === document.activeElement), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `${name}-question.png`) });
    if (width < 720) await page.locator("#back-button").click();
    await page.locator('[data-thread-id="other-thread"]').click();
    await page.locator("#conversation-title").filter({ hasText: "另一个任务" }).waitFor();
    if (width < 720) await page.locator("#back-button").click();
    await page.locator('[data-thread-id="request-ui"]').click();
    await answer.waitFor();
    assert.equal(await answer.inputValue(), "先做好断线恢复");
    await answer.focus();
    await page.evaluate(() => window.requestSource.onerror());
    assert.equal(await panel.getByRole("button", { name: "下一题" }).isDisabled(), true);
    assert.equal(await page.locator("#connection-state").getAttribute("data-state"), "disconnected");
    assert.equal(await answer.inputValue(), "先做好断线恢复");
    await page.evaluate(() => window.requestSource.dispatchEvent(new MessageEvent("status", { data: '{"state":"ready"}' })));
    assert.equal(await panel.getByRole("button", { name: "下一题" }).isDisabled(), false);
    thread.control.requests.push(request("concurrent", "item/commandExecution/requestApproval", { command: "npm test", availableDecisions: ["accept", "decline"] }));
    await emit();
    assert.equal(await answer.inputValue(), "先做好断线恢复");
    assert.equal(await answer.evaluate((node) => node === document.activeElement), true);
    thread.control.requests.pop();
    await emit();
    await panel.getByRole("button", { name: "下一题" }).click();
    await panel.getByRole("button", { name: "提交回答" }).click();
    await panel.getByRole("alert").filter({ hasText: "请填写回答" }).waitFor();
    const secret = panel.locator('input[type="password"]');
    await secret.fill("synthetic-private-answer");
    await panel.getByRole("button", { name: "提交回答" }).click();
    await panel.getByRole("alert").filter({ hasText: "连接暂时中断" }).waitFor();
    assert.equal(await secret.inputValue(), "synthetic-private-answer");
    reject = false;
    await panel.getByRole("button", { name: "提交回答" }).click();
    await panel.locator(".approval-state").filter({ hasText: "已提交" }).waitFor();
    assert.equal(await secret.inputValue(), "");
    assert.deepEqual(submissions[1].payload, { answers: { area: { answers: ["先做好断线恢复"] }, note: { answers: ["synthetic-private-answer"] } } });
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("synthetic-private-answer")), false);
    await emit();
    assert.equal(await panel.getByRole("button", { name: "提交回答" }).isDisabled(), true);
    thread.control.requests = [];
    await emit();
    await page.locator("#approval-tray").waitFor({ state: "hidden" });
    thread.control.requests = [request("command", "item/commandExecution/requestApproval", {
      command: "npm test", reason: "需要运行测试以确认修改是否正确。",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
    })];
    await emit();
    const command = page.locator('[data-token="command"]');
    await command.getByRole("button", { name: "在此会话中允许" }).waitFor();
    assert.equal(await command.locator("details").getAttribute("open"), null);
    await command.locator("summary").click();
    await page.screenshot({ path: path.join(output, `${name}-approval.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await command.getByRole("button", { name: "在此会话中允许" }).click();
    await command.locator(".approval-state").filter({ hasText: "已提交" }).waitFor();
    assert.deepEqual(submissions.at(-1), { token: "command", payload: { choice: "1" } });
    thread.control.requests = [request("mcp", "mcpServer/elicitation/request", { mode: "form", serverName: "项目设置", message: "确认后继续", requestedSchema: { type: "object", properties: {
      count: { type: "integer", title: "数量", minimum: 1 },
      enabled: { type: "boolean", title: "启用" },
      regions: { type: "array", title: "地区", minItems: 1, items: { type: "string", enum: ["cn", "us"] } },
    }, required: ["count", "enabled"] } })];
    await emit();
    const mcp = page.locator('[data-token="mcp"]');
    await mcp.getByLabel("数量").fill("2");
    await mcp.getByRole("button", { name: "提交", exact: true }).click();
    await mcp.locator(".approval-state").filter({ hasText: "已提交" }).waitFor();
    assert.deepEqual(submissions.at(-1).payload, { action: "accept", content: { count: 2, enabled: false } });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Request UI passed: desktop/390px/320px/dark, questions, validation, retained focus, retry, exact replies, secret cleanup, command scope, MCP and resolution.");
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
