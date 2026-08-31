import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "codex_pocket_session";

export function createAccessToken() {
  return randomBytes(32).toString("base64url");
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
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function requestToken(request) {
  const authorization = request.headers.authorization || "";
  if (authorization.startsWith("Bearer ")) return authorization.slice(7).trim();
  return parseCookies(request.headers.cookie)[SESSION_COOKIE] || "";
}
