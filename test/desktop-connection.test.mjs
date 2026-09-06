import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  classifyDesktop,
  connectionDescription,
  desktopConnectionMonitor,
  inspectDesktop,
} from "../src/desktop-connection.mjs";
import { openSharedDesktop, prepareDesktopProxy } from "../src/desktop-launch.mjs";

const url = "ws://127.0.0.1:4500";
const macApp = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";

test("independent desktop guidance matches each platform's switching support", () => {
  assert.equal(connectionDescription("independent", "darwin").label, "正在切换");
  assert.equal(connectionDescription("independent", "win32").label, "正在切换");
  assert.equal(connectionDescription("independent", "linux").label, "桌面未接入");
});

for (const [platform, file, cli] of [
  ["darwin", macApp, "/Applications/ChatGPT.app/Contents/Resources/codex"],
  ["linux", "/opt/codex/Codex", "/opt/codex/codex"],
  ["win32", "C:\\Apps\\Codex.exe", "C:\\Apps\\resources\\codex.exe"],
]) {
  test(`${platform}: only the desktop process tree's connection proves shared mode`, () => {
    const app = { pid: 100, ppid: 1, file };
    const codexChild = { pid: 101, ppid: 100, file: cli };
    const helper = { pid: 102, ppid: 101, file: "/opt/codex/helper" };
    const own = { pid: 100, host: "127.0.0.1", port: 4500 };
    const childSocket = { pid: 101, host: "127.0.0.1", port: 4500 };
    assert.equal(classifyDesktop([], [own], url, platform), "not-running");
    assert.equal(classifyDesktop([app], [{ ...own, pid: 200 }], url, platform), "unknown");
    assert.equal(classifyDesktop([app], [{ ...own, port: 4501 }], url, platform), "unknown");
    assert.equal(classifyDesktop([app], [{ ...own, host: "192.0.2.1" }], url, platform), "unknown");
    assert.equal(classifyDesktop([app], [own], url, platform), "shared");
    assert.equal(classifyDesktop([app, codexChild, helper], [childSocket], url, platform), "shared");
    assert.equal(classifyDesktop([app, codexChild, helper], [own], url, platform), "independent");
  });
}

test("macOS reads process and socket records, denied inspection never reports shared", async () => {
  const run = async (command) => ({ stdout: command === "ps"
    ? `100 1 ${macApp}\n200 1 /usr/local/bin/node\n`
    : "p100\nn127.0.0.1:50100->127.0.0.1:4500\n" });
  assert.equal((await inspectDesktop(url, { platform: "darwin", run })).state, "shared");
  assert.equal((await inspectDesktop(url, { platform: "darwin", run: async () => { throw new Error("denied"); } })).state, "unknown");
  assert.equal((await inspectDesktop("", { run })).state, "standalone");
});

test("macOS attributes a shared socket owned by a Codex descendant", async () => {
  let lsofArguments;
  const run = async (command, args) => {
    if (command === "ps") {
      return { stdout: `100 1 ${macApp}\n101 100 /Applications/ChatGPT.app/Contents/Resources/codex\n102 101 /Applications/ChatGPT.app/Contents/Resources/helper\n` };
    }
    lsofArguments = args;
    return { stdout: "p101\nn127.0.0.1:4800->127.0.0.1:4500\n" };
  };
  assert.equal((await inspectDesktop(url, { platform: "darwin", run })).state, "shared");
  assert.match(lsofArguments[lsofArguments.indexOf("-p") + 1], /^100,101,102$/);
  assert.deepEqual(lsofArguments, ["-nP", "-a", "-p", "100,101,102", "-iTCP", "-sTCP:ESTABLISHED", "-Fpn"]);
});

test("lsof command errors are detection failures, not empty socket lists", async () => {
  const run = async (command) => {
    if (command === "ps") return { stdout: `100 1 ${macApp}\n101 100 /Applications/ChatGPT.app/Contents/Resources/codex\n` };
    throw Object.assign(new Error("Command failed"), { code: 1, stdout: "", stderr: 'lsof: unknown -s protocol: "TCP"' });
  };
  const result = await inspectDesktop(url, { platform: "darwin", run });
  assert.equal(result.state, "unknown");
  assert.equal(result.label, "检测失败");
});

test("macOS recognizes the generated Node proxy as the desktop shared connection", () => {
  const app = { pid: 100, ppid: 1, file: macApp };
  const proxy = { pid: 101, ppid: 100, file: "/opt/homebrew/bin/node" };
  assert.equal(classifyDesktop(
    [app, proxy],
    [{ pid: proxy.pid, host: "127.0.0.1", port: 4500 }],
    url,
    "darwin",
  ), "shared");
});

test("macOS permission errors never become an independent/shared claim", async () => {
  const run = async (command) => {
    if (command === "ps") return { stdout: `100 1 ${macApp}\n101 100 /Applications/ChatGPT.app/Contents/Resources/codex\n` };
    throw Object.assign(new Error("Operation not permitted"), {
      code: 1,
      stderr: "lsof: permission denied",
    });
  };
  assert.equal((await inspectDesktop(url, { platform: "darwin", run })).state, "unknown");
});

test("Windows consumes structured process/socket output", async () => {
  const run = async () => ({ stdout: JSON.stringify({
    processes: [{ pid: 100, ppid: 1, file: "C:\\Apps\\Codex.exe" }],
    sockets: [{ pid: 100, host: "127.0.0.1", port: 4500 }],
  }) });
  assert.equal((await inspectDesktop(url, { platform: "win32", run })).state, "shared");
});

test("Windows accepts the Codex child as the shared socket owner", async () => {
  const run = async () => ({ stdout: JSON.stringify({
    processes: [
      { pid: 100, ppid: 1, file: "C:\\Apps\\Codex.exe" },
      { pid: 101, ppid: 100, file: "C:\\Apps\\resources\\codex.exe" },
    ],
    sockets: [{ pid: 101, host: "127.0.0.1", port: 4500 }],
  }) });
  assert.equal((await inspectDesktop(url, { platform: "win32", run })).state, "shared");
});

test("unknown desktops and Linux independent desktops are never relaunched", async () => {
  for (const [state, platform] of [["independent", "linux"], ["unknown", "darwin"], ["unknown", "win32"]]) {
    await assert.rejects(openSharedDesktop(url, {
      platform,
      inspect: async () => ({ state }),
      run: () => assert.fail("must not run"), launch: () => assert.fail("must not launch"),
    }), /正常退出/);
  }
});

test("macOS gracefully relaunches an already-running independent desktop into shared mode", async () => {
  const commands = [];
  const states = ["independent", "independent", "not-running", "shared"];
  const result = await openSharedDesktop(url, {
    platform: "darwin", env: {}, exists: () => true, wait: async () => {},
    prepareProxy: async () => "/tmp/codex-pocket-shared-cli",
    inspect: async () => ({ state: states.shift() || "shared" }),
    run: async (command, args, options) => { commands.push({ command, args, options }); },
  });

  assert.equal(result.state, "shared");
  assert.deepEqual(commands[0], {
    command: "/usr/bin/osascript",
    args: ["-e", 'tell application id "com.openai.codex" to quit'],
    options: { timeout: 10_000 },
  });
  assert.equal(commands[1].command, "/usr/bin/open");
  assert.ok(commands[1].args.includes("CODEX_APP_SERVER_FORCE_CLI=1"));
});

test("macOS never force-closes a desktop that does not finish quitting", async () => {
  const commands = [];
  await assert.rejects(openSharedDesktop(url, {
    platform: "darwin", wait: async () => {},
    inspect: async () => ({ state: "independent" }),
    run: async (command, args) => { commands.push({ command, args }); },
  }), /没有强制结束/);
  assert.deepEqual(commands, [{
    command: "/usr/bin/osascript",
    args: ["-e", 'tell application id "com.openai.codex" to quit'],
  }]);
});

test("macOS tolerates an app that exits while the graceful quit request is in flight", async () => {
  const states = ["independent", "not-running", "shared"];
  const commands = [];
  const result = await openSharedDesktop(url, {
    platform: "darwin", env: {}, exists: () => true, wait: async () => {},
    prepareProxy: async () => "/tmp/codex-pocket-shared-cli",
    inspect: async () => ({ state: states.shift() || "shared" }),
    run: async (command) => {
      commands.push(command);
      if (command === "/usr/bin/osascript") throw new Error("application already exited");
    },
  });
  assert.equal(result.state, "shared");
  assert.deepEqual(commands, ["/usr/bin/osascript", "/usr/bin/open"]);
});

test("Windows gracefully closes and relaunches an independent desktop into shared mode", async () => {
  const executable = "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe";
  const proxy = "C:\\Pocket\\proxy.exe";
  const commands = [];
  const states = ["independent", "independent", "not-running", "shared"];
  const child = new EventEmitter();
  child.unref = () => {};
  let launched;
  const result = await openSharedDesktop(url, {
    platform: "win32",
    env: { CODEX_DESKTOP_PATH: executable },
    exists: (value) => value === executable,
    prepareProxy: async () => proxy,
    wait: async () => {},
    inspect: async () => ({ state: states.shift() || "shared" }),
    run: async (command, args, options) => { commands.push({ command, args, options }); },
    launch: (file, _args, options) => {
      launched = { file, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });

  assert.equal(result.state, "shared");
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "powershell.exe");
  assert.ok(commands[0].args.at(-1).includes("CloseMainWindow()"));
  assert.ok(commands[0].args.at(-1).includes("MainWindowHandle"));
  assert.ok(commands[0].args.at(-1).includes("Start-Sleep -Milliseconds 250"));
  assert.doesNotMatch(commands[0].args.at(-1), /Stop-Process|taskkill|\.Kill\(/i);
  assert.deepEqual(commands[0].options, { timeout: 10_000, windowsHide: true, encoding: "utf8" });
  assert.equal(launched.file, executable);
  assert.equal(launched.options.env.CODEX_CLI_PATH, proxy);
  assert.equal(launched.options.env.CODEX_APP_SERVER_FORCE_CLI, "1");
});

test("Windows never force-closes a desktop that ignores the normal close request", async () => {
  const commands = [];
  await assert.rejects(openSharedDesktop(url, {
    platform: "win32", wait: async () => {},
    inspect: async () => ({ state: "independent" }),
    run: async (command, args) => { commands.push({ command, args }); },
  }), /没有强制结束/);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "powershell.exe");
  assert.ok(commands[0].args.at(-1).includes("CloseMainWindow()"));
});

test("explicit macOS connection launches in background with shared env and verifies attachment", async () => {
  let inspected = 0;
  let launched = 0;
  const result = await openSharedDesktop(url, {
    platform: "darwin", env: {}, exists: () => true, wait: async () => {},
    prepareProxy: async () => "/tmp/codex-pocket-shared-cli",
    inspect: async () => ({ state: ++inspected === 1 ? "not-running" : "shared" }),
    run: async (command, args) => {
      launched++;
      assert.equal(command, "/usr/bin/open");
      assert.deepEqual(args, [
        "-g",
        "--env", "CODEX_APP_SERVER_FORCE_CLI=1",
        "--env", "CODEX_CLI_PATH=/tmp/codex-pocket-shared-cli",
        "/Applications/ChatGPT.app",
      ]);
    },
  });
  assert.equal(launched, 1);
  assert.equal(result.state, "shared");
});

test("explicit desktop environment settings survive the shared launch", async () => {
  let macArgs;
  let childOptions;
  let inspected = 0;
  const child = new EventEmitter();
  child.unref = () => {};
  const result = await openSharedDesktop(url, {
    platform: "darwin",
    env: { CODEX_APP_SERVER_FORCE_CLI: "1", CODEX_HOME: "/tmp/codex-home" },
    exists: () => true,
    wait: async () => {},
    prepareProxy: async () => "/tmp/codex-pocket-shared-cli",
    inspect: async () => ({ state: ++inspected === 1 ? "not-running" : "shared" }),
    run: async (_command, args) => { macArgs = args; },
  });
  assert.equal(result.state, "shared");
  assert.deepEqual(macArgs, [
    "-g", "--env", "CODEX_APP_SERVER_FORCE_CLI=1",
    "--env", "CODEX_CLI_PATH=/tmp/codex-pocket-shared-cli",
    "--env", "CODEX_HOME=/tmp/codex-home", "/Applications/ChatGPT.app",
  ]);

  inspected = 0;
  await openSharedDesktop(url, {
    platform: "linux",
    env: { CODEX_DESKTOP_PATH: "/opt/codex/Codex", CODEX_APP_SERVER_FORCE_CLI: "1" },
    exists: () => true,
    wait: async () => {},
    prepareProxy: async () => "/tmp/codex-pocket-shared-cli",
    inspect: async () => ({ state: ++inspected === 1 ? "not-running" : "shared" }),
    launch: (_file, _args, options) => {
      childOptions = options;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal(childOptions.env.CODEX_APP_SERVER_FORCE_CLI, "1");
  assert.equal(childOptions.env.CODEX_CLI_PATH, "/tmp/codex-pocket-shared-cli");
});

test("a successful launch command alone is not connection success", async () => {
  await assert.rejects(openSharedDesktop(url, {
    platform: "darwin", env: {}, exists: () => true, wait: async () => {},
    prepareProxy: async () => "/tmp/codex-pocket-shared-cli",
    inspect: async () => ({ state: "not-running" }), run: async () => {},
  }), /未确认/);
});

test("Windows launches the discovered Store desktop with the native proxy and checks its socket", async () => {
  const executable = "C:\\Program Files\\WindowsApps\\OpenAI.Codex\\app\\Codex.exe";
  const proxy = "C:\\Pocket\\proxy.exe";
  let inspected = 0;
  let launched;
  const child = new EventEmitter();
  child.unref = () => {};
  const result = await openSharedDesktop(url, {
    platform: "win32", env: {}, exists: (value) => value === executable,
    inspect: async () => ({ state: ++inspected === 1 ? "not-running" : "shared" }),
    run: async (command, args) => {
      assert.equal(command, "powershell.exe");
      assert.ok(args.at(-1).endsWith("resolve-windows-desktop.ps1"));
      return { stdout: executable + "\r\n" };
    },
    prepareProxy: async () => proxy, wait: async () => {},
    launch: (file, _args, options) => {
      launched = { file, options };
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.equal(result.state, "shared");
  assert.equal(launched.file, executable);
  assert.equal(launched.options.env.CODEX_CLI_PATH, proxy);
  assert.equal(launched.options.env.CODEX_APP_SERVER_FORCE_CLI, "1");
});

test("desktop proxy wrapper redirects app-server but preserves other CLI commands", async () => {
  const writes = [];
  const proxyPath = await prepareDesktopProxy(url, {
    platform: "darwin",
    nodePath: "/opt/node bin/node",
    codexPath: "/opt/codex bin/codex",
    dataDirectory: "/tmp/pocket data",
    mkdir: async () => {},
    writeFile: async (target, content, options) => writes.push({ target, content, options }),
    rename: async () => {},
    chmod: async () => {},
  });
  assert.equal(proxyPath, "/tmp/pocket data/codex-pocket-shared-cli");
  assert.equal(writes.length, 1);
  assert.match(writes[0].content, /if \[ "\$arg" = "app-server" \]/);
  assert.match(writes[0].content, /exec '\/opt\/node bin\/node'.*app-server-ws-proxy\.mjs.*ws:\/\/127\.0\.0\.1:4500/);
  assert.match(writes[0].content, /exec '\/opt\/codex bin\/codex' "\$@"/);
  assert.equal(writes[0].options.mode, 0o700);
});

test("automatic desktop proxy resolves an isolated runtime config instead of pinning a port", async () => {
  let content;
  const proxyPath = await prepareDesktopProxy("auto", {
    platform: "darwin", dataDirectory: "/tmp/pocket auto", codexPath: "/opt/codex",
    mkdir: async () => {}, writeFile: async (_file, value) => { content = value; },
    rename: async () => {}, chmod: async () => {},
  });
  assert.equal(proxyPath, "/tmp/pocket auto/codex-pocket-auto-cli");
  assert.ok(content.includes("'auto' '/tmp/pocket auto/shared-server.json' \"$@\""));
  assert.match(content, /exec '\/opt\/codex' "\$@"/);
});

test("desktop connection status is stale-while-revalidate and deduplicates probes", async () => {
  let now = 0;
  let calls = 0;
  let release;
  const monitor = desktopConnectionMonitor(url, {
    now: () => now,
    ttlMs: 100,
    inspect: () => {
      calls += 1;
      return new Promise((resolve) => { release = resolve; });
    },
  });

  // The HTTP-facing call is synchronous and never waits for process inspection.
  assert.deepEqual(monitor(), connectionDescription("unknown"));
  const pending = monitor.refresh();
  assert.strictEqual(monitor.refresh(), pending);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.deepEqual(monitor(), connectionDescription("unknown"));

  release(connectionDescription("shared"));
  assert.deepEqual(await pending, connectionDescription("shared"));
  assert.deepEqual(monitor(), connectionDescription("shared"));

  now = 101;
  // Expired data remains usable while one new probe runs in the background.
  assert.deepEqual(monitor(), connectionDescription("shared"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  release(connectionDescription("not-running"));
  assert.deepEqual(await monitor.refresh(), connectionDescription("not-running"));
});

test("a failed background connection probe resolves to an untrusted status", async () => {
  const monitor = desktopConnectionMonitor(url, {
    inspect: async () => { throw new Error("permission denied"); },
  });
  assert.deepEqual(monitor(), connectionDescription("unknown"));
  assert.deepEqual(await monitor.refresh(), connectionDescription("unknown"));
});
