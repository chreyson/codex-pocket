import path from "node:path";

export const MAX_MESSAGE_LENGTH = 12_000;

const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);

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
  const text = value.text.trim();
  if (!text) throw requestError(400, "请输入消息内容");
  if (text.length > MAX_MESSAGE_LENGTH) {
    throw requestError(413, `消息不能超过 ${MAX_MESSAGE_LENGTH} 个字符`);
  }
  return { text };
}

export function parseApprovalPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(400, "审批格式无效");
  }
  if (!APPROVAL_DECISIONS.has(value.decision)) throw requestError(400, "审批选择无效");
  return { decision: value.decision };
}

function commandPreview(params) {
  if (params.command) return cleanText(params.command);
  const commands = (params.commandActions || [])
    .map((action) => action?.command)
    .filter(Boolean)
    .join("\n");
  return cleanText(commands || "Codex 请求运行命令");
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
    reason: cleanText(params.reason, 1_000),
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
        ? `写入范围：${cleanText(params.grantRoot)}`
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
