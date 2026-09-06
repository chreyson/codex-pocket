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
const requests = new Map();
const replies = [];
const queueTurns = [];
function notify(method, params) { process.stdout.write(`${JSON.stringify({ method, params })}\n`); }
function finishQueueTurn(status = "completed") {
  const turn = queueTurns.at(-1);
  if (!turn || turn.status !== "inProgress") return;
  turn.status = status;
  notify("turn/completed", { threadId: "queue-thread", turn });
}
function requestFixture(threadId) {
  const definitions = [
    ["item/tool/requestUserInput", { questions: [{ id: "target", header: "范围", question: "先处理哪里？", options: [{ label: "Web", description: "网页" }] }], isBlocking: true }],
    ["item/commandExecution/requestApproval", { command: "npm test", availableDecisions: ["accept", "decline"] }],
    ["item/permissions/requestApproval", { permissions: { network: { enabled: true } } }],
    ["mcpServer/elicitation/request", { mode: "form", serverName: "Fixture", message: "选择数量", requestedSchema: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"] } }],
  ];
  definitions.forEach(([method, params], i) => {
    const message = { id: `fixture-${i}`, method, params: { threadId, turnId: "turn-request", itemId: `item-${i}`, ...params } };
    requests.set(message.id, message);
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
}
for await (const line of lines) {
  const incoming = JSON.parse(line);
  const { id, method, params = {} } = incoming;
  if (!method && requests.has(id)) {
    replies.push({ id, result: incoming.result });
    requests.delete(id);
    process.stdout.write(`${JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "test-thread", requestId: id } })}\n`);
    continue;
  }
  if (method === "initialized") { initialized = true; continue; }
  if (id === undefined) continue;
  if (method === "test/exit") process.exit(17);
  if (method === "test/stall") continue;
  if (method !== "initialize" && !initialized) throw new Error("Request preceded initialization");
  if (method === "thread/resume" && params.threadId === "locked-thread") {
    process.stdout.write(`${JSON.stringify({ id, error: { code: -32603, message: "thread already has an active writer" } })}\n`);
    continue;
  }
  const thread = {
    id: params.threadId || "test-thread", title: threadName, name: threadName, cwd: process.cwd(), projectId: project?.id,
    status: { type: "idle" }, updatedAt: ++revision,
    turns: [{ id: "turn-1", status: "completed", items: [
      { id: "message-1", type: "agentMessage", text: replies.length ? JSON.stringify(replies) : `Snapshot ${revision}` },
    ] }],
  };
  if (params.threadId === "queue-thread") thread.turns = queueTurns;
  if (params.threadId === "queue-thread" && ["turn/start", "turn/steer", "turn/interrupt"].includes(method)) {
    const text = (params.input || []).find((item) => item.type === "text")?.text || "";
    if (method === "turn/start") {
      const turn = { id: `queue-turn-${queueTurns.length}`, status: "inProgress", items: [
        { type: "userMessage", id: params.clientUserMessageId, content: params.input },
      ] };
      queueTurns.push(turn);
      notify("turn/started", { threadId: "queue-thread", turn });
      process.stdout.write(`${JSON.stringify({ id, result: { turn } })}\n`);
      if (text.startsWith("auto")) setTimeout(() => finishQueueTurn(), 60);
    } else {
      if (method === "turn/interrupt") finishQueueTurn("interrupted");
      else if (text === "finish") finishQueueTurn();
      else queueTurns.at(-1).items.push({ type: "userMessage", id: params.clientUserMessageId, content: params.input });
      process.stdout.write(`${JSON.stringify({ id, result: { turnId: queueTurns.at(-1)?.id } })}\n`);
    }
    continue;
  }
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
    case "thread/fork": result = { thread: { ...thread, id: `web-${revision}`, forkedFromId: params.threadId }, model: "test" }; break;
    case "thread/read":
      if (params.threadId === "slow-thread") continue;
      result = { thread }; break;
    case "model/list": result = { data: [{ id: "test", model: "test", displayName: "Test", isDefault: true, supportedReasoningEfforts: [] }], nextCursor: null }; break;
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
    case "turn/start": result = { turn: { id: "turn-request" } }; break;
    case "test/pid": result = { pid: process.pid }; break;
    default: throw new Error(`Unexpected request: ${method}`);
  }
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
  if (method === "turn/start") requestFixture(params.threadId);
}
