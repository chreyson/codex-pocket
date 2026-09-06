import { execFile, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { inspectDesktop } from "./desktop-connection.mjs";
import { localAppServerUrl } from "./runtime-config.mjs";
import { createHash } from "node:crypto";

const execute = promisify(execFile);
const POCKET_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export async function prepareDesktopProxy(url, {
  platform = process.platform,
  nodePath = process.execPath,
  codexPath = process.env.CODEX_BIN || "codex",
  dataDirectory = path.join(POCKET_ROOT, ".data"),
  writeFile = fs.writeFile,
  rename = fs.rename,
  mkdir = fs.mkdir,
  chmod = fs.chmod,
  run = execute,
} = {}) {
  if (url !== "auto") url = localAppServerUrl(url);
  const proxyScript = path.join(POCKET_ROOT, "scripts", "app-server-ws-proxy.mjs");
  const extension = platform === "win32" ? ".exe" : "";
  const proxyPath = path.join(dataDirectory, `codex-pocket-${url === "auto" ? "auto" : "shared"}-cli${extension}`);
  const temporary = `${proxyPath}.${process.pid}.tmp`;
  const proxyArgs = [proxyScript, url, ...(url === "auto" ? [path.join(dataDirectory, "shared-server.json")] : [])];
  await mkdir(dataDirectory, { recursive: true });
  if (platform === "win32") {
    // Version the binary so upgrading Pocket never replaces an executable in use.
    const source = await fs.readFile(path.join(POCKET_ROOT, "scripts/windows-desktop-proxy.cs"));
    const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
    const executable = proxyPath.replace(/\.exe$/, `-${digest}.exe`);
    if (!existsSync(executable)) {
      await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.join(POCKET_ROOT, "scripts/build-windows-proxy.ps1"), "-OutputPath", temporary],
      { windowsHide: true, timeout: 30_000 });
      await rename(temporary, executable);
    }
    await writeFile(`${temporary}.json`, JSON.stringify({ nodePath, codexPath, proxyArgs }), { mode: 0o600 });
    await rename(`${temporary}.json`, `${executable}.json`);
    return executable;
  }
  const content = `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "app-server" ]; then\n    exec ${shellQuote(nodePath)} ${proxyArgs.map(shellQuote).join(" ")} "$@"\n  fi\ndone\nexec ${shellQuote(codexPath)} "$@"\n`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o700 });
  await rename(temporary, proxyPath);
  if (platform !== "win32") await chmod(proxyPath, 0o700);
  return proxyPath;
}

export async function openSharedDesktop(url, {
  platform = process.platform, env = process.env, inspect = inspectDesktop,
  run = execute, launch = spawn, exists = existsSync, wait = delay,
  prepareProxy = prepareDesktopProxy,
} = {}) {
  url = localAppServerUrl(url);
  const current = await inspect(url);
  if (current.state === "shared") return current;
  if (current.state !== "not-running") {
    throw new Error("桌面 App 尚未退出或连接无法确认。请先在桌面保存工作并正常退出 App，再点击“连接桌面 App”。Pocket 不会自动结束桌面任务。");
  }
  let executable = env.CODEX_DESKTOP_PATH || env.CODEX_DESKTOP_APP;
  if (platform === "darwin") {
    executable ||= ["/Applications/ChatGPT.app", "/Applications/Codex.app"].find(exists);
  } else if (!executable && platform === "win32") {
    executable = (await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(POCKET_ROOT, "scripts/resolve-windows-desktop.ps1")],
    { timeout: 15_000, windowsHide: true, encoding: "utf8" })).stdout.trim();
  } else if (!executable && platform === "linux") {
    executable = (await run("which", ["codex-desktop"], { timeout: 2500 })).stdout.trim();
  }
  if (!executable || !exists(executable)) {
    throw new Error("未找到桌面 App，请通过 CODEX_DESKTOP_PATH 配置安装路径。");
  }

  const proxyPath = await prepareProxy(url, {
    platform,
    nodePath: process.execPath,
    codexPath: env.CODEX_BIN || "codex",
  });
  const sharedEnvironment = {
    CODEX_APP_SERVER_FORCE_CLI: "1",
    CODEX_CLI_PATH: proxyPath,
  };
  if (platform === "darwin") {
    const openArgs = [
      "-g",
      "--env", `CODEX_APP_SERVER_FORCE_CLI=${sharedEnvironment.CODEX_APP_SERVER_FORCE_CLI}`,
      "--env", `CODEX_CLI_PATH=${sharedEnvironment.CODEX_CLI_PATH}`,
    ];
    if (env.CODEX_HOME) openArgs.push("--env", `CODEX_HOME=${env.CODEX_HOME}`);
    openArgs.push(executable);
    await run("/usr/bin/open", openArgs, { timeout: 10000 });
  } else {
    await new Promise((resolve, reject) => {
      const child = launch(executable, [], {
        detached: true, stdio: "ignore", windowsHide: true,
        env: { ...env, ...sharedEnvironment },
      });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    await wait(500);
    const result = await inspect(url);
    if (result.state === "shared") return result;
    if (result.state === "independent") break;
  }
  throw new Error("已发出启动请求，但未确认桌面 App 接入共享后端。请查看当前连接状态；不能据此认定已连接。");
}
