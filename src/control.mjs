import path from "node:path";
import {
  commandPreview as sanitizedCommandPreview,
  redactSensitiveText,
} from "./redaction.mjs";

export const MAX_MESSAGE_LENGTH = 12_000;

const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const COMPOSER_MODES = new Set(["default", "plan", "goal"]);
const GOAL_STATUSES = new Set(["active", "paused", "complete"]);
const MAX_SELECTED_SKILLS = 16;

function requestError(status, message) {
  const error = new Error(message);
  error.status = status;
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
  if (typeof value.text !== "string") throw requestError(400, "请输入消息内容");
  const text = value.text.replaceAll("\0", "").trim();
  if (!text) throw requestError(400, "请输入消息内容");
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
  return result;
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
