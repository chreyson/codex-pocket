import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { CodexAppServer } from "../src/codex-client.mjs";
import { prepareDesktopProxy } from "../src/desktop-launch.mjs";
import { defaultCodexCommand, stopManagedBackend } from "../src/shared-runtime.mjs";

const directory = await mkdtemp(path.join(os.tmpdir(), "pocket-auto-launch-"));
const previousHome = process.env.CODEX_HOME;
const previousCommand = process.env.CODEX_BIN;
process.env.CODEX_BIN = defaultCodexCommand();
process.env.CODEX_HOME = directory;
const configPath = path.join(directory, "shared-server.json");
const readConfig = async () => JSON.parse(await readFile(configPath, "utf8"));
let clients = [];
async function disconnect() {
  for (const client of clients) {
    const closed = client.proc ? once(client.proc, "close") : Promise.resolve();
    client.stop();
    await closed;
  }
  clients = [];
}
try {
  const wrapper = await prepareDesktopProxy("auto", { dataDirectory: directory, codexPath: process.env.CODEX_BIN });
  const connect = () => {
    const client = new CodexAppServer({ command: wrapper, websocketUrl: "", requestTimeoutMs: 15000 });
    clients.push(client);
    return client;
  };
  const desktop = connect();
  await desktop.start();
  const first = await readConfig();
  const { thread } = await desktop.startThread({ cwd: directory });
  await desktop.request("thread/inject_items", { threadId: thread.id, items: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Auto-launch regression fixture. No model call." }] },
  ] });
  const web = new CodexAppServer({ websocketUrl: first.url });
  clients.push(web);
  assert.equal((await web.readThread(thread.id)).thread.id, thread.id);
  const reopened = connect();
  assert.equal((await reopened.resumeThread(thread.id)).thread.id, thread.id);
  assert.equal((await readConfig()).pid, first.pid);
  await disconnect();
  await stopManagedBackend(first);
  const restarted = connect();
  assert.equal((await restarted.resumeThread(thread.id)).thread.id, thread.id);
  assert.notEqual((await readConfig()).pid, first.pid);
  console.log("PASS: normal-launch proxy starts its backend without Pocket, reuses the same writable task, and recovers after backend shutdown. No model call.");
} finally {
  await disconnect();
  try { await stopManagedBackend(await readConfig()); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  if (previousCommand === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = previousCommand;
  await rm(directory, { recursive: true, force: true });
}
