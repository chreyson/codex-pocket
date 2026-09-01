import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

const MAX_LIVE_MESSAGE_LENGTH = 80_000;
export const MAX_LIVE_MESSAGE_COUNT = 128;

function clipLiveMessageText(value) {
  return String(value ?? "").slice(0, MAX_LIVE_MESSAGE_LENGTH);
}

function turnInput(text, options = {}) {
  const input = (options.skills || []).map((skill) => ({
    type: "skill",
    name: skill.name,
    path: skill.path,
  }));
  for (const image of options.images || []) {
    if (!image?.path) continue;
    input.push({
      type: "localImage",
      path: image.path,
      detail: image.detail || "auto",
    });
  }
  const messageText = typeof text === "string" ? text.trim() : "";
  if (messageText) input.push({ type: "text", text: messageText, text_elements: [] });
  if (!messageText && !input.some((item) => item.type === "localImage")) {
    const error = new Error("A Codex turn requires text or an image");
    error.code = "EMPTY_INPUT";
    throw error;
  }
  return input;
}

export function appServerLaunchSpec(command, {
  platform = process.platform,
  comspec = process.env.ComSpec || "cmd.exe",
} = {}) {
  const value = String(command || "").trim();
  if (!value) throw new Error("Codex executable is not configured");
  const args = ["app-server", "--stdio"];
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(value)) {
    return { command: value, args, shell: false };
  }
  if (/["\r\n%!]/.test(value)) {
    throw new Error("Codex executable path contains unsupported characters");
  }
  return {
    command: `"${value}" app-server --stdio`,
    args: [],
    shell: comspec,
  };
}

export class CodexAppServer extends EventEmitter {
  constructor({
    command = process.env.CODEX_BIN || "codex",
    requestTimeoutMs = 20_000,
    experimentalApi = true,
  } = {}) {
    super();
    this.command = command;
    this.requestTimeoutMs = requestTimeoutMs;
    this.experimentalApi = experimentalApi;
    this.proc = null;
    this.startPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lastError = null;
    this.loadedThreads = new Set();
    this.activeTurns = new Map();
    this.startingThreads = new Set();
    this.interruptingThreads = new Set();
    this.liveAgentMessages = new Map();
    this.threadSettings = new Map();
    this.serverRequests = new Map();
    this.serverRequestTokensById = new Map();
    this.nextServerRequestToken = 1;
  }

  _clearRuntimeState(error) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    this.loadedThreads.clear();
    this.activeTurns.clear();
    this.startingThreads.clear();
    this.interruptingThreads.clear();
    this.liveAgentMessages.clear();
    this.threadSettings.clear();
    this.serverRequests.clear();
    this.serverRequestTokensById.clear();
  }

  _handleProcessExit(proc, code, signal) {
    if (this.proc !== proc) return false;
    this.proc = null;
    const error = new Error(`Codex App Server exited (${signal ?? code ?? "unknown"})`);
    this.lastError = error;
    this._clearRuntimeState(error);
    this.emit("exit", { code, signal });
    return true;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.proc && !this.proc.killed) return;

    this.startPromise = this._startProcess();
    try {
      await this.startPromise;
    } catch (error) {
      try {
        this.stop();
      } catch {
        // Preserve the startup failure; process cleanup is best-effort here.
      }
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  async _startProcess() {
    const launch = appServerLaunchSpec(this.command);
    const proc = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: launch.shell,
      windowsHide: true,
      env: process.env,
    });

    this.proc = proc;
    this.lastError = null;

    const lines = readline.createInterface({ input: proc.stdout });
    lines.on("line", (line) => {
      if (this.proc === proc) this._handleLine(line);
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      if (this.proc !== proc) return;
      const message = String(chunk).trim();
      if (message) this.emit("diagnostic", message);
    });
    proc.stdin.on("error", (error) => {
      if (this.proc === proc) this.emit("diagnostic", error.message);
    });

    proc.on("error", (error) => {
      if (this.proc !== proc) return;
      this.lastError = error;
      this.emit("diagnostic", error.message);
    });

    proc.on("exit", (code, signal) => {
      this._handleProcessExit(proc, code, signal);
    });

    await new Promise((resolve, reject) => {
      proc.once("spawn", resolve);
      proc.once("error", reject);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex_pocket",
        title: "Codex Pocket",
        version: "0.2.0",
      },
      capabilities: {
        experimentalApi: this.experimentalApi,
      },
    });
    this.notify("initialized", {});
    this.emit("ready");
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("diagnostic", `Ignored non-JSON App Server output: ${line}`);
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.emit("diagnostic", "Ignored malformed App Server message");
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Codex App Server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      const token = `request-${this.nextServerRequestToken++}`;
      const record = { token, message, responding: false };
      this.serverRequests.set(token, record);
      this.serverRequestTokensById.set(this._serverRequestIdKey(message.id), token);
      this.emit("serverRequest", record);
      this.emit("control", { threadId: message.params?.threadId || "" });
      return;
    }

    if (message.method) {
      this._trackNotification(message);
      this.emit("notification", message);
    }
  }

  _serverRequestIdKey(id) {
    return `${typeof id}:${String(id)}`;
  }

  _captureThreadState(thread, { authoritative = true } = {}) {
    if (!thread?.id) return;
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const activeTurn = [...turns].reverse().find(
      (turn) => ["inProgress", "running"].includes(turn?.status),
    );
    if (activeTurn?.id) {
      this.activeTurns.set(thread.id, activeTurn.id);
    } else if (authoritative) {
      this.activeTurns.delete(thread.id);
      this.interruptingThreads.delete(thread.id);
    }
  }

  _rememberThreadSession(result, expectedThreadId = "") {
    const threadId = result?.thread?.id;
    if (
      typeof threadId !== "string"
      || !threadId
      || (expectedThreadId && threadId !== expectedThreadId)
    ) {
      const error = new Error("Codex App Server returned an invalid thread response");
      error.code = "INVALID_THREAD_RESPONSE";
      throw error;
    }

    this.loadedThreads.add(threadId);
    this._captureThreadState(result.thread);
    this.threadSettings.set(threadId, {
      model: result.model || "",
      effort: result.reasoningEffort || null,
      serviceTier: result.serviceTier || null,
      collaborationMode: null,
    });
    return threadId;
  }

  _removeRequestsForThread(threadId) {
    for (const [token, record] of this.serverRequests) {
      if (record.message.params?.threadId !== threadId) continue;
      this.serverRequests.delete(token);
      this.serverRequestTokensById.delete(this._serverRequestIdKey(record.message.id));
    }
  }

  _liveAgentMessageKey(threadId, turnId, itemId) {
    return `${threadId}\u0000${turnId}\u0000${itemId}`;
  }

  _storeLiveAgentMessage(key, record) {
    this.liveAgentMessages.set(key, record);
    while (this.liveAgentMessages.size > MAX_LIVE_MESSAGE_COUNT) {
      let removableKey = null;
      for (const [candidateKey, candidate] of this.liveAgentMessages) {
        if (candidate.done) {
          removableKey = candidateKey;
          break;
        }
        if (removableKey === null) removableKey = candidateKey;
      }
      if (removableKey === null) break;
      this.liveAgentMessages.delete(removableKey);
    }
    return record;
  }

  _messageTimestamp(message, params) {
    const timestampMs = params.startedAtMs ?? params.completedAtMs ?? message.emittedAtMs;
    return Number.isFinite(timestampMs) ? timestampMs / 1_000 : Date.now() / 1_000;
  }

  _publicLiveAgentMessage(record) {
    return {
      threadId: record.threadId,
      turnId: record.turnId,
      itemId: record.itemId,
      kind: record.kind,
      text: record.text,
      timestamp: record.timestamp,
    };
  }

  _startLiveAgentMessage(message, params) {
    const { threadId, turnId, item } = params;
    if (!threadId || !turnId || item?.type !== "agentMessage" || !item.id) return null;

    const key = this._liveAgentMessageKey(threadId, turnId, item.id);
    const record = {
      threadId,
      turnId,
      itemId: item.id,
      kind: item.phase === "commentary" ? "commentary" : "message",
      text: clipLiveMessageText(item.text),
      timestamp: this._messageTimestamp(message, params),
      done: false,
    };
    this._storeLiveAgentMessage(key, record);
    this.emit("messageStart", this._publicLiveAgentMessage(record));
    return record;
  }

  _appendLiveAgentMessage(message, params) {
    const { threadId, turnId, itemId } = params;
    if (!threadId || !turnId || !itemId || typeof params.delta !== "string") return null;

    const key = this._liveAgentMessageKey(threadId, turnId, itemId);
    let record = this.liveAgentMessages.get(key);
    if (!record) {
      record = {
        threadId,
        turnId,
        itemId,
        kind: "message",
        text: "",
        timestamp: this._messageTimestamp(message, params),
        done: false,
      };
      this._storeLiveAgentMessage(key, record);
      this.emit("messageStart", this._publicLiveAgentMessage(record));
    }
    if (record.done) return record;

    const remaining = MAX_LIVE_MESSAGE_LENGTH - record.text.length;
    const delta = remaining > 0 ? params.delta.slice(0, remaining) : "";
    if (delta) {
      record.text += delta;
      this.emit("messageDelta", { threadId, turnId, itemId, delta });
    }
    return record;
  }

  _completeLiveAgentMessage(message, params) {
    const { threadId, turnId, item } = params;
    if (!threadId || !turnId || item?.type !== "agentMessage" || !item.id) return null;

    const key = this._liveAgentMessageKey(threadId, turnId, item.id);
    let record = this.liveAgentMessages.get(key);
    if (!record) {
      record = {
        threadId,
        turnId,
        itemId: item.id,
        kind: item.phase === "commentary" ? "commentary" : "message",
        text: "",
        timestamp: this._messageTimestamp(message, params),
        done: false,
      };
      this._storeLiveAgentMessage(key, record);
      this.emit("messageStart", this._publicLiveAgentMessage(record));
    }

    record.kind = item.phase === "commentary" ? "commentary" : "message";
    record.text = clipLiveMessageText(item.text);
    record.done = true;
    this.emit("messageDone", this._publicLiveAgentMessage(record));
    return record;
  }

  _trackNotification(message) {
    const { method, params = {} } = message;
    const threadId = params.threadId || "";
    let controlChanged = false;

    if (method === "thread/settings/updated" && threadId && params.threadSettings) {
      this.threadSettings.set(threadId, params.threadSettings);
    }

    if (method === "item/started") {
      this._startLiveAgentMessage(message, params);
    } else if (method === "item/agentMessage/delta") {
      this._appendLiveAgentMessage(message, params);
    } else if (method === "item/completed") {
      this._completeLiveAgentMessage(message, params);
    }

    if (method === "turn/started" && threadId && params.turn?.id) {
      this.activeTurns.set(threadId, params.turn.id);
      this.interruptingThreads.delete(threadId);
      controlChanged = true;
    } else if (method === "turn/completed" && threadId) {
      this.activeTurns.delete(threadId);
      this.interruptingThreads.delete(threadId);
      this._removeRequestsForThread(threadId);
      controlChanged = true;
    } else if (method === "thread/status/changed" && threadId && params.status?.type !== "active") {
      this.activeTurns.delete(threadId);
      this.interruptingThreads.delete(threadId);
      controlChanged = true;
    } else if (method === "serverRequest/resolved") {
      const token = this.serverRequestTokensById.get(this._serverRequestIdKey(params.requestId));
      if (token) {
        const record = this.serverRequests.get(token);
        this.serverRequests.delete(token);
        this.serverRequestTokensById.delete(this._serverRequestIdKey(params.requestId));
        this.emit("control", { threadId: record?.message.params?.threadId || threadId });
      }
    }

    if (controlChanged) this.emit("control", { threadId });
  }

  _write(message) {
    if (!this.proc?.stdin?.writable) throw new Error("Codex App Server is not running");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this._write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this._write({ method, params });
  }

  async listThreads({ limit = 60 } = {}) {
    await this.start();
    return this.request("thread/list", {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      useStateDbOnly: false,
    });
  }

  async readThread(threadId, { includeTurns = true } = {}) {
    await this.start();
    const result = await this.request("thread/read", {
      threadId,
      includeTurns,
    });
    if (includeTurns) this._captureThreadState(result.thread);
    return result;
  }

  async listModels({ includeHidden = false } = {}) {
    await this.start();
    const models = [];
    const seenCursors = new Set();
    const seenModels = new Set();
    let cursor = null;
    do {
      const result = await this.request("model/list", {
        cursor,
        limit: 100,
        includeHidden,
      });
      const page = Array.isArray(result?.data) ? result.data : [];
      for (const model of page) {
        const modelId = typeof model?.model === "string"
          ? model.model
          : typeof model?.id === "string" ? model.id : "";
        if (modelId && seenModels.has(modelId)) continue;
        if (modelId) seenModels.add(modelId);
        models.push(model);
      }
      const nextCursor = typeof result?.nextCursor === "string"
        ? result.nextCursor
        : null;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        cursor = null;
      } else {
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    } while (cursor && models.length < 500);
    return models;
  }

  async listSkills(cwd, { forceReload = false } = {}) {
    await this.start();
    const result = await this.request("skills/list", {
      cwds: cwd ? [cwd] : [],
      forceReload,
    });
    return Array.isArray(result?.data) ? result.data : [];
  }

  async listCollaborationModes() {
    await this.start();
    const result = await this.request("collaborationMode/list", {});
    return Array.isArray(result?.data) ? result.data : [];
  }

  async getGoal(threadId) {
    await this.start();
    return (await this.request("thread/goal/get", { threadId })).goal || null;
  }

  async setGoal(threadId, value) {
    await this.start();
    return (await this.request("thread/goal/set", { threadId, ...value })).goal;
  }

  async clearGoal(threadId) {
    await this.start();
    return this.request("thread/goal/clear", { threadId });
  }

  async composerCatalog(threadId, { thread: suppliedThread = null } = {}) {
    const threadResult = suppliedThread
      ? Promise.resolve(suppliedThread).then((thread) => ({ thread }))
      : this.readThread(threadId, { includeTurns: false });
    const [{ thread }, models] = await Promise.all([
      threadResult,
      this.listModels(),
    ]);
    const cwd = String(thread?.cwd || process.cwd());
    const [skillEntries, modeResult, goalResult] = await Promise.all([
      this.listSkills(cwd),
      this.listCollaborationModes()
        .then((modes) => ({ supported: true, modes }))
        .catch(() => ({ supported: false, modes: [] })),
      this.getGoal(threadId)
        .then((goal) => ({ supported: true, goal }))
        .catch(() => ({ supported: false, goal: null })),
    ]);
    return {
      models,
      skillEntries,
      modes: modeResult.modes,
      modeListSupported: modeResult.supported,
      goal: goalResult.goal,
      goalSupported: goalResult.supported,
      current: this.threadSettings.get(threadId) || null,
    };
  }

  async startThread({ cwd = "" } = {}) {
    await this.start();
    const params = { ephemeral: false };
    if (cwd) params.cwd = cwd;
    const result = await this.request("thread/start", params);
    this._rememberThreadSession(result);
    return result;
  }

  async resumeThread(threadId) {
    await this.start();
    if (this.loadedThreads.has(threadId)) return this.threadSettings.get(threadId) || null;
    const result = await this.request("thread/resume", { threadId });
    this._rememberThreadSession(result, threadId);
    return result;
  }

  async startTurn(threadId, text, options = {}) {
    if (this.isThreadBusy(threadId)) {
      const error = new Error("This Codex conversation already has an active turn");
      error.code = "TURN_ACTIVE";
      throw error;
    }

    this.startingThreads.add(threadId);
    this.emit("control", { threadId });
    try {
      await this.resumeThread(threadId);
      if (this.activeTurns.has(threadId)) {
        const error = new Error("This Codex conversation already has an active turn");
        error.code = "TURN_ACTIVE";
        throw error;
      }

      const params = {
        threadId,
        input: turnInput(text, options),
      };
      if (options.clientMessageId) params.clientUserMessageId = options.clientMessageId;
      if (options.model) params.model = options.model;
      if (options.effort) params.effort = options.effort;
      if (["default", "plan"].includes(options.mode) && options.model) {
        params.collaborationMode = {
          mode: options.mode,
          settings: {
            model: options.model,
            reasoning_effort: options.effort || null,
            developer_instructions: null,
          },
        };
      }

      const result = await this.request("turn/start", params);
      if (result.turn?.id) this.activeTurns.set(threadId, result.turn.id);
      if (options.model || options.effort || options.mode) {
        const previous = this.threadSettings.get(threadId) || {};
        this.threadSettings.set(threadId, {
          ...previous,
          model: options.model || previous.model || "",
          effort: options.effort || previous.effort || null,
          collaborationMode: options.mode || null,
        });
      }
      return result;
    } finally {
      this.startingThreads.delete(threadId);
      this.emit("control", { threadId });
    }
  }

  async steerTurn(threadId, text, options = {}) {
    await this.start();
    const expectedTurnId = options.turnId || this.activeTurns.get(threadId);
    if (!expectedTurnId) {
      const error = new Error("This Codex conversation has no steerable active turn");
      error.code = "NO_ACTIVE_TURN";
      throw error;
    }
    return this.request("turn/steer", {
      threadId,
      expectedTurnId,
      input: turnInput(text, options),
      ...(options.clientMessageId
        ? { clientUserMessageId: options.clientMessageId }
        : {}),
    });
  }

  async interruptTurn(threadId, turnId = this.activeTurns.get(threadId)) {
    await this.start();
    if (!turnId) {
      const error = new Error("This Codex conversation has no active turn");
      error.code = "NO_ACTIVE_TURN";
      throw error;
    }

    this.interruptingThreads.add(threadId);
    this.emit("control", { threadId });
    try {
      const result = await this.request("turn/interrupt", { threadId, turnId });
      return { ...result, turnId };
    } catch (error) {
      this.interruptingThreads.delete(threadId);
      this.emit("control", { threadId });
      throw error;
    }
  }

  isThreadBusy(threadId) {
    return this.startingThreads.has(threadId) || this.activeTurns.has(threadId);
  }

  threadControlState(threadId) {
    return {
      busy: this.isThreadBusy(threadId),
      phase: this.startingThreads.has(threadId)
        ? "starting"
        : this.interruptingThreads.has(threadId) ? "interrupting"
        : this.activeTurns.has(threadId) ? "running" : "idle",
      turnId: this.activeTurns.get(threadId) || null,
    };
  }

  pendingServerRequests(threadId) {
    return [...this.serverRequests.values()].filter(
      (record) => record.message.params?.threadId === threadId,
    );
  }

  liveAgentMessagesForThread(threadId) {
    return [...this.liveAgentMessages.values()]
      .filter((record) => record.threadId === threadId)
      .map((record) => ({
        event: record.done ? "messageDone" : "messageStart",
        value: this._publicLiveAgentMessage(record),
      }));
  }

  confirmLiveAgentMessageSnapshot(threadId, messages = []) {
    const snapshotById = new Map(
      messages
        .filter((message) => message?.role === "assistant" && message.id)
        .map((message) => [message.id, clipLiveMessageText(message.text)]),
    );
    let removed = 0;
    for (const [key, record] of this.liveAgentMessages) {
      if (record.threadId !== threadId || !record.done) continue;
      if (snapshotById.get(record.itemId) !== record.text) continue;
      this.liveAgentMessages.delete(key);
      removed += 1;
    }
    return removed;
  }

  respondToServerRequest(token, result) {
    const record = this.serverRequests.get(token);
    if (!record) {
      const error = new Error("The Codex request is no longer pending");
      error.code = "REQUEST_NOT_FOUND";
      throw error;
    }
    if (record.responding) {
      const error = new Error("The Codex request is already being resolved");
      error.code = "REQUEST_RESOLVING";
      throw error;
    }

    record.responding = true;
    try {
      this._write({ id: record.message.id, result });
    } catch (error) {
      record.responding = false;
      throw error;
    }
    this.emit("control", { threadId: record.message.params?.threadId || "" });
    return record;
  }

  stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    this._clearRuntimeState(new Error("Codex App Server stopped"));
    if (process.platform === "win32" && proc.pid) {
      const result = spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 5_000,
      });
      if (result.error || result.status !== 0) proc.kill();
      return;
    }
    proc.kill();
  }
}
