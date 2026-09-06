import process from "node:process";
import readline from "node:readline";
import WebSocket from "ws";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { localAppServerUrl } from "../src/runtime-config.mjs";
import { desktopLaunchConfig, withDesktopLaunchConfig } from "../src/desktop-proxy-config.mjs";
import { ensureSharedServer } from "../src/shared-runtime.mjs";

const automatic = process.argv[2] === "auto";
if (automatic && process.platform === "win32") {
  // Store updates can relocate the bundled CLI between two desktop launches.
  const configured = process.env.CODEX_BIN || "";
  const { stdout } = await promisify(execFile)("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    fileURLToPath(new URL("./resolve-windows-desktop.ps1", import.meta.url)),
    "-Cli", "-ConfiguredPath", configured,
  ], { timeout: 20_000, windowsHide: true, encoding: "utf8", env: { ...process.env, CODEX_BIN: "" } });
  process.env.CODEX_BIN = stdout.trim();
  if (!process.env.CODEX_BIN) throw new Error("Codex desktop CLI was not found. Run Pocket setup again.");
}
const url = automatic
  ? (await ensureSharedServer({ configPath: process.argv[3] })).url
  : localAppServerUrl(process.argv[2] || "");
const launchConfig = desktopLaunchConfig(process.argv.slice(automatic ? 4 : 3));
const socket = new WebSocket(url, {
  handshakeTimeout: 20_000,
  maxPayload: 16 * 1024 * 1024,
  perMessageDeflate: false,
});
const input = readline.createInterface({ input: process.stdin });
const queued = [];
let opened = false;
let closing = false;

function fail(message) {
  if (closing) return;
  closing = true;
  if (message) process.stderr.write(`${message}\n`);
  input.close();
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
  process.exitCode = 1;
}

input.on("line", (line) => {
  if (!line.trim()) return;
  try {
    line = JSON.stringify(withDesktopLaunchConfig(JSON.parse(line), launchConfig));
  } catch {
    fail("Codex Pocket shared proxy: invalid desktop request configuration");
    return;
  }
  if (!opened) {
    queued.push(line);
    return;
  }
  socket.send(line);
});
input.once("close", () => {
  closing = true;
  socket.close();
});

socket.once("open", () => {
  opened = true;
  for (const line of queued.splice(0)) socket.send(line);
});
socket.on("message", (data) => {
  process.stdout.write(`${data.toString()}\n`);
});
socket.once("error", (error) => fail(`Codex Pocket shared proxy: ${error.message}`));
socket.once("close", () => {
  if (!closing) fail("Codex Pocket shared proxy: connection closed");
});
process.stdout.once("error", (error) => {
  if (error.code === "EPIPE") {
    closing = true;
    socket.close();
    return;
  }
  fail(`Codex Pocket shared proxy: ${error.message}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    closing = true;
    input.close();
    socket.close();
  });
}
