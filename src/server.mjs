import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-client.mjs";
import { CodexDesktopBridge } from "./codex-desktop-bridge.mjs";
import { boundedInteger, loopbackHost } from "./runtime-config.mjs";
import {
  parseApprovalPayload,
  parseGoalPayload,
  parseMessagePayload,
  sanitizeServerRequest,
} from "./control.mjs";
import {
  normalizeComposerCatalog,
  publicComposerCatalog,
  publicGoal,
  resolveComposerSelection,
} from "./composer-options.mjs";
import {
  sanitizeDesktopThreadSnapshot,
  sanitizeThreadDetail,
  sanitizeThreadSummary,
} from "./transform.mjs";
import {
  FixedWindowRateLimiter,
  SESSION_COOKIE,
  createAccessToken,
  normalizeAccessToken,
  requestToken,
  safeTokenEqual,
} from "./security.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.RELAY_DATA_DIR || path.join(ROOT, ".data"));
const HOST = loopbackHost(process.env.HOST);
const PORT = boundedInteger(process.env.PORT, 4_173, { min: 1, max: 65_535 });
const POLL_INTERVAL_MS = boundedInteger(
  process.env.POLL_INTERVAL_MS,
  1_200,
  { min: 700, max: 60_000 },
);
const DESKTOP_SYNC_INTERVAL_MS = boundedInteger(
  process.env.DESKTOP_SYNC_INTERVAL_MS,
  250,
  { min: 150, max: 10_000 },
);
const MAX_SSE_BUFFER_BYTES = 512 * 1024;
const DESKTOP_SEND_UNAVAILABLE = "这个任务正由 Codex Desktop 占用，Web 端无法可靠写入。请完全退出 Codex Desktop（Codex Pocket 控制器可以继续运行），然后重试";
const DESKTOP_INTERRUPT_UNAVAILABLE = "这个任务正在 Codex Desktop 中执行，Web 端目前无法可靠中断。请回到 Codex Desktop 操作";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

await fs.mkdir(DATA_DIR, { recursive: true });
const tokenPath = path.join(DATA_DIR, "access-token");
let accessToken = normalizeAccessToken(process.env.CODEX_RELAY_TOKEN);
if (!accessToken) {
  try {
    accessToken = normalizeAccessToken(await fs.readFile(tokenPath, "utf8"));
  } catch {
    // Missing or unreadable development tokens are replaced below.
  }
  if (!accessToken) {
    accessToken = createAccessToken();
    await fs.writeFile(tokenPath, `${accessToken}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

const codex = new CodexAppServer();
const desktopBridge = new CodexDesktopBridge();
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
let pollDueAt = 0;
let polling = false;
let desktopPollTimer = null;
let desktopPollDueAt = 0;
let desktopPolling = false;
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
  if (response.destroyed || response.writableEnded) return false;
  if (response.headersSent) {
    response.destroy();
    return false;
  }
  response.writeHead(status, commonHeaders({ "Content-Type": "application/json; charset=utf-8", ...headers }));
  response.end(JSON.stringify(value));
  return true;
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
  const { response } = client;
  if (response.destroyed || response.writableEnded) {
    clients.delete(client);
    return false;
  }
  const payload = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  if ((response.writableLength || 0) + Buffer.byteLength(payload) > MAX_SSE_BUFFER_BYTES) {
    clients.delete(client);
    response.destroy();
    return false;
  }
  try {
    response.write(payload);
    return true;
  } catch {
    clients.delete(client);
    response.destroy();
    return false;
  }
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
  const data = Array.isArray(result?.data) ? result.data : [];
  return data
    .filter((thread) => thread && typeof thread === "object" && typeof thread.id === "string")
    .map(sanitizeThreadSummary);
}

function isDesktopWriterConflict(error) {
  return /already has an active writer/i.test(String(error?.message || ""));
}

function desktopMutationError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

async function loadThreadState(threadId) {
  try {
    const result = await codex.readThread(threadId);
    if (!result?.thread?.id) throw new Error("Codex App Server 返回的会话快照无效");
    const thread = {
      ...sanitizeThreadDetail(result.thread),
      control: {
        ...codex.threadControlState(threadId),
        requests: codex.pendingServerRequests(threadId).map(sanitizeServerRequest),
      },
    };
    const turns = Array.isArray(result.thread.turns) ? result.thread.turns : [];
    const agentMessages = turns.flatMap((turn) =>
      (Array.isArray(turn?.items) ? turn.items : [])
        .filter((item) => item?.type === "agentMessage" && item.id)
        .map((item) => ({ id: item.id, role: "assistant", text: String(item.text ?? "") })),
    );
    return { thread, agentMessages, catalogThread: result.thread };
  } catch (appServerError) {
    try {
      const desktopValue = await desktopBridge.readThread(threadId, { turnLimit: 10 });
      const snapshot = sanitizeDesktopThreadSnapshot(desktopValue);
      const thread = {
        ...snapshot,
        control: {
          ...snapshot.control,
          requests: codex.pendingServerRequests(threadId).map(sanitizeServerRequest),
        },
      };
      const agentMessages = snapshot.messages
        .filter((message) =>
          message.role === "assistant"
          && ["message", "commentary"].includes(message.kind))
        .map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
        }));
      return { thread, agentMessages, catalogThread: desktopValue.thread };
    } catch {
      throw appServerError;
    }
  }
}

async function loadComposerCatalog(threadId, catalogThread = null) {
  return normalizeComposerCatalog(await codex.composerCatalog(threadId, {
    thread: catalogThread,
  }));
}

async function loadThreadPage(threadId) {
  const statePromise = loadThreadState(threadId);
  const catalogResult = loadComposerCatalog(
    threadId,
    statePromise.then((state) => state.catalogThread),
  ).then(
    (catalog) => ({ catalog }),
    (error) => ({ error }),
  );
  const [{ thread }, composer] = await Promise.all([statePromise, catalogResult]);
  if (composer.catalog) {
    const composerOptions = publicComposerCatalog(composer.catalog);
    return { ...thread, composerOptions };
  }
  return {
    ...thread,
    composerOptions: {
      models: [],
      skills: [],
      modes: ["default"],
      defaultModel: "",
      defaultEffort: "",
      goal: null,
      features: { plan: false, goal: false, skills: false },
      error: composer.error?.message || "无法读取 Codex 设置",
    },
  };
}

function schedulePoll(delay = POLL_INTERVAL_MS) {
  const dueAt = Date.now() + delay;
  if (pollTimer && pollDueAt <= dueAt) return;
  if (pollTimer) clearTimeout(pollTimer);
  pollDueAt = dueAt;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    pollDueAt = 0;
    void runPoll();
  }, Math.max(0, dueAt - Date.now()));
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

function scheduleDesktopPoll(delay = DESKTOP_SYNC_INTERVAL_MS) {
  const dueAt = Date.now() + delay;
  if (desktopPollTimer && desktopPollDueAt <= dueAt) return;
  if (desktopPollTimer) clearTimeout(desktopPollTimer);
  desktopPollDueAt = dueAt;
  desktopPollTimer = setTimeout(() => {
    desktopPollTimer = null;
    desktopPollDueAt = 0;
    void runDesktopPoll();
  }, Math.max(0, dueAt - Date.now()));
}

async function runDesktopPoll() {
  if (desktopPolling) return scheduleDesktopPoll();
  const watchedIds = [...new Set(
    [...clients].map((client) => client.threadId).filter(Boolean),
  )];
  if (!watchedIds.length) return scheduleDesktopPoll(1_000);

  desktopPolling = true;
  let nextDelay = DESKTOP_SYNC_INTERVAL_MS;
  try {
    const results = await Promise.all(watchedIds.map(async (threadId) => {
      try {
        const value = await desktopBridge.readThread(threadId);
        return { threadId, snapshot: sanitizeDesktopThreadSnapshot(value) };
      } catch (error) {
        return { threadId, error };
      }
    }));

    for (const { threadId, snapshot, error } of results) {
      if (error) {
        if ([
          "DESKTOP_BRIDGE_UNAVAILABLE",
          "DESKTOP_BRIDGE_TOOL_UNAVAILABLE",
        ].includes(error.code)) nextDelay = Math.max(nextDelay, 3_000);
        else nextDelay = Math.max(nextDelay, 750);
        continue;
      }

      const hash = JSON.stringify(snapshot);
      for (const client of clients) {
        if (client.threadId !== threadId || client.desktopThreadHash === hash) continue;
        client.desktopThreadHash = hash;
        sseSend(client, "desktopThread", snapshot);
      }
    }
  } finally {
    desktopPolling = false;
    scheduleDesktopPoll(nextDelay);
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

const sessionLimiter = new FixedWindowRateLimiter({ limit: 10 });
const actionLimiter = new FixedWindowRateLimiter({ limit: 24 });

function parseThreadRoute(pathname) {
  const match = pathname.match(/^\/api\/threads\/([^/]+)(?:\/(messages|interrupt|approvals|goal)(?:\/([^/]+))?)?$/);
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

function isThreadMutation(method, route) {
  if (!route?.action) return false;
  if (route.action === "goal") return ["POST", "DELETE"].includes(method);
  return method === "POST" && ["messages", "interrupt", "approvals"].includes(route.action);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/api/health") {
      return sendJson(response, 200, { ok: true, codex: codexState });
    }

    if (request.method === "POST" && pathname === "/api/session") {
      const address = request.socket.remoteAddress || "unknown";
      if (!sessionLimiter.allow(address)) return sendJson(response, 429, { error: "Too many attempts" });
      await readBody(request);
      const token = requestToken(request);
      if (!safeTokenEqual(token, accessToken)) return sendJson(response, 401, { error: "访问密钥无效" });
      const forwardedProto = String(request.headers["x-forwarded-proto"] || "")
        .split(",")
        .some((value) => value.trim().toLowerCase() === "https");
      const secure = forwardedProto || process.env.FORCE_SECURE_COOKIE === "1";
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
    if (isThreadMutation(request.method, threadRoute)) {
      const address = request.socket.remoteAddress || "unknown";
      if (!actionLimiter.allow(address)) {
        return sendJson(response, 429, { error: "操作过于频繁，请稍后再试" });
      }
    }
    if (request.method === "GET" && threadRoute && !threadRoute.action) {
      return sendJson(response, 200, await loadThreadPage(threadRoute.threadId));
    }

    if (request.method === "POST" && threadRoute?.action === "messages" && !threadRoute.requestToken) {
      const message = parseMessagePayload(await readJson(request));
      const { text } = message;
      const statePromise = loadThreadState(threadRoute.threadId);
      const [{ thread: current }, catalog] = await Promise.all([
        statePromise,
        loadComposerCatalog(
          threadRoute.threadId,
          statePromise.then((state) => state.catalogThread),
        ),
      ]);
      if (current.status === "active" && !current.control.busy) {
        throw desktopMutationError(DESKTOP_SEND_UNAVAILABLE, "DESKTOP_WRITER_CONFLICT");
      }
      const selection = resolveComposerSelection(message, catalog);
      let goal = catalog.goal;
      if (selection.mode === "goal" && !["active", "paused"].includes(goal?.status)) {
        goal = publicGoal(await codex.setGoal(threadRoute.threadId, {
          objective: text,
          status: "active",
        }));
      } else if (selection.mode === "goal" && goal?.status === "paused") {
        goal = publicGoal(await codex.setGoal(threadRoute.threadId, { status: "active" }));
      }

      let result;
      let delivery;
      try {
        result = await codex.startTurn(threadRoute.threadId, text, {
          ...selection,
          mode: selection.mode === "goal" ? "default" : selection.mode,
        });
        delivery = "app-server";
      } catch (error) {
        if (!isDesktopWriterConflict(error)) throw error;
        throw desktopMutationError(DESKTOP_SEND_UNAVAILABLE, "DESKTOP_WRITER_CONFLICT");
      }
      schedulePoll(10);
      scheduleDesktopPoll(0);
      return sendJson(response, 202, {
        ok: true,
        delivery,
        turnId: result.turn?.id || null,
        selection: {
          model: selection.model,
          effort: selection.effort,
          mode: selection.mode,
          skillNames: selection.skills.map((skill) => skill.name),
        },
        goal,
        control: {
          ...codex.threadControlState(threadRoute.threadId),
          busy: true,
          phase: "starting",
        },
      });
    }

    if (request.method === "POST" && threadRoute?.action === "interrupt" && !threadRoute.requestToken) {
      await readJson(request, 2_048);
      const localControl = codex.threadControlState(threadRoute.threadId);
      let delivery;
      let interruption;
      let turnId = localControl.turnId;
      if (localControl.busy) {
        if (!turnId) {
          const error = new Error("Codex 正在启动这个任务，请稍后再中断");
          error.code = "TURN_STARTING";
          throw error;
        }
        await codex.interruptTurn(threadRoute.threadId, turnId);
        delivery = "app-server";
        interruption = "hard";
      } else {
        const snapshot = sanitizeDesktopThreadSnapshot(
          await desktopBridge.readThread(threadRoute.threadId),
        );
        if (!snapshot.control?.busy) {
          const error = new Error("当前没有正在执行的任务");
          error.code = "NO_ACTIVE_TURN";
          throw error;
        }
        turnId = snapshot.control.turnId || null;
        throw desktopMutationError(
          DESKTOP_INTERRUPT_UNAVAILABLE,
          "DESKTOP_INTERRUPT_UNAVAILABLE",
        );
      }

      schedulePoll(0);
      scheduleDesktopPoll(0);
      return sendJson(response, 202, {
        ok: true,
        delivery,
        interruption,
        turnId,
        control: {
          busy: true,
          phase: "interrupting",
          turnId,
        },
      });
    }

    if (threadRoute?.action === "goal" && !threadRoute.requestToken) {
      if (request.method === "POST") {
        const value = parseGoalPayload(await readJson(request));
        const goal = await codex.setGoal(threadRoute.threadId, value);
        return sendJson(response, 200, { ok: true, goal: publicGoal(goal) });
      }
      if (request.method === "DELETE") {
        const result = await codex.clearGoal(threadRoute.threadId);
        return sendJson(response, 200, { ok: true, cleared: Boolean(result.cleared) });
      }
    }

    if (request.method === "POST" && threadRoute?.action === "approvals" && threadRoute.requestToken) {
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
        desktopThreadHash: "",
      };
      clients.add(client);
      sseSend(client, "threads", latestThreads);
      sseSend(client, "status", { state: codexState, error: codexError });
      for (const liveMessage of codex.liveAgentMessagesForThread(client.threadId)) {
        sseSend(client, liveMessage.event, liveMessage.value);
      }
      schedulePoll(10);
      scheduleDesktopPoll(0);
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
    } else if (error.code === "TURN_STARTING") {
      status = 409;
      message = error.message;
    } else if (error.code === "NO_ACTIVE_TURN") {
      status = 409;
      message = "当前没有正在执行的任务";
    } else if ([
      "DESKTOP_WRITER_CONFLICT",
      "DESKTOP_INTERRUPT_UNAVAILABLE",
    ].includes(error.code)) {
      status = 409;
      message = error.message;
    } else if ([
      "DESKTOP_BRIDGE_CONNECTION",
      "DESKTOP_BRIDGE_TIMEOUT",
      "DESKTOP_BRIDGE_TOOL_UNAVAILABLE",
    ].includes(error.code)) {
      status = 503;
      message = "Codex App 连接暂时不可用，请重试";
    } else if (/already has an active writer/i.test(message)) {
      status = 409;
      message = DESKTOP_SEND_UNAVAILABLE;
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

server.headersTimeout = 15_000;
server.requestTimeout = 45_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;

server.on("error", (error) => {
  codexState = "error";
  codexError = error.message;
  console.error(`Codex Pocket server error: ${error.message}`);
  codex.stop();
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  const localUrl = `http://${HOST}:${PORT}/`;
  void fs.writeFile(path.join(DATA_DIR, "local-url.txt"), `${localUrl}\n`, "utf8")
    .catch((error) => console.error(`Unable to write local URL: ${error.message}`));
  console.log(`Codex Pocket: ${localUrl}`);
  console.log("Use the access key from the desktop controller to sign in.");
  codex.start().catch((error) => {
    codexState = "error";
    codexError = error.message;
  });
  schedulePoll(50);
  scheduleDesktopPoll(50);
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (pollTimer) clearTimeout(pollTimer);
  if (desktopPollTimer) clearTimeout(desktopPollTimer);
  for (const client of clients) {
    try {
      client.response.end();
    } catch {
      client.response.destroy();
    }
  }
  clients.clear();
  codex.stop();
  if (!server.listening) return process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
