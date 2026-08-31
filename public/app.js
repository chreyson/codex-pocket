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
const messageInput = document.querySelector("#message-input");
const composerStatus = document.querySelector("#composer-status");
const sendButton = document.querySelector("#send-button");
const backButton = document.querySelector("#back-button");
const refreshButton = document.querySelector("#refresh-button");

let threads = [];
let selectedThreadId = "";
let currentThread = null;
let eventSource = null;
let selectionEpoch = 0;
let pendingMessage = null;
const sendingThreads = new Set();
let composerError = "";
const collapsedProjects = new Set();
const resolvingRequests = new Set();
const liveMessages = new Map();
const messageNodes = new Map();
const queuedMessageDeltas = new Map();
let deltaFrameId = null;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const MAX_LIVE_MESSAGE_LENGTH = 80_000;

function createSidebarIcon(name) {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");

  const paths = name === "folder"
    ? ["M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z", "M3 10h18"]
    : [];
  for (const value of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", value);
    svg.append(path);
  }
  return svg;
}

function fragmentToken() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  return params.get("token") || "";
}

async function createSession(token) {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || "连接失败");
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (response.status === 401) throw new Error("UNAUTHORIZED");
  const body = await response.json().catch(() => ({}));
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
}

function showAuth(message = "") {
  closeEvents();
  selectionEpoch += 1;
  resetLiveRendering();
  selectedThreadId = "";
  currentThread = null;
  pendingMessage = null;
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

    const header = document.createElement("button");
    header.type = "button";
    header.className = "project-header";

    const folder = createSidebarIcon("folder");
    folder.classList.add("project-folder-icon");
    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = projectName;
    header.append(folder, name);

    const items = document.createElement("div");
    items.className = "project-threads";
    const collapsed = !query && collapsedProjects.has(projectName);
    header.setAttribute("aria-expanded", String(!collapsed));
    header.title = collapsed ? `展开项目：${projectName}` : `折叠项目：${projectName}`;
    items.hidden = collapsed;

    header.addEventListener("click", () => {
      if (query) return;
      const expanded = header.getAttribute("aria-expanded") === "true";
      header.setAttribute("aria-expanded", String(!expanded));
      header.title = expanded ? `展开项目：${projectName}` : `折叠项目：${projectName}`;
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
    if (current?.kind === "activityGroup") {
      current.activities.push(message);
      current.timestamp = message.timestamp || current.timestamp;
    } else {
      grouped.push({
        id: `activity-group-${message.id}`,
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
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("viewBox", "0 0 24 24");
  const paths = {
    command: ["M4 17.5v-11A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2h-11A2.5 2.5 0 0 1 4 17.5Z", "m7.5 9 2.5 2.5L7.5 14", "M12.5 14h4"],
    file: ["M4 19.5A2.5 2.5 0 0 1 6.5 17H20", "M6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3Z"],
    tool: ["M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3Z"],
    web: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M3 12h18", "M12 3a15 15 0 0 1 0 18", "M12 3a15 15 0 0 0 0 18"],
    collab: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
    context: ["M4 7h16", "M7 3 3 4-3 4", "M20 17H4", "m17 21-3-4 3-4"],
  }[type] || ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z"];
  for (const value of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", value);
    svg.append(path);
  }
  return svg;
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
    if (activity.count > 1) {
      const count = document.createElement("span");
      count.className = "activity-count";
      count.textContent = `×${activity.count}`;
      row.append(count);
    }
    list.append(row);
  }
  article.append(list);
  return article;
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
  const busy = sending || Boolean(control.busy);
  composer.hidden = !selectedThreadId;
  messageInput.disabled = !selectedThreadId || !ready || busy;
  sendButton.disabled = !selectedThreadId || !ready || busy || !messageInput.value.trim();

  let state = "idle";
  if (composerError) {
    state = "error";
    composerStatus.textContent = composerError;
  } else if (sending) {
    state = "sending";
    composerStatus.textContent = "正在发送";
  } else if (requests.some((request) => request.type !== "unsupported" && !request.responding)) {
    state = "approval";
    composerStatus.textContent = "Codex 正在等待你的批准";
  } else if (requests.some((request) => request.type === "unsupported" && !request.responding)) {
    state = "approval";
    composerStatus.textContent = "请在电脑端处理此请求";
  } else if (control.busy) {
    state = "busy";
    composerStatus.textContent = "Codex 正在执行";
  } else {
    composerStatus.textContent = "";
  }
  composer.dataset.state = state;
  composerStatus.dataset.state = state;
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
  article.append(meta, body);

  const record = { article, author, time, body, kind: "message" };
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
}

function reconcileMessageNodes(messages) {
  const ordered = [];
  const visibleIds = new Set();

  for (const message of groupActivityMessages(messages)) {
    visibleIds.add(message.id);
    let record = messageNodes.get(message.id);

    if (message.kind === "activityGroup") {
      record = {
        article: renderActivityGroup(message),
        kind: "activityGroup",
      };
      messageNodes.set(message.id, record);
    } else if (!record || record.kind !== "message") {
      record = createMessageNode(message);
      messageNodes.set(message.id, record);
    } else {
      updateMessageNode(record, message);
    }
    ordered.push(record.article);
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
    role: "assistant",
    kind: value.kind === "commentary" ? "commentary" : "message",
    text: clipLiveText(text),
    timestamp: value.timestamp ?? Math.floor(Date.now() / 1000),
  };
}

function handleMessageStart(value) {
  if (!ensureCurrentThreadForLive(value.threadId)) return;

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

function renderThread(
  thread,
  { authoritativeSnapshot = true, autoScroll = true } = {},
) {
  if (thread.id !== selectedThreadId) return;

  const followOutput = isFollowingOutput();
  currentThread = mergeThreadWithLiveMessages(thread, authoritativeSnapshot);
  const persistedPendingMessage = pendingMessage
    && [...currentThread.messages].reverse().some(
      (message) => message.role === "user"
        && message.text === pendingMessage.text
        && !pendingMessage.knownMessageIds.has(message.id),
    );
  if (persistedPendingMessage) pendingMessage = null;

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
      if (isCurrentSubscription() && error.message === "UNAUTHORIZED") {
        showAuth("会话已过期，请重新输入访问密钥。");
      }
    } finally {
      probingSession = false;
    }
  };
}

async function selectThread(threadId) {
  const epoch = ++selectionEpoch;
  resetLiveRendering();
  selectedThreadId = threadId;
  currentThread = null;
  pendingMessage = null;
  composerError = "";
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
  updateComposer();
  connectEvents(epoch);
  try {
    const loaded = await requestJson(
      `/api/threads/${encodeURIComponent(threadId)}`,
    );
    if (selectionEpoch !== epoch || selectedThreadId !== threadId) return;
    renderThread(loaded);
  } catch (error) {
    if (error.message === "UNAUTHORIZED") return showAuth("会话已过期，请重新输入访问密钥。");
    if (selectionEpoch !== epoch || selectedThreadId !== threadId) return;
    conversationMeta.textContent = error.message;
    setConversationPlaceholder("无法加载会话", error.message);
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = messageInput.value.trim();
  const threadId = selectedThreadId;
  if (!text || !threadId || sendingThreads.has(threadId) || currentThread?.control?.busy) return;

  const knownMessageIds = new Set((currentThread?.messages || []).map((message) => message.id));
  const optimisticMessage = {
    id: `pending-${Date.now()}`,
    role: "user",
    kind: "message",
    text,
    timestamp: Math.floor(Date.now() / 1000),
    pending: true,
    knownMessageIds,
  };
  sendingThreads.add(threadId);
  pendingMessage = optimisticMessage;
  composerError = "";
  messageInput.value = "";
  resizeComposer();
  if (currentThread) {
    renderThread(currentThread, { authoritativeSnapshot: false });
  }
  updateComposer();
  try {
    const result = await postJson(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      { text },
    );
    if (selectedThreadId !== threadId || currentThread?.id !== threadId) return;
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
    if (error.message === "UNAUTHORIZED") return showAuth("会话已过期，请重新输入访问密钥。");
    if (selectedThreadId === threadId) {
      if (pendingMessage?.id === optimisticMessage.id) {
        pendingMessage = null;
        if (!messageInput.value) {
          messageInput.value = text;
          resizeComposer();
        }
        if (currentThread) {
          renderThread(currentThread, { authoritativeSnapshot: false });
        }
      }
      composerError = error.message;
    }
  } finally {
    sendingThreads.delete(threadId);
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
    if (error.message === "UNAUTHORIZED") return showAuth("会话已过期，请重新输入访问密钥。");
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
messageInput.addEventListener("input", () => {
  composerError = "";
  resizeComposer();
  updateComposer();
});
messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
backButton.addEventListener("click", () => app.classList.remove("conversation-open"));
refreshButton.addEventListener("click", () => {
  if (selectedThreadId) selectThread(selectedThreadId);
  else bootstrap();
});

bootstrap();
