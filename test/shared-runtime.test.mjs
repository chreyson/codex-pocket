import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServer } from "../src/codex-client.mjs";
import {
  defaultCodexCommand,
  ensureSharedServer,
  hasActiveClients,
  readSharedConfig,
  stopManagedBackend,
} from "../src/shared-runtime.mjs";
import { fakeRuntime } from "../scripts/fixtures/runtime-fixture.mjs";

test("shared startup is serialized, survives client shutdown and reuses its address after restart", { timeout: 20_000 }, async (t) => {
  const runtime = await fakeRuntime(new URL("../scripts/fixtures/shared-codex.mjs", import.meta.url));
  const configPath = path.join(runtime.directory, "shared.json");
  let config;
  async function shutdown() {
    if (!config) return;
    const client = new CodexAppServer({ websocketUrl: config.url, requestTimeoutMs: 300 });
    try {
      await client.start();
      await client.request("test/shutdown");
      for (let attempt = 0; client.socket && attempt < 100; attempt++) await delay(10);
      assert.equal(client.socket, null);
    } finally { client.stop(); }
  }
  t.after(async () => { await shutdown(); await runtime.cleanup(); });
  [config] = await Promise.all([
    ensureSharedServer({ configPath, command: runtime.command }),
    ensureSharedServer({ configPath, command: runtime.command }).then((other) => {
      return readSharedConfig(configPath).then((saved) => { assert.deepEqual(other, saved); return other; });
    }),
  ]);
  assert.deepEqual(await ensureSharedServer({ configPath, command: "must-not-run" }), config);
  const previous = config;
  await shutdown();
  config = await ensureSharedServer({ configPath, command: runtime.command });
  assert.equal(config.url, previous.url);
  assert.notEqual(config.pid, previous.pid);
  await assert.rejects(fs.access(`${configPath}.lock`), { code: "ENOENT" });
});

test("CLI discovery honors configuration and installed macOS apps on a clean machine", () => {
  const chatgpt = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const codex = "/Applications/Codex.app/Contents/Resources/codex";
  const userApp = "/Users/test/Applications/Codex.app/Contents/Resources/codex";
  for (const [installed, configured, expected] of [
    [[chatgpt, codex, "/opt/homebrew/bin/codex"], "", chatgpt],
    [[codex, userApp], "", codex],
    [[userApp], "", userApp],
    [["/opt/homebrew/bin/codex"], "", "/opt/homebrew/bin/codex"],
    [["/custom/codex"], "/custom/codex", "/custom/codex"],
    [[], "/missing/codex", "codex"],
    [[], "", "codex"],
  ]) {
    assert.equal(defaultCodexCommand({
      platform: "darwin", env: {}, home: "/Users/test",
      exists: (file) => installed.includes(file),
      readFile: () => JSON.stringify({ Codex: { Path: configured } }),
    }), expected);
  }
  assert.equal(defaultCodexCommand({
    env: { CODEX_BIN: " custom-codex " },
    exists: () => assert.fail("An explicit CLI must take precedence over discovery"),
  }), "custom-codex");
});

test("failed shared startup releases its lock for a subsequent attempt", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "shared.json");
  await assert.rejects(ensureSharedServer({ configPath, command: path.join(runtime.directory, "missing.exe") }));
  assert.equal(await readSharedConfig(configPath), null);
  await assert.rejects(fs.access(`${configPath}.lock`), { code: "ENOENT" });
});

test("shared config rejects a CODEX_HOME mismatch before it can be used", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "mismatched-home.json");
  const expectedHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  await fs.writeFile(configPath, JSON.stringify({
    url: "ws://127.0.0.1:4500",
    codexHome: path.join(runtime.directory, "different-home"),
    pid: 4242,
  }));
  await assert.rejects(readSharedConfig(configPath), /数据目录|CODEX_HOME/);
  assert.notEqual(expectedHome, path.join(runtime.directory, "different-home"));
});

test("an old config missing its required URL is rejected instead of choosing a new backend", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "missing-url.json");
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  await fs.writeFile(configPath, JSON.stringify({ version: 1, codexHome, pid: 4242 }));
  await assert.rejects(readSharedConfig(configPath), /URL|地址|Invalid/);
});

test("a healthy legacy config with the same CLI path is reused and backfilled", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "legacy.json");
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const url = "ws://127.0.0.1:4511";
  const commandPath = await fs.realpath(runtime.command);
  const legacy = {
    version: 1,
    url,
    codexHome,
    codexCommand: commandPath,
    pid: 4242,
  };
  await fs.writeFile(configPath, `${JSON.stringify(legacy)}\n`);
  let stopped = false;
  let spawned = false;
  const metadata = { commandPath, version: "codex-cli test" };
  const result = await ensureSharedServer({
    configPath,
    command: runtime.command,
    readCommandMetadata: async () => metadata,
    probeServer: async () => true,
    inspectProcess: async () => ({ exists: true, owned: true }),
    hasActiveClients: async () => false,
    stopBackend: async () => { stopped = true; },
    spawnProcess: () => { spawned = true; throw new Error("legacy backend must be reused"); },
  });
  assert.equal(result.url, url);
  assert.equal(result.pid, legacy.pid);
  assert.equal(stopped, false);
  assert.equal(spawned, false);
  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(saved.url, url);
  assert.equal(saved.pid, legacy.pid);
  assert.equal(saved.codexCommandRealpath, commandPath);
  assert.equal(saved.codexVersion, metadata.version);
  assert.equal(saved.managedBy, undefined);
});

test("a healthy legacy config without CLI identity is preserved and rejected for migration", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "legacy-unknown.json");
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const legacy = {
    version: 1,
    url: "ws://127.0.0.1:4514",
    codexHome,
    pid: 4242,
  };
  await fs.writeFile(configPath, `${JSON.stringify(legacy)}\n`);
  let stopped = false;
  let spawned = false;
  await assert.rejects(ensureSharedServer({
    configPath,
    command: runtime.command,
    readCommandMetadata: async () => ({ commandPath: runtime.command, version: "codex-cli test" }),
    probeServer: async () => true,
    inspectProcess: async () => ({ exists: true, commandLine: "unrelated process" }),
    hasActiveClients: async () => false,
    stopBackend: async () => { stopped = true; },
    spawnProcess: () => { spawned = true; throw new Error("unidentified backend must be preserved"); },
  }), /CLI|管理|确认|共享后端/);
  assert.equal(stopped, false);
  assert.equal(spawned, false);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), legacy);
});

test("a healthy backend with an active client rejects a CLI path change without stopping it", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "active-mismatch.json");
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const oldCommand = path.join(runtime.directory, "old-codex");
  const newCommand = path.join(runtime.directory, "new-codex");
  const legacy = {
    url: "ws://127.0.0.1:4512",
    codexHome,
    codexCommand: oldCommand,
    codexCommandRealpath: oldCommand,
    codexVersion: "old-version",
    managedBy: "codex-pocket",
    pid: 4242,
  };
  await fs.writeFile(configPath, `${JSON.stringify(legacy)}\n`);
  let stopped = false;
  let spawned = false;
  await assert.rejects(ensureSharedServer({
    configPath,
    command: newCommand,
    readCommandMetadata: async () => ({ commandPath: newCommand, version: "new-version" }),
    probeServer: async () => true,
    inspectProcess: async () => ({
      exists: true,
      commandLine: `${oldCommand} app-server --listen ${legacy.url}`,
    }),
    hasActiveClients: async () => true,
    stopBackend: async () => { stopped = true; },
    spawnProcess: () => { spawned = true; throw new Error("active backend must be preserved"); },
  }), /活动客户端|活动连接|共享后端/);
  assert.equal(stopped, false);
  assert.equal(spawned, false);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), legacy);
});

test("an uncertain active-client probe rejects a CLI mismatch without stopping the backend", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "unknown-clients.json");
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const commandPath = path.join(runtime.directory, "old-codex");
  const legacy = {
    url: "ws://127.0.0.1:4519",
    codexHome,
    codexCommand: commandPath,
    codexCommandRealpath: commandPath,
    codexVersion: "old-version",
    managedBy: "codex-pocket",
    pid: 4242,
  };
  await fs.writeFile(configPath, `${JSON.stringify(legacy)}\n`);
  let stopped = false;
  let spawned = false;
  await assert.rejects(ensureSharedServer({
    configPath,
    command: path.join(runtime.directory, "new-codex"),
    readCommandMetadata: async () => ({ commandPath: path.join(runtime.directory, "new-codex"), version: "new-version" }),
    probeServer: async () => true,
    inspectProcess: async () => ({
      exists: true,
      commandLine: `${commandPath} app-server --listen ${legacy.url}`,
    }),
    hasActiveClients: async () => null,
    stopBackend: async () => { stopped = true; },
    spawnProcess: () => { spawned = true; throw new Error("uncertain clients must block migration"); },
  }), /无法确认|活动客户端|活动连接/);
  assert.equal(stopped, false);
  assert.equal(spawned, false);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), legacy);
});

test("a managed idle backend migrates a CLI version mismatch on the same URL", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "version-mismatch.json");
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const commandPath = await fs.realpath(runtime.command);
  const url = "ws://127.0.0.1:4515";
  const legacy = {
    url,
    codexHome,
    codexCommand: commandPath,
    codexCommandRealpath: commandPath,
    codexVersion: "old-version",
    managedBy: "codex-pocket",
    pid: 4242,
  };
  await fs.writeFile(configPath, `${JSON.stringify(legacy)}\n`);
  const child = new EventEmitter();
  child.pid = 987655;
  child.exitCode = null;
  child.unref = () => {};
  child.kill = () => { child.exitCode = 0; };
  let probeCalls = 0;
  let stopped = 0;
  let launched = 0;
  const result = await ensureSharedServer({
    configPath,
    command: runtime.command,
    readCommandMetadata: async () => ({ commandPath, version: "new-version" }),
    probeServer: async () => {
      probeCalls += 1;
      return probeCalls === 1 || probeCalls >= 3;
    },
    inspectProcess: async () => ({
      exists: true,
      commandLine: `${commandPath} app-server --listen ${url}`,
    }),
    hasActiveClients: async () => false,
    stopBackend: async (previous) => {
      assert.equal(previous.pid, legacy.pid);
      stopped += 1;
    },
    allocateUrl: () => { throw new Error("must retain the old URL"); },
    spawnProcess: () => {
      launched += 1;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal(stopped, 1);
  assert.equal(launched, 1);
  assert.equal(result.url, url);
  assert.equal(result.pid, child.pid);
  assert.equal(result.codexVersion, "new-version");
  assert.equal(result.managedBy, "codex-pocket");
  assert.equal(probeCalls, 3);
});

test("a dead backend is rebuilt on its saved URL without touching an unrelated live PID", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "dead.json");
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const url = "ws://127.0.0.1:4513";
  const legacy = {
    url,
    codexHome,
    codexCommand: runtime.command,
    codexCommandRealpath: runtime.command,
    codexVersion: "codex-cli test",
    managedBy: "codex-pocket",
    // This is deliberately the test runner, not the dead backend.
    pid: process.pid,
  };
  await fs.writeFile(configPath, `${JSON.stringify(legacy)}\n`);
  let probeCalls = 0;
  let stopped = false;
  let launched = false;
  let launchArgs;
  const child = new EventEmitter();
  child.pid = 987654;
  child.exitCode = null;
  child.unref = () => {};
  child.kill = () => { child.exitCode = 0; };
  const result = await ensureSharedServer({
    configPath,
    command: runtime.command,
    readCommandMetadata: async () => ({ commandPath: runtime.command, version: "codex-cli test" }),
    inspectProcess: async () => ({ exists: false }),
    probeServer: async () => ++probeCalls > 1,
    stopBackend: async () => { stopped = true; },
    spawnProcess: (command, args) => {
      launched = true;
      launchArgs = { command, args };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal(stopped, false);
  assert.equal(launched, true);
  assert.equal(result.url, url);
  assert.equal(result.pid, child.pid);
  if (process.platform === "win32") {
    assert.equal(launchArgs.command, `"${runtime.command}" app-server --listen "${url}"`);
    assert.deepEqual(launchArgs.args, []);
  } else {
    assert.equal(launchArgs.command, runtime.command);
    assert.deepEqual(launchArgs.args, ["app-server", "--listen", url]);
  }
  assert.doesNotThrow(() => process.kill(process.pid, 0));
  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(saved.url, url);
  assert.equal(saved.pid, child.pid);
});

test("a stale config with a live unrelated PID gets a fresh URL without signaling it", async (t) => {
  const runtime = await fakeRuntime();
  t.after(runtime.cleanup);
  const configPath = path.join(runtime.directory, "unknown-owner.json");
  const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
  const commandPath = await fs.realpath(runtime.command);
  const oldUrl = "ws://127.0.0.1:4520";
  const newUrl = "ws://127.0.0.1:4521";
  await fs.writeFile(configPath, `${JSON.stringify({
    url: oldUrl,
    codexHome,
    codexCommand: commandPath,
    codexCommandRealpath: commandPath,
    codexVersion: "codex-cli test",
    managedBy: "codex-pocket",
    pid: process.pid,
  })}\n`);
  const child = new EventEmitter();
  child.pid = 987656;
  child.exitCode = null;
  child.unref = () => {};
  child.kill = () => { child.exitCode = 0; };
  let stopped = false;
  let allocated = 0;
  let launched = 0;
  const probed = [];
  const result = await ensureSharedServer({
    configPath,
    command: runtime.command,
    readCommandMetadata: async () => ({ commandPath, version: "codex-cli test" }),
    probeServer: async (url) => { probed.push(url); return url === newUrl; },
    inspectProcess: async () => ({ exists: true, commandLine: "/usr/bin/unrelated-process" }),
    stopBackend: async () => { stopped = true; },
    allocateUrl: async () => { allocated += 1; return newUrl; },
    spawnProcess: () => {
      launched += 1;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal(stopped, false);
  assert.equal(allocated, 1);
  assert.equal(launched, 1);
  assert.deepEqual(probed, [oldUrl, newUrl]);
  assert.equal(result.url, newUrl);
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test("graceful migration rechecks clients immediately before signaling", async () => {
  const previous = {
    url: "ws://127.0.0.1:4516",
    pid: 4242,
    codexCommand: "/opt/codex",
    codexCommandRealpath: "/opt/codex",
  };
  let killed = false;
  await assert.rejects(stopManagedBackend(previous, {
    inspect: async () => ({
      pid: previous.pid,
      exists: true,
      commandLine: "/opt/codex app-server --listen ws://127.0.0.1:4516",
    }),
    activeClients: async () => true,
    kill: () => { killed = true; },
  }), /活动客户端/);
  assert.equal(killed, false);
});

test("graceful migration refuses a PID that changes after SIGTERM", async () => {
  const previous = {
    url: "ws://127.0.0.1:4517",
    pid: 4343,
    codexCommand: "/opt/codex",
    codexCommandRealpath: "/opt/codex",
  };
  let inspectCalls = 0;
  let killed = false;
  await assert.rejects(stopManagedBackend(previous, {
    inspect: async () => {
      inspectCalls += 1;
      return {
        pid: previous.pid,
        exists: true,
        commandLine: inspectCalls <= 2
          ? "/opt/codex app-server --listen ws://127.0.0.1:4517"
          : "/other app-server --listen ws://127.0.0.1:4517",
      };
    },
    activeClients: async () => false,
    kill: () => { killed = true; },
    wait: async () => {},
    timeoutMs: 100,
  }), /已被其他进程占用|停止前发生变化/);
  assert.equal(killed, true);
});

test("socket inspection permission errors remain unknown instead of allowing migration", async () => {
  const denied = async (program) => {
    assert.equal(program, "lsof");
    throw Object.assign(new Error("Operation not permitted"), {
      code: 1,
      stderr: "lsof: permission denied",
    });
  };
  assert.equal(await hasActiveClients("ws://127.0.0.1:4518", 4242, {
    platform: "darwin",
    execute: denied,
  }), null);

  const empty = async () => {
    throw Object.assign(new Error("no established sockets"), { code: 1, stderr: "" });
  };
  assert.equal(await hasActiveClients("ws://127.0.0.1:4518", 4242, {
    platform: "darwin",
    execute: empty,
  }), false);

  const unknown = async () => {
    throw Object.assign(new Error("lsof failed"), {
      code: 1,
      stderr: "unexpected lsof failure",
    });
  };
  assert.equal(await hasActiveClients("ws://127.0.0.1:4518", 4242, {
    platform: "darwin",
    execute: unknown,
  }), null);

  const deniedOnStdout = async () => {
    throw Object.assign(new Error("command failed"), {
      code: 1,
      stdout: "Operation not permitted",
    });
  };
  assert.equal(await hasActiveClients("ws://127.0.0.1:4518", 4242, {
    platform: "darwin",
    execute: deniedOnStdout,
  }), null);
});

test("socket inspection filters a Windows wrapper's app-server child", async () => {
  const url = "ws://127.0.0.1:4519";
  const result = await hasActiveClients(url, 100, {
    platform: "win32",
    execute: async () => ({ stdout: JSON.stringify({ OwningProcess: 200 }) }),
    inspect: async () => ({
      pid: 200,
      exists: true,
      commandLine: "C:\\Tools\\codex.exe app-server --listen ws://127.0.0.1:4519",
    }),
    config: {
      url,
      codexCommandRealpath: "C:\\Tools\\codex.cmd",
    },
  });
  assert.equal(result, false);
});

test("an idle Pocket viewer is not an active client and is reaped before migration", async () => {
  const viewerScript = path.resolve("src/server.mjs");
  const calls = [];
  const killed = [];
  const execute = async (program, args) => {
    calls.push({ program, args });
    assert.equal(program, "lsof");
    if (args.includes("-p")) {
      return { stdout: "p200\nf14\nn127.0.0.1:59000\nTST=LISTEN\n" };
    }
    return { stdout: "p200\n" };
  };
  const inspect = async (pid) => ({
    pid, exists: true, commandLine: `node ${viewerScript}`,
  });
  const result = await hasActiveClients("ws://127.0.0.1:4522", 100, {
    platform: "darwin",
    execute,
    inspect,
    cleanupStaleViewers: true,
    kill: (pid, signal) => killed.push({ pid, signal }),
    config: { url: "ws://127.0.0.1:4522" },
  });
  assert.equal(result, false);
  assert.deepEqual(killed, [{ pid: 200, signal: "SIGTERM" }]);
  assert.equal(calls.length, 3);
});

test("a Pocket viewer with a browser connection still blocks migration", async () => {
  const viewerScript = path.resolve("src/server.mjs");
  const execute = async (_program, args) => args.includes("-p")
    ? { stdout: "p201\nf14\nn127.0.0.1:59001\nTST=LISTEN\nf15\nn127.0.0.1:59001->127.0.0.1:59002\nTST=ESTABLISHED\n" }
    : { stdout: "p201\n" };
  const result = await hasActiveClients("ws://127.0.0.1:4523", 100, {
    platform: "darwin",
    execute,
    inspect: async (pid) => ({ pid, exists: true, commandLine: `node ${viewerScript}` }),
    cleanupStaleViewers: true,
    kill: () => assert.fail("an active viewer must not be killed"),
    config: { url: "ws://127.0.0.1:4523" },
  });
  assert.equal(result, true);
});

test("a relative Pocket viewer is identified by its project working directory", async () => {
  const projectRoot = path.resolve(".");
  const execute = async (_program, args) => args.includes("-p")
    ? { stdout: "p203\nf14\nn127.0.0.1:59003\nTST=LISTEN\n" }
    : { stdout: "p203\n" };
  const result = await hasActiveClients("ws://127.0.0.1:4525", 100, {
    platform: "darwin",
    execute,
    inspect: async (pid) => ({ pid, exists: true, commandLine: "node src/server.mjs", cwd: projectRoot }),
    cleanupStaleViewers: true,
    kill: () => {},
    config: { url: "ws://127.0.0.1:4525" },
  });
  assert.equal(result, false);
});

test("an unknown Node process remains an active client", async () => {
  const result = await hasActiveClients("ws://127.0.0.1:4524", 100, {
    platform: "darwin",
    execute: async () => ({ stdout: "p202\n" }),
    inspect: async (pid) => ({ pid, exists: true, commandLine: "node /other/server.mjs" }),
    viewerSockets: async () => assert.fail("unknown processes must not be probed as Pocket viewers"),
    config: { url: "ws://127.0.0.1:4524" },
  });
  assert.equal(result, true);
});
