import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const descriptions = {
  shared: ["已共享", "已确认桌面 App 和 Pocket 连接到同一后端，可继续同一任务。"],
  independent: ["正在切换", "Pocket 会自动请求桌面 App 正常退出并重开，以接入共享后端；不会强制结束进程。"],
  "not-running": ["桌面未打开", "Pocket 的共享后端已就绪。请打开 Codex App，打开后会检测是否连接到同一后端。"],
  unknown: ["待确认", "Pocket 无法确认桌面 App 的实际连接，尚未验证能否继续桌面任务。"],
  standalone: ["独立模式", "Pocket 未连接共享后端，无法保证与桌面 App 继续同一任务。请启用共享后端后重新启动 Pocket 服务。"],
};

export function connectionDescription(state, platform = process.platform) {
  const description = state === "independent" && !["darwin", "win32"].includes(platform)
    ? ["桌面未接入", "桌面 App 正在使用独立后端。请正常退出 App 后点击“连接桌面 App”。"]
    : descriptions[state] || descriptions.unknown;
  const [label, advice] = description;
  return { state, label, advice };
}

export function desktopProcesses(processes, platform) {
  const mainName = platform === "darwin"
    ? /\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)$/
    : platform === "win32" ? /(?:^|[\\/])(?:Codex|ChatGPT)\.exe$/
      : /(?:^|\/)(?:Codex|ChatGPT|codex-desktop)$/;
  const candidates = (Array.isArray(processes) ? processes : [])
    .filter((process) => typeof process?.file === "string" && mainName.test(process.file));
  return candidates.filter((process) => {
    const parentPid = processId(process.ppid);
    return parentPid === null || !candidates.some((parent) => processId(parent.pid) === parentPid);
  });
}

function processId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function descendantIds(processes, rootPid) {
  const children = new Map();
  for (const process of processes) {
    const pid = processId(process?.pid);
    const ppid = processId(process?.ppid);
    if (pid === null || ppid === null) continue;
    const siblings = children.get(ppid) || [];
    siblings.push(pid);
    children.set(ppid, siblings);
  }

  const descendants = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length) {
    const parent = pending.pop();
    for (const child of children.get(parent) || []) {
      if (descendants.has(child)) continue;
      descendants.add(child);
      pending.push(child);
    }
  }
  return descendants;
}

function isCodexCli(file) {
  return typeof file === "string" && /(?:^|[\\/])codex(?:\.exe)?$/i.test(file);
}

function targetSocketPids(sockets, port) {
  return new Set(
    (Array.isArray(sockets) ? sockets : [])
      .filter((socket) => Number(socket?.port) === port
        && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(socket?.host))
      .map((socket) => processId(socket?.pid))
      .filter((pid) => pid !== null),
  );
}

export function classifyDesktop(processes, sockets, url, platform) {
  const mains = desktopProcesses(processes, platform);
  if (!mains.length) return "not-running";
  const port = Number(new URL(url).port);
  const connected = targetSocketPids(sockets, port);
  const states = mains.map((main) => {
    const rootPid = processId(main.pid);
    if (rootPid === null) return "unknown";
    const descendants = descendantIds(processes, rootPid);
    const hasTargetSocket = [...descendants].some((pid) => connected.has(pid));
    // A Codex child without the shared socket is the old independent writer.
    // If it owns the target socket, it is the shared App Server child instead.
    const hasIndependentCli = processes.some((process) => {
      const pid = processId(process?.pid);
      return pid !== null && pid !== rootPid && descendants.has(pid)
        && isCodexCli(process?.file) && !connected.has(pid);
    });
    if (hasIndependentCli) return "independent";
    return hasTargetSocket ? "shared" : "unknown";
  });
  if (states.includes("independent")) return "independent";
  return states.every((state) => state === "shared") ? "shared" : "unknown";
}

export async function inspectDesktop(url, { platform = process.platform, run = execute } = {}) {
  if (!url) return connectionDescription("standalone");
  const options = { timeout: 2500, maxBuffer: 4 * 1024 * 1024, windowsHide: true };
  try {
    let processes;
    let sockets = [];
    if (platform === "win32") {
      const script = "$ErrorActionPreference='Stop'; $p=@(Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}},@{n='ppid';e={$_.ParentProcessId}},@{n='file';e={if ($_.ExecutablePath) {$_.ExecutablePath} else {$_.Name}}}); $s=@(Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue | Select-Object @{n='pid';e={$_.OwningProcess}},@{n='host';e={$_.RemoteAddress}},@{n='port';e={$_.RemotePort}}); @{processes=$p;sockets=$s} | ConvertTo-Json -Depth 4 -Compress";
      const result = JSON.parse((await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], options)).stdout);
      processes = result.processes.filter((process) => typeof process.file === "string");
      sockets = result.sockets;
    } else if (platform === "darwin" || platform === "linux") {
      const output = (await run("ps", ["-axo", "pid=,ppid=,comm="], options)).stdout;
      processes = output.split("\n").flatMap((line) => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), file: match[3] }] : [];
      });
      const mains = desktopProcesses(processes, platform);
      if (!mains.length) return connectionDescription("not-running");
      const processIds = mains.flatMap((main) => {
        const rootPid = processId(main.pid);
        return rootPid === null ? [] : [...descendantIds(processes, rootPid)];
      });
      if (!processIds.length) return connectionDescription("unknown");
      let outputSockets;
      try {
        outputSockets = (await run("lsof", ["-nP", "-a", "-p", processIds.join(","), "-iTCP", "-sTCP:ESTABLISHED", "-Fpn"], options)).stdout;
      } catch (error) {
        if (error.code !== 1 || error.stderr?.trim()) throw error;
        outputSockets = error.stdout || "";
      }
      let pid;
      for (const line of outputSockets.split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        const match = line.match(/^n.*->(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
        if (match) sockets.push({ pid, host: match[1] || match[2], port: Number(match[3]) });
      }
    } else return connectionDescription("unknown");
    return connectionDescription(classifyDesktop(processes, sockets, url, platform), platform);
  } catch {
    return { ...connectionDescription("unknown"), label: "检测失败",
      advice: "无法读取本机桌面进程或 TCP 连接，尚未确认接入状态。请重试连接检测。" };
  }
}

export function desktopConnectionMonitor(url, {
  inspect = inspectDesktop,
  now = () => Date.now(),
  ttlMs = 3_000,
} = {}) {
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : 3_000;
  let cached = connectionDescription(url ? "unknown" : "standalone");
  let expires = url ? 0 : Number.POSITIVE_INFINITY;
  let pending = null;

  function setUnknown() {
    cached = connectionDescription("unknown");
    expires = now() + ttl;
    return cached;
  }

  function refresh() {
    if (!url) return Promise.resolve(cached);
    if (pending) return pending;
    pending = Promise.resolve()
      .then(() => inspect(url))
      .then((result) => {
        cached = result && typeof result.state === "string"
          ? result
          : connectionDescription("unknown");
        expires = now() + ttl;
        return cached;
      })
      .catch(() => setUnknown())
      .finally(() => { pending = null; });
    return pending;
  }

  // Health and sync endpoints use stale-while-revalidate: process inspection
  // can involve multiple OS commands and must not delay an HTTP response.
  const monitor = () => {
    if (url && now() >= expires) void refresh();
    return cached;
  };
  monitor.refresh = refresh;
  monitor.snapshot = () => cached;
  monitor.isStale = () => Boolean(url) && now() >= expires;
  return monitor;
}
