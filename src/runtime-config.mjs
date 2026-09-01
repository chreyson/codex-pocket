export function boundedInteger(value, fallback, { min, max }) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function loopbackHost(value, fallback = "127.0.0.1") {
  const host = typeof value === "string" ? value.trim().toLowerCase() : "";
  return ["127.0.0.1", "::1", "localhost"].includes(host) ? host : fallback;
}
