import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareDesktopProxy } from "../src/desktop-launch.mjs";
import { defaultCodexCommand } from "../src/shared-runtime.mjs";

const codexIndex = process.argv.indexOf("--codex");
const proxyPath = await prepareDesktopProxy("auto", { codexPath: codexIndex >= 0 ? process.argv[codexIndex + 1] : defaultCodexCommand() });
if (process.platform === "win32") {
  // Match the App's raw spawn path before persisting any desktop setting.
  await promisify(execFile)(proxyPath, ["--version"], { timeout: 15_000, windowsHide: true });
}
const environment = { CODEX_APP_SERVER_FORCE_CLI: "1", CODEX_CLI_PATH: proxyPath };
if (process.argv.includes("--activate")) {
  if (process.platform !== "darwin") throw new Error("Automatic GUI launch setup requires macOS");
  const run = promisify(execFile);
  for (const [name, value] of Object.entries(environment)) {
    await run("/bin/launchctl", ["setenv", name, value]);
  }
} else {
  console.log(JSON.stringify(environment));
}
