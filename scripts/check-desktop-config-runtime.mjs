import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import net from "node:net";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServer } from "../src/codex-client.mjs";
import { prepareDesktopProxy } from "../src/desktop-launch.mjs";
import { desktopLaunchConfig, withDesktopLaunchConfig } from "../src/desktop-proxy-config.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "pocket-config-test-"));
const oldHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = directory;
const client = new CodexAppServer({ command: "/Applications/ChatGPT.app/Contents/Resources/codex", websocketUrl: "" });
let backend;
let desktop;
let web;
let reader;
const pending = new Map();
try {
  await client.start();
  const params = { cwd: directory, ephemeral: true, config: { "mcp_servers.codex_app.enabled_tools": ["list_threads"] } };
  await assert.rejects(client.request("thread/start", params), /invalid transport/);
  const args = ["app-server", "-c", 'mcp_servers.codex_app={command="/usr/bin/true",enabled=false}'];
  const fixed = withDesktopLaunchConfig({ method: "thread/start", params }, desktopLaunchConfig(args));
  const restored = await client.request("thread/start", fixed.params);
  assert.ok(restored.thread.id);
  const reservation = net.createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const url = `ws://127.0.0.1:${reservation.address().port}`;
  await new Promise((resolve) => reservation.close(resolve));
  backend = spawn(client.command, ["app-server", "--listen", url], { stdio: "ignore", env: process.env });
  web = new CodexAppServer({ websocketUrl: url, requestTimeoutMs: 1000 });
  for (let attempt = 0; ; attempt++) {
    try { await web.start(); break; }
    catch (error) { if (attempt >= 30 || backend.exitCode !== null) throw error; await delay(100); }
  }
  const proxyPath = await prepareDesktopProxy(url, { dataDirectory: directory, codexPath: client.command });
  desktop = spawn(proxyPath, args, { stdio: ["pipe", "pipe", "ignore"] });
  reader = readline.createInterface({ input: desktop.stdout });
  reader.on("line", (line) => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  let nextId = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    desktop.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  await request("initialize", { clientInfo: { name: "pocket_config_test", version: "1" }, capabilities: { experimentalApi: true } });
  desktop.stdin.write('{"method":"initialized"}\n');
  const created = await request("thread/start", { ...params, ephemeral: false });
  await request("thread/inject_items", { threadId: created.thread.id, items: [{ type: "message", role: "user", content: [{ type: "input_text", text: "Configuration regression fixture" }] }] });
  assert.equal((await web.readThread(created.thread.id)).thread.id, created.thread.id);
  const resumed = await request("thread/resume", { threadId: created.thread.id, config: params.config });
  assert.equal(resumed.thread.id, created.thread.id);
  console.log("PASS: reproduced invalid transport, then generated desktop wrapper + actual WebSocket backend successfully start/resume the same task with desktop launch config; Web reads the same task. No model called or user config modified.");
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  reader?.close();
  if (desktop) { const closed = once(desktop, "close"); desktop.kill(); await closed; }
  web?.stop();
  if (backend) { const closed = once(backend, "close"); backend.kill(); await closed; }
  const closed = client.proc ? once(client.proc, "close") : Promise.resolve();
  client.stop();
  await closed;
  if (oldHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldHome;
  await rm(directory, { recursive: true, force: true });
}
