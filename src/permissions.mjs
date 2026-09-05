const PRESETS = [
  {
    id: "ask", name: "请求批准", shortName: "请求批准",
    description: "编辑外部文件和使用互联网时始终询问",
    permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "user",
    sandboxMode: "workspace-write",
  },
  {
    id: "auto", name: "帮我批准", shortName: "帮我批准",
    description: "仅对检测到的风险操作请求批准",
    permissions: ":workspace", approvalPolicy: "on-request", approvalsReviewer: "auto_review",
    sandboxMode: "workspace-write",
  },
  {
    id: "full", name: "完全访问权限", shortName: "完全访问",
    description: "可不受限制地访问互联网和你电脑上的任何文件",
    permissions: ":danger-full-access", approvalPolicy: "never", approvalsReviewer: "user",
    sandboxMode: "danger-full-access",
  },
];

export function permissionMode(settings) {
  if (!settings) return "custom";
  if (settings.permissionMode) return settings.permissionMode;
  const sandbox = settings.sandboxPolicy;
  if (sandbox?.type === "dangerFullAccess" && settings.approvalPolicy === "never") return "full";
  if (sandbox?.type === "workspaceWrite" && !sandbox.networkAccess
      && settings.approvalPolicy === "on-request") {
    return ["auto_review", "guardian_subagent"].includes(settings.approvalsReviewer) ? "auto" : "ask";
  }
  return "custom";
}

export function permissionCatalog({ profiles = [], requirements = null, current = null, supported = false } = {}) {
  const allows = (key, value) => !requirements?.[key] || requirements[key].includes(value);
  return {
    supported,
    current: permissionMode(current),
    options: PRESETS.map(({ id, name, shortName, description, permissions, approvalPolicy, approvalsReviewer, sandboxMode }) => ({
      id, name, shortName, description,
      allowed: supported && profiles.some((profile) => profile.id === permissions && profile.allowed)
        && allows("allowedApprovalPolicies", approvalPolicy)
        && allows("allowedApprovalsReviewers", approvalsReviewer)
        && allows("allowedSandboxModes", sandboxMode),
    })),
  };
}

export function resolvePermissionMode(mode, catalog) {
  const preset = PRESETS.find((item) => item.id === mode);
  if (!preset || !catalog?.options?.some((item) => item.id === mode && item.allowed)) {
    const error = new Error("权限模式不可用");
    error.status = 400;
    throw error;
  }
  const { permissions, approvalPolicy, approvalsReviewer } = preset;
  return { permissions, approvalPolicy, approvalsReviewer };
}
