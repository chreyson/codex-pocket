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
      POCKET_SHARED_SERVER: "off", CODEX_APP_SERVER_WS_URL: "",
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

test("an idle writer conflict has a recovery code and explicit continuation is idempotent", { timeout: 15_000 }, async (t) => {
  const { url } = await startServer(t);
  const headers = { Authorization: "Bearer integration-test-token", "Content-Type": "application/json" };
  const health = await (await fetch(url + "/api/health")).json();
  const bootstrap = await (await fetch(url + "/api/bootstrap", { headers })).json();
  const sync = await (await fetch(url + "/api/sync", { headers })).json();
  const status = sync.events.find((entry) => entry.event === "status").value;
  assert.equal(health.connectionMode, "standalone");
  assert.deepEqual(status.desktopConnection, health.desktopConnection);
  assert.deepEqual(bootstrap.status.desktopConnection, health.desktopConnection);
  assert.equal(status.connectionMode, health.connectionMode);
  const post = (route, body) => fetch(url + route, { method: "POST", headers, body: JSON.stringify(body) });
  const conflict = await post("/api/threads/locked-thread/permissions", { mode: "ask" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "THREAD_CONTINUATION_REQUIRED");
  const anonymous = await fetch(url + "/api/threads/locked-thread/continue", { method: "POST", body: "{}" });
  assert.equal(anonymous.status, 401);
  const results = await Promise.all([post("/api/threads/locked-thread/continue", {}), post("/api/threads/locked-thread/continue", {})]);
  const bodies = [];
  for (const result of results) {
    assert.equal(result.status, 201);
    bodies.push(await result.json());
  }
  assert.notEqual(bodies[0].thread.id, "locked-thread");
  assert.equal(bodies[0].thread.id, bodies[1].thread.id);
  const sent = await post(`/api/threads/${bodies[0].thread.id}/messages`, { text: "Continue", clientMessageId: "continuation-message" });
  assert.equal(sent.status, 202, await sent.text());
});

test("questions and approvals travel through stdio, HTTP, SSE, reconnect and resolution", { timeout: 15000 }, async (t) => {
  const { url } = await startServer(t);
  const headers = { Authorization: "Bearer integration-test-token", "Content-Type": "application/json" };
  const post = (route, body) => fetch(url + route, { method: "POST", headers, body: JSON.stringify(body) });
  const session = await fetch(url + "/api/session", { method: "POST", headers });
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const stream = await subscribe(t, url, cookie);
  const started = await post("/api/threads/test-thread/messages", { text: "Synthetic requests", clientMessageId: "request-test" });
  assert.equal(started.status, 202, await started.text());
  const event = await stream.waitFor((event) => event.name === "thread" && event.value.control.requests.length === 4);
  const requests = event.value.control.requests;
  assert.deepEqual(requests.map((r) => r.type), ["userInput", "command", "permissions", "elicitation"]);
  await stream.close();
  const recovered = await subscribe(t, url, cookie);
  const replay = await recovered.waitFor((event) => event.name === "thread" && event.value.control.requests.length === 4);
  assert.deepEqual(replay.value.control.requests.map((r) => r.token), requests.map((r) => r.token));
  const sync = await (await fetch(url + "/api/sync?threadId=test-thread", { headers })).json();
  assert.equal(sync.events.find((e) => e.event === "thread").value.control.requests.length, 4);
  const route = (request, thread = "test-thread") => `/api/threads/${thread}/approvals/${request.token}`;
  assert.equal((await fetch(url + route(requests[0]), { method: "POST", body: "{}" })).status, 401);
  assert.equal((await post(route(requests[0], "wrong-thread"), {})).status, 404);
  assert.equal((await post(route(requests[0]), { answers: {} })).status, 400);
  assert.equal((await post(route(requests[1]), { decision: "acceptForSession" })).status, 400);
  const payloads = [
    { answers: { target: { answers: ["Web"] } } },
    { choice: "0" }, { choice: "turn", permissions: { fileSystem: { write: ["/"] } } },
    { action: "accept", content: { count: 2 } },
  ];
  for (const [i, request] of requests.entries()) assert.equal((await post(route(request), payloads[i])).status, 200);
  const completed = await recovered.waitFor((event) => event.name === "thread" && event.value.control.requests.length === 0 && event.value.messages.some((m) => m.text?.includes("fixture-3")));
  const replies = JSON.parse(completed.value.messages.find((m) => m.text?.includes("fixture-3")).text);
  assert.deepEqual(replies.map((r) => r.result), [payloads[0], { decision: "accept" }, { permissions: { network: { enabled: true } }, scope: "turn" }, payloads[3]]);
  assert.equal((await post(route(requests[0]), payloads[0])).status, 404);
});

test("waiting messages support multiple entries, cancellation, Steer and ordered draining", { timeout: 15000 }, async (t) => {
  const { url } = await startServer(t);
  const headers = { Authorization: "Bearer integration-test-token", "Content-Type": "application/json" };
  const post = async (route, body) => {
    const response = await fetch(url + `/api/threads/queue-thread/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  const read = async () => (await fetch(url + "/api/threads/queue-thread", { headers })).json();
  await post("messages", { text: "hold" });
  for (const id of ["one", "two"]) await post("messages", { text: id, action: "queue", clientMessageId: id });
  assert.deepEqual((await read()).control.queue.map((item) => item.id), ["one", "two"]);
  await post("queue/one", { action: "remove" });
  await post("queue/two", { action: "send" });
  assert.deepEqual((await read()).control.queue, []);
  assert.ok((await read()).messages.some((item) => item.text === "two"));
  for (const id of ["auto3", "auto4"]) await post("messages", { text: id, action: "queue", clientMessageId: id });
  await post("messages", { text: "finish", action: "steer" });
  let done;
  for (let attempt = 0; attempt < 60; attempt++) {
    done = await read();
    if (!done.control.busy && !done.control.queued) break;
    await delay(50);
  }
  assert.equal(done.control.busy, false);
  assert.deepEqual(done.control.queue, []);
  assert.deepEqual(done.messages.filter((item) => item.role === "user").map((item) => item.text), ["hold", "two", "auto3", "auto4"]);
  await post("messages", { text: "hold again" });
  await post("messages", { text: "must stay queued", action: "queue", clientMessageId: "paused" });
  await post("interrupt", {});
  await delay(900);
  assert.equal((await read()).control.queue[0].id, "paused", "interruption does not automatically consume the queue");
});

test("editing a waiting message pauses dispatch and preserves queue order through save and cancel", { timeout: 15000 }, async (t) => {
  const { url } = await startServer(t);
  const headers = { Authorization: "Bearer integration-test-token", "Content-Type": "application/json" };
  const post = async (route, body, status = 200) => {
    const response = await fetch(url + `/api/threads/queue-thread/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  const read = async () => (await fetch(url + "/api/threads/queue-thread", { headers })).json();
  await post("messages", { text: "hold" }, 202);
  for (const id of ["one", "two"]) {
    await post("messages", { text: `auto ${id}`, action: "queue", clientMessageId: id }, 202);
    await post(`queue/${id}`, { action: "edit" });
  }
  await post("messages", { text: "finish", action: "steer" }, 202);
  await delay(800);
  assert.deepEqual((await read()).control.queue.map((item) => [item.id, item.editing]), [["one", true], ["two", true]]);
  await post("queue/one", { action: "send" }, 409);
  await post("queue/one", { action: "update", text: " " }, 400);
  await post("queue/one", { action: "update", text: "x".repeat(12001) }, 413);
  await post("queue/one", { action: "update", text: "auto edited one" });
  let state;
  for (let attempt = 0; attempt < 60; attempt++) {
    state = await read();
    if (!state.control.busy && state.control.queue.length === 1) break;
    await delay(50);
  }
  assert.deepEqual(state.control.queue.map((item) => item.id), ["two"]);
  await post("queue/two", { action: "cancelEdit" });
  for (let attempt = 0; attempt < 60; attempt++) {
    state = await read();
    if (!state.control.busy && !state.control.queued) break;
    await delay(50);
  }
  assert.deepEqual(state.messages.filter((item) => item.role === "user").map((item) => item.text), ["hold", "auto edited one", "auto two"]);
  await post("queue/one", { action: "update", text: "too late" }, 404);
});

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
