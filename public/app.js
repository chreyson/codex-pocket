import { renderMarkdown } from "./markdown.js";
import { createRequestTray } from "./user-requests.js";

const bootScreen = document.querySelector("#boot-screen");
const authScreen = document.querySelector("#auth-screen");
const authForm = document.querySelector("#auth-form");
const authSubmit = document.querySelector("#auth-submit");
const authError = document.querySelector("#auth-error");
const tokenInput = document.querySelector("#token-input");
const app = document.querySelector("#app");
const threadList = document.querySelector("#thread-list");
const threadEmpty = document.querySelector("#thread-empty");
const threadEmptyTitle = document.querySelector("#thread-empty-title");
const threadEmptyDetail = document.querySelector("#thread-empty-detail");
const threadActionStatus = document.querySelector("#thread-action-status");
const threadSearch = document.querySelector("#thread-search");
const sidebarMenu = document.querySelector("#sidebar-menu");
const managementDialog = document.querySelector("#management-dialog");
const managementForm = document.querySelector("#management-form");
const managementNameInput = document.querySelector("#management-name");
const managementPathInput = document.querySelector("#management-path");
const managementError = document.querySelector("#management-error");
const managementSubmit = document.querySelector("#management-submit");
const archivedButton = document.querySelector("#archived-button");
const archivedMore = document.querySelector("#archived-more");
let projectCatalog = [];
let projectsSupported = false;
let viewingArchived = false;
let archivedThreads = [];
let archivedCursor = null;
let archivedLoading = false;
let selectedArchived = false;
let managementAction = null;
let managementPending = false;
let sidebarMenuTrigger = null;
const connectionState = document.querySelector("#connection-state");
const connectionLabel = document.querySelector("#connection-label");
const connectionModeWarning = document.querySelector("#connection-mode-warning");
const connectionModeCurrent = document.querySelector("#connection-mode-current");
const connectionModeAdvice = document.querySelector("#connection-mode-advice");
const conversationTitle = document.querySelector("#conversation-title");
const conversationMeta = document.querySelector("#conversation-meta");
const conversationActions = document.querySelector("#conversation-actions");
const conversationPlaceholder = document.querySelector("#conversation-placeholder");
const placeholderTitle = document.querySelector("#placeholder-title");
const placeholderDetail = document.querySelector("#placeholder-detail");
const messageList = document.querySelector("#message-list");
const approvalTray = document.querySelector("#approval-tray");
const requestTray = createRequestTray(approvalTray, respondToApproval);
const composer = document.querySelector("#composer");
const queuedMessageList = document.querySelector("#queued-message-list");
const queueMutations = new Set();
const queueEditDrafts = new Map();
let renderedQueueKey = "";
const continueWebButton = document.querySelector("#continue-web");
const continuationThreads = new Set();
const composerMenu = document.querySelector("#composer-menu");
const composerExtras = document.querySelector("#composer-extras");
const extrasSkills = document.querySelector("#extras-skills");
const extrasButton = document.querySelector("#extras-button");
const modeControl = document.querySelector("#mode-control");
const skillControl = document.querySelector("#skill-control");
const skillLabel = document.querySelector("#skill-label");
const skillCount = document.querySelector("#skill-count");
const selectedSkills = document.querySelector("#selected-skills");
const goalBanner = document.querySelector("#goal-banner");
const goalObjective = document.querySelector("#goal-objective");
const goalComplete = document.querySelector("#goal-complete");
const goalClear = document.querySelector("#goal-clear");
const composerImages = document.querySelector("#composer-images");
const imageInput = document.querySelector("#image-input");
const imageUploadButton = document.querySelector("#image-upload-button");
const messageInput = document.querySelector("#message-input");
const modelControl = document.querySelector("#model-control");
const modelLabel = document.querySelector("#model-label");
const permissionControl = document.querySelector("#permission-control");
const permissionLabel = document.querySelector("#permission-label");
const permissionUpdatingThreads = new Set();
const effortLabelNode = document.querySelector("#effort-label");
const composerStatus = document.querySelector("#composer-status");
const interruptButton = document.querySelector("#interrupt-button");
const sendButton = document.querySelector("#send-button");
const backButton = document.querySelector("#back-button");
const refreshButton = document.querySelector("#refresh-button");
const networkBanner = document.querySelector("#network-banner");
const networkMessage = document.querySelector("#network-message");
const reconnectButton = document.querySelector("#reconnect-button");
const latestButton = document.querySelector("#latest-button");
const imageViewer = document.querySelector("#image-viewer");
const imageViewerImage = document.querySelector("#image-viewer-image");
const imageViewerCaption = document.querySelector("#image-viewer-caption");
const imageViewerClose = document.querySelector("#image-viewer-close");
const imageViewerPrev = document.querySelector("#image-viewer-prev");
const imageViewerNext = document.querySelector("#image-viewer-next");

let threads = [];
let selectedThreadId = "";
let currentThread = null;
let eventSource = null;
let supportsPolling = false;
let usePolling = false;
let selectionEpoch = 0;
let pendingMessage = null;
const sendingThreads = new Set();
const interruptingThreads = new Set();
const interruptRequestThreads = new Set();
const deliveredMessageIds = new Set();
let composerError = "";
const collapsedProjects = new Set();
const openedProjects = new Set();
const expandedProjectLists = new Set();
const PROJECT_THREAD_PREVIEW_COUNT = 5;
const creatingProjects = new Set();
const expandedTurns = new Set();
const resolvingRequests = new Set();
const liveMessages = new Map();
const messageNodes = new Map();
const queuedMessageDeltas = new Map();
let deltaFrameId = null;
let desktopThreadSnapshot = null;
let composerCatalog = null;
let remoteComposerSignature = "";
let composerMenuKind = "";
let extrasSkillsExpanded = false;
let activeMessageArticle = null;
let goalUpdating = false;
let pendingImages = [];
const imageDrafts = new Map();
let nextPendingImageId = 1;
let viewerImages = [];
let viewerImageIndex = 0;
let transportState = "connecting";
let lastEventAt = Date.now();
let syncEpoch = 0;
let initialLoadEpoch = null;
let draftTimer = null;
let sidebarSignature = "";
const historyNodes = new Map();
const DRAFT_STORAGE_KEY = "codex-pocket-drafts-v1";
const LAST_THREAD_KEY = "codex-pocket-last-thread-v1";
const DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
const drafts = readDrafts();

function readDrafts() {
  try {
    const values = JSON.parse(globalThis.localStorage?.getItem(DRAFT_STORAGE_KEY) || "[]");
    return new Map((Array.isArray(values) ? values : []).filter((entry) =>
      Array.isArray(entry) && typeof entry[0] === "string"
      && typeof entry[1]?.text === "string" && entry[1].text.length <= 12000
      && Number.isFinite(entry[1].updatedAt) && Date.now() - entry[1].updatedAt < DRAFT_TTL
    ).slice(-30));
  } catch {
    return new Map();
  }
}

function writeDraft(threadId, text) {
  if (!threadId) return;
  drafts.delete(threadId);
  if (text) drafts.set(threadId, { text: text.slice(0, 12000), updatedAt: Date.now() });
  while (drafts.size > 30) drafts.delete(drafts.keys().next().value);
  try {
    globalThis.localStorage?.setItem(DRAFT_STORAGE_KEY, JSON.stringify([...drafts]));
  } catch {
    // The in-memory draft remains available when browser storage is unavailable.
  }
}

function saveDraft() {
  globalThis.clearTimeout?.(draftTimer);
  draftTimer = null;
  // Keep the submitted draft until the server acknowledges it.
  if (!sendingThreads.has(selectedThreadId)) writeDraft(selectedThreadId, messageInput.value);
}

function rememberThread(threadId) {
  try { globalThis.localStorage?.setItem(LAST_THREAD_KEY, threadId); } catch { /* Storage can be unavailable. */ }
}

function rememberedThread() {
  try { return globalThis.localStorage?.getItem(LAST_THREAD_KEY) || ""; } catch { return ""; }
}

function networkOffline() {
  return globalThis.navigator?.onLine === false;
}

function updateLatestButton() {
  if (latestButton) latestButton.hidden = !currentThread || messageList.hidden
    || !approvalTray.hidden || isFollowingOutput();
}

function scrollToLatest() {
  messageList.scrollTop = messageList.scrollHeight;
  updateLatestButton();
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_LIVE_MESSAGE_LENGTH = 80_000;
const REQUEST_TIMEOUT_MS = 35_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 4;
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
const COMPOSER_STORAGE_KEY = "codex-pocket-composer-v1";
const EFFORT_LABELS = {
  none: "无",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "超高",
  max: "最大",
  ultra: "Ultra",
};

function storedComposerSelection() {
  try {
    const value = JSON.parse(globalThis.localStorage?.getItem(COMPOSER_STORAGE_KEY) || "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const cleanString = (candidate) => typeof candidate === "string"
      ? candidate.replaceAll("\0", "").trim().slice(0, 160)
      : "";
    const mode = cleanString(value.mode);
    const skillNames = Array.isArray(value.skillNames)
      ? [...new Set(value.skillNames
        .map(cleanString)
        .filter(Boolean))].slice(0, 16)
      : [];
    return {
      model: cleanString(value.model),
      effort: cleanString(value.effort),
      mode: ["default", "plan", "goal"].includes(mode) ? mode : "default",
      skillNames,
    };
  } catch {
    return {};
  }
}

let composerSelection = {
  model: "",
  effort: "",
  mode: "default",
  skillNames: [],
  ...storedComposerSelection(),
};

function createIcon(paths) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  for (const value of paths) {
    const element = document.createElementNS(SVG_NAMESPACE, "path");
    element.setAttribute("d", value);
    svg.append(element);
  }
  return svg;
}

function createSidebarIcon(name) {
  const paths = name === "folder-open"
    ? ["m6 14 1.5-2.9a2 2 0 0 1 1.8-1.1H20a2 2 0 0 1 1.8 2.8l-2.6 6a2 2 0 0 1-1.8 1.2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v2"]
    : name === "folder"
    ? ["M20 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2 3h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2Z", "M2 10h20"]
    : name === "compose" ? ["M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7", "m16 3 5 5-9 9-5 1 1-5Z"]
    : name === "plus" ? ["M12 5v14", "M5 12h14"] : [];
  return createIcon(paths);
}

function fragmentToken() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return params.get("token") || "";
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const readResponse = async (signal) => {
    const response = await fetch(url, { ...options, signal });
    let body = {};
    try {
      body = (await response.json()) ?? {};
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      if (response.ok) throw new Error("服务返回了无效数据，请刷新后重试");
    }
    return { response, body };
  };
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await readResponse(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new Error("请求超时，请检查网络后重试");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function createSession(token) {
  const { response, body } = await fetchJsonWithTimeout("/api/session", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(body.error || "连接失败");
  }
}

async function requestJson(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const { response, body } = await fetchJsonWithTimeout(
    url,
    { cache: "no-store", ...options },
    timeoutMs,
  );
  if (response.status === 401) throw new Error("UNAUTHORIZED");
  if (!response.ok) throw Object.assign(new Error(body.error || `请求失败：${response.status}`), { code: body.code });
  return body;
}

function postJson(url, value) {
  return requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

function cancelQueuedMessageDeltas() {
  if (deltaFrameId !== null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(deltaFrameId);
  }
  deltaFrameId = null;
  queuedMessageDeltas.clear();
}

function resetLiveRendering() {
  clearActiveMessage();
  cancelQueuedMessageDeltas();
  liveMessages.clear();
  messageNodes.clear();
  historyNodes.clear();
  deliveredMessageIds.clear();
  desktopThreadSnapshot = null;
}

function resetTransientOperations() {
  continuationThreads.clear();
  sendingThreads.clear();
  interruptingThreads.clear();
  interruptRequestThreads.clear();
  creatingProjects.clear();
  resolvingRequests.clear();
  requestTray.clear();
  goalUpdating = false;
  composerError = "";
}

function showAuth(message = "") {
  selectedArchived = false;
  viewingArchived = false;
  archivedThreads = [];
  projectCatalog = [];
  if (sidebarMenu) closeSidebarMenu();
  if (managementDialog?.open) managementDialog.close();
  saveDraft();
  closeEvents();
  closeComposerMenu();
  closeImageViewer();
  discardPendingImages();
  for (const images of imageDrafts.values()) releaseImages(images);
  imageDrafts.clear();
  selectionEpoch += 1;
  resetLiveRendering();
  selectedThreadId = "";
  currentThread = null;
  pendingMessage = null;
  resetTransientOperations();
  composerCatalog = null;
  threadActionStatus.hidden = true;
  threadActionStatus.textContent = "";
  app.classList.remove("conversation-open");
  messageList.replaceChildren();
  approvalTray.replaceChildren();
  approvalTray.hidden = true;
  conversationTitle.textContent = "选择一个会话";
  conversationTitle.title = "";
  conversationActions.open = false;
  conversationMeta.textContent = "连接到电脑上的 Codex";
  setConversationPlaceholder("继续工作", "Codex Pocket");
  updateComposer();
  bootScreen.hidden = true;
  app.hidden = true;
  authScreen.hidden = false;
  authError.textContent = message;
  tokenInput.focus();
}

function handleUnauthorized(error) {
  if (error?.message !== "UNAUTHORIZED") return false;
  showAuth("会话已过期，请重新输入访问密钥。");
  return true;
}

function showApp() {
  bootScreen.hidden = true;
  authScreen.hidden = true;
  app.hidden = false;
}

function setConversationPlaceholder(title, detail = "", visible = true) {
  placeholderTitle.textContent = title;
  placeholderDetail.textContent = detail;
  placeholderDetail.hidden = !detail;
  conversationPlaceholder.hidden = !visible;
  if (visible) messageList.hidden = true;
}

let lastConnectionInfo = {};
function setConnection(status = {}) {
  lastConnectionInfo = { ...lastConnectionInfo, ...status };
  status = { ...lastConnectionInfo, state: status.state || "connecting" };
  const state = status.state || "connecting";
  const standalone = status.connectionMode === "standalone";
  connectionState.dataset.state = state;
  const labels = {
    ready: "已连接",
    starting: "启动中",
    connecting: "连接中",
    disconnected: "已断开",
    offline: "离线",
    error: "异常",
  };
  connectionLabel.textContent = labels[state] || state;
  connectionState.title = status.error || labels[state] || state;
  const desktop = status.desktopConnection || {
    label: standalone ? "独立模式" : "待确认",
    advice: "尚未确认桌面 App 是否连接到同一后端。",
  };
  if (connectionModeWarning) {
    connectionModeWarning.hidden = !standalone && status.connectionMode !== "shared";
    connectionModeWarning.textContent = state === "ready" ? desktop.label : "未连接";
    connectionModeWarning.title = state === "ready" ? desktop.advice : "与 Pocket 的连接已断开，正在重新确认状态。";
  }
  if (connectionModeCurrent && connectionModeAdvice) {
    connectionModeCurrent.textContent = state === "ready" ? desktop.label : "未连接";
    connectionModeAdvice.textContent = state === "ready" ? desktop.advice : "与 Pocket 的连接已断开，正在重新确认状态。";
  }
  transportState = state;
  if (networkBanner) {
    networkBanner.hidden = state === "ready";
    networkBanner.dataset.state = state;
    const messages = {
      offline: "网络已断开，文字草稿保留在本机",
      disconnected: "连接中断，正在重连",
      connecting: "正在同步电脑端状态…",
      starting: "电脑端正在启动…",
      error: "电脑端连接异常，请重试",
    };
    networkMessage.textContent = messages[state] || "正在连接…";
    reconnectButton.hidden = state === "starting" || state === "connecting";
    reconnectButton.disabled = networkOffline();
  }
  updateComposer();
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat("zh-CN", sameDay
    ? { hour: "2-digit", minute: "2-digit", hour12: false }
    : { month: "numeric", day: "numeric" }).format(date);
}

function statusLabel(status) {
  const labels = {
    active: "运行中",
    idle: "空闲",
    notLoaded: "已保存",
    systemError: "异常",
  };
  return labels[status] || status || "未知";
}

function setThreadActionStatus(message = "", state = "") {
  threadActionStatus.textContent = message;
  threadActionStatus.hidden = !message;
  threadActionStatus.dataset.state = state;
}

async function createProjectThread(projectName, projectThreadId, projectId) {
  const key = projectId || projectThreadId;
  if (!key || creatingProjects.has(key)) return;
  creatingProjects.add(key);
  setThreadActionStatus(`正在为 ${projectName} 新建会话`, "loading");
  renderThreads();
  try {
    const result = await postJson("/api/threads", projectId ? { projectId } : { projectThreadId });
    if (!result.thread?.id) throw new Error("新会话响应无效");
    threads = [result.thread, ...threads.filter((thread) => thread.id !== result.thread.id)];
    setThreadActionStatus();
    renderThreads();
    await selectThread(result.thread.id);
  } catch (error) {
    if (handleUnauthorized(error)) return;
    setThreadActionStatus(error.message, "error");
  } finally {
    creatingProjects.delete(key);
    renderThreads();
  }
}

function closeSidebarMenu(restoreFocus = false) {
  sidebarMenu.hidden = true;
  sidebarMenuTrigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) sidebarMenuTrigger?.focus();
}

function openManagementDialog(kind, target = {}) {
  closeSidebarMenu();
  managementAction = { kind, target, idempotencyKey: createClientMessageId() };
  document.querySelector("#management-title").textContent = kind === "create-project" ? "新建项目" : kind === "rename-project" ? "重命名项目" : "重命名会话";
  managementNameInput.value = target.name || target.title || "";
  managementPathInput.value = "";
  managementPathInput.required = kind === "create-project";
  document.querySelector("#management-path-field").hidden = kind !== "create-project";
  managementSubmit.textContent = kind === "create-project" ? "创建" : "保存";
  managementError.textContent = "";
  managementDialog.showModal();
  managementNameInput.focus();
  managementNameInput.select();
}

async function loadArchived(append = false) {
  if (archivedLoading) return;
  archivedLoading = true;
  archivedMore.disabled = true;
  setThreadActionStatus("正在读取已归档会话", "loading");
  try {
    const result = await requestJson(`/api/threads?archived=true${append && archivedCursor ? `&cursor=${encodeURIComponent(archivedCursor)}` : ""}`);
    const entries = (result.threads || []).map((thread) => ({ ...thread, archived: true }));
    archivedThreads = [...new Map([...(append ? archivedThreads : []), ...entries].map((thread) => [thread.id, thread])).values()];
    archivedCursor = result.nextCursor;
    setThreadActionStatus();
  } catch (error) {
    if (!handleUnauthorized(error)) setThreadActionStatus(error.message, "error");
  } finally {
    archivedLoading = false;
    archivedMore.disabled = false;
    renderThreads();
  }
}

async function manageItem(kind, target, value = {}) {
  if (managementPending) return;
  managementPending = true;
  managementSubmit.disabled = true;
  managementError.textContent = "";
  closeSidebarMenu();
  const [action, type] = kind.split("-");
  try {
    const endpoint = kind === "create-project" ? "/api/projects" : `/api/${type === "project" ? "projects" : "threads"}/${encodeURIComponent(target.id)}/${action}`;
    const result = await postJson(endpoint, value);
    if (type === "project") {
      projectCatalog = projectCatalog.some((project) => project.id === result.project.id)
        ? projectCatalog.map((project) => project.id === result.project.id ? result.project : project)
        : [...projectCatalog, result.project];
      if (kind === "create-project") {
        viewingArchived = false;
        openedProjects.add(result.project.id);
      }
    } else {
      if (action === "rename") {
        const rename = (thread) => thread.id === target.id ? { ...thread, title: value.name.trim() } : thread;
        threads = threads.map(rename);
        archivedThreads = archivedThreads.map(rename);
        if (currentThread?.id === target.id) renderThread(rename(currentThread), { authoritativeSnapshot: false });
      } else if (action === "archive") {
        threads = threads.filter((thread) => thread.id !== target.id);
        archivedThreads = [{ ...target, archived: true }, ...archivedThreads.filter((thread) => thread.id !== target.id)];
        if (selectedThreadId === target.id) { saveDraft(); selectedArchived = true; updateComposer(); }
      } else {
        archivedThreads = archivedThreads.filter((thread) => thread.id !== target.id);
        threads = [{ ...target, archived: false }, ...threads.filter((thread) => thread.id !== target.id)];
        if (selectedThreadId === target.id) { selectedArchived = false; updateComposer(); }
      }
    }
    if (managementDialog.open) managementDialog.close();
    setThreadActionStatus(action === "archive" ? "已归档，可在已归档列表恢复" : action === "restore" ? "已恢复" : "");
    renderThreads();
  } catch (error) {
    if (handleUnauthorized(error)) return;
    if (managementDialog.open) managementError.textContent = error.message;
    else setThreadActionStatus(error.message, "error");
  } finally {
    managementPending = false;
    managementSubmit.disabled = false;
  }
}

function sidebarMenuButton(type, target) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "project-create sidebar-more";
  button.append(createIcon(["M5 12h.01M12 12h.01M19 12h.01"]));
  button.setAttribute("aria-label", `${type === "project" ? "项目" : "会话"}操作：${target.name || target.title}`);
  button.title = button.getAttribute("aria-label");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", () => {
    if (!sidebarMenu.hidden && sidebarMenuTrigger === button) return closeSidebarMenu(true);
    closeSidebarMenu();
    sidebarMenuTrigger = button;
    button.setAttribute("aria-expanded", "true");
    sidebarMenu.replaceChildren();
    const heading = document.createElement("div");
    heading.className = "sidebar-menu-info";
    heading.textContent = target.name || target.title;
    if (type === "project" && target.roots?.length) {
      const roots = document.createElement("span");
      roots.textContent = target.roots.join("\n");
      heading.append(roots);
    }
    sidebarMenu.append(heading);
    const add = (label, handler, disabled = false) => {
      const item = document.createElement("button");
      item.type = "button";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.disabled = disabled;
      item.addEventListener("click", handler);
      sidebarMenu.append(item);
    };
    if (type === "project" && !target.archived) add("新建会话", () => { closeSidebarMenu(); void createProjectThread(target.name, null, target.id); });
    add("重命名", () => openManagementDialog(`rename-${type}`, target));
    add(target.archived ? "恢复" : type === "project" ? "在 Pocket 中归档" : "归档", () => void manageItem(`${target.archived ? "restore" : "archive"}-${type}`, target), type === "thread" && !target.archived && (target.status === "active" || sendingThreads.has(target.id)));
    sidebarMenu.hidden = false;
    const bounds = button.getBoundingClientRect();
    const menuBounds = sidebarMenu.getBoundingClientRect();
    sidebarMenu.style.left = `${Math.max(8, Math.min(bounds.right, innerWidth - menuBounds.width - 8))}px`;
    sidebarMenu.style.top = `${Math.max(8, Math.min(bounds.top, innerHeight - menuBounds.height - 8))}px`;
    sidebarMenu.querySelector("button:not(:disabled)")?.focus();
  });
  return button;
}

function renderThreads() {
  const query = threadSearch.value.trim().toLocaleLowerCase();
  const signature = JSON.stringify([threads, query, selectedThreadId, [...creatingProjects],
    [...collapsedProjects], [...openedProjects], [...expandedProjectLists], projectCatalog, viewingArchived, archivedThreads]);
  if (sidebarSignature === signature) return;
  sidebarSignature = signature;
  const scrollTop = threadList.scrollTop;
  const catalog = new Map(projectCatalog.map((project) => [project.id, project]));
  const sourceThreads = viewingArchived
    ? [...archivedThreads, ...threads.filter((thread) => catalog.get(thread.projectId)?.archived)]
    : threads.filter((thread) => !catalog.get(thread.projectId)?.archived);
  const threadsById = new Map();
  for (const thread of sourceThreads) {
    if (!threadsById.has(thread.id)) threadsById.set(thread.id, thread);
  }
  const visible = [...threadsById.values()].map((thread) => ({ ...thread, project: catalog.get(thread.projectId)?.name || thread.project })).filter((thread) => {
    if (!query) return true;
    return `${thread.title} ${thread.preview} ${thread.project}`.toLocaleLowerCase().includes(query);
  });
  archivedButton?.setAttribute("aria-pressed", String(viewingArchived));
  archivedButton?.setAttribute("aria-label", viewingArchived ? "返回项目" : "查看已归档");
  archivedButton?.setAttribute("title", viewingArchived ? "返回项目" : "查看已归档");
  const sectionTitle = document.querySelector("#sidebar-section-title");
  if (sectionTitle) sectionTitle.textContent = viewingArchived ? "已归档" : "项目";
  const newProjectButton = document.querySelector("#new-project-button");
  if (newProjectButton) newProjectButton.disabled = !projectsSupported;
  if (archivedMore) archivedMore.hidden = !viewingArchived || !archivedCursor;

  threadList.replaceChildren();
  threadList.hidden = visible.length === 0;
  threadEmpty.hidden = visible.length > 0;
  threadEmptyTitle.textContent = query ? "没有匹配的会话" : "还没有可显示的会话";
  threadEmptyDetail.textContent = query
    ? "换一个关键词再试。"
    : "在电脑上打开 Codex 并开始对话。";
  const projects = new Map();
  for (const project of projectCatalog) {
    if (project.archived === viewingArchived && (!query || project.name.toLocaleLowerCase().includes(query))) projects.set(project.id, []);
  }
  for (const thread of visible) {
    const projectKey = thread.projectId || thread.project?.trim() || "其他项目";
    const projectThreads = projects.get(projectKey) || [];
    projectThreads.push(thread);
    projects.set(projectKey, projectThreads);
  }
  threadList.hidden = projects.size === 0;
  threadEmpty.hidden = projects.size > 0;
  if (viewingArchived && !query) threadEmptyTitle.textContent = "暂无已归档内容";

  for (const [projectKey, projectThreads] of projects) {
    const project = catalog.get(projectKey);
    const projectName = project?.name || projectThreads[0]?.project || projectKey;
    const currentProject = projectThreads.some((thread) => thread.id === selectedThreadId);
    const defaultOpen = currentProject || (!selectedThreadId && projectKey === projects.keys().next().value);
    const collapsed = !query && (collapsedProjects.has(projectKey)
      || (!defaultOpen && !openedProjects.has(projectKey)));
    const group = document.createElement("section");
    group.className = "project-group";
    group.setAttribute("aria-label", projectName);

    const header = document.createElement("div");
    header.className = "project-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "project-toggle";

    const folder = createSidebarIcon(collapsed ? "folder" : "folder-open");
    folder.classList.add("project-folder-icon");
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = projectName;
    toggle.append(folder, name);

    const createButton = document.createElement("button");
    createButton.type = "button";
    createButton.className = "project-create";
    createButton.append(createSidebarIcon("compose"));
    createButton.setAttribute("aria-label", `在 ${projectName} 中新建会话`);
    createButton.title = `在 ${projectName} 中新建会话`;
    createButton.disabled = Boolean(project?.archived) || creatingProjects.has(project?.id || projectThreads[0]?.id);
    createButton.setAttribute("aria-busy", String(createButton.disabled));
    createButton.addEventListener("click", () => {
      void createProjectThread(projectName, projectThreads[0]?.id, project?.id);
    });
    header.append(toggle, createButton);
    if (project) {
      header.classList.add("has-project-menu");
      header.append(sidebarMenuButton("project", project));
    }

    const items = document.createElement("div");
    items.className = "project-threads";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = collapsed ? `展开项目：${projectName}` : `折叠项目：${projectName}`;
    items.hidden = collapsed;

    toggle.addEventListener("click", () => {
      if (query) return;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      toggle.title = expanded ? `展开项目：${projectName}` : `折叠项目：${projectName}`;
      items.hidden = expanded;
      const nextFolder = createSidebarIcon(expanded ? "folder" : "folder-open");
      nextFolder.classList.add("project-folder-icon");
      toggle.replaceChildren(nextFolder, name);
      if (expanded) {
        collapsedProjects.add(projectKey);
        openedProjects.delete(projectKey);
      } else {
        collapsedProjects.delete(projectKey);
        openedProjects.add(projectKey);
      }
    });

    const showAll = Boolean(query) || expandedProjectLists.has(projectKey);
    let displayedThreads = showAll ? projectThreads : projectThreads.slice(0, PROJECT_THREAD_PREVIEW_COUNT);
    const selected = projectThreads.find((thread) => thread.id === selectedThreadId);
    if (!showAll && selected && !displayedThreads.includes(selected)) {
      displayedThreads = [...displayedThreads.slice(0, PROJECT_THREAD_PREVIEW_COUNT - 1), selected];
    }
    for (const thread of displayedThreads) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "thread-row";
      button.dataset.threadId = thread.id;
      button.setAttribute("aria-current", String(thread.id === selectedThreadId));

      const title = document.createElement("span");
      title.className = "thread-title";
      title.textContent = thread.title;

      const state = document.createElement("span");
      state.className = "thread-status";
      state.dataset.status = thread.status || "unknown";
      state.dataset.active = String(thread.status === "active");
      state.setAttribute("aria-label", statusLabel(thread.status));
      state.title = statusLabel(thread.status);
      button.title = [thread.title, thread.preview].filter(Boolean).join("\n");

      button.append(title, state);
      button.addEventListener("click", () => { selectedArchived = Boolean(thread.archived); return selectThread(thread.id); });
      const row = document.createElement("div");
      row.className = "thread-entry";
      row.append(button, sidebarMenuButton("thread", thread));
      items.append(row);
    }

    if (!query && projectThreads.length > PROJECT_THREAD_PREVIEW_COUNT) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "project-show-more";
      more.textContent = showAll ? "收起显示" : "展开显示";
      more.setAttribute("aria-expanded", String(showAll));
      more.setAttribute("aria-label", `${more.textContent}：${projectName}`);
      more.addEventListener("click", () => {
        if (showAll) expandedProjectLists.delete(projectKey);
        else expandedProjectLists.add(projectKey);
        renderThreads();
        const updated = [...threadList.children].find((item) => item.getAttribute("aria-label") === projectName);
        const updatedItems = updated?.children[1];
        if (updatedItems) [...updatedItems.children].at(-1)?.focus({ preventScroll: true });
      });
      items.append(more);
    }

    group.append(header, items);
    threadList.append(group);
  }
  threadList.scrollTop = scrollTop;
}

function messageLabel(message) {
  if (message.role === "user") return "你";
  if (message.role === "assistant") {
    if (message.kind === "commentary") return "Codex · 进展";
    if (message.kind === "plan") return "Codex · 计划";
    return "Codex";
  }
  return message.label || "活动";
}

function groupActivityMessages(messages) {
  const grouped = [];
  const activeTurnId = currentThread?.control?.turnId;
  const thinkingIndex = currentThread?.control?.busy ? messages.findLastIndex((message) =>
    message.kind === "reasoning"
    && (!activeTurnId || !message.turnId || message.turnId === activeTurnId)) : -1;
  for (const [index, source] of messages.entries()) {
    if (source.kind === "reasoning" && (index !== thinkingIndex || !["inProgress", "running"].includes(source.activityStatus))) continue;
    const message = source.role === "system" && source.kind === "image"
      ? { ...source, kind: "activity", activityType: "image", activityStatus: "completed", text: "查看图片" }
      : source;
    if (message.role !== "system" || message.kind !== "activity") {
      grouped.push(message);
      continue;
    }
    const current = grouped.at(-1);
    if (
      current?.kind === "activityGroup"
      && current.turnId === (message.turnId || "")
    ) {
      current.activities.push(message);
      current.timestamp = message.timestamp || current.timestamp;
    } else {
      grouped.push({
        id: `activity-group-${message.id}`,
        turnId: message.turnId || "",
        role: "system",
        kind: "activityGroup",
        timestamp: message.timestamp,
        activities: [message],
      });
    }
  }
  return grouped;
}

function mergeRepeatedActivities(activities) {
  const merged = [];
  const known = new Map();
  for (const activity of activities) {
    const key = [activity.activityType, activity.activityStatus, activity.label, activity.text, JSON.stringify(activity.images || [])].join("\u0000");
    const existing = known.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      const entry = { ...activity, count: 1 };
      known.set(key, entry);
      merged.push(entry);
    }
  }
  return merged;
}

function createActivityIcon(type) {
  const paths = {
    edit: ["m16 3 5 5-12 12-6 1 1-6Z", "m14 5 5 5"],
    image: ["M4 3h16v18H4Z", "m4 16 5-5 5 5 3-3 3 3", "M8 7h.01"],
    command: ["M4 17.5v-11A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2h-11A2.5 2.5 0 0 1 4 17.5Z", "m7.5 9 2.5 2.5L7.5 14", "M12.5 14h4"],
    file: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3Z"],
    tool: ["M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3Z"],
    web: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M3 12h18", "M12 3a15 15 0 0 1 0 18", "M12 3a15 15 0 0 0 0 18"],
    collab: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
    context: ["M4 7h16", "M7 3 3 4-3 4", "M20 17H4", "m17 21-3-4 3-4"],
  }[type] || ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"];
  return createIcon(paths);
}

function activityStatusLabel(status) {
  return {
    inProgress: "进行中",
    running: "进行中",
    failed: "失败",
    systemError: "异常",
    declined: "已拒绝",
  }[status] || "";
}

function activityOverview(activities) {
  const categories = new Map();
  for (const activity of activities) {
    const kinds = activity.activityActions?.length ? activity.activityActions : [activity.activityType === "file" ? "edit" : activity.activityType || "tool"];
    for (const kind of new Set(kinds)) {
      const states = categories.get(kind) || [];
      states.push(activity.activityStatus || "completed");
      categories.set(kind, states);
    }
  }
  const descriptions = {
    edit: ["编辑文件", "编辑了文件", "edit"],
    read: ["读取文件", "已读取文件", "file"],
    search: ["搜索文件", "已搜索文件", "file"],
    command: ["运行命令", "运行了命令", "command"],
    web: ["搜索网页", "已搜索网页", "web"],
    image: ["查看图片", "已查看图片", "image"],
    tool: ["调用工具", "调用了工具", "tool"],
    collab: ["处理协作任务", "已处理协作任务", "collab"],
    context: ["整理上下文", "已整理上下文", "context"],
  };
  const labels = [];
  let icon;
  for (const [kind, [action, completed, iconType]] of Object.entries(descriptions)) {
    const states = categories.get(kind);
    if (!states) continue;
    icon ||= iconType;
    if (states.some((state) => ["inProgress", "running"].includes(state))) labels.push(`正在${action}`);
    else if (states.some((state) => ["failed", "systemError"].includes(state))) labels.push(action);
    else if (states.every((state) => state === "declined")) labels.push(`未${action}`);
    else labels.push(completed);
  }
  return { text: labels.join("、") || "执行了操作", icon: icon || "tool" };
}

function renderActivityGroup(message, expanded = false) {
  const article = document.createElement("article");
  article.className = "message";
  article.dataset.role = "system";
  article.dataset.kind = "activityGroup";
  const details = document.createElement("details");
  details.className = "activity-disclosure";
  details.open = expanded;
  const summary = document.createElement("summary");
  summary.className = "activity-summary";
  const overview = activityOverview(message.activities);
  const icon = document.createElement("span");
  icon.className = "activity-summary-icon";
  icon.append(createActivityIcon(overview.icon));
  const label = document.createElement("span");
  label.className = "activity-summary-label";
  label.textContent = overview.text;
  const chevron = document.createElement("span");
  chevron.className = "reasoning-chevron";
  chevron.setAttribute("aria-hidden", "true");
  summary.append(icon, label, chevron);
  details.append(summary);
  const list = document.createElement("div");
  list.className = "activity-list";
  list.setAttribute("role", "list");
  list.setAttribute("aria-label", "Codex 活动");

  for (const activity of mergeRepeatedActivities(message.activities)) {
    const row = document.createElement("div");
    row.className = "activity-row";
    row.dataset.type = activity.activityType || "activity";
    row.dataset.status = activity.activityStatus || "unknown";
    row.setAttribute("role", "listitem");
    row.title = activity.text;
    const icon = document.createElement("span");
    icon.className = "activity-icon";
    icon.append(createActivityIcon(activity.activityType));
    const text = document.createElement("span");
    text.className = "activity-text";
    text.textContent = activity.text;
    row.append(icon, text);
    if (activity.images?.length) {
      const preview = createMessageNode({ ...activity, kind: "image", role: "system", text: "" });
      row.append(preview.article);
    }
    const status = activityStatusLabel(activity.activityStatus);
    if (activity.count > 1 || status) {
      const tail = document.createElement("span");
      tail.className = "activity-tail";
      const count = document.createElement("span");
      if (activity.count > 1) {
        count.className = "activity-count";
        count.textContent = `×${activity.count}`;
        tail.append(count);
      }
      if (status) {
        const state = document.createElement("span");
        state.className = "activity-state";
        state.textContent = status;
        tail.append(state);
        row.setAttribute("aria-label", `${activity.text}，${status}`);
      }
      row.append(tail);
    }
    list.append(row);
  }
  details.append(list);
  article.append(details);
  return article;
}

function persistComposerSelection() {
  try {
    globalThis.localStorage?.setItem(COMPOSER_STORAGE_KEY, JSON.stringify({
      model: composerSelection.model,
      effort: composerSelection.effort,
      mode: composerSelection.mode,
      skillNames: composerSelection.skillNames,
    }));
  } catch {
    // Browser storage is optional for remote and private sessions.
  }
}

function selectedModel() {
  return composerCatalog?.models?.find((model) => model.id === composerSelection.model) || null;
}

function selectedModelSupportsImages() {
  return selectedModel()?.supportsImages !== false;
}

function localPreviewUrl(file) {
  try {
    return typeof globalThis.URL?.createObjectURL === "function"
      ? globalThis.URL.createObjectURL(file)
      : "";
  } catch {
    return "";
  }
}

function releasePreviewUrl(value) {
  if (!String(value || "").startsWith("blob:")) return;
  try {
    globalThis.URL?.revokeObjectURL?.(value);
  } catch {
    // Object URLs are a progressive enhancement for local previews.
  }
}

async function deleteUploadedImage(id) {
  if (!id) return;
  try {
    await requestJson(`/api/uploads/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (error) {
    if (error.message === "UNAUTHORIZED") handleUnauthorized(error);
  }
}

function discardPendingImages() {
  const discarded = pendingImages;
  pendingImages = [];
  releaseImages(discarded);
  renderPendingImages();
  updateComposer();
}

function releaseImages(images) {
  for (const image of images) {
    releasePreviewUrl(image.previewUrl);
    if (image.id) void deleteUploadedImage(image.id);
  }
}

function keepImageDraft(threadId, images) {
  if (images.length) imageDrafts.set(threadId, images);
  else imageDrafts.delete(threadId);
  while (imageDrafts.size > 30) {
    const oldest = imageDrafts.keys().next().value;
    releaseImages(imageDrafts.get(oldest));
    imageDrafts.delete(oldest);
  }
}

function retainedImage(item) {
  return pendingImages.includes(item) || [...imageDrafts.values()].some((images) => images.includes(item)) ? item : null;
}

async function removePendingImage(localId) {
  const index = pendingImages.findIndex((image) => image.localId === localId);
  if (index === -1) return;
  const [removed] = pendingImages.splice(index, 1);
  releasePreviewUrl(removed.previewUrl);
  renderPendingImages();
  updateComposer();
  if (removed.id) await deleteUploadedImage(removed.id);
}

function renderPendingImages() {
  composerImages.replaceChildren();
  composerImages.hidden = pendingImages.length === 0;
  for (const image of pendingImages) {
    const item = document.createElement("div");
    item.className = "composer-image";
    item.dataset.status = image.status;

    if (image.previewUrl || image.src) {
      const preview = document.createElement("img");
      preview.src = image.previewUrl || image.src;
      preview.alt = image.name || "待发送图片";
      item.append(preview);
    }

    if (image.status !== "ready") {
      const status = document.createElement("span");
      status.className = "composer-image-status";
      status.textContent = image.status === "error" ? "失败" : "上传中";
      item.append(status);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "composer-image-remove";
    remove.title = `移除图片：${image.name || "图片"}`;
    remove.setAttribute("aria-label", remove.title);
    remove.textContent = "×";
    remove.addEventListener("click", () => removePendingImage(image.localId));
    item.append(remove);
    composerImages.append(item);
  }
}

async function uploadPendingImage(item) {
  try {
    const result = await requestJson("/api/uploads", {
      method: "POST",
      headers: {
        "Content-Type": item.file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(item.name),
      },
      body: item.file,
    }, UPLOAD_TIMEOUT_MS);
    const current = retainedImage(item);
    if (!current) {
      if (result.image?.id) void deleteUploadedImage(result.image.id);
      return;
    }
    releasePreviewUrl(current.previewUrl);
    current.previewUrl = "";
    current.id = result.image?.id || "";
    current.src = result.image?.src || "";
    current.mimeType = result.image?.mimeType || current.file.type || "";
    current.status = current.id && current.src ? "ready" : "error";
    if (current.status === "error") throw new Error("图片上传响应无效");
  } catch (error) {
    const current = retainedImage(item);
    if (current) {
      current.status = "error";
      current.error = error.message;
      if (pendingImages.includes(current)) composerError = error.message;
    }
    if (handleUnauthorized(error)) return;
  } finally {
    renderPendingImages();
    updateComposer();
  }
}

async function addPendingImages(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  if (!selectedModelSupportsImages()) {
    composerError = "所选模型不支持图片输入";
    updateComposer();
    return;
  }
  const slots = Math.max(0, MAX_IMAGES_PER_MESSAGE - pendingImages.length);
  if (files.length > slots) composerError = `一条消息最多上传 ${MAX_IMAGES_PER_MESSAGE} 张图片`;

  const additions = [];
  for (const file of files.slice(0, slots)) {
    if (file.type && !SUPPORTED_IMAGE_TYPES.has(file.type)) {
      composerError = "仅支持 PNG、JPEG、WebP 或 GIF 图片";
      continue;
    }
    if (!Number.isFinite(file.size) || file.size <= 0) {
      composerError = "图片文件为空";
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      composerError = "单张图片不能超过 12 MB";
      continue;
    }
    const image = {
      localId: `local-image-${Date.now()}-${nextPendingImageId++}`,
      file,
      name: String(file.name || "图片").slice(0, 160),
      previewUrl: localPreviewUrl(file),
      src: "",
      id: "",
      status: "uploading",
      error: "",
    };
    pendingImages.push(image);
    additions.push(image);
  }
  renderPendingImages();
  updateComposer();
  await Promise.all(additions.map(uploadPendingImage));
}

function effortLabel(value) {
  return EFFORT_LABELS[value] || value || "强度";
}

function modelDisplayName(model) {
  const name = model?.name || "模型";
  return /^GPT[- ]\d/i.test(name) ? name.replace(/^GPT[- ]/i, "").replaceAll("-", " ") : name;
}

function activeGoal() {
  const goal = composerCatalog?.goal;
  return goal && !["complete"].includes(goal.status) ? goal : null;
}

function modeAvailable(mode) {
  if (mode === "goal") return Boolean(composerCatalog?.features?.goal);
  return Boolean(composerCatalog?.modes?.includes(mode));
}

function normalizeComposerSelection() {
  if (!composerCatalog?.models?.length) return;
  const model = selectedModel()
    || composerCatalog.models.find((item) => item.id === composerCatalog.defaultModel)
    || composerCatalog.models[0];
  composerSelection.model = model.id;
  if (!model.efforts.some((effort) => effort.id === composerSelection.effort)) {
    composerSelection.effort = model.defaultEffort || model.efforts[0]?.id || "";
  }
  if (activeGoal()) composerSelection.mode = "goal";
  if (!modeAvailable(composerSelection.mode)) composerSelection.mode = "default";
  const enabledSkills = new Set(
    (composerCatalog.skills || []).filter((skill) => skill.enabled).map((skill) => skill.name),
  );
  composerSelection.skillNames = [...new Set(composerSelection.skillNames || [])]
    .filter((name) => enabledSkills.has(name));
}

function applyComposerCatalog(value) {
  composerCatalog = value && Array.isArray(value.models) ? value : null;
  if (composerCatalog?.error) composerError = composerCatalog.error;
  const remoteSignature = JSON.stringify(composerCatalog?.currentSelection || null);
  if (composerCatalog?.currentSelection
    && (initialLoadEpoch === selectionEpoch || remoteSignature !== remoteComposerSignature)) {
    Object.assign(composerSelection, composerCatalog.currentSelection);
  }
  remoteComposerSignature = remoteSignature;
  normalizeComposerSelection();
  persistComposerSelection();
  renderComposerControls();
}

function controlIsBusy() {
  return goalUpdating
    || permissionUpdatingThreads.has(selectedThreadId)
    || sendingThreads.has(selectedThreadId)
    || interruptingThreads.has(selectedThreadId);
}

function updateComposerControlAvailability() {
  const busy = controlIsBusy();
  const running = Boolean(currentThread?.control?.busy);
  const hasModels = Boolean(composerCatalog?.models?.length);
  const ready = currentThread?.id === selectedThreadId;
  modelControl.disabled = busy || running || !hasModels;
  permissionControl.disabled = busy || running || Boolean(currentThread?.control?.queued)
    || !ready || !composerCatalog?.permissions?.supported;
  skillControl.disabled = busy || !composerCatalog?.features?.skills;
  for (const button of extrasSkills?.children || []) button.disabled = skillControl.disabled;
  imageUploadButton.disabled = busy
    || !ready
    || !selectedModelSupportsImages()
    || pendingImages.length >= MAX_IMAGES_PER_MESSAGE;
  imageInput.disabled = imageUploadButton.disabled;
  imageUploadButton.title = selectedModelSupportsImages()
    ? "添加图片"
    : "所选模型不支持图片输入";
  for (const button of modeControl.children) {
    button.disabled = busy || running || !modeAvailable(button.dataset.mode);
  }
  goalComplete.disabled = busy || running || !activeGoal();
  goalClear.disabled = busy || running || !activeGoal();
  if (["settings", "model"].includes(composerMenuKind)) {
    for (const button of composerMenu.querySelectorAll?.(".model-picker-summary, .composer-menu-item") || []) {
      button.disabled = modelControl.disabled;
    }
    const slider = composerMenu.querySelector?.(".effort-slider");
    const reset = composerMenu.querySelector?.(".model-picker-reset");
    if (slider) slider.disabled = modelControl.disabled || selectedModel().efforts.length < 2;
    if (reset) reset.disabled = modelControl.disabled || !selectedModel().efforts.length;
  }
}

function renderSelectedSkills() {
  selectedSkills.replaceChildren();
  const names = composerSelection.skillNames || [];
  selectedSkills.hidden = names.length === 0;
  for (const name of names) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "skill-chip";
    chip.title = `移除 Skill：${name}`;
    chip.setAttribute("aria-label", `移除 Skill：${name}`);
    const label = document.createElement("span");
    label.textContent = `$${name}`;
    const remove = document.createElement("span");
    remove.className = "skill-chip-remove";
    remove.setAttribute("aria-hidden", "true");
    remove.textContent = "×";
    chip.append(label, remove);
    chip.addEventListener("click", () => toggleSkill(name));
    selectedSkills.append(chip);
  }
}

function renderComposerControls() {
  const model = selectedModel();
  modelLabel.textContent = modelDisplayName(model);
  modelControl.title = "模型与思考强度";
  modelControl.setAttribute("aria-label", `模型与思考强度：${model?.name || "模型"}，${effortLabel(composerSelection.effort)}`);
  const permissions = composerCatalog?.permissions;
  const permission = permissions?.options?.find((item) => item.id === permissions.current);
  permissionLabel.textContent = permission?.shortName || (permissions?.supported ? "自定义" : "权限");
  permissionControl.title = permissions?.supported ? "更改权限" : "当前 Codex 未提供权限切换";
  permissionControl.dataset.mode = permissions?.current || "custom";
  effortLabelNode.textContent = effortLabel(composerSelection.effort);

  for (const button of modeControl.children) {
    const selected = button.dataset.mode === composerSelection.mode;
    button.setAttribute("aria-checked", String(selected));
    button.dataset.selected = String(selected);
    button.hidden = button.dataset.mode === "default" && composerSelection.mode === "default";
  }

  const goal = activeGoal();
  goalBanner.hidden = !goal;
  goalObjective.textContent = goal?.objective || "";
  goalBanner.dataset.status = goal?.status || "";

  const skillTotal = composerSelection.skillNames?.length || 0;
  skillLabel.textContent = extrasSkillsExpanded ? "收起技能" : "全部技能";
  skillCount.hidden = skillTotal === 0;
  skillCount.textContent = skillTotal ? String(skillTotal) : "";
  renderSelectedSkills();
  renderPendingImages();
  if (composerExtras?.hidden === false) renderExtrasSkills();

  messageInput.placeholder = composerSelection.mode === "plan"
    ? "描述要规划的任务"
    : composerSelection.mode === "goal"
      ? (goal ? "继续推进这个目标" : "描述要持续推进的目标")
      : "随心输入";
  updateComposerControlAvailability();
  if (composerMenuKind) renderComposerMenu(composerMenuKind);
}

function setControlExpanded(control, expanded) {
  control.setAttribute("aria-expanded", String(expanded));
}

function closeComposerMenu() {
  extrasSkillsExpanded = false;
  if (composerExtras) composerExtras.hidden = true;
  extrasButton?.setAttribute("aria-expanded", "false");
  composerMenuKind = "";
  composerMenu.hidden = true;
  composerMenu.replaceChildren();
  setControlExpanded(modelControl, false);
  setControlExpanded(permissionControl, false);
  setControlExpanded(skillControl, false);
}

function menuHeader(title) {
  const header = document.createElement("div");
  header.className = "composer-menu-header";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "menu-close";
  close.setAttribute("aria-label", "关闭");
  close.title = "关闭";
  close.textContent = "×";
  close.addEventListener("click", closeComposerMenu);
  header.append(heading, close);
  return header;
}

function choiceRow(title, description, selected) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "composer-menu-item";
  button.dataset.selected = String(selected);
  const copy = document.createElement("span");
  copy.className = "menu-item-copy";
  const name = document.createElement("strong");
  name.textContent = title;
  copy.append(name);
  if (description) {
    const detail = document.createElement("span");
    detail.textContent = description;
    copy.append(detail);
  }
  const check = document.createElement("span");
  check.className = "menu-check";
  check.setAttribute("aria-hidden", "true");
  check.textContent = selected ? "✓" : "";
  button.append(copy, check);
  return button;
}

function renderModelMenu() {
  const header = document.createElement("div");
  header.className = "model-menu-heading";
  header.textContent = "Select model";
  composerMenu.append(header);
  const list = document.createElement("div");
  list.className = "composer-menu-list";
  for (const model of composerCatalog?.models || []) {
    const row = choiceRow(
      modelDisplayName(model),
      "",
      model.id === composerSelection.model,
    );
    const check = row.children[1];
    check.replaceChildren();
    if (model.id === composerSelection.model) check.append(createIcon(["M20 6 9 17l-5-5"]));
    row.disabled = modelControl.disabled;
    row.setAttribute("role", "radio");
    row.setAttribute("aria-checked", String(model.id === composerSelection.model));
    row.addEventListener("click", (event) => {
      if (modelControl.disabled) return;
      composerSelection.model = model.id;
      if (!model.efforts.some((effort) => effort.id === composerSelection.effort)) {
        composerSelection.effort = model.defaultEffort || model.efforts[0]?.id || "";
      }
      if (pendingImages.length && model.supportsImages === false) {
        composerError = "所选模型不支持图片输入";
      } else if (composerError === "所选模型不支持图片输入") {
        composerError = "";
      }
      persistComposerSelection();
      composerMenuKind = "settings";
      renderComposerControls();
      updateComposer();
      if (event?.detail === 0) composerMenu.querySelector?.(".model-picker-summary")?.focus();
    });
    list.append(row);
  }
  list.setAttribute("role", "radiogroup");
  list.setAttribute("aria-label", "模型");
  composerMenu.append(list);
}

function renderModelSettings() {
  const model = selectedModel();
  const efforts = model?.efforts || [];
  const panel = document.createElement("div");
  panel.className = "model-settings-panel";
  const summary = document.createElement("button");
  summary.type = "button";
  summary.className = "model-picker-summary";
  summary.title = "切换模型";
  summary.setAttribute("aria-label", "切换模型");
  summary.disabled = modelControl.disabled;
  const strength = document.createElement("span");
  strength.className = "model-picker-strength";
  const name = document.createElement("span");
  name.className = "model-picker-name";
  name.textContent = modelDisplayName(model);
  summary.append(strength, name);
  summary.addEventListener("click", () => toggleComposerMenu("model"));
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "model-picker-reset";
  reset.title = "恢复默认思考强度";
  reset.setAttribute("aria-label", "恢复默认思考强度");
  reset.disabled = modelControl.disabled || !efforts.length;
  // Lucide rotate-ccw icon, matching the existing inline icon convention.
  reset.append(createIcon(["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"]));
  const track = document.createElement("div");
  track.className = "effort-slider-track";
  const shimmer = document.createElement("div");
  shimmer.className = "effort-slider-shimmer";
  shimmer.setAttribute("aria-hidden", "true");
  for (const [x, y] of [[7, 42], [9, 30], [14, 57], [19, 35], [31, 42], [44, 52], [52, 28], [52, 61], [60, 37], [64, 45], [77, 39], [88, 64]]) {
    const spark = document.createElement("span");
    spark.style.setProperty("--spark-x", `${x}%`);
    spark.style.setProperty("--spark-y", `${y}%`);
    spark.style.setProperty("--spark-delay", `${-x / 20}s`);
    shimmer.append(spark);
  }
  const thumb = document.createElement("span");
  thumb.className = "effort-slider-thumb";
  thumb.setAttribute("aria-hidden", "true");
  const dots = document.createElement("div");
  dots.className = "effort-slider-dots";
  dots.setAttribute("aria-hidden", "true");
  for (const effort of efforts) {
    const dot = document.createElement("span");
    dot.title = effortLabel(effort.id);
    dots.append(dot);
  }
  const slider = document.createElement("input");
  slider.type = "range";
  slider.className = "effort-slider";
  slider.min = "0";
  slider.max = String(Math.max(0, efforts.length - 1));
  slider.step = "0.001";
  slider.disabled = modelControl.disabled || efforts.length < 2;
  slider.setAttribute("aria-label", "思考强度");
  function sync(position) {
    const index = Math.max(0, efforts.findIndex((effort) => effort.id === composerSelection.effort));
    const label = effortLabel(composerSelection.effort);
    slider.value = String(position ?? index);
    slider.setAttribute("aria-valuetext", label);
    slider.title = efforts[index]?.description || label;
    track.style.setProperty("--effort-progress", String(efforts.length > 1 ? (position ?? index) / (efforts.length - 1) : 0));
    panel.dataset.effort = composerSelection.effort;
    strength.textContent = label;
    effortLabelNode.textContent = label;
    modelControl.setAttribute("aria-label", `模型与思考强度：${model?.name || "模型"}，${label}`);
  }
  function selectPosition(position) {
    const effort = efforts[Math.round(position)];
    if (modelControl.disabled || slider.disabled || !effort) return;
    if (composerSelection.effort !== effort.id) {
      composerSelection.effort = effort.id;
      persistComposerSelection();
    }
    sync(position);
  }
  slider.addEventListener("pointerdown", () => { track.dataset.dragging = "true"; });
  slider.addEventListener("input", () => {
    selectPosition(Number(slider.value));
  });
  function settle() {
    track.dataset.dragging = "false";
    sync();
  }
  slider.addEventListener("change", settle);
  slider.addEventListener("pointerup", settle);
  slider.addEventListener("pointercancel", settle);
  slider.addEventListener("blur", settle);
  slider.addEventListener("keydown", (event) => {
    const index = Math.round(Number(slider.value));
    const positions = { ArrowRight: index + 1, ArrowUp: index + 1, ArrowLeft: index - 1, ArrowDown: index - 1, Home: 0, End: efforts.length - 1, PageUp: index + 2, PageDown: index - 2 };
    if (!(event.key in positions) || slider.disabled) return;
    event.preventDefault();
    selectPosition(Math.max(0, Math.min(efforts.length - 1, positions[event.key])));
  });
  reset.addEventListener("click", () => {
    if (modelControl.disabled || !efforts.length) return;
    composerSelection.effort = model.defaultEffort || efforts[0].id;
    persistComposerSelection();
    sync();
  });
  sync();
  track.append(shimmer, dots, thumb, slider);
  panel.append(summary, reset, track);
  composerMenu.append(panel);
}

async function changePermissions(mode) {
  if (permissionControl.disabled) return;
  const threadId = selectedThreadId;
  permissionUpdatingThreads.add(threadId);
  closeComposerMenu();
  updateComposer();
  try {
    const result = await postJson(`/api/threads/${encodeURIComponent(threadId)}/permissions`, { mode });
    if (selectedThreadId === threadId && composerCatalog) {
      composerCatalog.permissions = result.permissions;
      composerError = "";
    }
  } catch (error) {
    if (handleUnauthorized(error)) return;
    if (selectedThreadId === threadId) {
      composerError = error.message;
      if (error.code === "THREAD_CONTINUATION_REQUIRED") continuationThreads.add(threadId);
    }
  } finally {
    permissionUpdatingThreads.delete(threadId);
    if (selectedThreadId === threadId) {
      renderComposerControls();
      updateComposer();
    }
  }
}

function renderPermissionMenu() {
  composerMenu.append(menuHeader("应如何批准 Codex 操作？"));
  const list = document.createElement("div");
  list.className = "composer-menu-list";
  const permissions = composerCatalog?.permissions;
  if (permissions?.current === "custom") {
    const row = choiceRow("自定义 (config.toml)", "使用根据你的配置解析出的权限", true);
    row.disabled = true;
    list.append(row);
  }
  for (const option of permissions?.options || []) {
    const row = choiceRow(option.name, option.allowed ? option.description : "权限模式不可用", option.id === permissions.current);
    row.disabled = !option.allowed;
    row.setAttribute("role", "menuitemradio");
    row.setAttribute("aria-checked", String(option.id === permissions.current));
    row.addEventListener("click", () => changePermissions(option.id));
    list.append(row);
  }
  list.setAttribute("role", "menu");
  composerMenu.append(list);
}

function renderSkillList(list, query = "") {
  list.replaceChildren();
  const normalized = query.trim().toLocaleLowerCase();
  const skills = (composerCatalog?.skills || []).filter((skill) =>
    skill.enabled
      && (!normalized
        || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(normalized)),
  );
  for (const skill of skills) {
    const selected = composerSelection.skillNames.includes(skill.name);
    const row = choiceRow(skill.name, skill.description, selected);
    row.setAttribute("role", "checkbox");
    row.setAttribute("aria-checked", String(selected));
    row.addEventListener("click", () => toggleSkill(skill.name));
    list.append(row);
  }
  if (!skills.length) {
    const empty = document.createElement("p");
    empty.className = "composer-menu-empty";
    empty.textContent = "没有匹配的 Skill";
    list.append(empty);
  }
}

function renderSkillMenu() {
  composerMenu.append(menuHeader("Skills"));
  const search = document.createElement("input");
  search.className = "composer-menu-search";
  search.type = "search";
  search.placeholder = "搜索 Skills";
  search.setAttribute("aria-label", "搜索 Skills");
  const list = document.createElement("div");
  list.className = "composer-menu-list skill-menu-list";
  search.addEventListener("input", () => renderSkillList(list, search.value));
  composerMenu.append(search, list);
  renderSkillList(list);
  search.focus();
}

function renderComposerMenu(kind) {
  composerMenu.replaceChildren();
  composerMenu.dataset.kind = kind;
  composerMenu.setAttribute("aria-label", kind === "settings" ? "模型与思考强度" : kind === "model" ? "模型" : kind === "skills" ? "Skills" : "权限");
  if (kind === "model") renderModelMenu();
  else if (kind === "settings") renderModelSettings();
  else if (kind === "skills") renderSkillMenu();
  else if (kind === "permissions") renderPermissionMenu();
  composerMenu.hidden = false;
  positionModelMenu();
}

function positionModelMenu() {
  positionExtrasMenu();
  if (!["settings", "model"].includes(composerMenuKind)) return;
  const shell = composer.getBoundingClientRect?.();
  const button = modelControl.getBoundingClientRect?.();
  if (!shell || !button) return;
  const width = Math.min(300, shell.width - 20);
  const right = Math.max(10, Math.min(shell.right - button.right, shell.width - width - 10));
  composerMenu.style.setProperty("--picker-right", `${right}px`);
  composerMenu.style.setProperty("--picker-bottom", `${shell.bottom - button.top + 4}px`);
}

function positionExtrasMenu() {
  if (!composerExtras || composerExtras.hidden) return;
  const box = document.querySelector(".composer-box")?.getBoundingClientRect?.();
  const shell = composer.getBoundingClientRect?.();
  if (!box || !shell) return;
  composerExtras.style.setProperty("--extras-left", `${box.left - shell.left}px`);
  composerExtras.style.setProperty("--extras-width", `${box.width}px`);
  composerExtras.style.setProperty("--extras-bottom", `${shell.bottom - box.top + 4}px`);
}

function renderExtrasSkills() {
  if (!extrasSkills) return;
  extrasSkills.replaceChildren();
  const skills = (composerCatalog?.skills || []).filter((item) => item.enabled);
  skillControl.hidden = skills.length <= 6;
  skillLabel.textContent = extrasSkillsExpanded ? "收起技能" : "全部技能";
  setControlExpanded(skillControl, extrasSkillsExpanded);
  const presentation = {
    documents: ["Documents", "blue"], pdf: ["PDF", "red"],
    spreadsheets: ["Spreadsheets", "green"], presentations: ["Presentations", "amber"],
  };
  for (const skill of extrasSkillsExpanded ? skills : skills.slice(0, 6)) {
    const key = skill.name.split(":").pop().toLowerCase();
    const [label, tone] = presentation[key] || [skill.name, "neutral"];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "extras-menu-row extras-skill-row";
    row.dataset.tone = tone;
    row.disabled = skillControl.disabled;
    row.setAttribute("role", "checkbox");
    row.setAttribute("aria-checked", String(composerSelection.skillNames.includes(skill.name)));
    row.title = skill.description || skill.name;
    const icon = createIcon(["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z", "M14 2v6h6", "M8 13h8M8 17h6"]);
    icon.classList.add("extras-skill-icon");
    const name = document.createElement("span");
    name.className = "extras-skill-name";
    name.textContent = label;
    row.append(icon, name);
    if (composerSelection.skillNames.includes(skill.name)) {
      const check = createIcon(["M20 6 9 17l-5-5"]);
      check.classList.add("extras-row-check");
      row.append(check);
    }
    row.addEventListener("click", () => {
      if (skillControl.disabled) return;
      toggleSkill(skill.name);
      closeComposerMenu();
      messageInput.focus();
    });
    extrasSkills.append(row);
  }
}

function toggleComposerMenu(kind) {
  if (composerExtras) composerExtras.hidden = true;
  extrasButton?.setAttribute("aria-expanded", "false");
  if (composerMenuKind === kind) return closeComposerMenu();
  composerMenuKind = kind;
  setControlExpanded(modelControl, kind === "model" || kind === "settings");
  setControlExpanded(permissionControl, kind === "permissions");
  setControlExpanded(skillControl, kind === "skills");
  renderComposerMenu(kind);
}

function toggleSkill(name) {
  const names = new Set(composerSelection.skillNames || []);
  if (names.has(name)) names.delete(name);
  else names.add(name);
  composerSelection.skillNames = [...names];
  persistComposerSelection();
  renderComposerControls();
}

async function mutateActiveGoal(mutation, { nextMode = "default", clear = false } = {}) {
  if (!selectedThreadId || !activeGoal() || goalUpdating) return;
  const threadId = selectedThreadId;
  const previousMode = composerSelection.mode;
  goalUpdating = true;
  updateComposer();
  try {
    const result = await mutation(threadId);
    if (selectedThreadId !== threadId) return;
    composerCatalog.goal = clear ? null : result.goal || null;
    composerSelection.mode = nextMode;
    persistComposerSelection();
  } catch (error) {
    if (handleUnauthorized(error)) return;
    if (selectedThreadId === threadId) {
      composerSelection.mode = previousMode;
      composerError = error.message;
    }
  } finally {
    goalUpdating = false;
    if (selectedThreadId === threadId) {
      renderComposerControls();
      updateComposer();
    }
  }
}

function clearActiveGoal({ nextMode = "default" } = {}) {
  return mutateActiveGoal(
    (threadId) => requestJson(`/api/threads/${encodeURIComponent(threadId)}/goal`, {
      method: "DELETE",
    }),
    { nextMode, clear: true },
  );
}

function completeActiveGoal() {
  return mutateActiveGoal(
    (threadId) => postJson(
      `/api/threads/${encodeURIComponent(threadId)}/goal`,
      { status: "complete" },
    ),
  );
}

async function chooseComposerMode(mode) {
  if (!modeAvailable(mode) || goalUpdating) return;
  closeComposerMenu();
  if (mode !== "goal" && activeGoal()) {
    await clearActiveGoal({ nextMode: mode });
    return;
  }
  composerSelection.mode = mode;
  persistComposerSelection();
  renderComposerControls();
  messageInput.focus();
}

function resizeComposer() {
  messageInput.style.height = "0px";
  messageInput.style.height = `${Math.min(messageInput.scrollHeight, 160)}px`;
}

function updateComposer() {
  const control = currentThread?.control || {};
  const requests = control.requests || [];
  const ready = currentThread?.id === selectedThreadId;
  const sending = sendingThreads.has(selectedThreadId);
  const interrupting = interruptingThreads.has(selectedThreadId);
  const running = Boolean(control.busy);
  const queued = Boolean(
    control.queued
    || pendingMessage?.deliveryState === "queued"
  );
  const uploadingImages = pendingImages.some((image) => image.status === "uploading");
  const failedImages = pendingImages.some((image) => image.status === "error");
  const readyImages = pendingImages.filter((image) => image.status === "ready");
  const hasMessageContent = Boolean(messageInput.value.trim() || readyImages.length);
  const stopAction = running && !hasMessageContent;
  const goalNeedsText = !running
    && composerSelection.mode === "goal"
    && !messageInput.value.trim();
  const action = running ? "queue" : "start";
  composer.hidden = !selectedThreadId || selectedArchived;
  messageInput.disabled = !selectedThreadId || !ready || sending || interrupting || goalUpdating;
  if (continueWebButton) {
    continueWebButton.hidden = !continuationThreads.has(selectedThreadId);
    continueWebButton.disabled = sending || running || networkOffline();
  }
  interruptButton.hidden = true;
  interruptButton.disabled = true;
  sendButton.dataset.action = stopAction ? "stop" : action;
  const sendLabel = stopAction ? "停止" : action === "queue" ? "加入等待" : "发送消息";
  sendButton.setAttribute("aria-label", sendLabel);
  sendButton.title = sendLabel;
  sendButton.disabled = !selectedThreadId || selectedArchived
    || permissionUpdatingThreads.has(selectedThreadId)
    || networkOffline()
    || ["offline", "disconnected", "error"].includes(transportState)
    || !ready
    || sending
    || interrupting
    || goalUpdating
    || uploadingImages
    || failedImages
    || (!hasMessageContent && !stopAction)
    || goalNeedsText;
  sendButton.querySelectorAll?.(".send-icon")?.forEach((icon) => { icon.hidden = stopAction; });
  const stopIcon = sendButton.querySelector?.(".stop-icon");
  if (stopIcon) stopIcon.hidden = !stopAction;

  let state = "idle";
  if (composerError) {
    state = "error";
    composerStatus.textContent = composerError;
  } else if (goalUpdating) {
    state = "sending";
    composerStatus.textContent = "正在更新目标";
  } else if (permissionUpdatingThreads.has(selectedThreadId)) {
    state = "sending";
    composerStatus.textContent = "正在更改权限";
  } else if (uploadingImages) {
    state = "sending";
    composerStatus.textContent = "正在上传图片";
  } else if (interrupting) {
    state = "interrupting";
    composerStatus.textContent = "正在中断";
  } else if (sending) {
    state = "sending";
    composerStatus.textContent = action === "queue" ? "正在加入等待" : "正在发送";
  } else if (requests.some((request) => request.type !== "unsupported" && !request.responding)) {
    state = "approval";
    composerStatus.textContent = requests.some((request) => ["userInput", "elicitation"].includes(request.type) && !request.responding)
      ? "Codex 正在等待你的回答" : "Codex 正在等待你的批准";
  } else if (requests.some((request) => request.type === "unsupported" && !request.responding)) {
    state = "approval";
    composerStatus.textContent = "此请求暂不支持在网页处理";
  } else if (queued) {
    state = "queued";
    composerStatus.textContent = "";
  } else if (control.busy) {
    state = "busy";
    composerStatus.textContent = "";
  } else {
    composerStatus.textContent = "";
  }
  composer.dataset.state = state;
  composer.dataset.running = String(running);
  composerStatus.dataset.state = state;
  updateComposerControlAvailability();
  renderApprovals(requests);
  renderQueuedMessages();
}

function waitingMessages() {
  const queue = currentThread?.control?.queue;
  return Array.isArray(queue) ? queue : queue ? [queue] : [];
}

function renderQueuedMessages() {
  if (!queuedMessageList) return;
  const queue = waitingMessages();
  queuedMessageList.hidden = !queue.length;
  const key = JSON.stringify([selectedThreadId, queue, currentThread?.control?.busy, [...queueMutations], networkOffline()]);
  if (key === renderedQueueKey) return;
  renderedQueueKey = key;
  const focused = queuedMessageList.contains(document.activeElement) ? document.activeElement : null;
  const focusId = focused?.closest("[data-queue-id]")?.dataset.queueId;
  const selection = focused?.matches("textarea") ? [focused.selectionStart, focused.selectionEnd] : null;
  const nodes = queue.map((message) => {
    const id = message.id || message.clientMessageId;
    const draftKey = `${selectedThreadId}/${id}`;
    const disabled = queueMutations.has(id) || networkOffline();
    const icon = (name) => {
      const image = document.createElement("img");
      image.src = `/vendor/lucide/${name}.svg`;
      image.alt = "";
      return image;
    };
    const button = (label, iconName, className, handler) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = className;
      element.title = label;
      element.setAttribute("aria-label", `${label}：${message.text || "图片"}`);
      element.disabled = disabled;
      if (iconName) element.append(icon(iconName));
      element.addEventListener("click", handler);
      return element;
    };
    const row = document.createElement("div");
    row.className = "queued-message";
    row.dataset.queueId = id;
    if (message.editing) row.classList.add("is-editing");
    const marker = icon("list-end");
    marker.className = "queued-message-marker";
    const text = document.createElement("span");
    text.className = "queued-message-text";
    text.textContent = message.text || (message.images?.length ? "图片" : "消息");
    text.title = message.error || text.textContent;
    const actions = document.createElement("div");
    actions.className = "queued-message-actions";
    row.append(marker, text, actions);
    if (message.editing) {
      const editor = document.createElement("textarea");
      editor.className = "queued-message-editor";
      editor.setAttribute("aria-label", "编辑等待消息");
      editor.rows = 3;
      editor.maxLength = 12000;
      editor.value = queueEditDrafts.get(draftKey) ?? message.text ?? "";
      editor.disabled = disabled;
      const cancel = button("取消编辑", null, "queued-edit-cancel", () => void mutateQueuedMessage(id, "cancelEdit"));
      cancel.textContent = "取消";
      const save = button("保存消息", null, "queued-edit-save", () => void mutateQueuedMessage(id, "update", { text: editor.value }));
      save.textContent = "保存";
      save.disabled ||= !editor.value.trim() && !message.images?.length;
      editor.addEventListener("input", () => {
        queueEditDrafts.set(draftKey, editor.value);
        save.disabled = disabled || (!editor.value.trim() && !message.images?.length);
      });
      editor.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); cancel.click(); }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save.click(); }
      });
      text.textContent = "编辑消息";
      actions.append(cancel, save);
      row.append(editor);
      if (message.images?.length) {
        const attachments = document.createElement("div");
        attachments.className = "queued-edit-images";
        for (const image of safeMessageImages(message.images)) {
          const preview = document.createElement("img");
          preview.src = image.src;
          preview.alt = image.alt;
          attachments.append(preview);
        }
        row.append(attachments);
      }
    } else {
      const label = currentThread.control?.busy ? "调整方向" : message.error ? "重试" : "发送";
      const send = button(label, "corner-down-right", "queued-send", () => void mutateQueuedMessage(id, "send"));
      const sendLabel = document.createElement("span");
      sendLabel.textContent = label;
      send.append(sendLabel);
      const remove = button("取消等待", "trash-2", "queued-remove", () => void mutateQueuedMessage(id, "remove"));
      const menu = document.createElement("details");
      menu.className = "queued-menu";
      const trigger = document.createElement("summary");
      trigger.title = "消息操作";
      trigger.setAttribute("aria-label", `消息操作：${text.textContent}`);
      trigger.append(icon("ellipsis"));
      const popup = document.createElement("div");
      popup.className = "queued-menu-popup";
      const edit = button("编辑消息", "pencil", "queued-edit", () => void mutateQueuedMessage(id, "edit"));
      const editLabel = document.createElement("span");
      editLabel.textContent = "编辑消息";
      edit.append(editLabel);
      popup.append(edit);
      menu.append(trigger, popup);
      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        menu.open = !menu.open;
        if (menu.open) {
          for (const other of queuedMessageList.querySelectorAll("details[open]")) if (other !== menu) other.open = false;
          const rect = trigger.getBoundingClientRect();
          popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, innerWidth - popup.offsetWidth - 8))}px`;
          const top = rect.bottom + popup.offsetHeight + 12 < innerHeight ? rect.bottom + 4 : rect.top - popup.offsetHeight - 6;
          popup.style.top = `${Math.max(8, top)}px`;
        }
      });
      actions.append(send, remove, menu);
    }
    return row;
  });
  queuedMessageList.replaceChildren(...nodes);
  if (selection) {
    const editor = [...queuedMessageList.querySelectorAll("[data-queue-id]")].find((row) => row.dataset.queueId === focusId)?.querySelector("textarea");
    if (editor && !editor.disabled) { editor.focus({ preventScroll: true }); editor.setSelectionRange(...selection); }
  }
}

async function mutateQueuedMessage(id, action, payload = {}) {
  if (queueMutations.has(id)) return;
  const threadId = selectedThreadId;
  queueMutations.add(id);
  renderQueuedMessages();
  try {
    const result = await postJson(`/api/threads/${encodeURIComponent(threadId)}/queue/${encodeURIComponent(id)}`, { action, ...payload });
    if (["update", "cancelEdit", "remove", "send"].includes(action)) queueEditDrafts.delete(`${threadId}/${id}`);
    if (selectedThreadId === threadId && currentThread?.id === threadId) {
      currentThread = { ...currentThread, control: result.control };
      renderThread(currentThread, { authoritativeSnapshot: false });
    }
  } catch (error) {
    if (handleUnauthorized(error)) return;
    if (selectedThreadId === threadId) composerError = error.message;
  } finally {
    queueMutations.delete(id);
    updateComposer();
    if (action === "edit" && selectedThreadId === threadId) {
      const row = [...queuedMessageList.querySelectorAll("[data-queue-id]")].find((row) => row.dataset.queueId === id);
      row?.querySelector("textarea")?.focus({ preventScroll: true });
    }
    void syncSelectedThread();
  }
}

function renderApprovals(requests = []) {
  if (!currentThread || currentThread.id !== selectedThreadId) return;
  requestTray.render(requests, selectedThreadId,
    networkOffline() || ["offline", "disconnected", "error"].includes(transportState));
}

function isFollowingOutput() {
  if (!messageList.dataset.rendered) return true;
  return messageList.scrollHeight
    - messageList.scrollTop
    - messageList.clientHeight < 120;
}

function clipLiveText(value) {
  return String(value ?? "").slice(0, MAX_LIVE_MESSAGE_LENGTH);
}

function safeMessageImages(value) {
  return (Array.isArray(value) ? value : []).flatMap((image) => {
    const src = typeof image?.src === "string" ? image.src.trim() : "";
    if (!(
      /^\/api\/images\/[a-z]+_[a-f0-9]{32}$/.test(src)
      || /^https:\/\//i.test(src)
      || /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(src)
    )) return [];
    return [{ src, alt: String(image.alt || "图片").slice(0, 160) }];
  });
}

function renderImageViewer() {
  const image = viewerImages[viewerImageIndex];
  if (!image) return closeImageViewer();
  imageViewerImage.src = image.src;
  imageViewerImage.alt = image.alt;
  imageViewerCaption.textContent = image.alt;
  const multiple = viewerImages.length > 1;
  imageViewer.dataset.multiple = String(multiple);
  imageViewerPrev.hidden = !multiple;
  imageViewerNext.hidden = !multiple;
}

function openImageViewer(images, index = 0) {
  viewerImages = safeMessageImages(images);
  if (!viewerImages.length) return;
  viewerImageIndex = Math.max(0, Math.min(index, viewerImages.length - 1));
  imageViewer.hidden = false;
  renderImageViewer();
  imageViewer.focus?.();
}

function closeImageViewer() {
  viewerImages = [];
  viewerImageIndex = 0;
  imageViewer.hidden = true;
  imageViewerImage.removeAttribute?.("src");
  imageViewerImage.alt = "";
  imageViewerCaption.textContent = "";
}

function moveImageViewer(offset) {
  if (viewerImages.length < 2) return;
  viewerImageIndex = (viewerImageIndex + offset + viewerImages.length) % viewerImages.length;
  renderImageViewer();
}

function updateMessageImages(record, value) {
  const images = safeMessageImages(value);
  const signature = JSON.stringify(images);
  if (record.mediaSignature === signature) return;
  record.mediaSignature = signature;
  record.media.replaceChildren();
  record.media.hidden = images.length === 0;
  record.media.dataset.count = String(images.length);
  if (!images.length) return;
  if (!record.mediaAttached) {
    if (record.actions && record.article.insertBefore) record.article.insertBefore(record.media, record.actions);
    else record.article.append(record.media);
    record.mediaAttached = true;
  }
  images.forEach((image, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "message-image-button";
    button.setAttribute("aria-label", `查看图片：${image.alt}`);
    button.title = image.alt;
    const preview = document.createElement("img");
    preview.src = image.src;
    preview.alt = image.alt;
    preview.loading = "lazy";
    preview.decoding = "async";
    preview.referrerPolicy = "no-referrer";
    preview.addEventListener("error", () => {
      button.dataset.error = "true";
      button.setAttribute("aria-label", `图片加载失败：${image.alt}`);
    });
    button.append(preview);
    button.addEventListener("click", () => openImageViewer(images, index));
    record.media.append(button);
  });
}

function createMessageNode(message) {
  const article = document.createElement("article");
  article.className = "message";

  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("span");
  author.className = "message-author";
  const time = document.createElement("time");
  meta.append(author, time);

  const body = document.createElement("div");
  body.className = "message-body";
  const receipt = document.createElement("span");
  receipt.className = "message-receipt";
  receipt.hidden = true;
  const media = document.createElement("div");
  media.className = "message-media";
  media.hidden = true;
  article.append(meta, body, receipt);

  const actions = document.createElement("div");
  actions.className = "message-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-copy-button";
  copy.title = "复制消息";
  copy.setAttribute("aria-label", "复制消息");
  copy.append(createIcon(["M9 9h11v11H9z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"]));
  const actionTime = document.createElement("time");
  actionTime.className = "message-action-time";
  actionTime.hidden = true;
  const copyStatus = document.createElement("span");
  copyStatus.className = "message-copy-status";
  copyStatus.setAttribute("role", "status");
  actions.append(copy, actionTime, copyStatus);
  article.append(actions);

  const record = {
    article,
    author,
    time,
    body,
    receipt,
    media,
    actions,
    copy,
    actionTime,
    copyStatus,
    mediaAttached: false,
    mediaSignature: "",
    kind: "message",
  };
  copy.addEventListener("click", () => copyMessage(record));
  const setResponseState = (key, active) => {
    const target = record.responseActionRecord?.article;
    if (!target) return;
    if (active) target.dataset[key] = "true";
    else delete target.dataset[key];
  };
  article.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "touch") setResponseState("responseHovered", true);
  });
  article.addEventListener("pointerleave", () => setResponseState("responseHovered", false));
  article.addEventListener("focusin", () => setResponseState("responseFocused", true));
  article.addEventListener("focusout", () => setResponseState("responseFocused", false));
  article.addEventListener("pointerup", (event) => {
    const actionRecord = record.responseActionRecord || record;
    if (event.pointerType !== "touch" || actionRecord.actions.hidden
      || event.target?.closest?.("button, a, input, textarea, summary")
      || globalThis.getSelection?.()?.isCollapsed === false) return;
    const selected = activeMessageArticle === actionRecord.article;
    clearActiveMessage();
    if (!selected) {
      activeMessageArticle = actionRecord.article;
      activeMessageArticle.dataset.actionsActive = "true";
    }
  });
  updateMessageNode(record, message);
  return record;
}

function clearActiveMessage() {
  if (activeMessageArticle) delete activeMessageArticle.dataset.actionsActive;
  activeMessageArticle = null;
}

async function writeClipboardText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Plain HTTP connections may require the older, user-initiated copy path.
  }
  const previousFocus = document.activeElement;
  const selection = globalThis.getSelection?.();
  const ranges = [];
  for (let index = 0; index < (selection?.rangeCount || 0); index++) ranges.push(selection.getRangeAt(index).cloneRange());
  const input = document.createElement("textarea");
  input.className = "clipboard-transfer";
  input.value = text;
  input.setAttribute("readonly", "");
  try {
    document.body.append(input);
    input.select();
    if (!document.execCommand?.("copy")) throw new Error("Copy failed");
  } finally {
    input.remove();
    previousFocus?.focus?.({ preventScroll: true });
    if (ranges.length) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}

async function copyMessage(record) {
  if (!record.copySource || record.copyPending) return;
  record.copyPending = true;
  record.copy.disabled = true;
  globalThis.clearTimeout?.(record.copyTimer);
  try {
    await writeClipboardText(record.copySource);
    record.copy.dataset.state = "copied";
    record.copy.title = "已复制";
    record.copy.setAttribute("aria-label", "已复制");
    record.copyStatus.textContent = "已复制";
  } catch {
    record.copy.dataset.state = "error";
    record.copy.title = "复制失败，请重试";
    record.copy.setAttribute("aria-label", "复制失败，请重试");
    record.copyStatus.textContent = "复制失败";
  } finally {
    record.copyPending = false;
    record.copy.disabled = !record.copySource;
    record.copyTimer = globalThis.setTimeout?.(() => {
      delete record.copy.dataset.state;
      record.copy.title = "复制消息";
      record.copy.setAttribute("aria-label", "复制消息");
      record.copyStatus.textContent = "";
    }, 1800);
  }
}

function updateMessageActions(record, message, visible = message.role === "user") {
  record.copySource = message.text || "";
  record.actions.hidden = !visible;
  record.article.tabIndex = visible ? 0 : -1;
  record.article.dataset.hasActions = String(visible);
  record.copy.hidden = !message.text;
  record.copy.disabled = Boolean(record.copyPending) || !message.text;
  if (record.actionTimestamp === message.timestamp) return;
  record.actionTimestamp = message.timestamp;
  const date = new Date(Number(message.timestamp) * 1000);
  const validTime = Boolean(message.timestamp) && Number.isFinite(date.getTime());
  record.actionTime.hidden = !validTime;
  if (validTime) {
    const label = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
    if (record.actionTime.textContent !== label) record.actionTime.textContent = label;
    record.actionTime.dateTime = date.toISOString();
    record.actionTime.title = date.toLocaleString("zh-CN", { hour12: false });
  }
}

function updateResponseActions(turn) {
  const replies = turn.messages.filter((message) => message.role === "assistant" && message.kind === "message" && message.text);
  const last = replies.at(-1);
  const actionRecord = last ? messageNodes.get(last.id) : null;
  for (const message of turn.messages) {
    if (message.role !== "assistant") continue;
    const record = messageNodes.get(message.id);
    if (record) {
      record.responseActionRecord = actionRecord;
      record.article.dataset.responsePart = String(message.kind === "message" && Boolean(message.text));
    }
  }
  if (!actionRecord) return;
  updateMessageActions(actionRecord, {
    ...last,
    text: replies.map((message) => message.text).join("\n\n"),
  }, true);
}

function updateMessageBody(record, message) {
  const text = message.text || "";
  const format = message.role === "assistant" ? "markdown" : "plain";
  if (record.bodySource !== text || record.bodyFormat !== format) {
    record.body.dataset.format = format;
    if (format === "markdown") renderMarkdown(record.body, text);
    else record.body.textContent = text;
    record.bodySource = text;
    record.bodyFormat = format;
  }
  record.body.hidden = !text;
}

function updateMessageNode(record, message) {
  record.article.dataset.role = message.role;
  record.article.dataset.kind = message.kind;

  if (message.pending) record.article.dataset.pending = "true";
  else delete record.article.dataset.pending;

  const live = liveMessages.get(message.id);
  if (live && !live.completed) record.article.dataset.streaming = "true";
  else delete record.article.dataset.streaming;

  const author = messageLabel(message);
  const time = formatTime(message.timestamp);
  if (record.author.textContent !== author) record.author.textContent = author;
  if (record.time.textContent !== time) record.time.textContent = time;
  updateMessageBody(record, message);
  updateMessageImages(record, message.images);
  updateMessageActions(record, message);

  const receipt = message.role === "user"
    ? {
        sending: "发送中",
        sent: "已送达",
        queued: "等待中",
        steered: "已调整方向",
      }[message.deliveryState] || ""
    : "";
  record.receipt.hidden = !receipt;
  if (record.receipt.textContent !== receipt) record.receipt.textContent = receipt;
}

function messagesByCommand(messages) {
  const turns = [];
  for (const [index, message] of groupActivityMessages(messages).entries()) {
    const sourceTurnId = message.turnId || "";
    const startsCommand = message.role === "user";
    let turn = turns.at(-1);
    if (startsCommand || !turn) {
      const seed = message.id || sourceTurnId || String(index);
      turn = {
        id: `${startsCommand ? "command" : "orphan"}:${seed}`,
        userMessage: startsCommand ? message : null,
        sourceTurnIds: new Set(),
        messages: [],
      };
      turns.push(turn);
    }
    if (sourceTurnId) turn.sourceTurnIds.add(sourceTurnId);
    turn.messages.push(message);
  }
  return turns;
}

function processLabel(turn) {
  const timings = (currentThread?.turns || []).filter((item) => turn.sourceTurnIds.has(item.id));
  if (!timings.length || timings.some((item) => !Number.isFinite(item.durationMs) || item.durationMs < 0)) return "执行过程";
  const seconds = Math.round(timings.reduce((total, item) => total + item.durationMs, 0) / 1000);
  const minutes = Math.floor(seconds / 60);
  return `用时 ${minutes ? `${minutes}分` : ""}${seconds % 60}秒`;
}

function processNode(turn, articles) {
  const cached = historyNodes.get(turn.id);
  if (cached) {
    cached.title.textContent = processLabel(turn);
    reconcileChildren(cached.content, articles);
    return cached.details;
  }
  const details = document.createElement("details");
  details.className = "turn-process";
  details.dataset.commandId = turn.id;
  details.dataset.turnId = [...turn.sourceTurnIds][0] || "";
  const expansionKey = `${selectedThreadId}\u0000${turn.id}`;
  details.open = expandedTurns.has(expansionKey);

  const summary = document.createElement("summary");
  summary.className = "turn-process-summary";
  const title = document.createElement("span");
  title.textContent = processLabel(turn);
  const chevron = document.createElement("span");
  chevron.className = "reasoning-chevron";
  chevron.setAttribute("aria-hidden", "true");
  summary.append(title, chevron);

  const content = document.createElement("div");
  content.className = "turn-process-content";
  content.append(...articles);
  details.append(summary, content);
  details.addEventListener("toggle", () => {
    if (details.open) expandedTurns.add(expansionKey);
    else expandedTurns.delete(expansionKey);
  });
  historyNodes.set(turn.id, { details, title, content });
  return details;
}

function reconcileChildren(parent, children) {
  if (typeof parent.insertBefore !== "function") {
    parent.replaceChildren(...children);
    return;
  }
  // Retain DOM identity so live snapshots do not interrupt selection or scrolling.
  for (const [index, child] of children.entries()) {
    if (parent.children[index] !== child) parent.insertBefore(child, parent.children[index] || null);
  }
  while (parent.children.length > children.length) parent.lastElementChild.remove();
}

function messageRecord(message) {
  let record = messageNodes.get(message.id);
  if (message.kind === "reasoning") {
    if (!record) {
      const article = document.createElement("article");
      article.className = "message thinking-status";
      article.dataset.kind = "reasoning";
      article.setAttribute("role", "status");
      const spinner = document.createElement("span");
      spinner.className = "reasoning-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = "思考中";
      article.append(spinner, label);
      record = { article, kind: "reasoning" };
      messageNodes.set(message.id, record);
    }
  } else if (message.kind === "activityGroup") {
    const signature = JSON.stringify(message);
    if (record?.signature === signature) return record;
    if (record?.kind === "activityGroup") {
      const details = record.article.children[0];
      const updated = renderActivityGroup(message).children[0];
      reconcileChildren(details.children[0], [...updated.children[0].children]);
      reconcileChildren(details.children[1], [...updated.children[1].children]);
      record.signature = signature;
      return record;
    }
    record = {
      article: renderActivityGroup(message),
      kind: "activityGroup",
      signature,
    };
    messageNodes.set(message.id, record);
  } else if (!record || record.kind !== "message") {
    record = createMessageNode(message);
    messageNodes.set(message.id, record);
  } else {
    updateMessageNode(record, message);
  }
  return record;
}

function reconcileMessageNodes(messages) {
  const ordered = [];
  const visibleIds = new Set();

  const turns = messagesByCommand(messages);
  const activeTurnId = currentThread?.control?.turnId || "";
  for (const [index, turn] of turns.entries()) {
    const articles = turn.messages.map((message) => {
      visibleIds.add(message.id);
      return messageRecord(message).article;
    });
    updateResponseActions(turn);
    const latest = index === turns.length - 1;
    const active = currentThread?.control?.busy && (activeTurnId ? turn.sourceTurnIds.has(activeTurnId) : latest);
    const hasResult = turn.messages.some((message) =>
      (message.role === "assistant" && ["message", "image"].includes(message.kind)) || message.kind === "error");
    const isProcess = (message) => ["commentary", "activityGroup", "plan"].includes(message.kind)
      || (message.role === "system" && message.kind === "image");
    const processArticles = articles.filter((_, i) => isProcess(turn.messages[i]));
    if (active || !hasResult || !processArticles.length) {
      ordered.push(...articles);
      if (active && historyNodes.has(turn.id)) {
        historyNodes.get(turn.id).details.open = false;
        expandedTurns.delete(`${selectedThreadId}\u0000${turn.id}`);
      }
      continue;
    }
    // Move existing process nodes into one disclosure, retaining the answer's DOM.
    let insertedProcess = false;
    articles.forEach((article, i) => {
      if (isProcess(turn.messages[i])) {
        if (!insertedProcess) ordered.push(processNode(turn, processArticles));
        insertedProcess = true;
      } else ordered.push(article);
    });
  }

  for (const id of messageNodes.keys()) {
    if (!visibleIds.has(id)) messageNodes.delete(id);
  }
  const visibleTurns = new Set(turns.map((turn) => turn.id));
  for (const id of historyNodes.keys()) if (!visibleTurns.has(id)) historyNodes.delete(id);
  reconcileChildren(messageList, ordered);
}

function mergeCumulativeText(currentText, incomingText) {
  const current = clipLiveText(currentText);
  const incoming = clipLiveText(incomingText);
  if (!current) return incoming;
  if (!incoming) return current;
  if (incoming.startsWith(current)) return incoming;
  if (current.startsWith(incoming)) return current;
  return incoming;
}

function snapshotCaughtUp(snapshotText, liveText) {
  return snapshotText === liveText
    || (
      liveText.length === MAX_LIVE_MESSAGE_LENGTH
      && snapshotText.startsWith(liveText)
    );
}

function terminalActivityStatus(status) {
  return ["completed", "failed", "declined", "systemError"].includes(status);
}

function mergeThreadWithDesktopSnapshot(thread) {
  const snapshot = desktopThreadSnapshot;
  if (!snapshot || snapshot.id !== thread.id) return thread;

  const timings = new Map((thread.turns || []).map((turn) => [turn.id, turn]));
  for (const turn of snapshot.turns || []) {
    if (turnHasEnded(thread, turn.id) && !turnHasEnded(snapshot, turn.id)) continue;
    if (!timings.has(turn.id) || (Number.isFinite(turn.durationMs) && turn.durationMs >= 0)) {
      timings.set(turn.id, turn);
    }
  }
  const messages = [...(thread.messages || [])];
  const indexes = new Map(messages.map((message, index) => [message.id, index]));
  for (const incoming of snapshot.messages || []) {
    const index = indexes.get(incoming.id);
    if (index === undefined) {
      indexes.set(incoming.id, messages.length);
      messages.push(incoming);
      continue;
    }

    const current = messages[index];
    if (
      terminalActivityStatus(current.activityStatus)
      && !terminalActivityStatus(incoming.activityStatus)
    ) continue;

    const merged = { ...current, ...incoming };
    if (
      typeof current.text === "string"
      && typeof incoming.text === "string"
      && current.text.startsWith(incoming.text)
    ) merged.text = current.text;
    messages[index] = merged;
  }

  return {
    ...thread,
    title: snapshot.title || thread.title,
    project: snapshot.project || thread.project,
    status: snapshot.status || thread.status,
    updatedAt: Math.max(thread.updatedAt || 0, snapshot.updatedAt || 0),
    turns: [...timings.values()],
    messages,
    control: {
      ...(thread.control || {}),
      ...(turnHasEnded(thread, snapshot.control?.turnId) ? {} : snapshot.control || {}),
      requests: thread.control?.requests || [],
    },
  };
}

function mergeThreadWithLiveMessages(thread, authoritativeSnapshot) {
  const activeId = currentThread?.control?.turnId;
  const newerStream = activeId && !thread.control?.busy
    && !(thread.turns || []).some((turn) => turn.id === activeId)
    && [...liveMessages.values()].some((live) => !live.completed && live.message.turnId === activeId);
  if (authoritativeSnapshot && newerStream) {
    thread = { ...thread, control: { ...thread.control, busy: true, turnId: activeId, phase: "running" } };
  }
  const messages = [...(thread.messages || [])];
  const indexes = new Map(messages.map((message, index) => [message.id, index]));

  for (const [itemId, live] of liveMessages) {
    // Polling also closes streams when an item/completed event was missed.
    if ((authoritativeSnapshot && !thread.control?.busy) || turnHasEnded(thread, live.message.turnId)) {
      live.completed = true;
      queuedMessageDeltas.delete(itemId);
    }
    const index = indexes.get(itemId);
    if (index === undefined) {
      indexes.set(itemId, messages.length);
      messages.push(live.message);
      continue;
    }

    const snapshotMessage = messages[index];
    if (live.completed) {
      if (snapshotMessage.text.startsWith(live.message.text)) live.message = { ...live.message, text: snapshotMessage.text };
      if (
        authoritativeSnapshot
        && snapshotCaughtUp(snapshotMessage.text, live.message.text)
      ) {
        liveMessages.delete(itemId);
      } else {
        messages[index] = { ...snapshotMessage, ...live.message };
      }
      continue;
    }

    let text = live.message.text;
    if (snapshotMessage.text.startsWith(text)) {
      text = clipLiveText(snapshotMessage.text);
      live.message = { ...snapshotMessage, ...live.message, text };
    }
    messages[index] = { ...snapshotMessage, ...live.message, text };
  }

  const hasActiveStream = [...liveMessages.values()]
    .some((live) => !live.completed);
  return {
    ...thread,
    messages,
    control: {
      ...(thread.control || {}),
      busy: authoritativeSnapshot ? Boolean(thread.control?.busy) : Boolean(thread.control?.busy || hasActiveStream),
      requests: thread.control?.requests || [],
    },
  };
}

function turnHasEnded(thread, turnId) {
  return Boolean(turnId) && (thread?.turns || []).some((turn) =>
    turn.id === turnId && ["completed", "failed", "interrupted"].includes(turn.status));
}

function ensureCurrentThreadForLive(threadId) {
  if (threadId !== selectedThreadId) return false;
  if (currentThread?.id === threadId) return true;

  const summary = threads.find((thread) => thread.id === threadId) || {};
  currentThread = {
    ...summary,
    id: threadId,
    title: summary.title || "Codex",
    project: summary.project || "当前项目",
    status: summary.status || "active",
    messages: [],
    control: { busy: true, requests: [] },
  };
  return true;
}

function upsertCurrentMessage(message, { markBusy = true } = {}) {
  const messages = [...(currentThread?.messages || [])];
  const index = messages.findIndex((item) => item.id === message.id);
  if (index === -1) messages.push(message);
  else messages[index] = message;

  currentThread = {
    ...currentThread,
    messages,
    control: {
      ...(currentThread?.control || {}),
      ...(markBusy ? { busy: true } : {}),
      requests: currentThread?.control?.requests || [],
    },
  };
}

function liveMessage(value, text = value.text) {
  return {
    id: value.itemId,
    turnId: value.turnId || "",
    role: "assistant",
    kind: value.kind === "commentary" ? "commentary" : "message",
    text: clipLiveText(text),
    timestamp: value.timestamp ?? Math.floor(Date.now() / 1000),
  };
}

function handleMessageStart(value) {
  if (!ensureCurrentThreadForLive(value.threadId)) return;
  if (turnHasEnded(currentThread, value.turnId) || liveMessages.get(value.itemId)?.completed) return;

  if (pendingMessage && value.turnId) {
    pendingMessage = { ...pendingMessage, turnId: value.turnId };
  }
  if (value.turnId) {
    currentThread = {
      ...currentThread,
      control: {
        ...(currentThread.control || {}),
        busy: true,
        turnId: value.turnId,
      },
    };
  }

  const previous = liveMessages.get(value.itemId);
  if (previous?.completed) return;

  const persisted = currentThread.messages
    .find((message) => message.id === value.itemId);
  const previousText = previous?.message.text ?? persisted?.text ?? "";
  const message = liveMessage(
    value,
    mergeCumulativeText(previousText, value.text),
  );

  liveMessages.set(value.itemId, { message, completed: false });
  upsertCurrentMessage(message);
  renderThread(currentThread, { authoritativeSnapshot: false });
}

function flushMessageDeltas(epoch, threadId) {
  deltaFrameId = null;
  if (selectionEpoch !== epoch || selectedThreadId !== threadId) {
    queuedMessageDeltas.clear();
    return;
  }

  const batches = [...queuedMessageDeltas.entries()];
  queuedMessageDeltas.clear();
  const followOutput = isFollowingOutput();
  let needsReconcile = false;

  for (const [itemId, chunks] of batches) {
    const live = liveMessages.get(itemId);
    if (live?.completed) continue;

    const persisted = currentThread?.messages
      ?.find((message) => message.id === itemId);
    const base = live?.message || persisted || {
      id: itemId,
      turnId: currentThread?.control?.turnId || "",
      role: "assistant",
      kind: "message",
      text: "",
      timestamp: Math.floor(Date.now() / 1000),
    };
    const message = {
      ...base,
      text: clipLiveText(`${base.text}${chunks.join("")}`),
    };

    liveMessages.set(itemId, { message, completed: false });
    upsertCurrentMessage(message);

    const record = messageNodes.get(itemId);
    if (record?.kind === "message") {
      updateMessageBody(record, message);
    } else {
      needsReconcile = true;
    }
  }

  if (!currentThread) return;
  if (needsReconcile) {
    renderThread(currentThread, {
      authoritativeSnapshot: false,
      autoScroll: false,
    });
  } else {
    if (currentThread.messages.length || pendingMessage) {
      setConversationPlaceholder("", "", false);
      messageList.hidden = false;
    }
    const state = currentThread.control?.busy
      ? "运行中"
      : statusLabel(currentThread.status);
    conversationMeta.textContent =
      `${currentThread.project} · ${state}`;
    updateComposer();
  }

  if (followOutput && currentThread.messages.length) {
    messageList.scrollTop = messageList.scrollHeight;
    messageList.dataset.rendered = "true";
  }
  updateLatestButton();
}

function queueMessageDelta(value) {
  if (!ensureCurrentThreadForLive(value.threadId)) return;
  if (turnHasEnded(currentThread, value.turnId) || liveMessages.get(value.itemId)?.completed) return;

  const chunks = queuedMessageDeltas.get(value.itemId) || [];
  chunks.push(value.delta);
  queuedMessageDeltas.set(value.itemId, chunks);

  if (deltaFrameId !== null) return;
  const epoch = selectionEpoch;
  const threadId = selectedThreadId;
  deltaFrameId = requestAnimationFrame(
    () => flushMessageDeltas(epoch, threadId),
  );
}

function handleMessageDone(value) {
  if (!ensureCurrentThreadForLive(value.threadId)) return;

  queuedMessageDeltas.delete(value.itemId);
  if (!queuedMessageDeltas.size && deltaFrameId !== null) {
    if (typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(deltaFrameId);
    }
    deltaFrameId = null;
  }

  const persisted = currentThread.messages.find((message) => message.id === value.itemId);
  const message = liveMessage(value, mergeCumulativeText(persisted?.text, value.text));
  liveMessages.set(value.itemId, { message, completed: true });
  upsertCurrentMessage(message, { markBusy: false });
  renderThread(currentThread, { authoritativeSnapshot: false });
}

function insertPendingMessage(messages) {
  if (!pendingMessage) return messages;
  const firstNewMessage = messages.findIndex(
    (message) => !pendingMessage.knownMessageIds.has(message.id),
  );
  const insertionIndex = firstNewMessage === -1
    ? messages.length
    : firstNewMessage;
  return [
    ...messages.slice(0, insertionIndex),
    pendingMessage,
    ...messages.slice(insertionIndex),
  ];
}

function persistedMessageMatchesPending(message, pending) {
  if (message.role !== "user" || pending.knownMessageIds.has(message.id)) return false;
  if (pending.clientId && message.clientId === pending.clientId) return true;
  if (pending.text && message.text === pending.text) return true;
  const invokedText = [
    ...(pending.skillNames || []).map((name) => `$${name}`),
    pending.text,
  ].join("\n");
  return Boolean(pending.text) && message.text === invokedText;
}

function renderThread(
  thread,
  { authoritativeSnapshot = true, autoScroll = true } = {},
) {
  if (thread.id !== selectedThreadId) return;

  const followOutput = isFollowingOutput();
  currentThread = mergeThreadWithLiveMessages(
    mergeThreadWithDesktopSnapshot(thread),
    authoritativeSnapshot,
  );
  if (!currentThread.control?.busy && !interruptRequestThreads.has(thread.id)) {
    interruptingThreads.delete(thread.id);
  }
  const persistedPendingMessage = pendingMessage
    && [...currentThread.messages].reverse().find(
      (message) => persistedMessageMatchesPending(message, pendingMessage),
    );
  if (persistedPendingMessage) {
    deliveredMessageIds.add(persistedPendingMessage.id);
    pendingMessage = null;
  }
  if (deliveredMessageIds.size) {
    currentThread = {
      ...currentThread,
      messages: currentThread.messages.map((message) =>
        deliveredMessageIds.has(message.id)
          ? { ...message, deliveryState: "sent" }
          : message),
    };
  }

  const displayMessages = insertPendingMessage(currentThread.messages);
  const hasMessages = displayMessages.length > 0;
  const state = currentThread.control?.busy
    ? "运行中"
    : statusLabel(currentThread.status);
  conversationTitle.textContent = currentThread.title;
  conversationTitle.title = currentThread.title;
  conversationMeta.textContent =
    `${currentThread.project} · ${state}`;

  if (hasMessages) {
    setConversationPlaceholder("", "", false);
    messageList.hidden = false;
  } else {
    setConversationPlaceholder("还没有消息");
  }
  renderApprovals(currentThread.control?.requests || []);
  updateComposer();
  reconcileMessageNodes(displayMessages);
  updateLatestButton();

  if (autoScroll && hasMessages && followOutput) {
    const initialRender = !messageList.dataset.rendered;
    if (initialRender) {
      messageList.scrollTop = messageList.scrollHeight;
      messageList.dataset.rendered = "true";
      updateLatestButton();
      return;
    }
    const epoch = selectionEpoch;
    const threadId = currentThread.id;
    const scrollTop = messageList.scrollTop;
    requestAnimationFrame(() => {
      if (selectionEpoch !== epoch || selectedThreadId !== threadId) return;
      if (messageList.scrollTop < scrollTop - 1) return;
      messageList.scrollTop = messageList.scrollHeight;
      messageList.dataset.rendered = "true";
      updateLatestButton();
    });
  }
}

function closeEvents() {
  eventSource?.close();
  eventSource = null;
}

class PollingEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url.replace("/api/events", "/api/sync");
    this.closed = false;
    this.opened = false;
    this.failures = 0;
    this.lastQueueEvent = 0;
    this.timer = null;
    this.firstPoll = Promise.resolve().then(() => this.poll());
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }

  async poll() {
    if (this.closed) return;
    try {
      if (document.visibilityState === "hidden") return;
      const result = await requestJson(this.url);
      if (this.closed) return;
      if (!Array.isArray(result.events)) throw new Error("同步数据无效");
      this.failures = 0;
      if (!this.opened) {
        this.opened = true;
        this.onopen?.();
      }
      for (const { event, value } of result.events) {
        if (this.closed) return;
        if (event === "queueStarted" || event === "queueFailed") {
          if (value.eventId === this.lastQueueEvent) continue;
          this.lastQueueEvent = value.eventId;
        }
        this.dispatchEvent(new MessageEvent(event, { data: JSON.stringify(value) }));
      }
    } catch (error) {
      if (this.closed || handleUnauthorized(error)) return;
      this.failures += 1;
      this.onerror?.();
    } finally {
      if (!this.closed) {
        const delay = this.failures ? Math.min(10_000, 1000 * 2 ** Math.min(this.failures, 4))
          : document.visibilityState === "hidden" ? 5000 : currentThread?.control?.busy ? 500 : 1500;
        this.timer = setTimeout(() => this.poll(), delay);
      }
    }
  }
}

function eventValue(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function validLiveEvent(value, subscriptionThreadId) {
  return value
    && value.threadId === subscriptionThreadId
    && typeof value.itemId === "string"
    && value.itemId;
}

function connectEvents(subscriptionEpoch = selectionEpoch) {
  if (queuedMessageDeltas.size) flushMessageDeltas(selectionEpoch, selectedThreadId);
  cancelQueuedMessageDeltas();
  closeEvents();
  if (networkOffline()) {
    setConnection({ state: "offline" });
    return;
  }
  const subscriptionThreadId = selectedThreadId;
  const query = subscriptionThreadId
    ? `?threadId=${encodeURIComponent(subscriptionThreadId)}`
    : "";
  const source = usePolling
    ? new PollingEventSource(`/api/events${query}`)
    : new EventSource(`/api/events${query}`);
  eventSource = source;
  setConnection({ state: "connecting" });
  lastEventAt = Date.now();

  const isCurrentSubscription = () => {
    const current = eventSource === source
    && selectedThreadId === subscriptionThreadId
    && selectionEpoch === subscriptionEpoch;
    if (current) lastEventAt = Date.now();
    return current;
  };
  source.addEventListener("heartbeat", () => { isCurrentSubscription(); });
  source.onopen = () => {
    if (!isCurrentSubscription()) return;
    if (initialLoadEpoch !== selectionEpoch) void syncSelectedThread();
  };

  source.addEventListener("threads", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (!Array.isArray(value)) return;
    threads = value;
    renderThreads();
    const lastThread = rememberedThread();
    if (!selectedThreadId && threads.some((thread) => thread.id === lastThread)) {
      void selectThread(lastThread);
    }
  });
  source.addEventListener("projects", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (!Array.isArray(value)) return;
    projectCatalog = value;
    renderThreads();
  });
  source.addEventListener("thread", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (!value || value.id !== subscriptionThreadId) return;
    renderThread(value);
  });
  source.addEventListener("desktopThread", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (value === null) {
      desktopThreadSnapshot = null;
      return;
    }
    if (!value || value.id !== subscriptionThreadId) return;
    desktopThreadSnapshot = value;
    if (!ensureCurrentThreadForLive(value.id)) return;
    renderThread(currentThread, { authoritativeSnapshot: false });
  });
  source.addEventListener("messageStart", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (!validLiveEvent(value, subscriptionThreadId)) return;
    handleMessageStart(value);
  });
  source.addEventListener("messageDelta", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (
      !validLiveEvent(value, subscriptionThreadId)
      || typeof value.delta !== "string"
      || !value.delta
    ) return;
    queueMessageDelta(value);
  });
  source.addEventListener("messageDone", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (!validLiveEvent(value, subscriptionThreadId)) return;
    handleMessageDone(value);
  });
  source.addEventListener("queueStarted", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (!value || value.threadId !== subscriptionThreadId) return;
    // Replayed delivery receipts cannot resurrect an already completed turn.
    void syncSelectedThread();
  });
  source.addEventListener("queueFailed", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (!value || value.threadId !== subscriptionThreadId) return;
    if (currentThread?.id === value.threadId) {
      composerError = value.message || "等待消息发送失败";
      if (value.code === "THREAD_CONTINUATION_REQUIRED") continuationThreads.add(value.threadId);
      void syncSelectedThread();
    }
  });
  source.addEventListener("status", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (value) setConnection(value);
  });
  source.addEventListener("threadError", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    conversationMeta.textContent = value?.message || "读取会话失败";
    conversationActions.open = true;
  });
  source.onerror = async () => {
    if (!isCurrentSubscription()) return;
    setConnection({ state: networkOffline() ? "offline" : "disconnected" });
    if (networkOffline() || source instanceof PollingEventSource) return;
    if (!supportsPolling) {
      try {
        await requestJson("/api/bootstrap");
      } catch (error) {
        if (isCurrentSubscription()) handleUnauthorized(error);
      }
      return;
    }
    usePolling = true;
    return connectEvents(subscriptionEpoch);
  };
  return source.firstPoll;
}

async function syncSelectedThread() {
  const threadId = selectedThreadId;
  if (!threadId || app.hidden || networkOffline()) return;
  const epoch = selectionEpoch;
  const sync = ++syncEpoch;
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  try {
    const loaded = await requestJson(`/api/threads/${encodeURIComponent(threadId)}`);
    if (epoch !== selectionEpoch || sync !== syncEpoch) return;
    applyComposerCatalog(loaded.composerOptions);
    renderThread(loaded);
  } catch (error) {
    if (epoch !== selectionEpoch || sync !== syncEpoch) return;
    if (!handleUnauthorized(error)) {
      setConnection({ state: networkOffline() ? "offline" : "disconnected" });
    }
  } finally {
    if (sync === syncEpoch) {
      refreshButton.disabled = false;
      refreshButton.setAttribute("aria-busy", "false");
    }
  }
}

function reconnect() {
  if (app.hidden) return;
  saveDraft();
  connectEvents();
}

async function selectThread(threadId) {
  selectedArchived = archivedThreads.some((thread) => thread.id === threadId && thread.archived);
  if (sidebarMenu) closeSidebarMenu();
  conversationActions.open = false;
  if (threadId === selectedThreadId && currentThread) {
    app.classList.add("conversation-open");
    return;
  }
  saveDraft();
  const epoch = ++selectionEpoch;
  initialLoadEpoch = epoch;
  closeComposerMenu();
  closeImageViewer();
  keepImageDraft(selectedThreadId, pendingImages);
  pendingImages = imageDrafts.get(threadId) || [];
  imageDrafts.delete(threadId);
  renderPendingImages();
  resetLiveRendering();
  selectedThreadId = threadId;
  currentThread = null;
  pendingMessage = null;
  composerCatalog = null;
  composerError = "";
  messageInput.value = sendingThreads.has(threadId) ? "" : drafts.get(threadId)?.text || "";
  rememberThread(threadId);
  resizeComposer();
  messageList.replaceChildren();
  messageList.hidden = true;
  messageList.dataset.rendered = "";
  approvalTray.replaceChildren();
  approvalTray.hidden = true;
  app.classList.add("conversation-open");
  renderThreads();
  const thread = [...threads, ...archivedThreads].find((item) => item.id === threadId);
  conversationTitle.textContent = thread?.title || "加载会话";
  conversationTitle.title = thread?.title || "";
  conversationMeta.textContent = thread ? `${thread.project} · 正在同步` : "正在同步";
  setConversationPlaceholder("正在同步会话");
  renderComposerControls();
  updateComposer();
  connectEvents(epoch);
  try {
    const loaded = await requestJson(
      `/api/threads/${encodeURIComponent(threadId)}`,
    );
    if (selectionEpoch !== epoch || selectedThreadId !== threadId) return;
    applyComposerCatalog(loaded.composerOptions);
    renderThread(loaded);
  } catch (error) {
    if (handleUnauthorized(error)) return;
    if (selectionEpoch !== epoch || selectedThreadId !== threadId) return;
    conversationMeta.textContent = error.message;
    conversationActions.open = true;
    setConversationPlaceholder("无法加载会话", error.message);
  } finally {
    if (initialLoadEpoch === epoch) initialLoadEpoch = null;
  }
}

function createClientMessageId() {
  try {
    return globalThis.crypto?.randomUUID?.() || `web-${Date.now()}-${nextPendingImageId++}`;
  } catch {
    return `web-${Date.now()}-${nextPendingImageId++}`;
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = messageInput.value.trim();
  const threadId = selectedThreadId;
  const control = currentThread?.control || {};
  const running = Boolean(control.busy);
  if (running && !text && !pendingImages.some((image) => image.status === "ready")) {
    await interruptTurn(event);
    return;
  }
  const action = running ? "queue" : "start";
  const readyImages = pendingImages.filter((image) => image.status === "ready");
  if (
    (!text && !readyImages.length)
    || selectedArchived
    || networkOffline()
    || ["offline", "disconnected", "error"].includes(transportState)
    || !threadId
    || sendingThreads.has(threadId)
    || permissionUpdatingThreads.has(threadId)
    || interruptingThreads.has(threadId)
    || pendingImages.some((image) => image.status !== "ready")
    || (!running && composerSelection.mode === "goal" && !text)
  ) return;
  saveDraft();

  const selection = {
    model: composerSelection.model,
    effort: composerSelection.effort,
    mode: composerSelection.mode,
    skillNames: [...(composerSelection.skillNames || [])],
  };
  const clientId = createClientMessageId();
  const payload = {
    text,
    action,
    clientMessageId: clientId,
    imageIds: readyImages.map((image) => image.id),
  };
  if (composerCatalog?.models?.length && selection.model) {
    Object.assign(payload, selection);
  }

  const knownMessageIds = new Set((currentThread?.messages || []).map((message) => message.id));
  const optimisticMessage = {
    id: `pending-${Date.now()}`,
    turnId: `${action}-${clientId}`,
    clientId,
    role: "user",
    kind: "message",
    text,
    timestamp: Math.floor(Date.now() / 1000),
    pending: true,
    deliveryState: "sending",
    skillNames: selection.skillNames,
    images: readyImages.map((image) => ({
      src: image.src,
      alt: image.name || "上传的图片",
    })),
    knownMessageIds,
  };
  sendingThreads.add(threadId);
  closeComposerMenu();
  pendingMessage = action === "queue" ? null : optimisticMessage;
  pendingImages = [];
  composerError = "";
  messageInput.value = "";
  renderPendingImages();
  resizeComposer();
  if (currentThread) {
    renderThread(currentThread, { authoritativeSnapshot: false });
  }
  updateComposer();
  try {
    const result = await postJson(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      payload,
    );
    if (drafts.get(threadId)?.text?.trim() === text) writeDraft(threadId, "");
    if (selectedThreadId !== threadId || currentThread?.id !== threadId) return;
    if (composerCatalog && result.goal !== undefined) {
      composerCatalog.goal = result.goal;
      renderComposerControls();
    }
    if (pendingMessage?.id === optimisticMessage.id) {
      const deliveryState = result.delivery === "queued"
        ? "queued"
        : result.delivery === "steered" ? "steered" : "sent";
      pendingMessage = {
        ...pendingMessage,
        pending: false,
        turnId: result.turnId || pendingMessage.turnId,
        deliveryState,
        delivery: result.delivery || "accepted",
      };
    }
    if (result.delivery === "queued") pendingMessage = null;
    if (result.delivery === "codex-app" && desktopThreadSnapshot?.id === threadId) {
      desktopThreadSnapshot = {
        ...desktopThreadSnapshot,
        control: {
          ...(desktopThreadSnapshot.control || {}),
          busy: Boolean(result.control?.busy),
          phase: "starting",
          turnId: result.turnId || desktopThreadSnapshot.control?.turnId || null,
        },
      };
    }
    if (currentThread) {
      currentThread = {
        ...currentThread,
        control: {
          ...currentThread.control,
          ...result.control,
          busy: !turnHasEnded(currentThread, result.turnId) && Boolean(result.control?.busy),
        },
      };
      renderThread(currentThread, { authoritativeSnapshot: false });
    }
  } catch (error) {
    if (handleUnauthorized(error)) return;
    if (selectedThreadId === threadId) {
      if (!messageInput.value) {
        messageInput.value = text;
        resizeComposer();
      }
      if (pendingMessage?.id === optimisticMessage.id || action === "queue") {
        pendingMessage = null;
        if (!messageInput.value) {
          messageInput.value = text;
          resizeComposer();
        }
        if (!pendingImages.length) {
          pendingImages = readyImages;
          renderPendingImages();
        }
        if (currentThread) {
          renderThread(currentThread, { authoritativeSnapshot: false });
        }
      }
      composerError = error.message;
      if (error.code === "THREAD_CONTINUATION_REQUIRED") continuationThreads.add(threadId);
    } else {
      if (!drafts.get(threadId)?.text) writeDraft(threadId, text);
      if (!imageDrafts.has(threadId)) keepImageDraft(threadId, readyImages);
      else releaseImages(readyImages);
    }
  } finally {
    sendingThreads.delete(threadId);
    if (selectedThreadId === threadId) saveDraft();
    updateComposer();
    if (selectedThreadId === threadId) void syncSelectedThread();
  }
}

async function continueInWeb() {
  const threadId = selectedThreadId;
  if (!continuationThreads.has(threadId) || sendingThreads.has(threadId)
    || currentThread?.control?.busy || networkOffline()) return;
  saveDraft();
  sendingThreads.add(threadId);
  updateComposer();
  try {
    const result = await postJson(`/api/threads/${encodeURIComponent(threadId)}/continue`, {});
    const next = result.thread;
    if (!next?.id || next.id === threadId) throw new Error("未能创建续接会话，请重试");
    if (!threads.some((thread) => thread.id === next.id)) threads.unshift(next);
    writeDraft(next.id, drafts.get(threadId)?.text || "");
    if (selectedThreadId !== threadId) { renderThreads(); return; }
    const images = pendingImages;
    pendingImages = [];
    await selectThread(next.id);
    if (selectedThreadId === next.id) {
      pendingImages = images;
      renderPendingImages();
      resizeComposer();
      messageInput.focus();
    }
  } catch (error) {
    if (handleUnauthorized(error)) return;
    if (selectedThreadId === threadId) composerError = error.message;
  } finally {
    sendingThreads.delete(threadId);
    updateComposer();
  }
}

async function interruptTurn(event) {
  event.preventDefault();
  const threadId = selectedThreadId;
  if (
    !threadId
    || !currentThread?.control?.busy
    || interruptingThreads.has(threadId)
  ) return;

  closeComposerMenu();
  interruptingThreads.add(threadId);
  interruptRequestThreads.add(threadId);
  composerError = "";
  updateComposer();
  try {
    const result = await postJson(
      `/api/threads/${encodeURIComponent(threadId)}/interrupt`,
      {},
    );
    if (selectedThreadId !== threadId || currentThread?.id !== threadId) return;
    currentThread = {
      ...currentThread,
      control: {
        ...currentThread.control,
        ...result.control,
      },
    };
    renderThread(currentThread, { authoritativeSnapshot: false });
  } catch (error) {
    interruptingThreads.delete(threadId);
    if (handleUnauthorized(error)) return;
    if (selectedThreadId === threadId) composerError = error.message;
  } finally {
    interruptRequestThreads.delete(threadId);
    if (
      selectedThreadId === threadId
      && currentThread?.id === threadId
      && !currentThread.control?.busy
    ) {
      interruptingThreads.delete(threadId);
    }
    updateComposer();
  }
}

async function respondToApproval(threadId, token, payload) {
  if (resolvingRequests.has(token)) throw new Error("正在提交，请稍候");
  if (threadId !== selectedThreadId) throw new Error("请回到对应会话后再提交");
  const request = currentThread?.control?.requests?.find((item) => item.token === token);
  if (!request) throw new Error("这个请求已经处理或已失效");
  resolvingRequests.add(token);
  composerError = "";
  renderApprovals(currentThread?.control?.requests || []);
  updateComposer();
  try {
    await postJson(
      `/api/threads/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(token)}`,
      payload,
    );
    if (selectedThreadId === threadId && request) request.responding = true;
  } catch (error) {
    handleUnauthorized(error);
    throw error;
  } finally {
    resolvingRequests.delete(token);
    if (selectedThreadId === threadId) {
      renderApprovals(currentThread?.control?.requests || []);
    }
    updateComposer();
  }
}

async function bootstrap() {
  const token = fragmentToken();
  if (token) {
    try {
      await createSession(token);
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch (error) {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      return showAuth(error.message);
    }
  }

  try {
    const data = await requestJson("/api/bootstrap");
    supportsPolling = data.transports?.includes("poll") || false;
    usePolling = supportsPolling && (location.hostname?.endsWith(".trycloudflare.com") || false);
    threads = data.threads || [];
    projectCatalog = data.projects || [];
    projectsSupported = data.projectsSupported === true;
    setConnection(data.status);
    showApp();
    renderThreads();
    const lastThread = rememberedThread();
    if (!selectedThreadId && threads.some((thread) => thread.id === lastThread)) {
      await selectThread(lastThread);
    } else {
      connectEvents();
    }
  } catch (error) {
    if (error.message === "UNAUTHORIZED") return showAuth();
    showApp();
    renderThreads();
    connectEvents();
    if (!networkOffline()) setConnection({ state: "disconnected" });
  }
}

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  authError.textContent = "";
  authSubmit.disabled = true;
  authSubmit.textContent = "正在连接";
  try {
    await createSession(tokenInput.value.trim());
    tokenInput.value = "";
    await bootstrap();
  } catch (error) {
    authError.textContent = error.message;
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = "连接电脑";
  }
});

threadSearch.addEventListener("input", renderThreads);
document.querySelector("#new-project-button")?.addEventListener("click", () => openManagementDialog("create-project"));
archivedButton?.addEventListener("click", () => {
  viewingArchived = !viewingArchived;
  renderThreads();
  if (viewingArchived) void loadArchived();
});
archivedMore?.addEventListener("click", () => void loadArchived(true));
document.querySelector("#management-cancel")?.addEventListener("click", () => {
  if (!managementPending) managementDialog.close();
});
managementDialog?.addEventListener("cancel", (event) => {
  if (managementPending) event.preventDefault();
});
managementForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const { kind, target, idempotencyKey } = managementAction;
  void manageItem(kind, target, { name: managementNameInput.value, ...(kind === "create-project" ? { path: managementPathInput.value, idempotencyKey } : {}) });
});
sidebarMenu?.addEventListener("keydown", (event) => {
  const options = [...sidebarMenu.querySelectorAll("button:not(:disabled)")];
  const index = options.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    options[(index + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length]?.focus();
  }
  if (event.key === "Escape") { event.preventDefault(); closeSidebarMenu(true); }
  if (event.key === "Tab") closeSidebarMenu();
});
threadList.addEventListener("scroll", () => closeSidebarMenu(), { passive: true });
document.addEventListener?.("pointerdown", (event) => {
  for (const menu of queuedMessageList.querySelectorAll("details[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
  if (activeMessageArticle && !activeMessageArticle.contains?.(event.target)) clearActiveMessage();
  if (sidebarMenu && !sidebarMenu.hidden && !sidebarMenu.contains(event.target) && !sidebarMenuTrigger?.contains(event.target)) closeSidebarMenu();
});
composer.addEventListener("submit", sendMessage);
continueWebButton?.addEventListener("click", continueInWeb);
interruptButton.addEventListener("click", interruptTurn);
imageUploadButton.addEventListener("click", () => {
  closeComposerMenu();
  imageInput.click?.();
});
extrasButton?.addEventListener("click", () => {
  const opening = composerExtras.hidden;
  closeComposerMenu();
  composerExtras.hidden = !opening;
  extrasButton.setAttribute("aria-expanded", String(opening));
  if (opening) {
    renderExtrasSkills();
    positionExtrasMenu();
  }
});
imageInput.addEventListener("change", () => {
  const files = imageInput.files;
  imageInput.value = "";
  void addPendingImages(files);
});
modelControl.addEventListener("click", (event) => {
  if (["model", "settings"].includes(composerMenuKind)) return closeComposerMenu();
  toggleComposerMenu("settings");
  if (event?.detail === 0) composerMenu.querySelector?.(".effort-slider:not(:disabled), .model-picker-summary")?.focus();
});
permissionControl.addEventListener("click", () => toggleComposerMenu("permissions"));
skillControl.addEventListener("click", () => {
  if (skillControl.disabled || !composerExtras || composerExtras.hidden) return;
  const scrollTop = composerExtras.scrollTop;
  extrasSkillsExpanded = !extrasSkillsExpanded;
  renderExtrasSkills();
  positionExtrasMenu();
  composerExtras.scrollTop = scrollTop;
});
for (const button of modeControl.children) {
  button.addEventListener("click", () => chooseComposerMode(button.dataset.mode));
}
goalComplete.addEventListener("click", completeActiveGoal);
goalClear.addEventListener("click", () => clearActiveGoal());
document.addEventListener?.("pointerdown", (event) => {
  if (conversationActions.open && !conversationActions.contains(event.target)) {
    conversationActions.open = false;
  }
  if (composerMenu.hidden && composerExtras?.hidden !== false) return;
  const target = event.target;
  if (
    composerMenu.contains?.(target)
    || composerExtras?.contains?.(target)
    || extrasButton?.contains?.(target)
    || modelControl.contains?.(target)
    || permissionControl.contains?.(target)
    || skillControl.contains?.(target)
  ) return;
  closeComposerMenu();
});
messageInput.addEventListener("input", () => {
  composerError = "";
  resizeComposer();
  updateComposer();
  globalThis.clearTimeout?.(draftTimer);
  draftTimer = globalThis.setTimeout(saveDraft, 250);
});
messageInput.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.files || [])]
    .filter((file) => !file.type || file.type.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  void addPendingImages(images);
});
messageInput.addEventListener("keydown", (event) => {
  const touchKeyboard = globalThis.matchMedia?.("(pointer: coarse)").matches;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing
    && (!touchKeyboard || event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
composer.addEventListener("dragover", (event) => {
  if (![...(event.dataTransfer?.types || [])].includes("Files")) return;
  event.preventDefault();
  composer.classList.add("is-dragging-image");
});
composer.addEventListener("dragleave", () => composer.classList.remove("is-dragging-image"));
composer.addEventListener("drop", (event) => {
  composer.classList.remove("is-dragging-image");
  const images = [...(event.dataTransfer?.files || [])]
    .filter((file) => !file.type || file.type.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  void addPendingImages(images);
});
imageViewerClose.addEventListener("click", closeImageViewer);
imageViewerPrev.addEventListener("click", () => moveImageViewer(-1));
imageViewerNext.addEventListener("click", () => moveImageViewer(1));
imageViewer.addEventListener("click", (event) => {
  if (event.target === imageViewer) closeImageViewer();
});
document.addEventListener?.("keydown", (event) => {
  if (event.key === "Escape") {
    for (const menu of queuedMessageList.querySelectorAll("details[open]")) {
      menu.open = false;
      menu.querySelector("summary").focus();
    }
  }
  if (event.key === "Escape" && (composerMenuKind || composerExtras?.hidden === false)) {
    const opener = ["model", "settings"].includes(composerMenuKind) ? modelControl
      : composerMenuKind === "permissions" ? permissionControl : extrasButton;
    closeComposerMenu();
    opener.focus();
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && conversationActions.open) {
    conversationActions.open = false;
    conversationActions.querySelector("summary").focus();
    event.preventDefault();
  }
  if (imageViewer.hidden) return;
  if (event.key === "Escape") closeImageViewer();
  else if (event.key === "ArrowLeft") moveImageViewer(-1);
  else if (event.key === "ArrowRight") moveImageViewer(1);
});
backButton.addEventListener("click", () => {
  conversationActions.open = false;
  saveDraft();
  closeComposerMenu();
  messageInput.blur?.();
  app.classList.remove("conversation-open");
});
refreshButton.addEventListener("click", () => {
  conversationActions.open = false;
  conversationActions.querySelector("summary").focus();
  reconnect();
});
reconnectButton?.addEventListener("click", reconnect);
latestButton?.addEventListener("click", scrollToLatest);
messageList.addEventListener("scroll", updateLatestButton, { passive: true });
messageList.addEventListener("load", () => {
  if (latestButton?.hidden) scrollToLatest();
}, true);

globalThis.addEventListener?.("offline", () => {
  saveDraft();
  if (queuedMessageDeltas.size) flushMessageDeltas(selectionEpoch, selectedThreadId);
  closeEvents();
  setConnection({ state: "offline" });
});
globalThis.addEventListener?.("online", reconnect);
globalThis.addEventListener?.("pagehide", () => { saveDraft(); closeEvents(); });
globalThis.addEventListener?.("pageshow", (event) => { if (event.persisted) reconnect(); });
document.addEventListener?.("visibilitychange", () => {
  saveDraft();
  if (document.visibilityState === "visible") reconnect();
});
globalThis.setInterval?.(() => {
  if (!app.hidden && document.visibilityState === "visible" && !networkOffline()
    && Date.now() - lastEventAt > 45000) {
    usePolling = supportsPolling;
    reconnect();
  }
}, 15000);

function updateViewport() {
  const viewport = globalThis.visualViewport;
  if (!viewport || viewport.scale !== 1) return;
  const follow = isFollowingOutput();
  const scrollTop = messageList.scrollTop;
  document.documentElement?.style.setProperty("--viewport-height", `${viewport.height}px`);
  document.documentElement?.style.setProperty("--viewport-top", `${viewport.offsetTop}px`);
  if (follow) requestAnimationFrame(() => {
    if (messageList.scrollTop >= scrollTop - 1) scrollToLatest();
  });
}
globalThis.visualViewport?.addEventListener("resize", updateViewport);
globalThis.visualViewport?.addEventListener("scroll", updateViewport);
globalThis.addEventListener?.("resize", positionModelMenu);
if (globalThis.ResizeObserver) new ResizeObserver(positionModelMenu).observe(composer);
updateViewport();

renderComposerControls();
bootstrap();
