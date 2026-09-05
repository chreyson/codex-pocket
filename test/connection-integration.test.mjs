import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { once } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServer } from "../src/codex-client.mjs";
import { fakeRuntime } from "../scripts/fixtures/runtime-fixture.mjs";

test("real stdio initializes concurrently, rejects lost requests and reconnects after exit", { timeout: 15_000 }, async (t) => {
  const { command, cleanup } = await fakeRuntime();
  const codex = new CodexAppServer({ command, requestTimeoutMs: 2_000 });
  t.after(async () => {
    const closed = codex.proc ? once(codex.proc, "close") : Promise.resolve();
    codex.stop();
    await closed;
    await cleanup();
  });
  const [first, second] = await Promise.all([codex.listThreads(), codex.listThreads()]);
  assert.equal(first.data[0].id, "test-thread");
  assert.equal(second.data[0].id, "test-thread");
  const original = (await codex.request("test/pid")).pid;
  const pending = assert.rejects(codex.request("test/stall"), /exited/);
  await assert.rejects(codex.request("test/exit"), /exited/);
  await pending;
  assert.equal(codex.pending.size, 0);
  assert.equal((await codex.listThreads()).data[0].id, "test-thread");
  assert.notEqual((await codex.request("test/pid")).pid, original);
  await assert.rejects(codex.request("test/stall"), /timed out/);
  assert.equal(codex.pending.size, 0);
});

async function startServer(t) {
  const { directory, command, cleanup } = await fakeRuntime();
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const proc = spawn(process.execPath, [fileURLToPath(new URL("../src/server.mjs", import.meta.url))], {
    env: {
      ...process.env, HOST: "127.0.0.1", PORT: String(port), CODEX_BIN: command,
      RELAY_DATA_DIR: path.join(directory, "data"), CODEX_RELAY_TOKEN: "integration-test-token",
      CODEX_APP_TOOLS_PIPE_PATH: "", FORCE_SECURE_COOKIE: "0", POLL_INTERVAL_MS: "700",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout.on("data", (chunk) => { output += chunk; });
  proc.stderr.on("data", (chunk) => { output += chunk; });
  const closed = once(proc, "close");
  t.after(async () => {
    proc.kill();
    await closed;
    await cleanup();
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (proc.exitCode !== null) throw new Error(output);
    try {
      const response = await fetch(`${url}/api/health`);
      if ((await response.json()).codex === "ready") return { url, proc, closed };
    } catch { /* Wait for the listener to bind. */ }
    await delay(50);
  }
  throw new Error(`Server did not become ready: ${output}`);
}

async function subscribe(t, url, cookie, threadId = "test-thread") {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/events?threadId=${threadId}`, {
    headers: { Cookie: cookie }, signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const reading = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (name && data) events.push({ name, value: JSON.parse(data) });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  const close = async () => { controller.abort(); await reading; };
  t.after(close);
  return {
    close,
    async waitFor(predicate, timeout = 5_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const event = events.find(predicate);
        if (event) return event;
        await delay(25);
      }
      assert.fail(`SSE event missing; received ${events.map((event) => event.name)}`);
    },
  };
}

test("management HTTP routes authenticate, validate, persist names and restore archived data", { timeout: 15000 }, async (t) => {
  const { url } = await startServer(t);
  const headers = { Authorization: "Bearer integration-test-token", "Content-Type": "application/json" };
  const post = (route, value = {}) => fetch(url + route, { method: "POST", headers, body: JSON.stringify(value) });
  for (const route of ["/api/projects", "/api/projects/test-project/rename", "/api/threads/test-thread/archive", "/api/threads/test-thread/restore"]) {
    assert.equal((await fetch(url + route, { method: "POST", body: "{}" })).status, 401);
  }
  assert.equal((await post("/api/projects", { name: "x", path: "relative", idempotencyKey: "test-create" })).status, 400);
  const created = await post("/api/projects", { name: "New project", path: process.cwd(), idempotencyKey: "test-create" });
  assert.equal(created.status, 201);
  const { project } = await created.json();
  assert.equal((await post(`/api/projects/${project.id}/rename`, { name: "Renamed project" })).status, 200);
  assert.equal((await post(`/api/projects/${project.id}/archive`)).status, 200);
  assert.equal((await post("/api/threads", { projectId: project.id })).status, 409);
  assert.equal((await post(`/api/projects/${project.id}/restore`)).status, 200);
  assert.equal((await post("/api/threads", { projectId: project.id })).status, 201);
  assert.equal((await post("/api/threads/test-thread/rename", { name: "" })).status, 400);
  assert.equal((await post("/api/threads/test-thread/rename", { name: "Renamed task" })).status, 200);
  const bootstrap = await (await fetch(url + "/api/bootstrap", { headers })).json();
  assert.equal(bootstrap.projects[0].name, "Renamed project");
  assert.equal(bootstrap.threads[0].title, "Renamed task");
  assert.equal(bootstrap.threads[0].project, "Renamed project");
  assert.equal((await post("/api/threads/test-thread/archive")).status, 200);
  const archived = await (await fetch(url + "/api/threads?archived=true", { headers })).json();
  assert.equal(archived.threads[0].title, "Renamed task");
  assert.equal((await post("/api/threads/test-thread/restore")).status, 200);
  assert.equal((await (await fetch(url + "/api/threads?archived=true", { headers })).json()).threads.length, 0);
});

test("HTTP authentication and SSE survive a slow thread, idle heartbeat and reconnect", { timeout: 35_000 }, async (t) => {
  const { url } = await startServer(t);
  assert.equal((await fetch(`${url}/api/events`)).status, 401);
  assert.equal((await fetch(`${url}/api/session`, { method: "POST" })).status, 401);
  const session = await fetch(`${url}/api/session`, {
    method: "POST", headers: { Authorization: "Bearer integration-test-token" },
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.get("set-cookie").split(";")[0];
  assert.match(session.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await fetch(`${url}/api/sync`)).status, 401);
  const sync = await fetch(`${url}/api/sync?threadId=test-thread`, { headers: { Cookie: cookie } });
  assert.equal(sync.status, 200);
  const { events } = await sync.json();
  assert.equal(events.find((event) => event.event === "thread").value.id, "test-thread");
  assert.equal(events.find((event) => event.event === "status").value.state, "ready");
  assert.equal((await fetch(`${url}/api/threads/test-thread/permissions`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "full" }),
  })).status, 401);
  for (const mode of ["invalid", "auto", "ask"]) {
    const result = await fetch(`${url}/api/threads/test-thread/permissions`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ mode }),
    });
    assert.equal(result.status, mode === "invalid" ? 400 : 200);
    if (mode !== "invalid") assert.equal((await result.json()).permissions.current, mode);
  }
  const page = await fetch(`${url}/api/threads/test-thread`, { headers: { Cookie: cookie } });
  assert.equal((await page.json()).composerOptions.permissions.current, "ask");
  const slow = await subscribe(t, url, cookie, "slow-thread");
  await delay(100);
  const first = await subscribe(t, url, cookie);
  const snapshot = await first.waitFor((event) => event.name === "thread");
  assert.equal(snapshot.value.id, "test-thread");
  await first.waitFor((event) => event.name === "thread"
    && event.value.messages[0].text !== snapshot.value.messages[0].text);
  await first.waitFor((event) => event.name === "heartbeat", 17_000);
  await slow.close();
  await first.close();
  const second = await subscribe(t, url, cookie);
  const recovered = await second.waitFor((event) => event.name === "thread", 8_000);
  assert.equal(recovered.value.id, "test-thread");
  assert.notDeepEqual(recovered.value.messages, snapshot.value.messages);
});
