import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { CodexAppServer, appServerLaunchSpec } from "../src/codex-client.mjs";
import { prepareDesktopProxy } from "../src/desktop-launch.mjs";
import { localAppServerUrl } from "../src/runtime-config.mjs";

async function fixture(t) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const thread = { id: "same-thread", cwd: "/test", status: { type: "idle" }, turns: [] };
  let pendingApproval = false;
  const notify = (method, params) => {
    for (const socket of server.clients) socket.send(JSON.stringify({ method, params }));
  };
  server.on("connection", (socket) => socket.on("message", (data) => {
    const message = JSON.parse(data);
    const { id, method } = message;
    if (method === "initialized") return;
    if (id === "approval") {
      pendingApproval = false;
      notify("serverRequest/resolved", { threadId: thread.id, requestId: id });
      return;
    }
    let result;
    if (method === "test/stall") return;
    if (method === "initialize") result = { userAgent: "shared-test" };
    else if (["thread/start", "thread/read", "thread/resume"].includes(method)) result = { thread, model: "test" };
    else if (method === "turn/start") {
      thread.status = { type: "active" };
      thread.turns = [{ id: "turn-live", status: "inProgress", items: [] }];
      result = { turn: thread.turns[0] };
      notify("turn/started", { threadId: thread.id, turn: thread.turns[0] });
      pendingApproval = true;
    } else if (method === "turn/interrupt") {
      thread.turns[0].status = "interrupted";
      thread.status = { type: "idle" };
      notify("turn/completed", { threadId: thread.id, turn: thread.turns[0] });
      result = {};
    } else if (method === "turn/steer") result = { turnId: "turn-live" };
    else throw new Error(`Unexpected method ${method}`);
    socket.send(JSON.stringify({ id, result }));
    if (pendingApproval && ["thread/resume", "turn/start"].includes(method)) {
      socket.send(JSON.stringify({ id: "approval", method: "item/commandExecution/requestApproval", params: { threadId: thread.id, turnId: "turn-live", command: "test" } }));
    }
  }));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, url: `ws://127.0.0.1:${server.address().port}` };
}

async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  assert.fail("Shared notification not received");
}

test("two clients share a running thread, reconnect, recover requests and interrupt it", async (t) => {
  const { url } = await fixture(t);
  const desktop = new CodexAppServer({ websocketUrl: url });
  const web = new CodexAppServer({ websocketUrl: url });
  t.after(() => { desktop.stop(); web.stop(); });
  const { thread } = await desktop.startThread();
  await web.readThread(thread.id);
  await desktop.startTurn(thread.id, "work");
  await until(() => web.isThreadBusy(thread.id));
  await assert.rejects(web.startTurn(thread.id, "duplicate"), { code: "TURN_ACTIVE" });
  const stalled = assert.rejects(web.request("test/stall"), /断开/);
  web.socket.terminate();
  await stalled;
  const restored = await web.readThread(thread.id);
  assert.equal(restored.thread.id, thread.id);
  assert.equal(web.threadControlState(thread.id).turnId, "turn-live");
  await until(() => web.pendingServerRequests(thread.id).length === 1);
  web.respondToServerRequest(web.pendingServerRequests(thread.id)[0].token, { decision: "accept" });
  await until(() => web.pendingServerRequests(thread.id).length === 0);
  await web.steerTurn(thread.id, "adjust");
  await web.interruptTurn(thread.id);
  await until(() => !web.isThreadBusy(thread.id) && !desktop.isThreadBusy(thread.id));
  web.stop();
  assert.equal((await desktop.readThread(thread.id)).thread.id, thread.id);
});

test("shared connection failures never silently spawn an independent writer", async (t) => {
  const { url, server } = await fixture(t);
  await new Promise((resolve) => server.close(resolve));
  const client = new CodexAppServer({ websocketUrl: url, command: "must-not-spawn", requestTimeoutMs: 100 });
  await assert.rejects(client.start());
  assert.equal(client.proc, null);
  assert.equal(client.socket, null);
});

test("the generated desktop CLI proxy joins the existing shared backend", async (t) => {
  const { url } = await fixture(t);
  const directory = await fs.mkdtemp(path.join(tmpdir(), "codex-pocket-proxy-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const proxy = await prepareDesktopProxy(url, {
    dataDirectory: directory,
    codexPath: process.execPath,
  });
  const desktop = new CodexAppServer({ command: proxy });
  t.after(() => desktop.stop());

  await desktop.start();
  const result = await desktop.request("thread/read", {
    threadId: "same-thread",
    includeTurns: true,
  });
  assert.equal(result.thread.id, "same-thread");
  assert.equal(desktop.websocketUrl, "");
  assert.ok(desktop.proc);
});

test("shared URLs and all platform launch specs remain local and shell-safe", () => {
  for (const url of ["wss://example.com", "ws://0.0.0.0:4500", "ws://user:pass@localhost", "ws://localhost/?token=x"]) {
    assert.throws(() => localAppServerUrl(url));
  }
  for (const platform of ["darwin", "linux", "win32"]) {
    const spec = appServerLaunchSpec(platform === "win32" ? "C:\\Tools\\codex.exe" : "/opt/codex", { platform, listenUrl: "ws://127.0.0.1:4500" });
    assert.deepEqual(spec.args, ["app-server", "--listen", "ws://127.0.0.1:4500"]);
    assert.equal(spec.shell, false);
  }
  assert.equal(appServerLaunchSpec("C:\\Tools with spaces\\codex.cmd", { platform: "win32", listenUrl: "ws://127.0.0.1:4500" }).command,
    '"C:\\Tools with spaces\\codex.cmd" app-server --listen "ws://127.0.0.1:4500"');
});
