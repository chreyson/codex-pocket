import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { managementName, createProject, updateProject, listProjects, PROJECT_ARCHIVE_KEY } from "../src/management.mjs";

test("project creation validates a real directory and forwards an idempotency key", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pocket-project-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const codex = { request: async (method, params) => { calls.push({ method, params }); return { project: { id: "p", ...params } }; } };
  const created = await createProject(codex, { name: " Project ", path: root, idempotencyKey: "test-request-1" });
  assert.equal(created.name, "Project");
  assert.equal(calls[0].method, "project/create");
  assert.equal(calls[0].params.idempotencyKey, "test-request-1");
  await assert.rejects(createProject(codex, { name: "x", path: "relative", idempotencyKey: "test-request-1" }), /完整路径/);
  await assert.rejects(createProject(codex, { name: "x", path: path.join(root, "missing"), idempotencyKey: "test-request-1" }), /不存在/);
  assert.equal(calls.length, 1);
});

test("project archive and restore preserve other metadata and never delete files or threads", async () => {
  let project = { id: "p", name: "Project", roots: [{ path: "/repo" }], metadata: { owner: "existing" } };
  const calls = [];
  const codex = { request: async (method, params) => {
    calls.push(method);
    if (method === "project/update") project = { ...project, ...params };
    else assert.equal(method, "project/read");
    return { project };
  } };
  assert.equal((await updateProject(codex, "p", "archive", {})).archived, true);
  assert.equal(project.metadata.owner, "existing");
  assert.equal(project.metadata[PROJECT_ARCHIVE_KEY], "true");
  assert.equal((await updateProject(codex, "p", "restore", {})).archived, false);
  assert.deepEqual(project.metadata, { owner: "existing" });
  assert.equal((await updateProject(codex, "p", "rename", { name: "Renamed" })).name, "Renamed");
  assert.ok(calls.every((method) => ["project/read", "project/update"].includes(method)));
});

test("project listing reads all pages and names reject malformed input", async () => {
  const projects = await listProjects({ request: async (_method, params) => params.cursor
    ? { data: [{ id: "b", name: "Duplicate", roots: [] }], nextCursor: null }
    : { data: [{ id: "a", name: "Duplicate", roots: [] }], nextCursor: "page-2" } });
  assert.deepEqual(projects.map((project) => project.id), ["a", "b"]);
  for (const name of [null, "", " ", "a\nb", "a".repeat(161)]) assert.throws(() => managementName(name));
});
