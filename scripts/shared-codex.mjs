import { promises as fs } from "node:fs";
import { ensureSharedServer, readSharedConfig, sharedConfigPath, stopManagedBackend } from "../src/shared-runtime.mjs";
import { openSharedDesktop } from "../src/desktop-launch.mjs";

if (process.argv.includes("--stop")) {
  const config = await readSharedConfig();
  if (!config) process.exit(0);
  try {
    await stopManagedBackend(config);
    await fs.unlink(sharedConfigPath).catch(() => {});
    console.log("Pocket 管理的共享 Codex 已停止");
  } catch (error) {
    // An active desktop client deliberately keeps the App Server alive.
    console.log(`保留共享 Codex：${error.message}`);
  }
  process.exit(0);
}

const config = process.env.CODEX_APP_SERVER_WS_URL
  ? { url: process.env.CODEX_APP_SERVER_WS_URL } : await ensureSharedServer();
console.log(`共享 Codex 已就绪：${config.url}`);
console.log("Pocket 下次启动将自动使用此连接。关闭 Pocket 不会结束共享服务中的任务。");
if (process.argv.includes("--open-app")) {
  try {
    const connection = await openSharedDesktop(config.url);
    console.log(connection.advice);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
