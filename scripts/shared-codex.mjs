import { ensureSharedServer } from "../src/shared-runtime.mjs";
import { openSharedDesktop } from "../src/desktop-launch.mjs";

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
