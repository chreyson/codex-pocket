import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import net from "node:net";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 4_000;
const WINDOWS_PIPE_PREFIX = "\\\\.\\pipe\\";
const CODEX_PIPE_PATTERN = /^codex-(?:browser-use|app-tools)-/i;

function bridgeError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export async function discoverCodexAppPipePaths({
  env = process.env,
  platform = process.platform,
  readdir = fs.readdir,
} = {}) {
  const configured = String(env.CODEX_APP_TOOLS_PIPE_PATH || "").trim();
  const paths = configured ? [configured] : [];
  if (platform !== "win32") return paths;

  try {
    const names = await readdir(WINDOWS_PIPE_PREFIX);
    for (const name of names) {
      if (CODEX_PIPE_PATTERN.test(name)) paths.push(`${WINDOWS_PIPE_PREFIX}${name}`);
    }
  } catch {
    // An explicit path can still work when Windows refuses pipe enumeration.
  }
  return unique(paths);
}

export function encodeNativeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_FRAME_BYTES) {
    throw bridgeError("Codex App 请求内容过大", "DESKTOP_BRIDGE_PROTOCOL");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export function requestNativePipe(pipePath, method, params, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createConnection = net.createConnection,
} = {}) {
  return new Promise((resolve, reject) => {
    const id = 1;
    let socket;
    let settled = false;
    let pending = Buffer.alloc(0);

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket && !socket.destroyed) socket.destroy();
      callback(value);
    };

    const failConnection = (error) => {
      finish(
        reject,
        bridgeError("无法连接正在运行的 Codex App", "DESKTOP_BRIDGE_CONNECTION", error),
      );
    };

    const timer = setTimeout(() => {
      finish(reject, bridgeError("连接 Codex App 超时", "DESKTOP_BRIDGE_TIMEOUT"));
    }, timeoutMs);

    try {
      socket = createConnection(pipePath);
    } catch (error) {
      failConnection(error);
      return;
    }

    socket.once("connect", () => {
      try {
        socket.write(encodeNativeFrame({ id, jsonrpc: "2.0", method, params }));
      } catch (error) {
        finish(reject, error);
      }
    });
    socket.once("error", failConnection);
    socket.once("close", () => {
      if (!settled) failConnection(new Error("Codex App pipe closed"));
    });
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const length = pending.readUInt32LE(0);
        if (length > MAX_FRAME_BYTES) {
          finish(reject, bridgeError("Codex App 返回内容过大", "DESKTOP_BRIDGE_PROTOCOL"));
          return;
        }
        if (pending.length < length + 4) return;
        const payload = pending.subarray(4, length + 4);
        pending = pending.subarray(length + 4);

        let response;
        try {
          response = JSON.parse(payload.toString("utf8"));
        } catch (error) {
          finish(reject, bridgeError("Codex App 返回了无效数据", "DESKTOP_BRIDGE_PROTOCOL", error));
          return;
        }
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          finish(reject, bridgeError("Codex App 返回了无效响应", "DESKTOP_BRIDGE_PROTOCOL"));
          return;
        }
        if (String(response.id) !== String(id)) continue;
        if (response.error) {
          const error = bridgeError(
            response.error.message || "Codex App 调用失败",
            "DESKTOP_BRIDGE_TOOL_ERROR",
          );
          error.rpcCode = response.error.code;
          finish(reject, error);
        } else {
          finish(resolve, response.result);
        }
        return;
      }
    });
  });
}

function resultErrorMessage(result) {
  const text = result?.contentItems?.find((item) => item?.type === "inputText")?.text;
  if (!text) return "Codex App 未接受这条消息";
  try {
    const value = JSON.parse(text);
    return String(value?.error || value?.message || text);
  } catch {
    return text;
  }
}

function parseToolJson(result, toolName) {
  if (!result?.success) {
    throw bridgeError(resultErrorMessage(result), "DESKTOP_BRIDGE_TOOL_ERROR");
  }

  const text = result.contentItems
    ?.find((item) => item?.type === "inputText" && typeof item.text === "string")
    ?.text;
  if (!text) {
    throw bridgeError(`Codex App 的 ${toolName} 没有返回数据`, "DESKTOP_BRIDGE_PROTOCOL");
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw bridgeError(`Codex App 的 ${toolName} 返回了无效数据`, "DESKTOP_BRIDGE_PROTOCOL", error);
  }
}

function assertToolSuccess(result) {
  if (!result?.success) {
    throw bridgeError(resultErrorMessage(result), "DESKTOP_BRIDGE_TOOL_ERROR");
  }
  return result;
}

export class CodexDesktopBridge {
  constructor({
    discover = discoverCodexAppPipePaths,
    request = requestNativePipe,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.discover = discover;
    this.request = request;
    this.timeoutMs = timeoutMs;
    this.endpoint = null;
    this.discoveryPromise = null;
  }

  async _discoverEndpoint(requiredTool) {
    if (this.endpoint?.tools.has(requiredTool)) return this.endpoint;
    this.endpoint = null;

    if (!this.discoveryPromise) {
      this.discoveryPromise = (async () => {
        const paths = await this.discover();
        if (paths.length === 0) {
          throw bridgeError("未检测到正在运行的 Codex App", "DESKTOP_BRIDGE_UNAVAILABLE");
        }

        const attempts = await Promise.all(paths.map(async (pipePath) => {
          try {
            const result = await this.request(
              pipePath,
              "tools/list",
              { threadStartKind: "all" },
              { timeoutMs: Math.min(this.timeoutMs, 1_500) },
            );
            const tools = new Map(
              (result?.tools || []).map((item) => [
                item.name,
                item.namespace || "codex_app",
              ]),
            );
            return { pipePath, tools };
          } catch {
            return null;
          }
        }));

        const available = attempts.filter(Boolean);
        if (!available.length) {
          throw bridgeError("无法连接正在运行的 Codex App", "DESKTOP_BRIDGE_UNAVAILABLE");
        }
        return available;
      })();
    }

    const discovery = this.discoveryPromise;
    let available;
    try {
      available = await discovery;
    } finally {
      if (this.discoveryPromise === discovery) this.discoveryPromise = null;
    }

    const endpoint = available.find((candidate) => candidate.tools.has(requiredTool));
    if (!endpoint) {
      throw bridgeError(
        `当前 Codex App 不支持 ${requiredTool}`,
        "DESKTOP_BRIDGE_TOOL_UNAVAILABLE",
      );
    }
    this.endpoint = endpoint;
    return endpoint;
  }

  async _callTool(tool, threadId, args) {
    const endpoint = await this._discoverEndpoint(tool);
    const namespace = endpoint.tools.get(tool);
    if (!namespace) {
      throw bridgeError(
        `当前 Codex App 不支持 ${tool}`,
        "DESKTOP_BRIDGE_TOOL_UNAVAILABLE",
      );
    }
    return this.request(
      endpoint.pipePath,
      "tools/call",
      {
        arguments: args,
        callId: `codex-pocket-${randomUUID()}`,
        namespace,
        threadId,
        tool,
        turnId: `codex-pocket-${randomUUID()}`,
      },
      { timeoutMs: this.timeoutMs },
    );
  }

  async _callWithReconnect(tool, threadId, args, { retry = false } = {}) {
    try {
      return await this._callTool(tool, threadId, args);
    } catch (error) {
      if (![
        "DESKTOP_BRIDGE_CONNECTION",
        "DESKTOP_BRIDGE_TIMEOUT",
      ].includes(error.code)) throw error;
      this.endpoint = null;
      if (!retry) throw error;
      return this._callTool(tool, threadId, args);
    }
  }

  async readThread(threadId, { turnLimit = 2 } = {}) {
    const result = await this._callWithReconnect(
      "read_thread",
      threadId,
      {
        threadId,
        turnLimit,
        includeOutputs: false,
        maxOutputCharsPerItem: 20_000,
      },
      { retry: true },
    );
    return parseToolJson(result, "read_thread");
  }

  async sendMessage(threadId, prompt, { model = "", effort = "" } = {}) {
    const args = { threadId, prompt };
    if (model) args.model = model;
    if (effort) args.thinking = effort;
    try {
      const result = await this._callWithReconnect(
        "send_message_to_thread",
        threadId,
        args,
      );
      return assertToolSuccess(result);
    } catch (error) {
      if (error.code !== "DESKTOP_BRIDGE_TIMEOUT") throw error;
      throw bridgeError(
        "Codex Desktop 的发送结果未确认，请先在 Desktop 中检查，避免重复发送",
        "DESKTOP_BRIDGE_DELIVERY_UNKNOWN",
        error,
      );
    }
  }
}
