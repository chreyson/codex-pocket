import path from "node:path";
import { commandPreview } from "./redaction.mjs";

const MAX_TEXT_LENGTH = 80_000;

function clip(value, limit = MAX_TEXT_LENGTH) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}\n\n[内容过长，已截断]` : text;
}

function messageId(value, fallback) {
  if (typeof value === "string" && value) return value;
  if (Number.isFinite(value)) return String(value);
  return fallback;
}

function timestamp(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function statusType(status) {
  const value = typeof status === "string" ? status : status?.type;
  return typeof value === "string" && value ? clip(value, 64) : "unknown";
}

function sourceType(source) {
  if (typeof source === "string") return source;
  if (!source || typeof source !== "object") return "unknown";
  const value = source.type || Object.keys(source)[0];
  return typeof value === "string" && value ? clip(value, 64) : "unknown";
}

function projectName(cwd) {
  if (!cwd) return "未知项目";
  const normalized = String(cwd).replace(/[\\/]+$/, "");
  return path.basename(normalized) || normalized;
}

export function sanitizeThreadSummary(thread) {
  const source = thread && typeof thread === "object" ? thread : {};
  return {
    id: source.id,
    title: clip(source.name || source.title || source.preview || "未命名会话", 160),
    preview: clip(source.preview || "", 240),
    project: projectName(source.cwd),
    status: statusType(source.status),
    source: sourceType(source.source),
    updatedAt: timestamp(source.updatedAt || source.recencyAt || source.createdAt),
    createdAt: timestamp(source.createdAt),
  };
}

function resolvedImage(resolveImage, source) {
  if (typeof resolveImage !== "function") return null;
  try {
    const value = resolveImage(source);
    return value && typeof value.src === "string" && value.src ? value : null;
  } catch {
    return null;
  }
}

function userContent(content = [], resolveImage) {
  const lines = [];
  const images = [];
  for (const item of Array.isArray(content) ? content : []) {
    if (item?.type === "text" && item.text) lines.push(item.text);
    else if (item?.type === "localImage") {
      const image = resolvedImage(resolveImage, {
        type: "local",
        path: item.path,
        alt: "上传的图片",
      });
      if (image) images.push(image);
      else lines.push("[图片]");
    } else if (item?.type === "image") {
      const image = resolvedImage(resolveImage, {
        type: "url",
        url: item.url,
        alt: "上传的图片",
      });
      if (image) images.push(image);
      else lines.push("[图片]");
    } else if (item?.type === "audio" || item?.type === "localAudio") lines.push("[音频]");
    else if (item?.type === "mention") lines.push(`@${item.name || "会话"}`);
    else if (item?.type === "skill") lines.push(`$${item.name || "skill"}`);
  }
  return { text: lines.filter(Boolean).join("\n"), images };
}

function agentContent(value, resolveImage) {
  const images = [];
  const lines = String(value ?? "").split("\n");
  const remaining = [];
  for (const line of lines) {
    const match = line.match(/^\s*!\[([^\]]*)\]\((.+)\)\s*$/);
    if (!match) {
      remaining.push(line);
      continue;
    }
    let target = match[2].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1).trim();
    }
    const source = /^(?:https:|data:image\/)/i.test(target)
      ? { type: "url", url: target, alt: match[1] || "图片" }
      : { type: "local", path: target, alt: match[1] || "图片" };
    const image = resolvedImage(resolveImage, source);
    if (image) images.push(image);
    else remaining.push(line);
  }
  return {
    text: remaining.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    images,
  };
}

function commandText(item) {
  const summary = commandPreview(item.command);
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
  if (!item || typeof item !== "object") return null;
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

function reasoningText(item) {
  const summaries = Array.isArray(item.summary) ? item.summary : [];
  return summaries
    .map((summary) => typeof summary === "string" ? summary : summary?.text)
    .filter(Boolean)
    .map((summary) => String(summary).replace(/^\*\*([\s\S]*)\*\*$/, "$1"))
    .join("\n");
}

function inferredItemStatus(turn, item, index, itemCount) {
  if (item.status) return item.status;
  const turnRunning = ["inProgress", "running"].includes(turn.status);
  return turnRunning && index === itemCount - 1 ? "inProgress" : "completed";
}

export function sanitizeThreadDetail(thread, { resolveImage } = {}) {
  const source = thread && typeof thread === "object" ? thread : {};
  const messages = [];
  const turns = Array.isArray(source.turns) ? source.turns : [];
  for (const [turnIndex, turn] of turns.entries()) {
    if (!turn || typeof turn !== "object") continue;
    const turnId = messageId(turn.id, `turn-${turnIndex}`);
    const startedAt = timestamp(turn.startedAt, null);
    const items = Array.isArray(turn.items) ? turn.items : [];
    for (const [index, item] of items.entries()) {
      if (!item || typeof item !== "object") continue;
      const itemId = messageId(item.id, `${turnId}-item-${index}`);
      if (item.type === "userMessage") {
        const content = userContent(item.content, resolveImage);
        if (content.text || content.images.length) {
          messages.push({
            id: itemId,
            turnId,
            clientId: typeof item.clientId === "string" ? clip(item.clientId, 200) : "",
            role: "user",
            kind: "message",
            text: clip(content.text),
            images: content.images,
            timestamp: startedAt,
          });
        }
        continue;
      }

      if (item.type === "reasoning") {
        const status = inferredItemStatus(turn, item, index, items.length);
        const text = reasoningText(item);
        if (text || ["inProgress", "running"].includes(status)) {
          messages.push({
            id: itemId,
            turnId,
            role: "assistant",
            kind: "reasoning",
            text: clip(text),
            activityStatus: status,
            timestamp: startedAt,
          });
        }
        continue;
      }

      if (item.type === "agentMessage") {
        const content = agentContent(item.text, resolveImage);
        if (content.text || content.images.length) {
          messages.push({
            id: itemId,
            turnId,
            role: "assistant",
            kind: item.phase === "commentary" ? "commentary" : "message",
            text: clip(content.text),
            images: content.images,
            timestamp: startedAt,
          });
        }
        continue;
      }

      if (item.type === "imageView") {
        const image = resolvedImage(resolveImage, {
          type: "local",
          path: item.path,
          alt: "查看的图片",
        });
        if (image) {
          messages.push({
            id: itemId,
            turnId,
            role: "system",
            kind: "image",
            label: "图片",
            text: "",
            images: [image],
            timestamp: startedAt,
          });
        }
        continue;
      }

      if (item.type === "imageGeneration") {
        const image = item.savedPath
          ? resolvedImage(resolveImage, {
            type: "local",
            path: item.savedPath,
            alt: "生成的图片",
          })
          : resolvedImage(resolveImage, {
            type: "data",
            data: item.result,
            alt: "生成的图片",
          });
        if (image) {
          messages.push({
            id: itemId,
            turnId,
            role: "assistant",
            kind: "image",
            text: clip(item.revisedPrompt || "", 2_000),
            images: [image],
            timestamp: startedAt,
          });
        }
        continue;
      }

      if (item.type === "plan" && item.text) {
        messages.push({ id: itemId, turnId, role: "assistant", kind: "plan", text: clip(item.text), timestamp: startedAt });
        continue;
      }

      const activity = activityMessage(item);
      if (activity) {
        messages.push({
          id: itemId,
          turnId,
          role: "system",
          kind: "activity",
          label: activity.label,
          activityType: activity.type,
          activityStatus: activity.status,
          text: clip(activity.text, 4_000),
          timestamp: startedAt,
        });
      }
    }

    if (turn.status === "failed" && turn.error?.message) {
      messages.push({
        id: `${turnId}-error`,
        turnId,
        role: "system",
        kind: "error",
        label: "错误",
        text: clip(turn.error.message, 4_000),
        timestamp: startedAt,
      });
    }
  }

  return {
    ...sanitizeThreadSummary(source),
    messages,
  };
}

export function sanitizeDesktopThreadSnapshot(value, options = {}) {
  const sourceThread = value?.thread;
  if (typeof sourceThread?.id !== "string" || !sourceThread.id) {
    throw new Error("Codex App 返回的会话快照无效");
  }

  const turns = Array.isArray(value.turns)
    ? value.turns.filter((turn) => turn && typeof turn === "object")
    : [];
  if (value.page?.order === "newest_first") turns.reverse();
  const activeTurn = [...turns].reverse().find(
    (turn) => ["inProgress", "running"].includes(turn?.status),
  );
  const busy = Boolean(activeTurn);

  return {
    ...sanitizeThreadDetail({ ...sourceThread, turns }, options),
    partial: true,
    control: {
      busy,
      phase: busy ? "running" : "idle",
      turnId: activeTurn?.id || null,
    },
  };
}
