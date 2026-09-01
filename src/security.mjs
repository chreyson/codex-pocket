import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "codex_pocket_session";

export function createAccessToken() {
  return randomBytes(32).toString("base64url");
}

export function normalizeAccessToken(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function safeTokenEqual(received, expected) {
  if (!received || !expected) return false;
  const receivedHash = createHash("sha256").update(String(received)).digest();
  const expectedHash = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(receivedHash, expectedHash);
}

export function parseCookies(header = "") {
  const cookies = {};
  for (const pair of String(header).split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookie pairs without rejecting the whole request.
    }
  }
  return cookies;
}

export function requestToken(request) {
  const authorization = request.headers.authorization || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return parseCookies(request.headers.cookie)[SESSION_COOKIE] || "";
}

export class FixedWindowRateLimiter {
  constructor({ limit, windowMs = 60_000, maxEntries = 2_048, now = Date.now }) {
    if (!Number.isInteger(limit) || limit < 1) throw new TypeError("limit must be positive");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new TypeError("windowMs must be positive");
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be positive");
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.now = now;
    this.attempts = new Map();
  }

  _pruneExpired(now) {
    for (const [key, attempt] of this.attempts) {
      if (now - attempt.startedAt >= this.windowMs) this.attempts.delete(key);
    }
  }

  allow(key) {
    const normalizedKey = String(key || "unknown");
    const now = this.now();
    const current = this.attempts.get(normalizedKey);
    if (current && now - current.startedAt < this.windowMs) {
      if (current.count >= this.limit) return false;
      current.count += 1;
      return true;
    }

    if (current) this.attempts.delete(normalizedKey);
    if (this.attempts.size >= this.maxEntries) this._pruneExpired(now);
    if (this.attempts.size >= this.maxEntries) return false;
    this.attempts.set(normalizedKey, { startedAt: now, count: 1 });
    return true;
  }
}
