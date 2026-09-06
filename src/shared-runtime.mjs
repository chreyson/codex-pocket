import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { CodexAppServer, appServerLaunchSpec } from "./codex-client.mjs";
import { localAppServerUrl } from "./runtime-config.mjs";

export const sharedConfigPath = fileURLToPath(new URL("../.data/shared-server.json", import.meta.url));
export const SHARED_RUNTIME_OWNER = "codex-pocket";
const executeFile = promisify(execFile);
const COMMAND_TIMEOUT_MS = 10_000;
const MIGRATION_TIMEOUT_MS = 8_000;
const POCKET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function readSharedConfig(configPath = sharedConfigPath) {
  try {
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.url = localAppServerUrl(config.url);
    const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
    if (config.codexHome !== codexHome) throw new Error("共享 Codex 使用不同的数据目录，请重新配置共享连接");
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function commandLooksLikePath(value, platform = process.platform) {
  if (!value) return false;
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\")
    || (platform === "win32" && /^[a-z]:/i.test(value));
}

async function resolveCommandPath(command, {
  execute = executeFile,
  realpath = fs.realpath,
  platform = process.platform,
} = {}) {
  const value = String(command || "").trim();
  if (!value) throw new Error("Codex CLI 未配置");

  if (commandLooksLikePath(value, platform)) {
    try {
      return await realpath(value);
    } catch (error) {
      throw new Error(`Codex CLI 不可用：${value}`);
    }
  }

  const locator = platform === "win32" ? "where" : "which";
  try {
    const result = await execute(locator, [value], {
      encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
    });
    const candidate = String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!candidate) throw new Error("not found");
    return await realpath(candidate);
  } catch (error) {
    throw new Error(`Codex CLI 不可用：${value}`);
  }
}

export async function readCommandMetadata(command, {
  execute = executeFile,
  realpath = fs.realpath,
  platform = process.platform,
} = {}) {
  const commandPath = await resolveCommandPath(command, { execute, realpath, platform });
  const options = {
    encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
    ...(platform === "win32" && /\.(?:cmd|bat)$/i.test(commandPath) ? { shell: true } : {}),
  };
  let result;
  try {
    if (options.shell && /["\r\n%!]/.test(commandPath)) throw new Error("Unsupported batch executable path");
    result = await execute(options.shell ? `"${commandPath}"` : commandPath, ["--version"], options);
  } catch (error) {
    const detail = error?.message ? `：${error.message}` : "";
    throw new Error(`无法读取 Codex CLI 版本（${commandPath}）${detail}`);
  }
  const version = String(result.stdout || result.stderr || "").trim();
  if (!version) throw new Error(`无法读取 Codex CLI 版本（${commandPath}）`);
  return { commandPath, version };
}

function normalizedPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

async function cliCompatibility(previous, metadata, realpath = fs.realpath) {
  const previousCommand = previous?.codexCommandRealpath || previous?.codexCommand;
  if (!previousCommand) return "mismatch";
  let previousPath = previousCommand;
  try { previousPath = await realpath(previousCommand); } catch { /* A removed CLI is a mismatch. */ }
  if (normalizedPath(previousPath) !== normalizedPath(metadata.commandPath)) return "mismatch";
  if (!previous?.codexVersion) return "match-missing-version";
  return String(previous.codexVersion).trim() === metadata.version ? "match" : "mismatch";
}

async function writeSharedConfig(configPath, config) {
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    await fs.rename(temporary, configPath);
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

function commandLineForProcess(info) {
  return [info?.commandLine, info?.command, info?.file, info?.executablePath]
    .filter(Boolean)
    .map(String)
    .join(" ")
    .trim();
}

function processCommandMatches(expected, commandLine) {
  const wanted = normalizedPath(expected);
  const actual = normalizedPath(commandLine);
  if (!wanted || !actual) return false;
  const expectedIsPath = wanted.includes("/");
  if (!expectedIsPath) return actual.includes(wanted);
  if (actual.includes(wanted)) return true;

  // On Windows a .cmd/.bat launcher can leave the real .exe as the socket
  // owner. Accept only a sibling executable with the same stem and directory.
  const expectedBase = path.posix.basename(wanted);
  if (!/\.(?:cmd|bat)$/i.test(expectedBase)) return false;
  const stem = expectedBase.replace(/\.(?:cmd|bat)$/i, "");
  const directory = path.posix.dirname(wanted);
  return actual.includes(`${directory}/${stem}.exe`) || actual.includes(`${directory}/${stem}`);
}

function processOwnsSharedBackend(previous, info) {
  if (!info || info.exists === false || info.alive === false) return false;
  const commandLine = commandLineForProcess(info);
  if (!commandLine || !/\bapp-server\b/i.test(commandLine)) return false;
  let parsed;
  try { parsed = new URL(localAppServerUrl(previous.url)); } catch { return false; }
  const listenMatches = commandLine.includes(parsed.origin) || commandLine.includes(`:${parsed.port}`);
  if (!listenMatches) return false;
  const expected = normalizedPath(previous.codexCommandRealpath || previous.codexCommand);
  if (!expected) return false;
  return processCommandMatches(expected, commandLine);
}

function pocketViewerScript(config = {}) {
  const root = config.pocketRoot || POCKET_ROOT;
  return normalizedPath(path.join(root, "src", "server.mjs"));
}

async function processWorkingDirectory(pid, {
  execute = executeFile,
  platform = process.platform,
} = {}) {
  if (platform === "win32") return null;
  try {
    const result = await execute("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
    });
    const line = String(result.stdout || "").split(/\r?\n/).find((value) => value.startsWith("n"));
    return line ? line.slice(1).trim() : null;
  } catch {
    return null;
  }
}

async function processIsPocketViewer(config, info, socketOptions = {}) {
  if (!info || info.exists === false || info.alive === false) return false;
  const commandLine = normalizedPath(commandLineForProcess(info));
  const root = normalizedPath(config?.pocketRoot || POCKET_ROOT);
  const script = pocketViewerScript(config);
  // The script path is the ownership boundary.  Do not classify arbitrary
  // Node processes that merely happen to expose a server.mjs file.
  if (script && commandLine.includes(script)) return true;
  if (!/(?:^|\s)(?:\.\/)?src\/server\.mjs(?:\s|$)/i.test(commandLine)) return false;
  const cwd = normalizedPath(info.cwd || await processWorkingDirectory(info.pid, socketOptions));
  return Boolean(root && cwd === root);
}

function processIdentity(info) {
  if (!info || info.exists === false || info.alive === false) return "gone";
  return [
    Number(info.pid) || "",
    normalizedPath(commandLineForProcess(info)),
  ].join("|");
}

async function inspectPosixProcess(pid, execute) {
  try {
    const result = await execute("ps", ["-p", String(pid), "-o", "pid=,ppid=,command="], {
      encoding: "utf8", timeout: COMMAND_TIMEOUT_MS,
    });
    const line = String(result.stdout || "").split(/\r?\n/).map((item) => item.trim()).find(Boolean);
    if (!line) return { pid, exists: false };
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    return match
      ? { pid: Number(match[1]), ppid: Number(match[2]), commandLine: match[3], exists: true }
      : { pid, commandLine: line, exists: true };
  } catch (error) {
    if (error?.code === 1 || error?.code === "ESRCH") return { pid, exists: false };
    return null;
  }
}

async function inspectWindowsProcess(pid, execute) {
  const script = "$p=Get-CimInstance Win32_Process -Filter 'ProcessId="
    + String(pid) + "'; if ($p) { $p | Select-Object ProcessId,ParentProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress }";
  try {
    const result = await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
    });
    const output = String(result.stdout || "").trim();
    if (!output) return { pid, exists: false };
    const value = JSON.parse(output);
    return {
      pid: Number(value.ProcessId),
      ppid: Number(value.ParentProcessId),
      commandLine: value.CommandLine || value.ExecutablePath || "",
      exists: true,
    };
  } catch (error) {
    if (error?.code === 1 || error?.code === "ESRCH") return { pid, exists: false };
    return null;
  }
}

export async function inspectProcess(pid, {
  execute = executeFile,
  platform = process.platform,
} = {}) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return { pid, exists: false };
  return platform === "win32"
    ? inspectWindowsProcess(Number(pid), execute)
    : inspectPosixProcess(Number(pid), execute);
}

function socketPidsFromText(text, platform) {
  const value = String(text || "");
  if (platform === "win32") {
    try {
      const parsed = JSON.parse(value);
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return rows.map((row) => Number(row.OwningProcess)).filter((pid) => Number.isInteger(pid));
    } catch {
      return [...value.matchAll(/(?:OwningProcess|pid)\s*[:=]\s*(\d+)/gi)].map((match) => Number(match[1]));
    }
  }
  const lsofPids = [...value.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1]));
  if (lsofPids.length) return lsofPids;
  return [...value.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
}

async function connectedSocketPids(port, {
  execute = executeFile,
  platform = process.platform,
} = {}) {
  const commands = platform === "win32"
    ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-NetTCPConnection -State Established -LocalPort ${Number(port)} | Select-Object OwningProcess | ConvertTo-Json -Compress`]]]
    : [["lsof", ["-nP", "-a", `-iTCP:${Number(port)}`, "-sTCP:ESTABLISHED", "-F", "p"]],
      ["ss", ["-Htnp", `sport = :${Number(port)}`]]];
  for (const [program, args] of commands) {
    try {
      const result = await execute(program, args, {
        encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
      });
      return socketPidsFromText(result.stdout, platform);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error?.code === 1) {
        const stderr = String(error.stderr || "");
        const stdout = String(error.stdout || "");
        const detail = `${stderr}\n${stdout}\n${String(error.message || "")}`.toLowerCase();
        if (/(permission|operation not permitted|access denied|denied)/.test(detail)) return null;
        if (!stderr.trim() && !stdout.trim()) return [];
        return null;
      }
      // Try the next platform utility before declaring the state unknown.
    }
  }
  return null;
}

function viewerConnectionFromPosix(text) {
  const listeners = new Set();
  const sockets = [];
  let pendingPort = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("TST=")) {
      const state = line.slice(4).trim().toUpperCase();
      if (pendingPort !== null && state === "LISTEN") listeners.add(pendingPort);
      if (pendingPort !== null && state === "ESTABLISHED") sockets.push(pendingPort);
      pendingPort = null;
      continue;
    }
    if (!line.startsWith("n")) continue;
    const address = line.slice(1).trim();
    const local = address.split("->", 1)[0];
    const portMatch = local.match(/:(\d+)$/);
    if (!portMatch) continue;
    pendingPort = Number(portMatch[1]);
  }
  return sockets.some((port) => listeners.has(port));
}

function viewerConnectionFromWindows(text) {
  if (!String(text || "").trim()) return false;
  try {
    const parsed = JSON.parse(String(text || ""));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const listeners = new Set(rows
      .filter((row) => String(row?.State || "").toUpperCase() === "LISTEN")
      .map((row) => Number(row.LocalPort))
      .filter((port) => Number.isInteger(port)));
    return rows.some((row) => String(row?.State || "").toUpperCase() === "ESTABLISHED"
      && listeners.has(Number(row.LocalPort)));
  } catch {
    return null;
  }
}

async function pocketViewerHasBrowserConnection(pid, {
  execute = executeFile,
  platform = process.platform,
} = {}) {
  const commands = platform === "win32"
    ? [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; Get-NetTCPConnection -OwningProcess ${Number(pid)} | Select-Object State,LocalPort,RemotePort | ConvertTo-Json -Compress`]]]
    : [["lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-FpnT"]]];
  for (const [program, args] of commands) {
    try {
      const result = await execute(program, args, {
        encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true,
      });
      return platform === "win32"
        ? viewerConnectionFromWindows(result.stdout)
        : viewerConnectionFromPosix(result.stdout);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (error?.code === 1) {
        const detail = `${error.stderr || ""}\n${error.stdout || ""}\n${error.message || ""}`;
        if (/(permission|operation not permitted|access denied|denied)/i.test(detail)) return null;
        if (!String(error.stdout || "").trim() && !String(error.stderr || "").trim()) return false;
      }
    }
  }
  return null;
}

async function stopStalePocketViewer(pid, originalInfo, {
  inspect = inspectProcess,
  viewerSockets = pocketViewerHasBrowserConnection,
  kill = process.kill,
  ...socketOptions
} = {}) {
  const latest = await inspect(pid);
  if (!latest || processIdentity(latest) !== processIdentity(originalInfo)) return null;
  const connected = await viewerSockets(pid, socketOptions);
  if (connected !== false) return connected;
  try {
    kill(pid, "SIGTERM");
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    return null;
  }
}

export async function hasActiveClients(url, backendPid, {
  inspect = inspectProcess,
  viewerSockets = pocketViewerHasBrowserConnection,
  kill = process.kill,
  cleanupStaleViewers = false,
  config = null,
  ...socketOptions
} = {}) {
  let parsed;
  try { parsed = new URL(localAppServerUrl(url)); } catch { return null; }
  const pids = await connectedSocketPids(parsed.port, socketOptions);
  if (pids === null) return null;
  const backend = Number(backendPid);
  for (const pid of pids) {
    if (pid === backend || pid === process.pid) continue;
    // A shell wrapper (notably Windows .cmd) can own the listening socket's
    // process ID separately from the saved launcher PID. Treat a matching
    // app-server descendant as the backend itself; every other established
    // socket is a real client and blocks migration.
    if (config) {
      const info = await inspect(pid);
      if (info && processOwnsSharedBackend(config, info)) continue;
      if (info === null) return null;
      if (info && await processIsPocketViewer(config, info, socketOptions)) {
        const connected = await viewerSockets(pid, socketOptions);
        if (connected === null) return null;
        if (!connected) {
          if (cleanupStaleViewers) {
            const stopped = await stopStalePocketViewer(pid, info, {
              inspect, viewerSockets, kill, ...socketOptions,
            });
            if (stopped === null) return null;
            if (stopped === true) return true;
          }
          continue;
        }
      }
    }
    return true;
  }
  return false;
}

export async function stopManagedBackend(previous, {
  inspect = inspectProcess,
  probeServer = probe,
  activeClients = hasActiveClients,
  kill = process.kill,
  wait = delay,
  timeoutMs = MIGRATION_TIMEOUT_MS,
} = {}) {
  const pid = Number(previous?.pid);
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("共享 Codex 的旧 PID 无效，拒绝迁移");
  if (pid === process.pid) throw new Error("共享 Codex 的旧 PID 指向当前进程，拒绝迁移");
  const before = await inspect(pid);
  if (!processOwnsSharedBackend(previous, before)) {
    throw new Error(`无法确认旧共享 Codex 的 PID ${pid} 仍属于 Pocket，已取消迁移`);
  }
  const identity = processIdentity(before);
  const clients = await activeClients(previous.url, pid, {
    config: previous, inspect, cleanupStaleViewers: true,
  });
  if (clients !== false) {
    throw new Error(
      clients === true
        ? "共享 Codex 仍有活动客户端，无法安全停止"
        : "无法确认共享 Codex 没有活动客户端，已取消停止",
    );
  }
  const latest = await inspect(pid);
  if (!processOwnsSharedBackend(previous, latest) || processIdentity(latest) !== identity) {
    throw new Error(`旧共享 Codex 的 PID ${pid} 在停止前发生变化，已取消迁移`);
  }
  const clientsAgain = await activeClients(previous.url, pid, {
    config: previous, inspect, cleanupStaleViewers: true,
  });
  if (clientsAgain !== false) {
    throw new Error(
      clientsAgain === true
        ? "共享 Codex 仍有活动客户端，无法安全停止"
        : "无法确认共享 Codex 没有活动客户端，已取消停止",
    );
  }
  try {
    kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw new Error(`无法优雅停止旧共享 Codex（PID ${pid}）：${error?.message || error}`);
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await inspect(pid);
    if (status?.exists === false || status?.alive === false) return;
    if (status === null) {
      throw new Error("无法确认旧共享 Codex 的 PID 状态，已取消迁移");
    }
    if (processIdentity(status) !== identity) {
      throw new Error(`旧共享 Codex 的 PID ${pid} 已被其他进程占用，已取消迁移`);
    }
    await wait(100);
  }
  throw new Error(`旧共享 Codex 未能优雅停止（PID ${pid}），已取消迁移`);
}

async function probe(url) {
  const client = new CodexAppServer({ websocketUrl: url, requestTimeoutMs: 1500 });
  try { await client.start(); return true; }
  catch { return false; }
  finally { client.stop(); }
}

async function unusedUrl() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `ws://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

export function defaultCodexCommand({
  env = process.env, platform = process.platform, exists = existsSync,
  readFile = readFileSync, home = homedir(),
} = {}) {
  if (env.CODEX_BIN?.trim()) return env.CODEX_BIN.trim();
  if (platform === "darwin") {
    for (const bundled of [
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      path.posix.join(home, "Applications/ChatGPT.app/Contents/Resources/codex"),
      path.posix.join(home, "Applications/Codex.app/Contents/Resources/codex"),
    ]) {
      if (exists(bundled)) return bundled;
    }
    const system = "/opt/homebrew/bin/codex";
    if (exists(system)) return system;
  }
  // GUI launches do not necessarily inherit the installer's shell PATH.
  try {
    const configured = JSON.parse(readFile(path.join(POCKET_ROOT, ".data/runtime.json"), "utf8"))?.Codex?.Path;
    if (configured && exists(configured)) return configured;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return "codex";
}

export async function ensureSharedServer({
  configPath = sharedConfigPath,
  command = defaultCodexCommand(),
  readCommandMetadata: readMetadata = readCommandMetadata,
  realpath = fs.realpath,
  probeServer = probe,
  inspectProcess: inspect = inspectProcess,
  hasActiveClients: activeClients = hasActiveClients,
  stopBackend = stopManagedBackend,
  spawnProcess = spawn,
  allocateUrl = unusedUrl,
} = {}) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const lockPath = `${configPath}.lock`;
  let lock;
  for (let attempt = 0; !lock; attempt++) {
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (error.code !== "EEXIST" || attempt >= 100) throw error;
      try {
        const owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) process.kill(owner.pid, 0);
      } catch (ownerError) {
        if (ownerError.code === "ESRCH") await fs.unlink(lockPath).catch(() => {});
      }
      await delay(100);
    }
  }
  try {
    const previous = await readSharedConfig(configPath);
    const previousHealthy = previous ? await probeServer(previous.url) : false;
    let metadata;
    try {
      metadata = await readMetadata(command);
    } catch (error) {
      // An already healthy shared backend owns the live session.  A temporary
      // CLI lookup failure must not tear it down or silently start a writer.
      if (previousHealthy && previous?.codexCommand && previous?.codexVersion) return previous;
      throw error;
    }
    const commandPath = metadata.commandPath;
    const codexHome = path.resolve(process.env.CODEX_HOME || path.join(homedir(), ".codex"));
    const compatibility = previous ? await cliCompatibility(previous, metadata, realpath) : "mismatch";
    if (previousHealthy && compatibility !== "mismatch") {
      if (compatibility === "match-missing-version"
          || previous.codexCommandRealpath !== metadata.commandPath) {
        const enriched = {
          ...previous,
          codexCommand: metadata.commandPath,
          codexCommandRealpath: metadata.commandPath,
          codexVersion: metadata.version,
        };
        await writeSharedConfig(configPath, enriched);
        return enriched;
      }
      return previous;
    }
    let url = previous?.url || "";
    if (previousHealthy) {
      const processInfo = await inspect(previous.pid);
      if (!processOwnsSharedBackend(previous, processInfo)) {
        throw new Error(
          `共享 Codex 正在运行，但无法确认由 Pocket 管理（旧 CLI ${previous.codexVersion || "未知"}，当前 CLI ${metadata.version}）；请先退出旧 App Server 后重试`,
        );
      }
      const clients = await activeClients(previous.url, previous.pid, {
        config: previous, inspect, cleanupStaleViewers: true,
      });
      if (clients !== false) {
        throw new Error(
          clients === true
            ? "共享 Codex 仍有活动客户端，无法安全切换 CLI；请先关闭 Web/桌面连接后重试"
            : "无法确认共享 Codex 没有活动客户端，已取消 CLI 切换以避免中断任务",
        );
      }
      await stopBackend(previous, { inspect, probeServer, activeClients });
      if (await probeServer(previous.url)) {
        throw new Error("旧共享 Codex 停止后仍可访问，已取消迁移");
      }
    } else if (previous) {
      // A failed probe is not enough to reclaim the old port: the PID may be
      // an unrelated process or the backend may be temporarily unreachable.
      // Reuse the saved URL only after proving that its owner is gone, or
      // after the same ownership/client checks used for a CLI migration.
      const previousPid = Number(previous.pid);
      if (!Number.isInteger(previousPid) || previousPid <= 0) {
        url = await allocateUrl();
      } else {
        const processInfo = await inspect(previousPid);
        if (processInfo?.exists === false || processInfo?.alive === false) {
          url = previous.url;
        } else if (processOwnsSharedBackend(previous, processInfo)) {
          const clients = await activeClients(previous.url, previousPid, { config: previous, inspect });
          if (clients !== false) {
            throw new Error(
              clients === true
                ? "旧共享 Codex 仍有活动客户端，无法回收其地址"
                : "无法确认旧共享 Codex 没有活动客户端，已保留旧进程并取消迁移",
            );
          }
          await stopBackend(previous, { inspect, probeServer, activeClients });
          if (await probeServer(previous.url)) {
            throw new Error("旧共享 Codex 停止后仍可访问，已取消迁移");
          }
          url = previous.url;
        } else {
          // Keep an unknown process untouched and use a fresh loopback port.
          url = await allocateUrl();
        }
      }
    }
    if (!url) url = await allocateUrl();
    const launch = appServerLaunchSpec(commandPath, { listenUrl: url });
    const log = await fs.open(path.join(path.dirname(configPath), "shared-codex.log"), "a", 0o600);
    let child;
    try {
      child = spawnProcess(launch.command, launch.args, {
        detached: true, shell: launch.shell, windowsHide: true,
        stdio: ["ignore", log.fd, log.fd], env: process.env,
      });
      await once(child, "spawn");
      child.unref();
    } finally { await log.close(); }
    const config = {
      url,
      codexHome,
      codexCommand: commandPath,
      codexCommandRealpath: commandPath,
      codexVersion: metadata.version,
      managedBy: SHARED_RUNTIME_OWNER,
      pid: child.pid,
    };
    try {
      for (let attempt = 0; ; attempt++) {
        if (child.exitCode !== null || attempt >= 30) throw new Error("共享 Codex 启动失败，请检查 .data/shared-codex.log；需要支持 WebSocket 的 Codex 版本");
        if (await probeServer(url)) break;
        await delay(100);
      }
      await writeSharedConfig(configPath, config);
      return config;
    } catch (error) {
      child.kill();
      throw error;
    }
  } finally {
    await lock.close();
    await fs.unlink(lockPath);
  }
}
