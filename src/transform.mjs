import path from "node:path";

const MAX_TEXT_LENGTH = 80_000;

function clip(value, limit = MAX_TEXT_LENGTH) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n\n[内容过长，已截断]` : text;
}

function statusType(status) {
  if (typeof status === "string") return status;
  return status?.type || "unknown";
}

function sourceType(source) {
  if (typeof source === "string") return source;
  if (!source || typeof source !== "object") return "unknown";
  return source.type || Object.keys(source)[0] || "unknown";
}

function projectName(cwd) {
  if (!cwd) return "未知项目";
  const normalized = String(cwd).replace(/[\\/]+$/, "");
  return path.basename(normalized) || normalized;
}

export function sanitizeThreadSummary(thread) {
  return {
    id: thread.id,
    title: clip(thread.name || thread.preview || "未命名会话", 160),
    preview: clip(thread.preview || "", 240),
    project: projectName(thread.cwd),
    status: statusType(thread.status),
    source: sourceType(thread.source),
    updatedAt: thread.updatedAt || thread.recencyAt || thread.createdAt || 0,
    createdAt: thread.createdAt || 0,
  };
}

function userText(content = []) {
  return content
    .map((item) => {
      if (item?.type === "text") return item.text;
      if (item?.type === "image" || item?.type === "localImage") return "[图片]";
      if (item?.type === "audio" || item?.type === "localAudio") return "[音频]";
      if (item?.type === "mention") return `@${item.name || "会话"}`;
      if (item?.type === "skill") return `$${item.name || "skill"}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function commandSummary(value) {
  const raw = Array.isArray(value) ? value.join(" ") : value;
  if (typeof raw !== "string" || !raw.trim()) return "";
  const redacted = raw
    .replace(/\s+/g, " ")
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^'"\s]+/gi, "$1[已隐藏]")
    .replace(/((?:--?(?:api[-_]?key|token|secret|password|passwd|pwd|authorization|auth|cookie))\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1[已隐藏]")
    .replace(/((?:--?(?:api[-_]?key|token|secret|password|passwd|pwd|authorization|auth|cookie))\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1[已隐藏]")
    .replace(/(\b(?:api[-_]?key|token|secret|password|passwd|pwd|authorization|auth|cookie)\s*=\s*)(?:"[^"]*"|'[^'"\s;&|]+)/gi, "$1[已隐藏]")
    .replace(/([?&](?:api[-_]?key|token|secret|password|passwd|pwd|auth|cookie)=)[^&\s]+/gi, "$1[已隐藏]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[已隐藏]@")
    .trim();
  return redacted.length > 260 ? `${redacted.slice(0, 259)}…` : redacted;
}

function commandText(item) {
  const summary = commandSummary(item.command);
  if (item.status === "completed") {
    if (Number.isInteger(item.exitCode) && item.exitCode !== 0) {
      return summary ? `运行失败（退出码 ${item.exitCode}）：${summary}` : `命令失败（退出码 ${item.exitCode}）`;
    }
    return summary ? `运行 ${summary}` : "命令已完成";
  }
  const label = {
    failed: "运行失败",
    declined: "未运行",
    inProgress: "正在运行",
    running: "正在运行",
  }[item.status] || "运行";
  return summary ? `${label} ${summary}` : label.replace("运行", "命令执行");
}

function fileChangeText(item) {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const lines = changes.slice(0, 30).map((change) => {
    const file = change?.path ? path.basename(String(change.path)) : "文件";
    const rawKind = typeof change?.kind === "string"
      ? change.kind
      : change?.kind?.type || Object.keys(change?.kind || {})[0];
    const kind = {
      add: "新增",
      create: "新增",
      delete: "删除",
      remove: "删除",
      update: "修改",
      modify: "修改",
    }[rawKind] || "修改";
    return `${kind} ${file}`;
  });
  if (changes.length > lines.length) lines.push(`另有 ${changes.length - lines.length} 个文件`);
  return lines.join("\n") || "文件发生变化";
}

function activityMessage(item) {
  switch (item.type) {
    case "commandExecution":
      return { type: "command", label: "终端", status: item.status, text: commandText(item) };
    case "fileChange":
      return { type: "file", label: "文件", status: item.status, text: fileChangeText(item) };
    case "mcpToolCall":
      return { type: "tool", label: "工具", status: item.status, text: `调用 ${item.server || "MCP"} / ${item.tool || "工具"}` };
    case "dynamicToolCall":
      return { type: "tool", label: "工具", status: item.status, text: `调用 ${item.namespace ? `${item.namespace} / ` : ""}${item.tool || "工具"}` };
    case "collabAgentToolCall":
      return { type: "collab", label: "协作", status: item.status, text: item.tool || "处理协作任务" };
    case "webSearch":
      return { type: "web", label: "网页", status: item.status, text: item.query ? `搜索 ${item.query}` : "浏览网页" };
    case "contextCompaction":
      return { type: "context", label: "上下文", status: item.status, text: "压缩会话上下文" };
    default:
      return null;
  }
}

export function sanitizeThreadDetail(thread) {
  const messages = [];
  for (const turn of thread.turns || []) {
    const timestamp = turn.startedAt || null;
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        const text = userText(item.content);
        if (text) messages.push({ id: item.id, role: "user", kind: "message", text: clip(text), timestamp });
        continue;
      }

      if (item.type === "agentMessage") {
        if (item.text) {
          messages.push({
            id: item.id,
            role: "assistant",
            kind: item.phase === "commentary" ? "commentary" : "message",
            text: clip(item.text),
            timestamp,
          });
        }
        continue;
      }

      if (item.type === "plan" && item.text) {
        messages.push({ id: item.id, role: "assistant", kind: "plan", text: clip(item.text), timestamp });
        continue;
      }

      const activity = activityMessage(item);
      if (activity) {
        messages.push({
          id: item.id,
          role: "system",
          kind: "activity",
          label: activity.label,
          activityType: activity.type,
          activityStatus: activity.status,
          text: clip(activity.text, 4_000),
          timestamp,
        });
      }
    }

    if (turn.status === "failed" && turn.error?.message) {
      messages.push({
        id: `${turn.id}-error`,
        role: "system",
        kind: "error",
        label: "错误",
        text: clip(turn.error.message, 4_000),
        timestamp,
      });
    }
  }

  return {
    ...sanitizeThreadSummary(thread),
    messages,
  };
}
