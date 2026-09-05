import readline from "node:readline";

if (process.argv.includes("--version")) {
  console.log("codex-cli test");
  process.exit(0);
}

const lines = readline.createInterface({ input: process.stdin });
let initialized = false;
let revision = 0;
let project = null;
let threadName = "Connection test";
let archived = false;
for await (const line of lines) {
  const { id, method, params = {} } = JSON.parse(line);
  if (method === "initialized") { initialized = true; continue; }
  if (id === undefined) continue;
  if (method === "test/exit") process.exit(17);
  if (method === "test/stall") continue;
  if (method !== "initialize" && !initialized) throw new Error("Request preceded initialization");
  const thread = {
    id: params.threadId || "test-thread", title: threadName, name: threadName, cwd: process.cwd(), projectId: project?.id,
    status: { type: "idle" }, updatedAt: ++revision,
    turns: [{ id: "turn-1", status: "completed", items: [
      { id: "message-1", type: "agentMessage", text: `Snapshot ${revision}` },
    ] }],
  };
  let result = {};
  switch (method) {
    case "initialize": result = { userAgent: "test" }; break;
    case "thread/list": result = { data: Boolean(params.archived) === archived ? [thread] : [], nextCursor: null }; break;
    case "project/list": result = { data: project ? [project] : [], nextCursor: null }; break;
    case "project/create": project = { id: "test-project", ...params, metadata: {} }; result = { project }; break;
    case "project/read": result = { project }; break;
    case "project/update": project = { ...project, ...params }; result = { project }; break;
    case "thread/name/set": threadName = params.name; break;
    case "thread/archive": archived = true; break;
    case "thread/unarchive": archived = false; result = { thread }; break;
    case "thread/start": result = { thread }; break;
    case "thread/read":
      if (params.threadId === "slow-thread") continue;
      result = { thread }; break;
    case "model/list": result = { data: [], nextCursor: null }; break;
    case "skills/list": result = { data: [] }; break;
    case "collaborationMode/list": result = { data: [] }; break;
    case "thread/goal/get": result = { goal: null }; break;
    case "config/read": result = { config: {} }; break;
    case "configRequirements/read": result = { requirements: null }; break;
    case "permissionProfile/list": result = { data: [
      { id: ":workspace", allowed: true }, { id: ":danger-full-access", allowed: true },
    ] }; break;
    case "thread/resume": result = { thread, model: "test", approvalPolicy: "on-request", approvalsReviewer: "user", sandbox: { type: "workspaceWrite", networkAccess: false } }; break;
    case "thread/settings/update": result = {}; break;
    case "test/pid": result = { pid: process.pid }; break;
    default: throw new Error(`Unexpected request: ${method}`);
  }
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
