export function redactSensitiveText(value) {
  return String(value ?? "")
    .replace(/(\bauthorization\s*:\s*)((?:bearer|basic)\s+)?[^'"\r\n]+/gi, "$1$2[已隐藏]")
    .replace(/(\b(?:proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)\s*:\s*)[^'"\r\n]+/gi, "$1[已隐藏]")
    .replace(/((?:--?(?:api[-_]?key|token|secret|password|passwd|pwd|authorization|auth|cookie))\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1[已隐藏]")
    .replace(/((?:--?(?:api[-_]?key|token|secret|password|passwd|pwd|authorization|auth|cookie))\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "$1[已隐藏]")
    .replace(/(\b(?:[a-z0-9_]+_)?(?:api[-_]?key|token|secret|password|passwd|pwd|authorization|auth|cookie)\s*=\s*)(?:"[^"]*"|'[^']*'|[^'"\s;&|]+)/gi, "$1[已隐藏]")
    .replace(/(["'](?:[a-z0-9_]+_)?(?:api[-_]?key|token|secret|password|passwd|pwd|authorization|auth|cookie)["']\s*:\s*)(?:"[^"]*"|'[^']*')/gi, "$1[已隐藏]")
    .replace(/([?&](?:api[-_]?key|token|secret|password|passwd|pwd|auth|cookie)=)[^&\s]+/gi, "$1[已隐藏]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[已隐藏]@");
}

export function commandPreview(value, { compact = true, limit = 260 } = {}) {
  const raw = Array.isArray(value) ? value.join(" ") : value;
  if (typeof raw !== "string" || !raw.trim()) return "";
  let text = redactSensitiveText(raw);
  if (compact) text = text.replace(/\s+/g, " ");
  text = text.trim();
  const maxLength = Math.max(1, Number(limit) || 1);
  return text.length > maxLength
    ? `${text.slice(0, Math.max(0, maxLength - 1))}…`
    : text;
}
