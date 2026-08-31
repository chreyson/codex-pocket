import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

const MAX_LIVE_MESSAGE_LENGTH = 80_000;

function clipLiveMessageText(value) {
  return String(value ?? "").slice(0, MAX_LIVE_MESSAGE_LENGTH);
}

export class CodexAppServer extends EventEmitter {
  constructor({ command = process.env.CODEX_BIN || "codex", requestTimeoutMs = 20_000 } = {}) {
    super();
    this.command = command;
    this.requestTimeoutMs = requestTimeoutMs;
    this.proc = null;
    this.startPromise = null;
    this.pending = new Map();
    this.nextId = 1;
    this.lastError = null;
    this.loadedThreads = new Set();
    this.activeTurns = new Map();
    this.startingThreads = new Set();
    this.liveAgentMessages = new Map();
    this.serverRequests = new Map();
    this.serverRequestTokensById = new Map();
    this.nextServerRequestToken = 1;
  }

  async start() {
    if (this.proc && !this.proc.killed) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this._startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async _startProcess() {
    const proc = spawn(this.command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
      env: process.env,
    });

    this.proc = proc;
    this.lastError = null;

    const lines = readline.createInterface({ input: proc.stdout });
    lines.on("line", (line) => this._handleLine(line));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) this.emit("diagnostic", message);
    });

    proc.on("error", (error) => {
      this.lastError = error;
      this.emit("diagnostic", error.message);
    });

    proc.on("exit", (code, signal) => {
      if (this.proc === proc) this.proc = null;
      const error = new Error(`Codex App Server exited (${signal ?? code ?? "unknown"})`);
      this.lastError = error;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
      this.loadedThreads.clear();
      this.activeTurns.clear();
      this.startingThreads.clear();
      this.liveAgentMessages.clear();
      this.serverRequests.clear();
      this.serverRequestTokensById.clear();
      this.emit("exit", { code, signal });
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
        experimentalApi: false,
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

  _captureThreadState(thread) {
    if (!thread?.id) return;
    const activeTurn = [...(thread.turns || [])].reverse().find((turn) => turn.status === "inProgress");
    if (activeTurn?.id) this.activeTurns.set(thread.id, activeTurn.id);
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
    this.liveAgentMessages.set(key, record);
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
      this.liveAgentMessages.set(key, record);
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
      this.liveAgentMessages.set(key, record);
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

    if (method === "item/started") {
      this._startLiveAgentMessage(message, params);
    } else if (method === "item/agentMessage/delta") {
      this._appendLiveAgentMessage(message, params);
    } else if (method === "item/completed") {
      this._completeLiveAgentMessage(message, params);
    }

    if (method === "turn/started" && threadId && params.turn?.id) {
      this.activeTurns.set(threadId, params.turn.id);
      controlChanged = true;
    } else if (method === "turn/completed" && threadId) {
      this.activeTurns.delete(threadId);
      this._removeRequestsForThread(threadId);
      controlChanged = true;
    } else if (method === "thread/status/changed" && threadId && params.status?.type !== "active") {
      this.activeTurns.delete(threadId);
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

  async readThread(threadId) {
    await this.start();
    return this.request("thread/read", {
      threadId,
      includeTurns: true,
    });
  }

  async resumeThread(threadId) {
    await this.start();
    if (this.loadedThreads.has(threadId)) return null;
    const result = await this.request("thread/resume", { threadId });
    this.loadedThreads.add(threadId);
    this._captureThreadState(result.thread);
    return result;
  }

  async startTurn(threadId, text) {
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

      const result = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
      });
      if (result.turn?.id) this.activeTurns.set(threadId, result.turn.id);
      return result;
    } finally {
      this.startingThreads.delete(threadId);
      this.emit("control", { threadId });
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
