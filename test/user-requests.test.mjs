import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeServerRequest } from "../src/control.mjs";
import { parseServerRequestResponse, elicitationFields } from "../src/user-requests.mjs";
import { CodexAppServer } from "../src/codex-client.mjs";

const record = (method, params = {}) => ({ token: "test-request", message: { id: 41, method, params: { threadId: "A", turnId: "turn", ...params } } });
const wire = (value) => JSON.parse(JSON.stringify(value));
const input = (params) => record("item/tool/requestUserInput", { isBlocking: true, questions: [
  { id: "target", header: "范围", question: "先处理哪一部分？", options: [{ label: "网页（推荐）", description: "继续当前工作" }] },
  { id: "secret", header: "密钥", question: "请输入测试值", isSecret: true },
], ...params });

test("structured questions keep exact ids/options and return exact answers", () => {
  const request = input();
  const preview = sanitizeServerRequest(request);
  assert.equal(preview.type, "userInput");
  assert.equal(preview.questions[1].isSecret, true);
  assert.equal(preview.questions[0].options[0].label, "网页（推荐）");
  const answers = { target: { answers: ["网页（推荐）"] }, secret: { answers: [" synthetic "] } };
  assert.deepEqual(wire(parseServerRequestResponse(request, { answers })), { answers });
  assert.throws(() => parseServerRequestResponse(request, { answers: { target: answers.target } }), /所有问题/);
  assert.throws(() => parseServerRequestResponse(request, { answers: { ...answers, extra: { answers: ["x"] } } }), /变更/);
  assert.throws(() => parseServerRequestResponse(request, { skip: true }), /所有问题/);
  assert.deepEqual(parseServerRequestResponse(input({ isBlocking: false }), { skip: true }), { answers: {} });
  assert.throws(() => parseServerRequestResponse(request, { answers: { ...answers, secret: { answers: ["x".repeat(12001)] } } }), /所有问题/);
});

test("command decisions preserve server order and cannot forge an amendment", () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm", "test"] } };
  const request = record("item/commandExecution/requestApproval", { availableDecisions: ["decline", amendment, "accept"] });
  assert.deepEqual(sanitizeServerRequest(request).choices.map((c) => c.id), ["0", "1", "2"]);
  assert.deepEqual(parseServerRequestResponse(request, { choice: "1", decision: { arbitrary: true } }), { decision: amendment });
  assert.throws(() => parseServerRequestResponse(request, { decision: "acceptForSession" }), /不可用/);
  assert.deepEqual(parseServerRequestResponse(request, { decision: "accept" }), { decision: "accept" });
  assert.throws(() => parseServerRequestResponse(request, { choice: "99" }), /不可用/);
  const denied = record("item/commandExecution/requestApproval", { availableDecisions: [] });
  assert.deepEqual(sanitizeServerRequest(denied).choices, []);
  assert.throws(() => parseServerRequestResponse(denied, { decision: "accept" }), /不可用/);
});

test("permission grants use the requested profile and selected scope only", () => {
  const permissions = { fileSystem: { entries: [{ access: "write", path: { type: "path", path: "/work/project" } }] }, network: { enabled: true } };
  const request = record("item/permissions/requestApproval", { permissions });
  assert.match(sanitizeServerRequest(request).detail, /写入：\/work\/project/);
  assert.deepEqual(parseServerRequestResponse(request, { choice: "turn", permissions: { fileSystem: { write: ["/"] } }, scope: "session" }), { permissions, scope: "turn" });
  assert.deepEqual(parseServerRequestResponse(request, { choice: "decline" }), { permissions: {}, scope: "turn" });
  assert.deepEqual(parseServerRequestResponse(request, { choice: "session" }), { permissions, scope: "session" });
});

test("MCP form handles typed fields, titled choices, constraints and safe dismissal", () => {
  const request = record("mcpServer/elicitation/request", { mode: "form", serverName: "Test", message: "确认信息", requestedSchema: {
    type: "object", properties: {
      title: { type: "string", minLength: 2, maxLength: 20 },
      count: { type: "integer", minimum: 1, maximum: 4 },
      confirmed: { type: "boolean" },
      team: { type: "string", oneOf: [{ const: "a", title: "A" }, { const: "b", title: "B" }] },
      regions: { type: "array", items: { anyOf: [{ const: "cn", title: "中国" }, { const: "us", title: "美国" }] }, minItems: 1, maxItems: 2 },
      date: { type: "string", format: "date" },
    }, required: ["title", "count", "confirmed", "team", "regions"],
  } });
  const content = { title: "项目", count: 2, confirmed: false, team: "a", regions: ["cn"] };
  assert.equal(sanitizeServerRequest(request).supported, true);
  assert.deepEqual(wire(parseServerRequestResponse(request, { action: "accept", content })), { action: "accept", content });
  for (const wrong of [{ count: 1.2 }, { count: "2" }, { confirmed: "false" }, { team: "z" }, { regions: ["cn", "cn"] }, { date: "2026-02-30" }, { extra: "x" }, { title: "x" }]) {
    assert.throws(() => parseServerRequestResponse(request, { action: "accept", content: { ...content, ...wrong } }), (error) => error.status === 400);
  }
  assert.deepEqual(parseServerRequestResponse(request, { action: "decline", content: { secret: "ignored" } }), { action: "decline" });
  const unsupported = record("mcpServer/elicitation/request", { mode: "openai/form", requestedSchema: { type: "object", properties: { x: { type: "string", pattern: "^a+$" } } } });
  assert.equal(sanitizeServerRequest(unsupported).supported, false);
  assert.throws(() => parseServerRequestResponse(unsupported, { action: "accept", content: { x: "a" } }), (error) => error.status === 409);
  assert.deepEqual(parseServerRequestResponse(unsupported, { action: "cancel" }), { action: "cancel" });
  assert.equal(elicitationFields({ type: "object", properties: { x: { type: "object" } } }), null);
});

test("MCP URL mode exposes only HTTP(S) links and requires an explicit completion", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@example.test", "not a URL"]) {
    const request = record("mcpServer/elicitation/request", { mode: "url", url });
    assert.equal(sanitizeServerRequest(request).url, "");
    assert.throws(() => parseServerRequestResponse(request, { action: "accept" }), /不支持/);
  }
  const request = record("mcpServer/elicitation/request", { mode: "url", url: "https://example.test/authorize" });
  assert.deepEqual(parseServerRequestResponse(request, { action: "accept", content: { forged: true } }), { action: "accept" });
});

test("request identity survives id type differences and never collides across processes", () => {
  const first = new CodexAppServer();
  const second = new CodexAppServer();
  const request = input().message;
  first._handleLine(JSON.stringify(request));
  first._handleLine(JSON.stringify({ ...request, id: "41" }));
  second._handleLine(JSON.stringify(request));
  const records = first.pendingServerRequests("A");
  assert.equal(records.length, 2);
  assert.notEqual(records[0].token, second.pendingServerRequests("A")[0].token);
  first._write = () => {};
  first.respondToServerRequest(records[0].token, { answers: {} });
  assert.throws(() => first.respondToServerRequest(records[0].token, {}), (e) => e.code === "REQUEST_RESOLVING");
  first._handleLine(JSON.stringify({ method: "serverRequest/resolved", params: { requestId: 41 } }));
  assert.equal(first.pendingServerRequests("A").length, 1);
  assert.equal(first.pendingServerRequests("A")[0].message.id, "41");
});
