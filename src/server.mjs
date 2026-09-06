import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "./codex-client.mjs";
import { CodexDesktopBridge } from "./codex-desktop-bridge.mjs";
import { readSharedConfig } from "./shared-runtime.mjs";
import { desktopConnectionMonitor } from "./desktop-connection.mjs";
import {
  isDesktopWriterConflict,
  continuationRequired,
  startTurnWithDesktopFallback,
} from "./desktop-delivery.mjs";
import { ImageStore, MAX_IMAGE_BYTES } from "./image-store.mjs";
import { boundedInteger, loopbackHost } from "./runtime-config.mjs";
import { createProject, listProjects, updateProject, managementName, managementError } from "./management.mjs";
import {
  collectTrackedThreadIds,
  parseGoalPayload,
  parseMessagePayload,
  parseThreadCreatePayload,
  resolveMessageDispatch,
  sanitizeServerRequest,
} from "./control.mjs";
import { parseServerRequestResponse } from "./user-requests.mjs";
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
const IMAGE_DIR = path.join(DATA_DIR, "images");
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
const DESKTOP_SEND_UNAVAILABLE = continuationRequired().message;
const DESKTOP_STEER_UNAVAILABLE = "这个任务正在 Codex Desktop 中执行，Web 端目前无法可靠 Steer。请回到 Codex Desktop 操作";
const DESKTOP_INTERRUPT_UNAVAILABLE = "这个任务正在 Codex Desktop 中执行，Web 端目前无法可靠中断。请回到 Codex Desktop 操作";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

await fs.mkdir(DATA_DIR, { recursive: true });
const imageStore = new ImageStore(IMAGE_DIR);
await imageStore.init();
const threadImageOptions = {
  resolveImage: (source) => imageStore.registerThreadImage(source),
};
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

const sharedConfig = process.env.POCKET_SHARED_SERVER === "off" || process.env.CODEX_APP_SERVER_WS_URL
  ? null : await readSharedConfig();
const websocketUrl = process.env.CODEX_APP_SERVER_WS_URL || sharedConfig?.url || "";
const connectionMode = websocketUrl ? "shared" : "standalone";
const desktopConnection = desktopConnectionMonitor(websocketUrl);
function connectionStatus() {
  // Desktop process inspection is stale-while-revalidate so health/sync never
  // waits for ps/lsof or PowerShell to finish.
  return { state: codexState, error: codexError, connectionMode, desktopConnection: desktopConnection() };
}
const codex = new CodexAppServer({ websocketUrl });
const desktopBridge = new CodexDesktopBridge();
const webContinuations = new Map();
let codexState = "starting";
let codexError = "";
const queuedTurns = new Map();
const queueEvents = new Map();
let nextQueueEventId = 1;
const drainingQueuedThreads = new Set();
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
codex.on("control", ({ threadId } = {}) => {
  schedulePoll(10);
});

const clients = new Set();
let pollTimer = null;
let pollDueAt = 0;
let polling = false;
let desktopPollTimer = null;
let desktopPollDueAt = 0;
let desktopPolling = false;
let latestThreads = [];
let latestThreadsHash = "";
let latestProjects = [];
let projectsSupported = true;
let latestProjectsHash = "";
const managementMutations = new Set();
let shuttingDown = false;
let pollFailures = 0;
const threadLoads = new Map();
const pollingThreads = new Set();
const httpWatches = new Map();
const desktopSnapshots = new Map();

function commonHeaders(extra = {}) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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

async function readBodyBuffer(request, limit = 4_096) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    const error = new Error("请求内容过大");
    error.status = 413;
    throw error;
  }
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
  return Buffer.concat(chunks);
}

async function readBody(request, limit = 4_096) {
  return (await readBodyBuffer(request, limit)).toString("utf8");
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
  if (event === "queueStarted" || event === "queueFailed") {
    value = { ...value, eventId: nextQueueEventId++ };
    queueEvents.delete(value.threadId);
    queueEvents.set(value.threadId, { event, value });
    if (queueEvents.size > 128) queueEvents.delete(queueEvents.keys().next().value);
  }
  for (const client of clients) {
    if (client.threadId === value.threadId) sseSend(client, event, value);
  }
}

codex.on("messageStart", (value) => broadcastMessageEvent("messageStart", value));
codex.on("messageDelta", (value) => broadcastMessageEvent("messageDelta", value));
codex.on("messageDone", (value) => broadcastMessageEvent("messageDone", value));

async function loadThreads() {
  const result = await codex.listThreads();
  if (projectsSupported) {
    try { latestProjects = await listProjects(codex); }
    catch (error) {
      if (error.code !== -32601 && !/unknown method|method not found|experimental.*required/i.test(error.message)) throw error;
      projectsSupported = false;
    }
  }
  codexState = "ready";
  codexError = "";
  const data = Array.isArray(result?.data) ? result.data : [];
  return data
    .filter((thread) => thread && typeof thread === "object" && typeof thread.id === "string")
    .map(sidebarThread);
}

function sidebarThread(value) {
  const summary = sanitizeThreadSummary(value);
  const project = latestProjects.find((item) => item.id === summary.projectId)
    || (!summary.projectId && latestProjects.find((item) => item.roots.some((root) => path.normalize(root) === path.normalize(value.cwd || ""))));
  return project ? { ...summary, project: project.name, projectId: project.id } : summary;
}

function desktopMutationError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}

function publicQueuedTurn(value) {
  if (!value) return null;
  return {
    id: value.clientMessageId,
    clientMessageId: value.clientMessageId || "",
    text: value.text,
    skillNames: value.skillNames,
    images: value.imageIds.map((id) => ({
      src: `/api/images/${encodeURIComponent(id)}`,
      alt: "上传的图片",
    })),
    queuedAt: value.queuedAt,
    error: value.error || "",
    editing: Boolean(value.editing),
  };
}

function pocketThreadControlState(threadId) {
  const queue = (queuedTurns.get(threadId) || []).map(publicQueuedTurn);
  return {
    ...codex.threadControlState(threadId),
    queued: queue.length > 0,
    queue,
  };
}

function observeQueuedTurn(threadId, thread) {
  const queued = queuedTurns.get(threadId)?.[0];
  if (!queued) return false;
  queued.ready = !thread.control?.busy && thread.turns?.at(-1)?.status === "completed" && !queued.error;
  void drainQueuedTurn(threadId);
  return true;
}

function removeQueuedTurn(threadId, queued) {
  const remaining = (queuedTurns.get(threadId) || []).filter((item) => item !== queued);
  if (remaining.length) queuedTurns.set(threadId, remaining);
  else queuedTurns.delete(threadId);
}

async function drainQueuedTurn(threadId) {
  const queued = queuedTurns.get(threadId)?.[0];
  if (
    !queued
    || queued.editing
    || !queued.ready
    || drainingQueuedThreads.has(threadId)
    || codex.isThreadBusy(threadId)
  ) {
    return false;
  }

  drainingQueuedThreads.add(threadId);
  try {
    const { result } = await startTurnWithDesktopFallback({
      codex,
      desktopBridge,
      threadId,
      text: queued.text,
      options: queued.options,
      transformOptions: threadImageOptions,
    });
    removeQueuedTurn(threadId, queued);
    broadcastMessageEvent("queueStarted", {
      threadId,
      clientMessageId: queued.clientMessageId || "",
      turnId: result.turn?.id || null,
      control: pocketThreadControlState(threadId),
    });
    schedulePoll(10);
    scheduleDesktopPoll(0);
    return true;
  } catch (error) {
    if (error.code === "TURN_ACTIVE") return false;
    queued.ready = false;
    queued.error = error.message || "等待消息发送失败";
    broadcastMessageEvent("queueFailed", {
      threadId,
      code: isDesktopWriterConflict(error) ? "THREAD_CONTINUATION_REQUIRED" : error.code,
      clientMessageId: queued.clientMessageId || "",
      control: pocketThreadControlState(threadId),
      message: isDesktopWriterConflict(error)
        ? DESKTOP_SEND_UNAVAILABLE
        : error.message || "等待消息发送失败",
    });
    schedulePoll(10);
    return false;
  } finally {
    drainingQueuedThreads.delete(threadId);
  }
}

function loadThreadState(threadId) {
  if (!threadLoads.has(threadId)) {
    const pending = readThreadState(threadId).finally(() => threadLoads.delete(threadId));
    threadLoads.set(threadId, pending);
  }
  return threadLoads.get(threadId);
}

async function readThreadState(threadId) {
  try {
    const result = await codex.readThread(threadId);
    if (!result?.thread?.id) throw new Error("Codex App Server 返回的会话快照无效");
    const thread = {
      ...sanitizeThreadDetail(result.thread, threadImageOptions),
      control: {
        ...pocketThreadControlState(threadId),
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
      const snapshot = sanitizeDesktopThreadSnapshot(desktopValue, threadImageOptions);
      const thread = {
        ...snapshot,
        control: {
          ...snapshot.control,
          queued: queuedTurns.has(threadId),
          queue: (queuedTurns.get(threadId) || []).map(publicQueuedTurn),
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
  if (shuttingDown) return;
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
  if (shuttingDown) return;
  if (polling) return schedulePoll();
  polling = true;
  try {
    if (!clients.size && !queuedTurns.size && codexState === "ready") return;
    const threads = await loadThreads();
    pollFailures = 0;
    const projectsHash = JSON.stringify(latestProjects);
    if (projectsHash !== latestProjectsHash) {
      latestProjectsHash = projectsHash;
      for (const client of clients) sseSend(client, "projects", latestProjects);
    }
    const threadsHash = JSON.stringify(threads);
    if (threadsHash !== latestThreadsHash) {
      latestThreads = threads;
      latestThreadsHash = threadsHash;
      for (const client of clients) sseSend(client, "threads", threads);
    }

    const watchedIds = collectTrackedThreadIds(clients, queuedTurns.keys());
    for (const threadId of watchedIds) {
      if (!pollingThreads.has(threadId)) void pollThread(threadId);
    }

    const status = await connectionStatus();
    for (const client of clients) sseSend(client, "status", status);
  } catch (error) {
    pollFailures += 1;
    codexState = "error";
    codexError = error.message;
    const status = await connectionStatus();
    for (const client of clients) sseSend(client, "status", status);
  } finally {
    polling = false;
    schedulePoll(pollFailures
      ? Math.min(30_000, POLL_INTERVAL_MS * 2 ** Math.min(pollFailures, 5))
      : clients.size || queuedTurns.size ? POLL_INTERVAL_MS : 15_000);
  }
}

async function pollThread(threadId) {
  pollingThreads.add(threadId);
  try {
    const { thread, agentMessages } = await loadThreadState(threadId);
    if (shuttingDown) return;
    const hash = JSON.stringify(thread);
    let broadcasted = false;
    for (const client of clients) {
      if (client.threadId === threadId && client.threadHash !== hash) {
        client.threadHash = hash;
        if (sseSend(client, "thread", thread)) broadcasted = true;
      }
    }
    if (broadcasted) codex.confirmLiveAgentMessageSnapshot(threadId, agentMessages);
    observeQueuedTurn(threadId, thread);
  } catch (error) {
    for (const client of clients) {
      if (client.threadId === threadId) sseSend(client, "threadError", { message: error.message });
    }
  } finally {
    pollingThreads.delete(threadId);
  }
}

function scheduleDesktopPoll(delay = DESKTOP_SYNC_INTERVAL_MS) {
  if (shuttingDown || codex.websocketUrl) return;
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
  if (shuttingDown) return;
  if (desktopPolling) return scheduleDesktopPoll();
  for (const [threadId, timestamp] of httpWatches) {
    if (Date.now() - timestamp > 15_000) httpWatches.delete(threadId);
  }
  const watchedIds = [...new Set([
    ...[...clients].map((client) => client.threadId).filter(Boolean), ...httpWatches.keys(),
  ])];
  for (const threadId of desktopSnapshots.keys()) {
    if (!watchedIds.includes(threadId)) desktopSnapshots.delete(threadId);
  }
  if (!watchedIds.length) return scheduleDesktopPoll(1_000);

  desktopPolling = true;
  let nextDelay = DESKTOP_SYNC_INTERVAL_MS;
  try {
    const results = await Promise.all(watchedIds.map(async (threadId) => {
      try {
        const value = await desktopBridge.readThread(threadId);
        return {
          threadId,
          snapshot: sanitizeDesktopThreadSnapshot(value, threadImageOptions),
        };
      } catch (error) {
        return { threadId, error };
      }
    }));

    for (const { threadId, snapshot, error } of results) {
      if (error) {
        desktopSnapshots.delete(threadId);
        if ([
          "DESKTOP_BRIDGE_UNAVAILABLE",
          "DESKTOP_BRIDGE_TOOL_UNAVAILABLE",
        ].includes(error.code)) nextDelay = Math.max(nextDelay, 3_000);
        else nextDelay = Math.max(nextDelay, 750);
        continue;
      }

      const hash = JSON.stringify(snapshot);
      desktopSnapshots.set(threadId, snapshot);
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

function enforceActionRateLimit(request) {
  const address = request.socket.remoteAddress || "unknown";
  if (actionLimiter.allow(address)) return;
  const error = new Error("操作过于频繁，请稍后再试");
  error.status = 429;
  throw error;
}

function parseThreadRoute(pathname) {
  const match = pathname.match(/^\/api\/threads\/([^/]+)(?:\/(messages|queue|interrupt|approvals|goal|permissions|rename|archive|restore|continue)(?:\/([^/]+))?)?$/);
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
  return method === "POST" && ["messages", "queue", "interrupt", "approvals", "permissions", "rename", "archive", "restore", "continue"].includes(route.action);
}

async function prepareGoalForTurn(threadId, message, selection, goal, dispatch) {
  if (dispatch === "steer" || selection.mode !== "goal" || goal?.status === "active") {
    return goal;
  }
  if (goal?.status === "paused") {
    return publicGoal(await codex.setGoal(threadId, { status: "active" }));
  }
  if (!message.text) {
    const error = new Error("目标模式需要输入目标内容，不能只发送图片");
    error.status = 400;
    throw error;
  }
  return publicGoal(await codex.setGoal(threadId, {
    objective: message.text,
    status: "active",
  }));
}

async function prepareTurn(threadId, message) {
  const statePromise = loadThreadState(threadId);
  const [{ thread: current }, catalog] = await Promise.all([
    statePromise,
    loadComposerCatalog(
      threadId,
      statePromise.then((state) => state.catalogThread),
    ),
  ]);
  const selection = resolveComposerSelection(message, catalog);
  const dispatch = resolveMessageDispatch(message.action || "start", current);
  const images = await imageStore.resolveUploads(message.imageIds || []);
  const goal = await prepareGoalForTurn(
    threadId,
    message,
    selection,
    catalog.goal,
    dispatch,
  );

  return {
    current,
    dispatch,
    goal,
    images,
    selection,
    options: {
      ...selection,
      images,
      clientMessageId: message.clientMessageId,
      mode: selection.mode === "goal" ? "default" : selection.mode,
    },
  };
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/api/health") {
      return sendJson(response, 200, { ok: true, codex: codexState, ...await connectionStatus() });
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

    if (request.method === "POST" && pathname === "/api/uploads") {
      enforceActionRateLimit(request);
      const data = await readBodyBuffer(request, MAX_IMAGE_BYTES);
      const image = await imageStore.saveUpload(data, {
        fileName: request.headers["x-file-name"],
        contentType: request.headers["content-type"],
      });
      return sendJson(response, 201, { ok: true, image });
    }

    const uploadRoute = pathname.match(/^\/api\/uploads\/(img_[a-f0-9]{32})$/);
    if (request.method === "DELETE" && uploadRoute) {
      const removed = await imageStore.removeUpload(uploadRoute[1]);
      return sendJson(response, removed ? 200 : 404, removed
        ? { ok: true }
        : { error: "图片附件已失效" });
    }

    const imageRoute = pathname.match(/^\/api\/images\/([a-z]+_[a-f0-9]{32})$/);
    if (request.method === "GET" && imageRoute) {
      const image = await imageStore.readImage(imageRoute[1]);
      response.writeHead(200, commonHeaders({
        "Content-Type": image.mimeType,
        "Content-Length": String(image.data.length),
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": "inline",
        "Cross-Origin-Resource-Policy": "same-origin",
      }));
      response.end(image.data);
      return;
    }

    if (request.method === "GET" && pathname === "/api/bootstrap") {
      const threads = await loadThreads();
      latestThreads = threads;
      latestThreadsHash = JSON.stringify(threads);
      return sendJson(response, 200, {
        status: await connectionStatus(),
        transports: ["sse", "poll"],
        projects: latestProjects,
        projectsSupported,
        threads,
      });
    }

    if (request.method === "GET" && pathname === "/api/sync") {
      const threadId = url.searchParams.get("threadId") || "";
      if (threadId) httpWatches.set(threadId, Date.now());
      const [threads, state] = await Promise.all([
        loadThreads(), threadId ? loadThreadState(threadId) : null,
      ]);
      const events = [{ event: "projects", value: latestProjects }, { event: "threads", value: threads }];
      if (state) {
        const queued = queueEvents.get(threadId);
        if (queued) events.push(queued);
        events.push({ event: "desktopThread", value: desktopSnapshots.get(threadId) || null });
        events.push({ event: "thread", value: state.thread });
        codex.confirmLiveAgentMessageSnapshot(threadId, state.agentMessages);
        events.push(...codex.liveAgentMessagesForThread(threadId));
      }
      events.push({ event: "status", value: await connectionStatus() });
      return sendJson(response, 200, { events });
    }

    if (request.method === "GET" && pathname === "/api/projects") {
      await loadThreads();
      return sendJson(response, 200, { projects: latestProjects, projectsSupported });
    }
    if (request.method === "POST" && pathname === "/api/projects") {
      enforceActionRateLimit(request);
      const project = await createProject(codex, await readJson(request, 8_192));
      schedulePoll(0);
      return sendJson(response, 201, { project });
    }
    const projectRoute = pathname.match(/^\/api\/projects\/([^/]+)\/(rename|archive|restore)$/);
    if (request.method === "POST" && projectRoute) {
      enforceActionRateLimit(request);
      const projectId = decodeURIComponent(projectRoute[1]);
      if (managementMutations.has(projectId)) throw managementError(409, "项目正在更新，请稍后重试");
      const value = await readJson(request, 2_048);
      managementMutations.add(projectId);
      try {
        const project = await updateProject(codex, projectId, projectRoute[2], value);
        schedulePoll(0);
        return sendJson(response, 200, { project });
      } finally { managementMutations.delete(projectId); }
    }
    if (request.method === "GET" && pathname === "/api/threads") {
      const archived = url.searchParams.get("archived") === "true";
      const page = await codex.listThreads({ archived, limit: 100, cursor: url.searchParams.get("cursor") || undefined });
      return sendJson(response, 200, { threads: page.data.map(sidebarThread), nextCursor: page.nextCursor || null });
    }
    if (request.method === "POST" && pathname === "/api/threads") {
      enforceActionRateLimit(request);
      const value = await readJson(request, 2_048);
      let cwd, projectId;
      if (typeof value?.projectId === "string" && value.projectId) {
        const { project } = await codex.request("project/read", { projectId: value.projectId });
        if (project.metadata?.["codexPocket.archived"] === "true") throw managementError(409, "请先恢复项目");
        cwd = project.roots?.[0]?.path;
        projectId = project.id;
      } else {
        const { projectThreadId } = parseThreadCreatePayload(value);
        const source = await codex.readThread(projectThreadId, { includeTurns: false });
        cwd = source.thread?.cwd;
        projectId = source.thread?.projectId;
      }
      if (typeof cwd !== "string" || !cwd.trim()) {
        const error = new Error("无法读取这个项目的工作目录");
        error.status = 409;
        throw error;
      }
      const result = await codex.startThread({ cwd, projectId });
      if (!result.thread?.id) throw new Error("Codex 未返回新会话");
      const thread = sidebarThread(result.thread);
      schedulePoll(0);
      return sendJson(response, 201, { ok: true, thread });
    }

    const threadRoute = parseThreadRoute(pathname);
    if (isThreadMutation(request.method, threadRoute)) {
      enforceActionRateLimit(request);
    }
    if (request.method === "GET" && threadRoute && !threadRoute.action) {
      return sendJson(response, 200, await loadThreadPage(threadRoute.threadId));
    }

    if (request.method === "POST" && threadRoute?.action === "continue" && !threadRoute.requestToken) {
      await readJson(request, 2_048);
      const { threadId } = threadRoute;
      if (!webContinuations.has(threadId)) {
        const pending = (async () => {
          const { thread } = await loadThreadState(threadId);
          if (thread.control?.busy || queuedTurns.has(threadId)) {
            throw managementError(409, "请在当前任务结束后创建续接会话");
          }
          return codex.forkThread(threadId);
        })();
        webContinuations.set(threadId, pending);
        pending.catch(() => webContinuations.delete(threadId));
      }
      const result = await webContinuations.get(threadId);
      if (webContinuations.size > 128) webContinuations.delete(webContinuations.keys().next().value);
      schedulePoll(0);
      return sendJson(response, 201, { ok: true, thread: sidebarThread(result.thread) });
    }

    if (request.method === "POST" && ["rename", "archive", "restore"].includes(threadRoute?.action) && !threadRoute.requestToken) {
      const { threadId, action } = threadRoute;
      const value = await readJson(request, 2_048);
      if (managementMutations.has(threadId)) throw managementError(409, "会话正在更新，请稍后重试");
      managementMutations.add(threadId);
      try {
        if (action === "archive") {
          const state = await loadThreadState(threadId);
          if (state.thread.control?.busy || queuedTurns.has(threadId)) throw managementError(409, "请在任务和等待消息处理完成后归档");
          await codex.request("thread/archive", { threadId });
        } else if (action === "restore") await codex.request("thread/unarchive", { threadId });
        else {
          const name = managementName(value?.name);
          await codex.request("thread/name/set", { threadId, name });
          const draft = codex.newThreads.get(threadId);
          if (draft) codex.newThreads.set(threadId, { ...draft, name });
        }
        if (action === "archive") codex.newThreads.delete(threadId);
        schedulePoll(0);
        return sendJson(response, 200, { ok: true });
      } catch (error) {
        if (action === "archive" && /no rollout found|not materialized/i.test(error.message)) throw managementError(409, "该会话尚无历史内容，发送第一条消息后可以归档");
        throw error;
      } finally { managementMutations.delete(threadId); }
    }

    if (request.method === "POST" && threadRoute?.action === "permissions" && !threadRoute.requestToken) {
      const { threadId } = threadRoute;
      const value = await readJson(request, 2_048);
      const state = await loadThreadState(threadId);
      if (state.thread.control?.busy || queuedTurns.has(threadId)) {
        const error = new Error("请在当前任务结束后更改权限");
        error.status = 409;
        throw error;
      }
      const catalog = await codex.readPermissions(threadId, state.catalogThread?.cwd);
      const permissions = await codex.updatePermissions(threadId, value?.mode, catalog);
      return sendJson(response, 200, { permissions });
    }

    if (request.method === "POST" && threadRoute?.action === "queue" && threadRoute.requestToken) {
      const { threadId, requestToken: messageId } = threadRoute;
      const payload = await readJson(request, 65_536);
      const { action } = payload;
      if (!["remove", "send", "edit", "update", "cancelEdit"].includes(action)) throw managementError(400, "等待消息操作无效");
      if (drainingQueuedThreads.has(threadId)) throw managementError(409, "等待消息正在发送，请稍后重试");
      const queued = queuedTurns.get(threadId)?.find((item) => item.clientMessageId === messageId);
      if (!queued) throw managementError(404, "这条等待消息已发送或取消");
      if (action === "remove") removeQueuedTurn(threadId, queued);
      else if (action === "edit") queued.editing = true;
      else if (action === "update") {
        if (!queued.editing) throw managementError(409, "这条消息的编辑已结束，请重新打开编辑");
        const { text } = parseMessagePayload({ text: payload.text });
        if (!text && !queued.imageIds.length) throw managementError(400, "消息不能为空");
        queued.text = text;
        queued.editing = false;
        queued.error = "";
      } else if (action === "cancelEdit") queued.editing = false;
      else {
        if (queued.editing) throw managementError(409, "请先保存或取消消息编辑");
        drainingQueuedThreads.add(threadId);
        try {
          await loadThreadState(threadId);
          const result = codex.isThreadBusy(threadId)
            ? await codex.steerTurn(threadId, queued.text, queued.options)
            : (await startTurnWithDesktopFallback({ codex, desktopBridge, threadId, text: queued.text,
              options: queued.options, transformOptions: threadImageOptions })).result;
          removeQueuedTurn(threadId, queued);
          broadcastMessageEvent("queueStarted", { threadId, clientMessageId: messageId,
            turnId: result.turn?.id || result.turnId || null, control: pocketThreadControlState(threadId) });
        } finally { drainingQueuedThreads.delete(threadId); }
      }
      schedulePoll(0);
      return sendJson(response, 200, { control: pocketThreadControlState(threadId) });
    }

    if (request.method === "POST" && threadRoute?.action === "messages" && !threadRoute.requestToken) {
      const message = parseMessagePayload(await readJson(request));
      const prepared = await prepareTurn(threadRoute.threadId, message);
      const { current, dispatch, goal, selection } = prepared;

      if (dispatch === "queue") {
        const queued = {
          text: message.text,
          imageIds: message.imageIds || [],
          clientMessageId: message.clientMessageId || randomUUID(),
          skillNames: selection.skills.map((skill) => skill.name),
          queuedAt: Math.floor(Date.now() / 1_000),
          ready: false,
          options: prepared.options,
        };
        queued.options.clientMessageId = queued.clientMessageId;
        queuedTurns.set(threadRoute.threadId, [...(queuedTurns.get(threadRoute.threadId) || []), queued]);
        queueEvents.delete(threadRoute.threadId);
        imageStore.commitUploads(message.imageIds || []);
        schedulePoll(10);
        return sendJson(response, 202, {
          ok: true,
          delivery: "queued",
          turnId: null,
          selection: {
            model: selection.model,
            effort: selection.effort,
            mode: selection.mode,
            skillNames: queued.skillNames,
          },
          goal,
          control: {
            ...pocketThreadControlState(threadRoute.threadId),
            requests: current.control.requests || [],
          },
        });
      }

      let result;
      let delivery = "app-server";
      try {
        if (dispatch === "steer") {
          result = await codex.steerTurn(threadRoute.threadId, message.text, {
            ...prepared.options,
            turnId: message.expectedTurnId || current.control.turnId,
          });
          delivery = "steered";
        } else {
          const started = await startTurnWithDesktopFallback({
            codex,
            desktopBridge,
            threadId: threadRoute.threadId,
            text: message.text,
            options: prepared.options,
            transformOptions: threadImageOptions,
          });
          result = started.result;
          delivery = started.delivery;
        }
      } catch (error) {
        if (!isDesktopWriterConflict(error)) throw error;
        throw desktopMutationError(DESKTOP_STEER_UNAVAILABLE, "DESKTOP_WRITER_CONFLICT");
      }
      imageStore.commitUploads(message.imageIds || []);
      queueEvents.delete(threadRoute.threadId);
      schedulePoll(10);
      scheduleDesktopPoll(0);
      return sendJson(response, 202, {
        ok: true,
        delivery,
        turnId: result.turn?.id
          || message.expectedTurnId
          || current.control.turnId
          || null,
        selection: {
          model: selection.model,
          effort: selection.effort,
          mode: selection.mode,
          skillNames: selection.skills.map((skill) => skill.name),
        },
        goal,
        control: {
          ...pocketThreadControlState(threadRoute.threadId),
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
          threadImageOptions,
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
      if (!record) return sendJson(response, 404, { error: "这个请求已经处理或已失效" });
      const result = parseServerRequestResponse(record, await readJson(request, 65_536));
      codex.respondToServerRequest(threadRoute.requestToken, result);
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
      const heartbeat = setInterval(() => {
        sseSend(client, "heartbeat", { timestamp: Date.now() });
      }, 15000);
      heartbeat.unref();
      response.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(client);
      });
      sseSend(client, "threads", latestThreads);
      sseSend(client, "projects", latestProjects);
      sseSend(client, "status", await connectionStatus());
      for (const liveMessage of codex.liveAgentMessagesForThread(client.threadId)) {
        sseSend(client, liveMessage.event, liveMessage.value);
      }
      schedulePoll(10);
      scheduleDesktopPoll(0);
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
    } else if (error.code === "DESKTOP_BRIDGE_DELIVERY_UNKNOWN") {
      status = 504;
      message = error.message;
    } else if (/already has an active writer/i.test(message)) {
      status = 409;
      message = DESKTOP_SEND_UNAVAILABLE;
      error.code = "THREAD_CONTINUATION_REQUIRED";
    } else if (error.code === "REQUEST_NOT_FOUND") {
      status = 404;
      message = "这个审批请求已经失效";
    } else if (error.code === "REQUEST_RESOLVING") {
      status = 409;
      message = "这个审批正在处理中";
    }
    sendJson(response, status, { error: message, code: error.code });
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
  const localUrl = `http://${HOST === "::1" ? "[::1]" : HOST}:${PORT}/`;
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
