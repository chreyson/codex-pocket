import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { CodexAppServer } from "../src/codex-client.mjs";
import { createProject, updateProject } from "../src/management.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "pocket-management-runtime-"));
const previousHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = path.join(directory, "codex");
await mkdir(process.env.CODEX_HOME);
const client = new CodexAppServer();
try {
  await client.start();
  const project = await createProject(client, { name: "Management test", path: directory, idempotencyKey: "isolated-project-test" });
  assert.equal((await updateProject(client, project.id, "rename", { name: "Renamed project" })).name, "Renamed project");
  assert.equal((await updateProject(client, project.id, "archive", {})).archived, true);
  assert.equal((await updateProject(client, project.id, "restore", {})).archived, false);
  const result = await client.startThread({ cwd: directory, projectId: project.id });
  const threadId = result.thread.id;
  assert.equal(result.thread.projectId, project.id);
  console.log("Project lifecycle and empty thread creation passed");
  await client.request("thread/inject_items", { threadId, items: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic management fixture" }] },
  ] });
  await client.request("thread/name/set", { threadId, name: "Renamed task" });
  console.log("Thread rename passed");
  assert.equal((await client.readThread(threadId, { includeTurns: false })).thread.name, "Renamed task");
  await client.request("thread/archive", { threadId });
  assert.ok((await readdir(path.join(process.env.CODEX_HOME, "archived_sessions"), { recursive: true })).some((file) => file.includes(threadId)));
  await client.request("thread/unarchive", { threadId });
  assert.ok((await readdir(path.join(process.env.CODEX_HOME, "sessions"), { recursive: true })).some((file) => file.includes(threadId)));
  console.log("Isolated real Codex runtime passed: project create/rename/archive/restore, thread assignment/rename/archive/restore. No model turn sent.");
} finally {
  const closed = client.proc ? once(client.proc, "close") : Promise.resolve();
  client.stop();
  await closed;
  if (previousHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousHome;
  await rm(directory, { recursive: true, force: true });
}
