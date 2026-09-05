import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const playwright = await import("playwright");
const browser = await playwright[process.env.PLAYWRIGHT_BROWSER || "chromium"].launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
const output = new URL("../.data/qa/management/", import.meta.url);
await fs.mkdir(output, { recursive: true });
try {
  for (const [name, width, height, colorScheme] of [["desktop", 1440, 900, "light"], ["phone", 390, 844, "light"], ["small-phone", 320, 640, "light"], ["dark", 390, 844, "dark"]]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, hasTouch: width < 720, isMobile: width < 720 });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let projects = [{ id: "p1", name: "Codex Pocket", roots: ["/test/pocket"], archived: false }];
    let threads = [{ id: "t1", projectId: "p1", project: "Codex Pocket", title: "继续现有任务", status: "idle", messages: [], control: { busy: false, requests: [] } }];
    const archived = [];
    await page.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() { super(); setTimeout(() => { this.onopen?.(); this.dispatchEvent(new MessageEvent("status", { data: '{"state":"ready"}' })); }, 10); }
        close() {}
      };
    });
    await page.route("**/api/**", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const payload = req.postDataJSON();
      let body = {};
      if (url.pathname === "/api/bootstrap") body = { projects, projectsSupported: true, threads, status: { state: "ready" } };
      else if (url.pathname === "/api/threads" && req.method() === "GET") body = { threads: archived, nextCursor: null };
      else if (url.pathname === "/api/projects") {
        if (payload.path === "/missing") return route.fulfill({ status: 400, json: { error: "该文件夹不存在或无法访问" } });
        const project = { id: "p2", name: payload.name, roots: [payload.path], archived: false };
        projects.push(project); body = { project };
      } else if (url.pathname.startsWith("/api/projects/")) {
        const [, , , id, action] = url.pathname.split("/");
        const project = projects.find((item) => item.id === id);
        if (action === "rename") project.name = payload.name;
        else project.archived = action === "archive";
        body = { project };
      } else if (url.pathname === "/api/threads" && req.method() === "POST") {
        const project = projects.find((item) => item.id === payload.projectId);
        const thread = { ...threads[0], id: "t2", projectId: project.id, project: project.name, title: "新会话", messages: [], control: { busy: false, requests: [] } };
        threads.push(thread); body = { thread };
      } else {
        const [, , , id, action] = url.pathname.split("/");
        const thread = [...threads, ...archived].find((item) => item.id === id);
        if (!action) body = thread;
        else if (action === "rename") thread.title = payload.name;
        else if (action === "archive") { archived.push(thread); threads = threads.filter((item) => item.id !== id); }
        else if (action === "restore") { threads.push(thread); archived.splice(archived.indexOf(thread), 1); }
      }
      return route.fulfill({ json: body });
    });
    await page.goto(process.env.POCKET_TEST_URL || "http://127.0.0.1:4175");
    const menu = page.locator("#sidebar-menu");
    const openMenu = (label) => page.getByRole("button", { name: label, exact: true }).click();
    await openMenu("项目操作：Codex Pocket");
    await page.keyboard.press("Escape");
    assert.equal(await menu.isVisible(), false);
    await page.locator("#new-project-button").click();
    await page.locator("#management-name").fill("新项目");
    await page.locator("#management-path").fill("/missing");
    await page.locator("#management-submit").click();
    await page.getByText("该文件夹不存在或无法访问", { exact: true }).waitFor();
    await page.locator("#management-path").fill("/test/new-project");
    await page.locator("#management-submit").click();
    await page.locator("#management-dialog").waitFor({ state: "hidden" });
    await openMenu("项目操作：新项目");
    await menu.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await page.locator("#management-name").fill("工作项目");
    await page.locator("#management-submit").click();
    await page.locator("#management-dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "在 工作项目 中新建会话", exact: true }).click();
    await page.locator("#conversation-title").filter({ hasText: "新会话" }).waitFor();
    if (width < 720) await page.locator("#back-button").click();
    await openMenu("会话操作：新会话");
    await menu.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await page.locator("#management-name").fill("继续检查侧边栏");
    await page.locator("#management-submit").click();
    await page.locator("#management-dialog").waitFor({ state: "hidden" });
    await openMenu("会话操作：继续检查侧边栏");
    await page.screenshot({ path: fileURLToPath(new URL(`${name}-menu.png`, output)) });
    await menu.getByRole("menuitem", { name: "归档", exact: true }).click();
    await page.getByRole("button", { name: "查看已归档", exact: true }).click();
    const group = page.locator('.project-group[aria-label="工作项目"]');
    await group.waitFor();
    if (await group.locator(".project-toggle").getAttribute("aria-expanded") === "false") await group.locator(".project-toggle").click();
    await page.locator('[data-thread-id="t2"]').click();
    assert.equal(await page.locator("#composer").isVisible(), false);
    if (width < 720) await page.locator("#back-button").click();
    await openMenu("会话操作：继续检查侧边栏");
    await menu.getByRole("menuitem", { name: "恢复", exact: true }).click();
    await page.locator("#archived-button").click();
    await openMenu("项目操作：工作项目");
    await menu.getByRole("menuitem", { name: "在 Pocket 中归档", exact: true }).click();
    await page.locator("#archived-button").click();
    await openMenu("项目操作：工作项目");
    await menu.getByRole("menuitem", { name: "恢复", exact: true }).click();
    await page.locator("#archived-button").click();
    await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log("Management passed: create, rename, archive, restore, errors, menus and responsive layouts.");
} finally { await browser.close(); }
