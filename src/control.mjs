import path from "node:path";
import {
  commandPreview as sanitizedCommandPreview,
  redactSensitiveText,
} from "./redaction.mjs";
import { MAX_IMAGES_PER_MESSAGE } from "./image-store.mjs";

export const MAX_MESSAGE_LENGTH = 12_000;

const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const COMPOSER_MODES = new Set(["default", "plan", "goal"]);
const MESSAGE_ACTIONS = new Set(["start", "queue", "steer"]);
const GOAL_STATUSES = new Set(["active", "paused", "complete"]);
const MAX_SELECTED_SKILLS = 16;

function requestError(status, message, code = "") {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function cleanText(value, limit = 2_000) {
  const text = String(value ?? "").replaceAll("\0", "").trim();
  return text.length > limit ? `${text.slice(0, limit)}\n[内容已截断]` : text;
}

function projectName(value) {
  const normalized = cleanText(value, 1_000).replace(/[\\/]+$/, "");
  return normalized ? path.basename(normalized) || normalized : "";
}

export function parseMessagePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(400, "消息格式无效");
  }
  if (value.text !== undefined && typeof value.text !== "string") {
    throw requestError(400, "消息内容无效");
  }
  const text = String(value.text ?? "").replaceAll("\0", "").trim();
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw requestError(413, `消息不能超过 ${MAX_MESSAGE_LENGTH} 个字符`);
  }
  const result = { text };
  for (const field of ["model", "effort", "mode"]) {
    if (value[field] === undefined || value[field] === null || value[field] === "") continue;
    if (typeof value[field] !== "string") throw requestError(400, "消息设置无效");
    const selected = value[field].replaceAll("\0", "").trim();
    if (!selected || selected.length > 160) throw requestError(400, "消息设置无效");
    result[field] = selected;
  }
  if (result.mode && !COMPOSER_MODES.has(result.mode)) {
    throw requestError(400, "工作模式无效");
  }
  if (value.action !== undefined && value.action !== null) {
    if (typeof value.action !== "string" || !MESSAGE_ACTIONS.has(value.action)) {
      throw requestError(400, "发送方式无效");
    }
    result.action = value.action;
  }

  if (value.skillNames !== undefined) {
    if (!Array.isArray(value.skillNames) || value.skillNames.length > MAX_SELECTED_SKILLS) {
      throw requestError(400, `一次最多选择 ${MAX_SELECTED_SKILLS} 个 Skill`);
    }
    const names = [];
    const seen = new Set();
    for (const item of value.skillNames) {
      if (typeof item !== "string") throw requestError(400, "Skill 选择无效");
      const name = item.replaceAll("\0", "").trim();
      if (!name || name.length > 160) throw requestError(400, "Skill 选择无效");
      if (!seen.has(name)) names.push(name);
      seen.add(name);
    }
    result.skillNames = names;
  }
  if (value.imageIds !== undefined) {
    if (!Array.isArray(value.imageIds) || value.imageIds.length > MAX_IMAGES_PER_MESSAGE) {
      throw requestError(400, `一条消息最多上传 ${MAX_IMAGES_PER_MESSAGE} 张图片`);
    }
    const ids = [];
    const seen = new Set();
    for (const item of value.imageIds) {
      if (typeof item !== "string") throw requestError(400, "图片附件无效");
      const id = item.replaceAll("\0", "").trim();
      if (!/^img_[a-f0-9]{32}$/.test(id)) throw requestError(400, "图片附件无效");
      if (!seen.has(id)) ids.push(id);
      seen.add(id);
    }
    result.imageIds = ids;
  }
  if (value.clientMessageId !== undefined && value.clientMessageId !== null) {
    if (typeof value.clientMessageId !== "string") throw requestError(400, "消息标识无效");
    const clientMessageId = value.clientMessageId.replaceAll("\0", "").trim();
    if (!clientMessageId || clientMessageId.length > 200) throw requestError(400, "消息标识无效");
    result.clientMessageId = clientMessageId;
  }
  if (value.expectedTurnId !== undefined && value.expectedTurnId !== null) {
    if (typeof value.expectedTurnId !== "string") throw requestError(400, "运行任务标识无效");
    const expectedTurnId = value.expectedTurnId.replaceAll("\0", "").trim();
    if (!expectedTurnId || expectedTurnId.length > 200) {
      throw requestError(400, "运行任务标识无效");
    }
    result.expectedTurnId = expectedTurnId;
  }
  if (!text && !(result.imageIds || []).length) throw requestError(400, "请输入消息内容或选择图片");
  return result;
}

export function parseThreadCreatePayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(400, "新会话格式无效");
  }
  if (typeof value.projectThreadId !== "string") {
    throw requestError(400, "请选择要使用的项目");
  }
  const projectThreadId = value.projectThreadId.replaceAll("\0", "").trim();
  if (!projectThreadId || projectThreadId.length > 200) {
    throw requestError(400, "项目会话标识无效");
  }
  return { projectThreadId };
}

export function resolveMessageDispatch(action = "start", thread = {}) {
  const busy = Boolean(thread.control?.busy);
  if (action === "steer") {
    if (!busy) throw requestError(409, "当前没有可 Steer 的运行任务", "NO_ACTIVE_TURN");
    if (!thread.control?.turnId) {
      throw requestError(409, "Codex 正在启动这个任务，请稍后再 Steer", "TURN_STARTING");
    }
    return "steer";
  }
  if (action === "queue" && busy) return "queue";
  if (busy) {
    throw requestError(409, "Codex 正在处理这个会话，请使用等待或 Steer", "TURN_ACTIVE");
  }
  return "start";
}

export function collectTrackedThreadIds(clients = [], queuedThreadIds = []) {
  const ids = new Set();
  for (const threadId of queuedThreadIds) {
    if (typeof threadId === "string" && threadId) ids.add(threadId);
  }
  for (const client of clients) {
    if (typeof client?.threadId === "string" && client.threadId) ids.add(client.threadId);
  }
  return [...ids];
}

export function parseGoalPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(400, "目标格式无效");
  }
  const result = {};
  if (value.objective !== undefined && value.objective !== null) {
    if (typeof value.objective !== "string") throw requestError(400, "目标内容无效");
    const objective = value.objective.replaceAll("\0", "").trim();
    if (!objective) throw requestError(400, "请输入目标内容");
    if (objective.length > MAX_MESSAGE_LENGTH) {
      throw requestError(413, `目标不能超过 ${MAX_MESSAGE_LENGTH} 个字符`);
    }
    result.objective = objective;
  }
  if (value.status !== undefined && value.status !== null) {
    if (!GOAL_STATUSES.has(value.status)) throw requestError(400, "目标状态无效");
    result.status = value.status;
  }
  if (!result.objective && !result.status) throw requestError(400, "目标内容无效");
  return result;
}

export function parseApprovalPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(400, "审批格式无效");
  }
  if (!APPROVAL_DECISIONS.has(value.decision)) throw requestError(400, "审批选择无效");
  return { decision: value.decision };
}

function commandPreview(params) {
  const commands = params.command || (params.commandActions || [])
    .map((action) => action?.command)
    .filter(Boolean)
    .join("\n");
  return sanitizedCommandPreview(commands, { compact: false, limit: 2_000 })
    || "Codex 请求运行命令";
}

export function sanitizeServerRequest(record) {
  const { message, token, responding } = record;
  const params = message.params || {};
  const base = {
    token,
    method: message.method,
    responding: Boolean(responding),
    itemId: cleanText(params.itemId, 200),
    turnId: cleanText(params.turnId, 200),
    reason: cleanText(redactSensitiveText(params.reason), 1_000),
    project: projectName(params.cwd || params.grantRoot),
    startedAt: Number(params.startedAtMs || 0),
  };

  if (message.method === "item/commandExecution/requestApproval") {
    const network = params.networkApprovalContext;
    return {
      ...base,
      type: network ? "network" : "command",
      title: network ? "网络访问需要批准" : "命令需要批准",
      detail: network
        ? cleanText(`${network.protocol || "network"}://${network.host || "未知地址"}`)
        : commandPreview(params),
    };
  }

  if (message.method === "item/fileChange/requestApproval") {
    return {
      ...base,
      type: "fileChange",
      title: "文件修改需要批准",
      detail: params.grantRoot
        ? `写入范围：${projectName(params.grantRoot) || "当前项目"}`
        : "Codex 准备修改当前项目中的文件",
    };
  }

  return {
    ...base,
    type: "unsupported",
    title: "Codex 正在等待额外输入",
    detail: "这个请求暂时需要回到电脑端处理",
  };
}
