import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServer, appServerLaunchSpec } from "../src/codex-client.mjs";
import { defaultCodexCommand } from "../src/shared-runtime.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "pocket-shared-test-"));
const reservation = net.createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const websocketUrl = `ws://127.0.0.1:${reservation.address().port}`;
await new Promise((resolve) => reservation.close(resolve));
const launch = appServerLaunchSpec(defaultCodexCommand(), { listenUrl: websocketUrl });
const backend = spawn(launch.command, launch.args, {
  env: { ...process.env, CODEX_HOME: directory }, shell: launch.shell,
  stdio: ["ignore", "ignore", "pipe"], windowsHide: true,
});
let diagnostic = "";
backend.stderr.on("data", (data) => { diagnostic = String(data).slice(-1000); });
const closed = once(backend, "close");
const desktop = new CodexAppServer({ websocketUrl, requestTimeoutMs: 1000 });
const web = new CodexAppServer({ websocketUrl, requestTimeoutMs: 1000 });
try {
  for (let attempt = 0; ; attempt++) {
    try { await desktop.start(); break; }
    catch (error) {
      if (attempt >= 30 || backend.exitCode !== null) throw new Error(diagnostic || error.message);
      await delay(100);
    }
  }
  const { thread } = await desktop.startThread({ cwd: directory });
  await desktop.request("thread/inject_items", { threadId: thread.id, items: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Shared connection fixture" }] },
  ] });
  await web.resumeThread(thread.id);
  assert.equal(web.loadedThreads.has(thread.id), true);
  await web.request("thread/settings/update", { threadId: thread.id, approvalPolicy: "on-request" });
  await web.request("thread/name/set", { threadId: thread.id, name: "Same task across clients" });
  assert.equal((await desktop.readThread(thread.id)).thread.name, "Same task across clients");
  web.stop();
  assert.equal(backend.exitCode, null);
  await web.readThread(thread.id);
  assert.equal(web.loadedThreads.has(thread.id), true);
  assert.equal((await desktop.readThread(thread.id)).thread.id, thread.id);
  console.log("Real shared runtime passed: two clients read and modify the SAME thread, disconnect/reconnect preserves it, closing Pocket does not stop the backend. No model turn sent.");
} finally {
  web.stop(); desktop.stop();
  backend.kill(); await closed;
  await rm(directory, { recursive: true, force: true });
}
