import { parse } from "smol-toml";

function isTable(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    const previous = Object.hasOwn(target, key) ? target[key] : undefined;
    const next = isTable(value) ? merge(isTable(previous) ? previous : {}, value) : structuredClone(value);
    Object.defineProperty(target, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return target;
}

function configAssignment(value) {
  try { return parse(value); }
  catch {
    // Codex also accepts unquoted string values on its command line.
    const separator = value.indexOf("=");
    if (separator < 1) throw new Error("桌面启动配置缺少赋值，已取消连接");
    return parse(`${value.slice(0, separator)}=${JSON.stringify(value.slice(separator + 1).trim())}`);
  }
}

export function desktopLaunchConfig(args) {
  const config = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["-c", "--config"].includes(arg)) {
      if (typeof args[index + 1] !== "string") throw new Error("桌面启动配置缺少参数，已取消连接");
      merge(config, configAssignment(args[++index]));
    } else if (arg.startsWith("--config=")) {
      merge(config, configAssignment(arg.slice("--config=".length)));
    } else if (arg === "--enable" || arg === "--disable") {
      const feature = args[++index];
      if (!feature) throw new Error("桌面功能开关缺少参数，已取消连接");
      merge(config, parse(`features.${JSON.stringify(feature)}=${arg === "--enable"}`));
    }
  }
  return config;
}

function expandRequestKey(key, value) {
  const skeleton = parse(`${key}=0`);
  let table = skeleton;
  while (true) {
    const name = Object.keys(table)[0];
    if (!isTable(table[name])) {
      Object.defineProperty(table, name, { value, enumerable: true, writable: true, configurable: true });
      break;
    }
    table = table[name];
  }
  return skeleton;
}

export function withDesktopLaunchConfig(message, defaults) {
  if (!["thread/start", "thread/resume", "thread/fork"].includes(message?.method) || !Object.keys(defaults).length) return message;
  const config = structuredClone(defaults);
  // Per-task values override the launch defaults, including explicit tool disabling.
  for (const [key, value] of Object.entries(message.params?.config || {})) {
    merge(config, expandRequestKey(key, value));
  }
  return { ...message, params: { ...message.params, config } };
}
