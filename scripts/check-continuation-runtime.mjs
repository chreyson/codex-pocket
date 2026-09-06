import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { CodexAppServer } from "../src/codex-client.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "pocket-continuation-"));
const previousHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(directory, "codex");
await mkdir(process.env.CODEX_HOME);
const desktop = new CodexAppServer();
const web = new CodexAppServer();
async function waitForHistory(file, marker) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await readFile(file, "utf8")).includes(marker)) return;
    await delay(50);
  }
  assert.fail("History was not persisted");
}
try {
  const { thread: source } = await desktop.startThread({ cwd: directory });
  const marker = "Synthetic continuation history. No model turn sent.";
  await desktop.request("thread/inject_items", { threadId: source.id, items: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Materialize test history" }] },
  ] });
  await waitForHistory(source.path, "Materialize test history");
  const closed = once(desktop.proc, "close");
  desktop.stop();
  await closed;
  // Seed a completed turn in the isolated home; no network/model work is needed.
  const turnId = "00000000-0000-4000-8000-000000000001";
  const records = [
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "event_msg", payload: { type: "user_message", message: marker, images: [], local_images: [] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: marker }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Synthetic completed result" }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId, last_agent_message: "Synthetic completed result" } },
  ];
  const previousRecords = (await readFile(source.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const lastOrdinal = Math.max(...previousRecords.map((record) => record.ordinal ?? -1));
  await appendFile(source.path, records.map((record, index) => JSON.stringify({ ordinal: lastOrdinal + index + 1, timestamp: new Date().toISOString(), ...record }) + "\n").join(""));
  await desktop.resumeThread(source.id);
  await waitForHistory(source.path, marker);
  await assert.rejects(web.resumeThread(source.id), /already has an active writer/);
  const { thread: fork } = await web.forkThread(source.id);
  assert.notEqual(fork.id, source.id);
  assert.equal(await realpath(fork.cwd), await realpath(source.cwd));
  assert.equal(web.isThreadBusy(fork.id), false);
  const restored = await web.readThread(fork.id);
  assert.equal(restored.thread.forkedFromId, source.id);
  assert.equal(restored.thread.turns[0]?.status, "completed");
  const forkRecords = (await readFile(fork.path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const base = forkRecords.find((record) => record.type === "session_meta")?.payload.history_base;
  // Paginated forks reference parent history instead of duplicating it on disk.
  assert.equal(base.thread_id, source.id);
  const inherited = (await readFile(source.path)).subarray(0, base.end_byte_offset).toString("utf8");
  assert.ok(inherited.includes(marker));
  await web.resumeThread(fork.id);
  assert.equal(web.loadedThreads.has(fork.id), true);
  console.log("Real runtime passed: idle writer conflict reproduced; Web continuation retains history and cwd, is writable, and starts no model turn.");
} finally {
  for (const client of [web, desktop]) {
    const closed = client.proc ? once(client.proc, "close") : Promise.resolve();
    client.stop();
    await closed;
  }
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  await rm(directory, { recursive: true, force: true });
}
