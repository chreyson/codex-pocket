import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-client.mjs";
import {
  parseApprovalPayload,
  parseMessagePayload,
  sanitizeServerRequest,
} from "./control.mjs";
import { sanitizeThreadDetail, sanitizeThreadSummary } from "./transform.mjs";
import {
  SESSION_COOKIE,
  createAccessToken,
  requestToken,
  safeTokenEqual,
} from "./security.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.RELAY_DATA_DIR || path.join(ROOT, ".data"));
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4173);
const POLL_INTERVAL_MS = Math.max(700, Number(process.env.POLL_INTERVAL_MS || 1_200));

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

await fs.mkdir(DATA_DIR, { recursive: true });
const tokenPath = path.join(DATA_DIR, "access-token");
let accessToken = process.env.CODEX_RELAY_TOKEN || "";
if (!accessToken) {
  try {
    accessToken = (await fs.readFile(tokenPath, "utf8")).trim();
  } catch {
    accessToken = createAccessToken();
    await fs.writeFile(tokenPath, `${accessToken}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

const codex = new CodexAppServer();
let codexState = "starting";
let codexError = "";
codex.on("ready", () => {
  codexState = "ready";
  codexError = "";
});
codex.on("exit", () => {
  codexState = "disconnected";
});
codex.on("diagnostic", (message) => {
  codexError = String(message).split("\n").at(-1) || "";
});
codex.on("notification", (message) => {
  if (message.method !== "item/agentMessage/delta") schedulePoll(30);
});
codex.on("serverRequest", () => schedulePoll(10));
codex.on("control", () => schedulePoll(10));

const clients = new Set();
let pollTimer = null;
let polling = false;
let latestThreads = [];
let latestThreadsHash = "";

function commonHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...extra,
  };
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, commonHeaders({ "Content-Type": "application/json; charset=utf-8", ...headers }));
  response.end(JSON.stringify(value));
}

function isAuthorized(request) {
  return safeTokenEqual(requestToken(request), accessToken);
}

async function readBody(request, limit = 4_096) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      const error = new Error("请求内容过大");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(request, limit = 16_384) {
  const contentType = String(request.headers["content-type"] || "").toLowerCase();
  if (!contentType.startsWith("application/json")) {
    const error = new Error("请求必须使用 JSON 格式");
    error.status = 415;
    throw error;
  }
  const raw = await readBody(request, limit);
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("JSON 内容无效");
    error.status = 400;
    throw error;
  }
}

function sseSend(client, event, value) {
  if (client.response.destroyed || client.response.writableEnded) return false;
  client.response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  return true;
}

function broadcastMessageEvent(event, value) {
  for (const client of clients) {
    if (client.threadId === value.threadId) sseSend(client, event, value);
  }
}

codex.on("messageStart", (value) => broadcastMessageEvent("messageStart", value));
codex.on("messageDelta", (value) => broadcastMessageEvent("messageDelta", value));
codex.on("messageDone", (value) => broadcastMessageEvent("messageDone", value));

async function loadThreads() {
  const result = await codex.listThreads();
  return (result.data || []).map(sanitizeThreadSummary);
}

async function loadThreadState(threadId) {
  const result = await codex.readThread(threadId);
  const thread = {
    ...sanitizeThreadDetail(result.thread),
    control: {
      ...codex.threadControlState(threadId),
      requests: codex.pendingServerRequests(threadId).map(sanitizeServerRequest),
    },
  };
  const agentMessages = (result.thread?.turns || []).flatMap((turn) =>
    (turn.items || [])
      .filter((item) => item.type === "agentMessage" && item.id)
      .map((item) => ({ id: item.id, role: "assistant", text: String(item.text ?? "") })),
  );
  return { thread, agentMessages };
}

async function loadThread(threadId) {
  return (await loadThreadState(threadId)).thread;
}

function schedulePoll(delay = POLL_INTERVAL_MS) {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(runPoll, delay);
}

async function runPoll() {
  if (polling) return schedulePoll();
  polling = true;
  try {
    const threads = await loadThreads();
    codexState = "ready";
    codexError = "";
    const threadsHash = JSON.stringify(threads);
    if (threadsHash !== latestThreadsHash) {
      latestThreads = threads;
      latestThreadsHash = threadsHash;
      for (const client of clients) sseSend(client, "threads", threads);
    }

    const watchedIds = [...new Set([...clients].map((client) => client.threadId).filter(Boolean))];
    for (const threadId of watchedIds) {
      try {
        const { thread, agentMessages } = await loadThreadState(threadId);
        const hash = JSON.stringify(thread);
        let broadcasted = false;
        for (const client of clients) {
          if (client.threadId === threadId && client.threadHash !== hash) {
            client.threadHash = hash;
            if (sseSend(client, "thread", thread)) broadcasted = true;
          }
        }
        if (broadcasted) codex.confirmLiveAgentMessageSnapshot(threadId, agentMessages);
      } catch (error) {
        for (const client of clients) {
          if (client.threadId === threadId) sseSend(client, "threadError", { message: error.message });
        }
      }
    }

    for (const client of clients) {
      sseSend(client, "status", { state: codexState, error: codexError });
    }
  } catch (error) {
    codexState = "error";
    codexError = error.message;
    for (const client of clients) sseSend(client, "status", { state: codexState, error: codexError });
  } finally {
    polling = false;
    schedulePoll();
  }
}

async function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== path.join(PUBLIC_DIR, "index.html")) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  try {
    const content = await fs.readFile(resolved);
    response.writeHead(200, commonHeaders({
      "Content-Type": MIME_TYPES[path.extname(resolved)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    }));
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

const sessionAttempts = new Map();
const actionAttempts = new Map();

function allowAttempt(attempts, address, limit) {
  const now = Date.now();
  const current = attempts.get(address);
  if (!current || now - current.startedAt > 60_000) {
    attempts.set(address, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function parseThreadRoute(pathname) {
  const match = pathname.match(/^\/api\/threads\/([^/]+)(?:\/(messages|approvals)(?:\/([^/]+))?)?$/);
  if (!match) return null;
  try {
    return {
      threadId: decodeURIComponent(match[1]),
      action: match[2] || "",
      requestToken: match[3] ? decodeURIComponent(match[3]) : "",
    };
  } catch {
    const error = new Error("会话地址无效");
    error.status = 400;
    throw error;
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (request.method === "GET" && pathname === "/api/health") {
      return sendJson(response, 200, { ok: true, codex: codexState });
    }

    if (request.method === "POST" && pathname === "/api/session") {
      const address = request.socket.remoteAddress || "unknown";
      if (!allowAttempt(sessionAttempts, address, 10)) return sendJson(response, 429, { error: "Too many attempts" });
      await readBody(request);
      const token = requestToken(request);
      if (!safeTokenEqual(token, accessToken)) return sendJson(response, 401, { error: "访问密钥无效" });
      const forwardedProto = String(request.headers["x-forwarded-proto"] || "");
      const secure = forwardedProto.includes("https") || process.env.FORCE_SECURE_COOKIE === "1";
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(accessToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`;
      return sendJson(response, 200, { ok: true }, { "Set-Cookie": cookie });
    }

    if (pathname.startsWith("/api/") && !isAuthorized(request)) {
      return sendJson(response, 401, { error: "Unauthorized" });
    }

    if (request.method === "GET" && pathname === "/api/bootstrap") {
      const threads = await loadThreads();
      latestThreads = threads;
      latestThreadsHash = JSON.stringify(threads);
      return sendJson(response, 200, {
        status: { state: codexState, error: codexError },
        threads,
      });
    }

    const threadRoute = parseThreadRoute(pathname);
    if (request.method === "GET" && threadRoute && !threadRoute.action) {
      return sendJson(response, 200, await loadThread(threadRoute.threadId));
    }

    if (request.method === "POST" && threadRoute?.action === "messages" && !threadRoute.requestToken) {
      const address = request.socket.remoteAddress || "unknown";
      if (!allowAttempt(actionAttempts, address, 24)) {
        return sendJson(response, 429, { error: "发送过于频繁，请稍后再试" });
      }
      const { text } = parseMessagePayload(await readJson(request));
      const current = await loadThread(threadRoute.threadId);
      if (current.status === "active" && !current.control.busy) {
        return sendJson(response, 409, { error: "这个会话正在电脑端执行，请完成后再发送" });
      }
      const result = await codex.startTurn(threadRoute.threadId, text);
      schedulePoll(10);
      return sendJson(response, 202, {
        ok: true,
        turnId: result.turn?.id || null,
        control: codex.threadControlState(threadRoute.threadId),
      });
    }

    if (request.method === "POST" && threadRoute?.action === "approvals" && threadRoute.requestToken) {
      const address = request.socket.remoteAddress || "unknown";
      if (!allowAttempt(actionAttempts, address, 24)) {
        return sendJson(response, 429, { error: "操作过于频繁，请稍后再试" });
      }
      const record = codex.pendingServerRequests(threadRoute.threadId)
        .find((item) => item.token === threadRoute.requestToken);
      if (!record) return sendJson(response, 404, { error: "这个审批请求已经失效" });
      if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(record.message.method)) {
        return sendJson(response, 409, { error: "手机端暂不支持处理这个请求" });
      }
      const { decision } = parseApprovalPayload(await readJson(request, 2_048));
      codex.respondToServerRequest(threadRoute.requestToken, { decision });
      schedulePoll(10);
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "GET" && pathname === "/api/events") {
      request.socket.setNoDelay(true);
      response.writeHead(200, commonHeaders({
        "Content-Type": "text/event-stream; charset=utf-8",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      }));
      response.flushHeaders?.();
      response.write("retry: 2000\n\n");
      const client = {
        response,
        threadId: url.searchParams.get("threadId") || "",
        threadHash: "",
      };
      clients.add(client);
      sseSend(client, "threads", latestThreads);
      sseSend(client, "status", { state: codexState, error: codexError });
      for (const liveMessage of codex.liveAgentMessagesForThread(client.threadId)) {
        sseSend(client, liveMessage.event, liveMessage.value);
      }
      schedulePoll(10);
      request.on("close", () => clients.delete(client));
      return;
    }

    if (request.method === "GET" && !pathname.startsWith("/api/")) {
      return serveStatic(response, pathname);
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    let status = Number(error.status) || 500;
    let message = error.message || "Internal server error";
    if (error.code === "TURN_ACTIVE") {
      status = 409;
      message = "Codex 正在处理这个会话，请完成后再发送";
    } else if (error.code === "REQUEST_NOT_FOUND") {
      status = 404;
      message = "这个审批请求已经失效";
    } else if (error.code === "REQUEST_RESOLVING") {
      status = 409;
      message = "这个审批正在处理中";
    }
    sendJson(response, status, { error: message });
  }
});

server.listen(PORT, HOST, async () => {
  const localUrl = `http://${HOST}:${PORT}/`;
  await fs.writeFile(path.join(DATA_DIR, "local-url.txt"), `${localUrl}\n`, "utf8");
  console.log(`Codex Pocket: ${localUrl}`);
  console.log("Use the access key from the desktop controller to sign in.");
  codex.start().catch((error) => {
    codexState = "error";
    codexError = error.message;
  });
  schedulePoll(50);
});

function shutdown() {
  if (pollTimer) clearTimeout(pollTimer);
  codex.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
