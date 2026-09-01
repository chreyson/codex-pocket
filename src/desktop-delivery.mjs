import { sanitizeDesktopThreadSnapshot } from "./transform.mjs";

export function isDesktopWriterConflict(error) {
  return /already has an active writer/i.test(String(error?.message || ""));
}

function deliveryError(message, code, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function desktopPrompt(text, skills = []) {
  return [
    ...skills.map((skill) => `$${skill.name}`),
    String(text || "").trim(),
  ].filter(Boolean).join("\n");
}

export async function sendDesktopTurn({
  desktopBridge,
  threadId,
  text,
  options = {},
  transformOptions = {},
}) {
  const value = await desktopBridge.readThread(threadId);
  const snapshot = sanitizeDesktopThreadSnapshot(value, transformOptions);
  if (snapshot.control.busy) {
    throw deliveryError(
      "Codex Desktop 正在处理这个会话，请完成后再发送",
      "TURN_ACTIVE",
    );
  }
  if ((options.images || []).length) {
    throw deliveryError(
      "Codex Desktop 持有这个会话，当前无法从 Web 端转交图片。请移除图片后重试，或退出 Codex Desktop",
      "DESKTOP_DELIVERY_UNSUPPORTED",
    );
  }
  if (options.mode === "plan") {
    throw deliveryError(
      "Codex Desktop 持有这个会话，当前无法从 Web 端转交计划模式。请切换到执行模式后重试，或退出 Codex Desktop",
      "DESKTOP_DELIVERY_UNSUPPORTED",
    );
  }

  const prompt = desktopPrompt(text, options.skills);
  const result = await desktopBridge.sendMessage(threadId, prompt, {
    model: options.model,
    effort: options.effort,
  });
  return { result, snapshot };
}

export async function startTurnWithDesktopFallback({
  codex,
  desktopBridge,
  threadId,
  text,
  options = {},
  transformOptions = {},
}) {
  try {
    return {
      delivery: "app-server",
      result: await codex.startTurn(threadId, text, options),
    };
  } catch (error) {
    if (!isDesktopWriterConflict(error)) throw error;
    const desktop = await sendDesktopTurn({
      desktopBridge,
      threadId,
      text,
      options,
      transformOptions,
    });
    return { delivery: "codex-app", result: desktop.result };
  }
}
