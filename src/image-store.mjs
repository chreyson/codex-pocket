import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_RENDER_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 4;

const UPLOAD_ID_PATTERN = /^img_[a-f0-9]{32}$/;
const DATA_IMAGE_PATTERN = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i;

function imageError(status, message, code = "IMAGE_ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function cleanName(value) {
  const decoded = (() => {
    try {
      return decodeURIComponent(String(value ?? ""));
    } catch {
      return String(value ?? "");
    }
  })();
  const name = path.basename(decoded.replaceAll("\0", "")).trim().slice(0, 160);
  return name || "图片";
}

function normalizedLocalPath(value) {
  let candidate = typeof value === "string" ? value.replaceAll("\0", "").trim() : "";
  if (!candidate) return "";
  if (/^file:/i.test(candidate)) {
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      return "";
    }
  }
  if (!path.isAbsolute(candidate)) return "";
  return path.normalize(candidate);
}

function sourceKey(filePath) {
  const normalized = path.normalize(filePath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isPng(buffer) {
  return buffer.length >= 8
    && buffer[0] === 0x89
    && buffer.subarray(1, 4).toString("ascii") === "PNG"
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
}

export function detectImageType(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
  if (isPng(buffer)) return { mimeType: "image/png", extension: ".png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: ".jpg" };
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) {
    return { mimeType: "image/gif", extension: ".gif" };
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { mimeType: "image/webp", extension: ".webp" };
  }
  return null;
}

function decodeDataImage(value) {
  const text = typeof value === "string" ? value.trim() : "";
  const match = text.match(DATA_IMAGE_PATTERN);
  const encoded = match ? match[2] : text;
  if (!encoded || !/^[a-z0-9+/=\s]+$/i.test(encoded)) return null;
  try {
    const data = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
    return data.length ? data : null;
  } catch {
    return null;
  }
}

export class ImageStore {
  constructor(directory, {
    idFactory = randomUUID,
    maxEntries = 2_048,
    maxPendingUploads = 64,
  } = {}) {
    this.directory = path.resolve(directory);
    this.idFactory = idFactory;
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : 2_048;
    this.maxPendingUploads = Number.isInteger(maxPendingUploads) && maxPendingUploads > 0
      ? maxPendingUploads
      : 64;
    this.pendingUploadReservations = 0;
    this.entries = new Map();
    this.sourceIds = new Map();
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
  }

  _newId(prefix) {
    return `${prefix}_${String(this.idFactory()).replaceAll("-", "").toLowerCase()}`;
  }

  _descriptor(entry, alt = entry.name) {
    return {
      id: entry.id,
      src: `/api/images/${encodeURIComponent(entry.id)}`,
      alt: cleanName(alt),
      mimeType: entry.mimeType || "",
      size: Number.isFinite(entry.size) ? entry.size : null,
    };
  }

  _forget(entry) {
    if (!entry) return false;
    const removed = this.entries.delete(entry.id);
    if (entry.sourceKey && this.sourceIds.get(entry.sourceKey) === entry.id) {
      this.sourceIds.delete(entry.sourceKey);
    }
    return removed;
  }

  _remember(entry, key = "") {
    this.entries.set(entry.id, entry);
    if (key) this.sourceIds.set(key, entry.id);
    while (this.entries.size > this.maxEntries) {
      const removable = [...this.entries.values()].find(
        (item) => item.kind !== "upload" || item.committed,
      );
      if (!removable) break;
      this._forget(removable);
    }
    return entry;
  }

  async saveUpload(value, { fileName = "", contentType = "" } = {}) {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value || []);
    if (!buffer.length) throw imageError(400, "请选择要上传的图片", "IMAGE_EMPTY");
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw imageError(413, "单张图片不能超过 12 MB", "IMAGE_TOO_LARGE");
    }
    const detected = detectImageType(buffer);
    if (!detected) {
      throw imageError(415, "仅支持 PNG、JPEG、WebP 或 GIF 图片", "IMAGE_TYPE_UNSUPPORTED");
    }
    const claimed = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
    if (claimed && claimed !== "application/octet-stream" && !claimed.startsWith("image/")) {
      throw imageError(415, "上传内容不是图片", "IMAGE_TYPE_UNSUPPORTED");
    }

    const pendingUploads = [...this.entries.values()].filter(
      (entry) => entry.kind === "upload" && !entry.committed,
    ).length;
    if (pendingUploads + this.pendingUploadReservations >= this.maxPendingUploads) {
      throw imageError(429, "待发送图片过多，请先发送或移除现有图片", "IMAGE_UPLOAD_LIMIT");
    }

    this.pendingUploadReservations += 1;
    try {
      await this.init();
      const id = this._newId("img");
      const filePath = path.join(this.directory, `${id}${detected.extension}`);
      await fs.writeFile(filePath, buffer, { flag: "wx", mode: 0o600 });
      const key = `file:${sourceKey(filePath)}`;
      const entry = this._remember({
        id,
        kind: "upload",
        path: filePath,
        name: cleanName(fileName),
        mimeType: detected.mimeType,
        size: buffer.length,
        committed: false,
        sourceKey: key,
      }, key);
      return this._descriptor(entry);
    } finally {
      this.pendingUploadReservations -= 1;
    }
  }

  async resolveUploads(ids = []) {
    const resolved = [];
    for (const id of ids) {
      if (!UPLOAD_ID_PATTERN.test(id)) {
        throw imageError(400, "图片附件标识无效", "IMAGE_ID_INVALID");
      }
      const entry = this.entries.get(id);
      if (!entry || entry.kind !== "upload") {
        throw imageError(410, "图片附件已失效，请重新选择", "IMAGE_UPLOAD_EXPIRED");
      }
      try {
        const info = await fs.stat(entry.path);
        if (!info.isFile() || info.size !== entry.size) throw new Error("invalid upload");
      } catch {
        throw imageError(410, "图片附件已失效，请重新选择", "IMAGE_UPLOAD_EXPIRED");
      }
      resolved.push({ id: entry.id, path: entry.path, detail: "auto" });
    }
    return resolved;
  }

  commitUploads(ids = []) {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry?.kind === "upload") entry.committed = true;
    }
  }

  async removeUpload(id) {
    const entry = this.entries.get(id);
    if (!entry || entry.kind !== "upload") return false;
    if (entry.committed) {
      throw imageError(409, "已发送的图片不能删除", "IMAGE_ALREADY_SENT");
    }
    this._forget(entry);
    try {
      await fs.unlink(entry.path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return true;
  }

  registerLocalImage(value, { alt = "图片" } = {}) {
    const filePath = normalizedLocalPath(value);
    if (!filePath) return null;
    const key = `file:${sourceKey(filePath)}`;
    const existing = this.sourceIds.get(key);
    if (existing && this.entries.has(existing)) {
      return this._descriptor(this.entries.get(existing), alt);
    }
    const entry = this._remember({
      id: this._newId("asset"),
      kind: "local",
      path: filePath,
      name: cleanName(alt || path.basename(filePath)),
      mimeType: "",
      size: null,
      sourceKey: key,
    }, key);
    return this._descriptor(entry, alt);
  }

  registerDataImage(value, { alt = "图片" } = {}) {
    const data = decodeDataImage(value);
    if (!data || data.length > MAX_RENDER_IMAGE_BYTES) return null;
    const detected = detectImageType(data);
    if (!detected) return null;
    const digest = createHash("sha256").update(data).digest("hex");
    const key = `data:${digest}`;
    const existing = this.sourceIds.get(key);
    if (existing && this.entries.has(existing)) {
      return this._descriptor(this.entries.get(existing), alt);
    }
    const entry = this._remember({
      id: this._newId("asset"),
      kind: "data",
      data,
      name: cleanName(alt),
      mimeType: detected.mimeType,
      size: data.length,
      sourceKey: key,
    }, key);
    return this._descriptor(entry, alt);
  }

  registerThreadImage(source = {}) {
    if (source.type === "local") {
      return this.registerLocalImage(source.path, { alt: source.alt });
    }
    if (source.type === "data") {
      return this.registerDataImage(source.data, { alt: source.alt });
    }
    if (source.type === "url") {
      const value = typeof source.url === "string" ? source.url.trim() : "";
      if (/^data:image\//i.test(value)) {
        return this.registerDataImage(value, { alt: source.alt });
      }
      try {
        const url = new URL(value);
        if (url.protocol === "https:") {
          return { src: url.href, alt: cleanName(source.alt), mimeType: "", size: null };
        }
      } catch {
        // Unsupported URL inputs fall back to a textual placeholder.
      }
    }
    return null;
  }

  async readImage(id) {
    const entry = this.entries.get(id);
    if (!entry) throw imageError(404, "图片不存在或已失效", "IMAGE_NOT_FOUND");
    if (entry.kind === "data") {
      return { data: entry.data, mimeType: entry.mimeType };
    }
    let info;
    try {
      info = await fs.stat(entry.path);
    } catch {
      throw imageError(404, "图片不存在或已失效", "IMAGE_NOT_FOUND");
    }
    if (!info.isFile() || info.size > MAX_RENDER_IMAGE_BYTES) {
      throw imageError(413, "图片过大，无法在 Web 端显示", "IMAGE_TOO_LARGE");
    }
    const data = await fs.readFile(entry.path);
    const detected = detectImageType(data);
    if (!detected) {
      throw imageError(415, "这个图片格式无法在 Web 端显示", "IMAGE_TYPE_UNSUPPORTED");
    }
    entry.mimeType = detected.mimeType;
    entry.size = data.length;
    return { data, mimeType: detected.mimeType };
  }
}
