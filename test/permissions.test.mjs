import assert from "node:assert/strict";
import test from "node:test";
import { permissionCatalog, permissionMode, resolvePermissionMode } from "../src/permissions.mjs";
import { CodexAppServer } from "../src/codex-client.mjs";

const profiles = [":workspace", ":danger-full-access"].map((id) => ({ id, allowed: true }));
const catalog = permissionCatalog({ profiles, supported: true });

test("permission presets use desktop labels and switch both reviewer and access boundary", () => {
  assert.deepEqual(catalog.options.map((item) => item.name), ["请求批准", "帮我批准", "完全访问权限"]);
  assert.equal(catalog.current, "custom");
  assert.deepEqual(resolvePermissionMode("auto", catalog), {
    permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review",
  });
  assert.deepEqual(resolvePermissionMode("full", catalog), {
    permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user",
  });
  assert.equal(permissionMode({ approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    sandboxPolicy: { type: "workspaceWrite", networkAccess: false } }), "auto");
  assert.equal(permissionMode({ approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } }), "custom");
});

test("managed requirements and unavailable profile APIs cannot be bypassed by a submitted mode", () => {
  for (const requirements of [
    { allowedSandboxModes: ["workspace-write"] },
    { allowedApprovalPolicies: ["on-request"] },
    { allowedApprovalsReviewers: ["auto_review"] },
  ]) {
    assert.throws(() => resolvePermissionMode("full", permissionCatalog({ profiles, supported: true, requirements })), /不可用/);
  }
  assert.throws(() => resolvePermissionMode("ask", permissionCatalog()), /不可用/);
  assert.throws(() => resolvePermissionMode("ask", permissionCatalog({ supported: true, profiles: [] })), /不可用/);
  assert.throws(() => resolvePermissionMode("invalid", catalog), /不可用/);
});

test("permission updates are task scoped, survive empty acknowledgments, and unlock after rejection", async () => {
  const client = new CodexAppServer();
  client.resumeThread = async () => {};
  client.threadSettings.set("A", { model: "gpt-6-astra" });
  let request;
  client.request = async (method, params) => { request = { method, params }; return {}; };
  assert.equal((await client.updatePermissions("A", "auto", catalog)).current, "auto");
  assert.equal(request.method, "thread/settings/update");
  assert.deepEqual(request.params, { threadId: "A", ...resolvePermissionMode("auto", catalog) });
  assert.equal(client.threadSettings.get("A").model, "gpt-6-astra");
  assert.equal(client.threadSettings.has("B"), false);
  client.request = async () => { throw new Error("managed rejection"); };
  await assert.rejects(client.updatePermissions("A", "full", catalog), /managed rejection/);
  assert.equal(client.threadSettings.get("A").permissionMode, "auto");
  assert.equal(client.isThreadBusy("A"), false);
  client.activeTurns.set("A", "turn");
  await assert.rejects(client.updatePermissions("A", "ask", catalog), /任务结束/);
  client._trackNotification({ method: "thread/settings/updated", params: { threadId: "A", threadSettings: {
    model: "gpt-6-astra", approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite", networkAccess: false },
  } } });
  assert.equal(permissionMode(client.threadSettings.get("A")), "ask");
});
