import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export const PROJECT_ARCHIVE_KEY = "codexPocket.archived";

export function managementError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function managementName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160 || /[\x00-\x1f]/.test(value)) {
    throw managementError(400, "名称需为 1–160 个字符，不能包含换行");
  }
  return value.trim();
}

export function publicProject(project) {
  return {
    id: project.id,
    name: project.name,
    roots: (project.roots || []).map((root) => root.path),
    archived: project.metadata?.[PROJECT_ARCHIVE_KEY] === "true",
  };
}

export async function listProjects(codex) {
  const projects = [];
  const cursors = new Set();
  let cursor;
  do {
    const page = await codex.request("project/list", { limit: 100, ...(cursor ? { cursor } : {}) });
    projects.push(...page.data);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error("项目列表分页未前进");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return projects.map(publicProject);
}

export async function createProject(codex, value) {
  const name = managementName(value?.name);
  if (typeof value?.path !== "string" || !path.isAbsolute(value.path) || value.path.includes("\0")) {
    throw managementError(400, "请输入电脑上文件夹的完整路径");
  }
  if (typeof value.idempotencyKey !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(value.idempotencyKey)) {
    throw managementError(400, "新建项目请求标识无效");
  }
  let root;
  try {
    root = await realpath(value.path);
    if (!(await stat(root)).isDirectory()) throw new Error("Not a directory");
  } catch {
    throw managementError(400, "该文件夹不存在或无法访问");
  }
  const result = await codex.request("project/create", {
    name, roots: [{ path: root }], idempotencyKey: value.idempotencyKey,
  });
  return publicProject(result.project);
}

export async function updateProject(codex, projectId, action, value) {
  let patch;
  if (action === "rename") patch = { name: managementName(value?.name) };
  else {
    const { project } = await codex.request("project/read", { projectId });
    const metadata = { ...project.metadata };
    if (action === "archive") metadata[PROJECT_ARCHIVE_KEY] = "true";
    else delete metadata[PROJECT_ARCHIVE_KEY];
    patch = { metadata };
  }
  const result = await codex.request("project/update", { projectId, ...patch });
  return publicProject(result.project);
}
