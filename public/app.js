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
const connectionState = document.querySelector("#connection-state");
const connectionLabel = document.querySelector("#connection-label");
const conversationTitle = document.querySelector("#conversation-title");
const conversationMeta = document.querySelector("#conversation-meta");
const conversationPlaceholder = document.querySelector("#conversation-placeholder");
const placeholderTitle = document.querySelector("#placeholder-title");
const placeholderDetail = document.querySelector("#placeholder-detail");
const messageList = document.querySelector("#message-list");
const approvalTray = document.querySelector("#approval-tray");
const composer = document.querySelector("#composer");
const composerMenu = document.querySelector("#composer-menu");
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
const effortControl = document.querySelector("#effort-control");
const effortLabelNode = document.querySelector("#effort-label");
const composerStatus = document.querySelector("#composer-status");
const deliveryControl = document.querySelector("#delivery-control");
const interruptButton = document.querySelector("#interrupt-button");
const sendButton = document.querySelector("#send-button");
const backButton = document.querySelector("#back-button");
const refreshButton = document.querySelector("#refresh-button");
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
let selectionEpoch = 0;
let pendingMessage = null;
const sendingThreads = new Set();
const interruptingThreads = new Set();
const interruptRequestThreads = new Set();
const deliveredMessageIds = new Set();
let composerError = "";
const collapsedProjects = new Set();
const creatingProjects = new Set();
const expandedTurns = new Set();
const resolvingRequests = new Set();
const liveMessages = new Map();
const messageNodes = new Map();
const queuedMessageDeltas = new Map();
let deltaFrameId = null;
let desktopThreadSnapshot = null;
let composerCatalog = null;
let composerMenuKind = "";
let goalUpdating = false;
let pendingImages = [];
let nextPendingImageId = 1;
let viewerImages = [];
let viewerImageIndex = 0;
let runningMessageAction = "queue";

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
  const paths = name === "folder"
    ? ["M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "M3 10h18"]
    : name === "plus" ? ["M12 5v14", "M5 12h14"] : [];
  return createIcon(paths);
}

function fragmentToken() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return params.get("token") || "";
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const AbortControllerType = globalThis.AbortController;
  const readResponse = async (signal) => {
    const response = await fetch(url, signal ? { ...options, signal } : options);
    let body = {};
    try {
      body = (await response.json()) ?? {};
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
    }
    return { response, body };
  };
  if (typeof AbortControllerType !== "function" || typeof globalThis.setTimeout !== "function") {
    return readResponse();
  }

  const controller = new AbortControllerType();
  const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await readResponse(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || error?.name === "AbortError") {
      throw new Error("请求超时，请检查网络后重试");
    }
    throw error;
  } finally {
    globalThis.clearTimeout?.(timer);
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
  if (!response.ok) throw new Error(body.error || `请求失败：${response.status}`);
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
  cancelQueuedMessageDeltas();
  liveMessages.clear();
  messageNodes.clear();
  deliveredMessageIds.clear();
  desktopThreadSnapshot = null;
}

function resetTransientOperations() {
  sendingThreads.clear();
  interruptingThreads.clear();
  interruptRequestThreads.clear();
  creatingProjects.clear();
  resolvingRequests.clear();
  goalUpdating = false;
  composerError = "";
}

function showAuth(message = "") {
  closeEvents();
  closeComposerMenu();
  closeImageViewer();
  discardPendingImages();
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
  conversationMeta.textContent = "连接到电脑上的 Codex";
  setConversationPlaceholder("从左侧选择一个会话", "消息和任务状态会自动更新。");
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

function setConnection(status = {}) {
  const state = status.state || "connecting";
  connectionState.dataset.state = state;
  const labels = {
    ready: "已连接",
    starting: "启动中",
    connecting: "连接中",
    disconnected: "已断开",
    error: "异常",
  };
  connectionLabel.textContent = labels[state] || state;
  connectionState.title = status.error || labels[state] || state;
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

async function createProjectThread(projectName, projectThreadId) {
  if (!projectThreadId || creatingProjects.has(projectThreadId)) return;
  creatingProjects.add(projectThreadId);
  setThreadActionStatus(`正在为 ${projectName} 新建会话`, "loading");
  renderThreads();
  try {
    const result = await postJson("/api/threads", { projectThreadId });
    if (!result.thread?.id) throw new Error("新会话响应无效");
    threads = [result.thread, ...threads.filter((thread) => thread.id !== result.thread.id)];
    setThreadActionStatus();
    renderThreads();
    await selectThread(result.thread.id);
  } catch (error) {
    if (handleUnauthorized(error)) return;
    setThreadActionStatus(error.message, "error");
  } finally {
    creatingProjects.delete(projectThreadId);
    renderThreads();
  }
}

function renderThreads() {
  const query = threadSearch.value.trim().toLocaleLowerCase();
  const visible = threads.filter((thread) => {
    if (!query) return true;
    return `${thread.title} ${thread.preview} ${thread.project}`.toLocaleLowerCase().includes(query);
  });

  threadList.replaceChildren();
  threadList.hidden = visible.length === 0;
  threadEmpty.hidden = visible.length > 0;
  threadEmptyTitle.textContent = query ? "没有匹配的会话" : "还没有可显示的会话";
  threadEmptyDetail.textContent = query
    ? "换一个关键词再试。"
    : "在电脑上打开 Codex 并开始对话。";
  const projects = new Map();
  for (const thread of visible) {
    const projectName = thread.project?.trim() || "其他项目";
    const projectThreads = projects.get(projectName) || [];
    projectThreads.push(thread);
    projects.set(projectName, projectThreads);
  }

  for (const [projectName, projectThreads] of projects) {
    const group = document.createElement("section");
    group.className = "project-group";
    group.setAttribute("aria-label", projectName);

    const header = document.createElement("div");
    header.className = "project-header";

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "project-toggle";

    const folder = createSidebarIcon("folder");
    folder.classList.add("project-folder-icon");
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = projectName;
    toggle.append(folder, name);

    const createButton = document.createElement("button");
    createButton.type = "button";
    createButton.className = "project-create";
    createButton.append(createSidebarIcon("plus"));
    createButton.setAttribute("aria-label", `在 ${projectName} 中新建会话`);
    createButton.title = `在 ${projectName} 中新建会话`;
    createButton.disabled = creatingProjects.has(projectThreads[0]?.id);
    createButton.setAttribute("aria-busy", String(createButton.disabled));
    createButton.addEventListener("click", () => {
      void createProjectThread(projectName, projectThreads[0]?.id);
    });
    header.append(toggle, createButton);

    const items = document.createElement("div");
    items.className = "project-threads";
    const collapsed = !query && collapsedProjects.has(projectName);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.title = collapsed ? `展开项目：${projectName}` : `折叠项目：${projectName}`;
    items.hidden = collapsed;

    toggle.addEventListener("click", () => {
      if (query) return;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      toggle.setAttribute("aria-expanded", String(!expanded));
      toggle.title = expanded ? `展开项目：${projectName}` : `折叠项目：${projectName}`;
      items.hidden = expanded;
      if (expanded) collapsedProjects.add(projectName);
      else collapsedProjects.delete(projectName);
    });

    for (const thread of projectThreads) {
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
      button.addEventListener("click", () => selectThread(thread.id));
      items.append(button);
    }

    group.append(header, items);
    threadList.append(group);
  }
}

function messageLabel(message) {
  if (message.role === "user") return "你";
  if (message.role === "assistant") {
    if (message.kind === "reasoning") return "Codex · 思考";
    if (message.kind === "commentary") return "Codex · 进展";
    if (message.kind === "plan") return "Codex · 计划";
    return "Codex";
  }
  return message.label || "活动";
}

function groupActivityMessages(messages) {
  const grouped = [];
  for (const message of messages) {
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
    const key = [activity.activityType, activity.activityStatus, activity.label, activity.text].join("\u0000");
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

function renderActivityGroup(message) {
  const article = document.createElement("article");
  article.className = "message";
  article.dataset.role = "system";
  article.dataset.kind = "activityGroup";
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
  article.append(list);
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
  for (const image of discarded) {
    releasePreviewUrl(image.previewUrl);
    if (image.id) void deleteUploadedImage(image.id);
  }
  renderPendingImages();
  updateComposer();
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
    const current = pendingImages.find((image) => image.localId === item.localId);
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
    const current = pendingImages.find((image) => image.localId === item.localId);
    if (current) {
      current.status = "error";
      current.error = error.message;
      composerError = error.message;
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
  normalizeComposerSelection();
  persistComposerSelection();
  renderComposerControls();
}

function controlIsBusy() {
  return goalUpdating
    || sendingThreads.has(selectedThreadId)
    || interruptingThreads.has(selectedThreadId);
}

function updateComposerControlAvailability() {
  const busy = controlIsBusy();
  const running = Boolean(currentThread?.control?.busy);
  const hasModels = Boolean(composerCatalog?.models?.length);
  const ready = currentThread?.id === selectedThreadId;
  modelControl.disabled = busy || running || !hasModels;
  effortControl.disabled = busy || running || !selectedModel()?.efforts?.length;
  skillControl.disabled = busy || !composerCatalog?.features?.skills;
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
  modelLabel.textContent = model?.name || "模型";
  modelControl.title = model?.description || "选择模型";
  effortLabelNode.textContent = effortLabel(composerSelection.effort);
  effortControl.title = "选择推理强度";

  for (const button of modeControl.children) {
    const selected = button.dataset.mode === composerSelection.mode;
    button.setAttribute("aria-checked", String(selected));
    button.dataset.selected = String(selected);
  }

  const goal = activeGoal();
  goalBanner.hidden = !goal;
  goalObjective.textContent = goal?.objective || "";
  goalBanner.dataset.status = goal?.status || "";

  const skillTotal = composerSelection.skillNames?.length || 0;
  skillLabel.textContent = "Skills";
  skillCount.hidden = skillTotal === 0;
  skillCount.textContent = skillTotal ? String(skillTotal) : "";
  renderSelectedSkills();
  renderPendingImages();

  messageInput.placeholder = composerSelection.mode === "plan"
    ? "描述要规划的任务"
    : composerSelection.mode === "goal"
      ? (goal ? "继续推进这个目标" : "描述要持续推进的目标")
      : "给 Codex 发送消息";
  updateComposerControlAvailability();
  if (composerMenuKind) renderComposerMenu(composerMenuKind);
}

function setControlExpanded(control, expanded) {
  control.setAttribute("aria-expanded", String(expanded));
}

function closeComposerMenu() {
  composerMenuKind = "";
  composerMenu.hidden = true;
  composerMenu.replaceChildren();
  setControlExpanded(modelControl, false);
  setControlExpanded(effortControl, false);
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
  composerMenu.append(menuHeader("模型"));
  const list = document.createElement("div");
  list.className = "composer-menu-list";
  for (const model of composerCatalog?.models || []) {
    const row = choiceRow(
      model.name,
      model.specialty || model.description,
      model.id === composerSelection.model,
    );
    row.addEventListener("click", () => {
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
      closeComposerMenu();
      renderComposerControls();
      updateComposer();
    });
    list.append(row);
  }
  composerMenu.append(list);
}

function renderEffortMenu() {
  composerMenu.append(menuHeader("推理强度"));
  const list = document.createElement("div");
  list.className = "composer-menu-list";
  for (const effort of selectedModel()?.efforts || []) {
    const row = choiceRow(
      effortLabel(effort.id),
      effort.description,
      effort.id === composerSelection.effort,
    );
    row.addEventListener("click", () => {
      composerSelection.effort = effort.id;
      persistComposerSelection();
      closeComposerMenu();
      renderComposerControls();
    });
    list.append(row);
  }
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
  if (kind === "model") renderModelMenu();
  else if (kind === "effort") renderEffortMenu();
  else if (kind === "skills") renderSkillMenu();
  composerMenu.hidden = false;
}

function toggleComposerMenu(kind) {
  if (composerMenuKind === kind) return closeComposerMenu();
  composerMenuKind = kind;
  setControlExpanded(modelControl, kind === "model");
  setControlExpanded(effortControl, kind === "effort");
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

function chooseRunningMessageAction(action) {
  if (!["queue", "steer"].includes(action)) return;
  runningMessageAction = action;
  updateComposer();
  messageInput.focus();
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
  const goalNeedsText = !running
    && composerSelection.mode === "goal"
    && !messageInput.value.trim();
  const action = running ? runningMessageAction : "start";
  composer.hidden = !selectedThreadId;
  messageInput.disabled = !selectedThreadId || !ready || sending || interrupting || goalUpdating;
  deliveryControl.hidden = !running;
  for (const button of deliveryControl.children) {
    const selected = button.dataset.action === runningMessageAction;
    button.dataset.selected = String(selected);
    button.setAttribute("aria-checked", String(selected));
    button.disabled = sending
      || interrupting
      || (button.dataset.action === "queue" && queued)
      || (button.dataset.action === "steer" && !control.turnId);
  }
  interruptButton.hidden = !running && !interrupting;
  interruptButton.disabled = !ready || sending || interrupting || goalUpdating;
  sendButton.dataset.action = action;
  const sendLabel = action === "queue"
    ? "加入等待"
    : action === "steer" ? "Steer 当前任务" : "发送消息";
  sendButton.setAttribute("aria-label", sendLabel);
  sendButton.title = sendLabel;
  sendButton.disabled = !selectedThreadId
    || !ready
    || sending
    || interrupting
    || goalUpdating
    || uploadingImages
    || failedImages
    || !hasMessageContent
    || goalNeedsText
    || queued
    || (action === "steer" && !control.turnId);

  let state = "idle";
  if (composerError) {
    state = "error";
    composerStatus.textContent = composerError;
  } else if (goalUpdating) {
    state = "sending";
    composerStatus.textContent = "正在更新目标";
  } else if (uploadingImages) {
    state = "sending";
    composerStatus.textContent = "正在上传图片";
  } else if (interrupting) {
    state = "interrupting";
    composerStatus.textContent = "正在中断";
  } else if (sending) {
    state = "sending";
    composerStatus.textContent = action === "queue"
      ? "正在加入等待"
      : action === "steer" ? "正在 Steer" : "正在发送";
  } else if (requests.some((request) => request.type !== "unsupported" && !request.responding)) {
    state = "approval";
    composerStatus.textContent = "Codex 正在等待你的批准";
  } else if (requests.some((request) => request.type === "unsupported" && !request.responding)) {
    state = "approval";
    composerStatus.textContent = "请在电脑端处理此请求";
  } else if (queued) {
    state = "queued";
    composerStatus.textContent = "消息将在当前任务完成后发送";
  } else if (control.busy) {
    state = "busy";
    composerStatus.textContent = "Codex 正在执行";
  } else {
    composerStatus.textContent = "";
  }
  composer.dataset.state = state;
  composer.dataset.running = String(running);
  composerStatus.dataset.state = state;
  updateComposerControlAvailability();
}

function renderApprovals(requests = []) {
  approvalTray.replaceChildren();
  approvalTray.hidden = requests.length === 0;

  for (const request of requests) {
    const article = document.createElement("article");
    article.className = "approval-request";
    article.dataset.type = request.type;
    const processing = Boolean(request.responding || resolvingRequests.has(request.token));
    article.dataset.state = processing ? "processing" : "pending";
    article.setAttribute("aria-busy", String(processing));

    const header = document.createElement("div");
    header.className = "approval-header";
    const headingWrap = document.createElement("div");
    const kicker = document.createElement("span");
    kicker.className = "approval-kicker";
    kicker.textContent = "审批请求";
    const title = document.createElement("h3");
    title.textContent = request.title;
    headingWrap.append(kicker, title);

    const state = document.createElement("span");
    state.className = "approval-state";
    state.textContent = processing ? "处理中" : "待处理";
    header.append(headingWrap, state);

    const detail = document.createElement("pre");
    detail.className = "approval-detail";
    detail.textContent = request.detail;
    article.append(header, detail);

    if (request.reason) {
      const reason = document.createElement("p");
      reason.className = "approval-reason";
      reason.textContent = request.reason;
      article.append(reason);
    }

    if (request.type !== "unsupported") {
      const actions = document.createElement("div");
      actions.className = "approval-actions";
      const decline = document.createElement("button");
      decline.type = "button";
      decline.className = "approval-button secondary";
      decline.textContent = "拒绝";
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "approval-button primary";
      accept.textContent = "允许一次";
      const disabled = processing;
      decline.disabled = disabled;
      accept.disabled = disabled;
      decline.addEventListener("click", () => respondToApproval(request.token, "decline"));
      accept.addEventListener("click", () => respondToApproval(request.token, "accept"));
      actions.append(decline, accept);
      article.append(actions);
    }

    approvalTray.append(article);
  }
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
    record.article.append(record.media);
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

  const record = {
    article,
    author,
    time,
    body,
    receipt,
    media,
    mediaAttached: false,
    mediaSignature: "",
    kind: "message",
  };
  updateMessageNode(record, message);
  return record;
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
  if (record.body.textContent !== message.text) record.body.textContent = message.text;
  record.body.hidden = !message.text;
  updateMessageImages(record, message.images);

  const receipt = message.role === "user"
    ? {
        sending: "发送中",
        sent: "已送达",
        queued: "等待中",
        steered: "已 Steer",
      }[message.deliveryState] || ""
    : "";
  record.receipt.hidden = !receipt;
  if (record.receipt.textContent !== receipt) record.receipt.textContent = receipt;
}

function createReasoningNode(message) {
  const article = document.createElement("article");
  article.className = "message reasoning-message";
  const details = document.createElement("details");
  details.className = "reasoning-block";
  const summary = document.createElement("summary");
  summary.className = "reasoning-summary";
  const spinner = document.createElement("span");
  spinner.className = "reasoning-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "reasoning-label";
  const chevron = document.createElement("span");
  chevron.className = "reasoning-chevron";
  chevron.setAttribute("aria-hidden", "true");
  summary.append(spinner, label, chevron);
  const body = document.createElement("div");
  body.className = "reasoning-body";
  details.append(summary, body);
  article.append(details);

  const record = {
    article,
    details,
    spinner,
    label,
    body,
    status: "",
    kind: "reasoning",
  };
  updateReasoningNode(record, message);
  return record;
}

function updateReasoningNode(record, message) {
  const status = message.activityStatus || "completed";
  const running = ["inProgress", "running"].includes(status);
  const statusChanged = record.status !== status;
  record.article.dataset.role = "assistant";
  record.article.dataset.kind = "reasoning";
  record.article.dataset.status = status;
  record.spinner.hidden = !running;
  record.label.textContent = running ? "思考中" : "已思考";
  record.body.hidden = !message.text;
  if (record.body.textContent !== message.text) record.body.textContent = message.text;
  if (statusChanged && running) record.details.open = true;
  if (statusChanged && record.status && !running) record.details.open = false;
  record.status = status;
}

function messagesByTurn(messages) {
  const turns = [];
  for (const message of groupActivityMessages(messages)) {
    const turnId = message.turnId || "legacy";
    let turn = turns.at(-1);
    if (!turn || turn.id !== turnId) {
      turn = { id: turnId, messages: [] };
      turns.push(turn);
    }
    turn.messages.push(message);
  }
  return turns;
}

function historyTurnSummary(turn, index) {
  const userMessage = turn.messages.find((message) => message.role === "user");
  const text = String(userMessage?.text || "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 72 ? `${text.slice(0, 72)}…` : text;
  if (userMessage?.images?.length) return "图片消息";
  return `历史回合 ${index + 1}`;
}

function historyTurnNode(turn, index, articles) {
  const details = document.createElement("details");
  details.className = "history-turn";
  details.dataset.turnId = turn.id;
  const expansionKey = `${selectedThreadId}\u0000${turn.id}`;
  details.open = expandedTurns.has(expansionKey);

  const summary = document.createElement("summary");
  summary.className = "history-turn-summary";
  const title = document.createElement("span");
  title.className = "history-turn-title";
  title.textContent = historyTurnSummary(turn, index);
  const meta = document.createElement("span");
  meta.className = "history-turn-meta";
  meta.textContent = formatTime(turn.messages[0]?.timestamp) || "历史";
  summary.append(title, meta);

  const content = document.createElement("div");
  content.className = "history-turn-content";
  content.append(...articles);
  details.append(summary, content);
  details.addEventListener("toggle", () => {
    if (details.open) expandedTurns.add(expansionKey);
    else expandedTurns.delete(expansionKey);
  });
  return details;
}

function messageRecord(message) {
  let record = messageNodes.get(message.id);
  if (message.kind === "activityGroup") {
    record = {
      article: renderActivityGroup(message),
      kind: "activityGroup",
    };
    messageNodes.set(message.id, record);
  } else if (message.kind === "reasoning") {
    if (!record || record.kind !== "reasoning") {
      record = createReasoningNode(message);
      messageNodes.set(message.id, record);
    } else {
      updateReasoningNode(record, message);
    }
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

  const turns = messagesByTurn(messages);
  const activeTurnId = currentThread?.control?.turnId || "";
  for (const [index, turn] of turns.entries()) {
    const articles = turn.messages.map((message) => {
      visibleIds.add(message.id);
      return messageRecord(message).article;
    });
    const latest = index === turns.length - 1;
    if (latest || turn.id === activeTurnId) ordered.push(...articles);
    else ordered.push(historyTurnNode(turn, index, articles));
  }

  for (const id of messageNodes.keys()) {
    if (!visibleIds.has(id)) messageNodes.delete(id);
  }
  messageList.replaceChildren(...ordered);
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
    messages,
    control: {
      ...(thread.control || {}),
      ...(snapshot.control || {}),
      requests: thread.control?.requests || [],
    },
  };
}

function mergeThreadWithLiveMessages(thread, authoritativeSnapshot) {
  const messages = [...(thread.messages || [])];
  const indexes = new Map(messages.map((message, index) => [message.id, index]));

  for (const [itemId, live] of liveMessages) {
    const index = indexes.get(itemId);
    if (index === undefined) {
      indexes.set(itemId, messages.length);
      messages.push(live.message);
      continue;
    }

    const snapshotMessage = messages[index];
    if (live.completed) {
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
      busy: Boolean(thread.control?.busy || hasActiveStream),
      requests: thread.control?.requests || [],
    },
  };
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
      if (record.body.textContent !== message.text) {
        record.body.textContent = message.text;
      }
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
      `${currentThread.project} · ${state} · ${currentThread.messages.length} 条记录`;
    updateComposer();
  }

  if (followOutput && currentThread.messages.length) {
    messageList.scrollTop = messageList.scrollHeight;
    messageList.dataset.rendered = "true";
  }
}

function queueMessageDelta(value) {
  if (!ensureCurrentThreadForLive(value.threadId)) return;
  if (liveMessages.get(value.itemId)?.completed) return;

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

  const message = liveMessage(value);
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

function restoreQueuedMessage(thread) {
  const queued = thread.control?.queue;
  if (pendingMessage || !queued) return;
  const clientId = queued.clientMessageId || `queued-${queued.queuedAt || Date.now()}`;
  pendingMessage = {
    id: `pending-${clientId}`,
    turnId: `queued-${clientId}`,
    clientId,
    role: "user",
    kind: "message",
    text: queued.text || "",
    timestamp: queued.queuedAt || Math.floor(Date.now() / 1_000),
    pending: false,
    deliveryState: "queued",
    skillNames: queued.skillNames || [],
    images: queued.images || [],
    knownMessageIds: new Set((thread.messages || []).map((message) => message.id)),
  };
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
  restoreQueuedMessage(currentThread);
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
  conversationMeta.textContent =
    `${currentThread.project} · ${state} · ${currentThread.messages.length} 条记录`;

  if (hasMessages) {
    setConversationPlaceholder("", "", false);
    messageList.hidden = false;
  } else {
    setConversationPlaceholder("还没有消息");
  }
  renderApprovals(currentThread.control?.requests || []);
  updateComposer();
  reconcileMessageNodes(displayMessages);

  if (autoScroll && hasMessages && followOutput) {
    const initialRender = !messageList.dataset.rendered;
    if (initialRender) {
      messageList.scrollTop = messageList.scrollHeight;
      messageList.dataset.rendered = "true";
      return;
    }
    const epoch = selectionEpoch;
    const threadId = currentThread.id;
    requestAnimationFrame(() => {
      if (selectionEpoch !== epoch || selectedThreadId !== threadId) return;
      messageList.scrollTop = messageList.scrollHeight;
      messageList.dataset.rendered = "true";
    });
  }
}

function closeEvents() {
  eventSource?.close();
  eventSource = null;
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
  cancelQueuedMessageDeltas();
  closeEvents();
  const subscriptionThreadId = selectedThreadId;
  const query = subscriptionThreadId
    ? `?threadId=${encodeURIComponent(subscriptionThreadId)}`
    : "";
  const source = new EventSource(`/api/events${query}`);
  eventSource = source;
  setConnection({ state: "connecting" });

  const isCurrentSubscription = () =>
    eventSource === source
    && selectedThreadId === subscriptionThreadId
    && selectionEpoch === subscriptionEpoch;

  source.addEventListener("threads", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (!Array.isArray(value)) return;
    threads = value;
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
    if (
      pendingMessage
      && (!value.clientMessageId || pendingMessage.clientId === value.clientMessageId)
    ) {
      pendingMessage = {
        ...pendingMessage,
        turnId: value.turnId || pendingMessage.turnId,
        deliveryState: "sending",
      };
    }
    if (!ensureCurrentThreadForLive(value.threadId)) return;
    currentThread = {
      ...currentThread,
      control: {
        ...(currentThread.control || {}),
        busy: true,
        phase: "starting",
        turnId: value.turnId || currentThread.control?.turnId || null,
        queued: false,
        queue: null,
      },
    };
    renderThread(currentThread, { authoritativeSnapshot: false });
  });
  source.addEventListener("queueFailed", (event) => {
    if (!isCurrentSubscription()) return;
    const value = eventValue(event);
    if (!value || value.threadId !== subscriptionThreadId) return;
    const failedPending = pendingMessage
      && (!value.clientMessageId || pendingMessage.clientId === value.clientMessageId)
      ? pendingMessage
      : null;
    if (failedPending) {
      pendingMessage = null;
      if (!messageInput.value && failedPending.text) messageInput.value = failedPending.text;
      resizeComposer();
    }
    if (currentThread?.id === value.threadId) {
      currentThread = {
        ...currentThread,
        control: {
          ...(currentThread.control || {}),
          queued: false,
          queue: null,
        },
      };
      composerError = `${value.message || "等待消息发送失败"}${failedPending?.images?.length ? "，请重新选择图片" : ""}`;
      renderThread(currentThread, { authoritativeSnapshot: false });
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
  });
  let probingSession = false;
  source.onerror = async () => {
    if (!isCurrentSubscription()) return;
    setConnection({ state: "disconnected" });
    if (probingSession) return;
    probingSession = true;
    try {
      const data = await requestJson("/api/bootstrap");
      if (isCurrentSubscription()) setConnection(data.status);
    } catch (error) {
      if (isCurrentSubscription()) handleUnauthorized(error);
    } finally {
      probingSession = false;
    }
  };
}

async function selectThread(threadId) {
  const epoch = ++selectionEpoch;
  closeComposerMenu();
  closeImageViewer();
  discardPendingImages();
  resetLiveRendering();
  selectedThreadId = threadId;
  currentThread = null;
  pendingMessage = null;
  composerCatalog = null;
  composerError = "";
  runningMessageAction = "queue";
  messageInput.value = "";
  resizeComposer();
  messageList.replaceChildren();
  messageList.hidden = true;
  messageList.dataset.rendered = "";
  approvalTray.replaceChildren();
  approvalTray.hidden = true;
  app.classList.add("conversation-open");
  renderThreads();
  const thread = threads.find((item) => item.id === threadId);
  conversationTitle.textContent = thread?.title || "加载会话";
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
    setConversationPlaceholder("无法加载会话", error.message);
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
  const action = running ? runningMessageAction : "start";
  const readyImages = pendingImages.filter((image) => image.status === "ready");
  if (
    (!text && !readyImages.length)
    || !threadId
    || sendingThreads.has(threadId)
    || interruptingThreads.has(threadId)
    || control.queued
    || (action === "steer" && !control.turnId)
    || pendingImages.some((image) => image.status !== "ready")
    || (!running && composerSelection.mode === "goal" && !text)
  ) return;

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
  if (action === "steer") payload.expectedTurnId = control.turnId;
  if (composerCatalog?.models?.length && selection.model) {
    Object.assign(payload, selection);
  }

  const knownMessageIds = new Set((currentThread?.messages || []).map((message) => message.id));
  const optimisticMessage = {
    id: `pending-${Date.now()}`,
    turnId: action === "steer" && control.turnId
      ? control.turnId
      : `${action}-${clientId}`,
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
  pendingMessage = optimisticMessage;
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
    if (currentThread) {
      currentThread = {
        ...currentThread,
        control: {
          ...currentThread.control,
          ...result.control,
          busy: true,
        },
      };
      renderThread(currentThread, { authoritativeSnapshot: false });
    }
  } catch (error) {
    if (handleUnauthorized(error)) return;
    if (selectedThreadId === threadId) {
      if (pendingMessage?.id === optimisticMessage.id) {
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
    } else {
      for (const image of readyImages) void deleteUploadedImage(image.id);
    }
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

async function respondToApproval(token, decision) {
  if (resolvingRequests.has(token)) return;
  const threadId = selectedThreadId;
  const request = currentThread?.control?.requests?.find((item) => item.token === token);
  resolvingRequests.add(token);
  composerError = "";
  renderApprovals(currentThread?.control?.requests || []);
  updateComposer();
  try {
    await postJson(
      `/api/threads/${encodeURIComponent(threadId)}/approvals/${encodeURIComponent(token)}`,
      { decision },
    );
    if (selectedThreadId === threadId && request) request.responding = true;
  } catch (error) {
    if (handleUnauthorized(error)) return;
    if (selectedThreadId === threadId) composerError = error.message;
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
    threads = data.threads || [];
    setConnection(data.status);
    showApp();
    renderThreads();
    connectEvents();
  } catch (error) {
    if (error.message === "UNAUTHORIZED") return showAuth();
    showAuth(error.message);
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
composer.addEventListener("submit", sendMessage);
interruptButton.addEventListener("click", interruptTurn);
for (const button of deliveryControl.children) {
  button.addEventListener("click", () => chooseRunningMessageAction(button.dataset.action));
}
imageUploadButton.addEventListener("click", () => imageInput.click?.());
imageInput.addEventListener("change", () => {
  const files = imageInput.files;
  imageInput.value = "";
  void addPendingImages(files);
});
modelControl.addEventListener("click", () => toggleComposerMenu("model"));
effortControl.addEventListener("click", () => toggleComposerMenu("effort"));
skillControl.addEventListener("click", () => toggleComposerMenu("skills"));
for (const button of modeControl.children) {
  button.addEventListener("click", () => chooseComposerMode(button.dataset.mode));
}
goalComplete.addEventListener("click", completeActiveGoal);
goalClear.addEventListener("click", () => clearActiveGoal());
composerMenu.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeComposerMenu();
});
document.addEventListener?.("pointerdown", (event) => {
  if (composerMenu.hidden) return;
  const target = event.target;
  if (
    composerMenu.contains?.(target)
    || modelControl.contains?.(target)
    || effortControl.contains?.(target)
    || skillControl.contains?.(target)
  ) return;
  closeComposerMenu();
});
messageInput.addEventListener("input", () => {
  composerError = "";
  resizeComposer();
  updateComposer();
});
messageInput.addEventListener("paste", (event) => {
  const images = [...(event.clipboardData?.files || [])]
    .filter((file) => !file.type || file.type.startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  void addPendingImages(images);
});
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
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
  if (imageViewer.hidden) return;
  if (event.key === "Escape") closeImageViewer();
  else if (event.key === "ArrowLeft") moveImageViewer(-1);
  else if (event.key === "ArrowRight") moveImageViewer(1);
});
backButton.addEventListener("click", () => app.classList.remove("conversation-open"));
refreshButton.addEventListener("click", () => {
  if (selectedThreadId) selectThread(selectedThreadId);
  else bootstrap();
});

renderComposerControls();
bootstrap();
