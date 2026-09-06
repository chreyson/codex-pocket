import { redactSensitiveText } from "./redaction.mjs";

const COMMAND = "item/commandExecution/requestApproval";
const FILE = "item/fileChange/requestApproval";
const INPUT = "item/tool/requestUserInput";
const PERMISSIONS = "item/permissions/requestApproval";
const MCP = "mcpServer/elicitation/request";
const labels = { accept: "允许一次", acceptForSession: "在此会话中允许", decline: "拒绝", cancel: "拒绝并停止" };
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(message = "请求回复无效", status = 400) {
  return Object.assign(new Error(message), { status });
}

function decisions(record) {
  const { method, params = {} } = record.message;
  if (method === COMMAND || method === FILE) {
    const values = method === COMMAND && Array.isArray(params.availableDecisions)
      ? params.availableDecisions : ["accept", "acceptForSession", "decline", "cancel"];
    return values.flatMap((decision, index) => {
      let label = labels[decision];
      let detail = "";
      if (decision?.acceptWithExecpolicyAmendment) {
        label = "允许并记住此命令规则";
        detail = redactSensitiveText(decision.acceptWithExecpolicyAmendment.execpolicy_amendment.join(" "));
      } else if (decision?.applyNetworkPolicyAmendment) {
        const rule = decision.applyNetworkPolicyAmendment.network_policy_amendment;
        label = rule.action === "allow" ? "始终允许此地址" : "始终拒绝此地址";
        detail = rule.host;
      }
      return label ? [{ id: String(index), label, detail, result: { decision } }] : [];
    });
  }
  if (method === PERMISSIONS) return [
    { id: "turn", label: "本轮允许", result: { permissions: params.permissions, scope: "turn" } },
    { id: "session", label: "在此会话中允许", result: { permissions: params.permissions, scope: "session" } },
    { id: "decline", label: "拒绝", result: { permissions: {}, scope: "turn" } },
  ];
  return [];
}

// MCP defines a flat form of typed primitives and enum arrays. Unknown extensions
// remain dismissible, but cannot be accepted without validating their constraints.
export function elicitationFields(schema) {
  if (!object(schema) || schema.type !== "object" || !object(schema.properties)) return null;
  if (Object.keys(schema).some((key) => !["type", "properties", "required", "$schema", "additionalProperties", "title", "description"].includes(key))) return null;
  const allowed = new Set(["type", "title", "description", "default", "enum", "enumNames", "oneOf", "items", "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "format"]);
  const fields = [];
  for (const [id, field] of Object.entries(schema.properties)) {
    if (!object(field) || Object.keys(field).some((key) => !allowed.has(key))) return null;
    if (!["string", "number", "integer", "boolean", "array"].includes(field.type)) return null;
    if (field.format && !["email", "uri", "date", "date-time"].includes(field.format)) return null;
    const optionsSchema = field.type === "array" ? field.items : field;
    if (!object(optionsSchema)) return null;
    const titled = optionsSchema.oneOf || optionsSchema.anyOf;
    let options;
    if (titled) {
      if (!Array.isArray(titled) || titled.some((v) => !object(v) || typeof v.const !== "string" || Object.keys(v).some((k) => !["const", "title"].includes(k)))) return null;
      options = titled.map((v) => ({ value: v.const, label: v.title || v.const }));
    } else if (optionsSchema.enum) {
      if (!Array.isArray(optionsSchema.enum) || optionsSchema.enum.some((v) => typeof v !== "string")) return null;
      options = optionsSchema.enum.map((value, i) => ({ value, label: field.enumNames?.[i] || value }));
    }
    if (field.type === "array" && (!options || Object.keys(optionsSchema).some((k) => !["type", "enum", "anyOf"].includes(k)))) return null;
    fields.push({ ...field, id, label: field.title || id, required: Boolean(schema.required?.includes(id)), options });
  }
  if (schema.required?.some((id) => !Object.hasOwn(schema.properties, id))) return null;
  return fields;
}

function permissionDetail(permissions = {}) {
  const lines = [];
  if (permissions.network?.enabled) lines.push("访问网络");
  const file = permissions.fileSystem || {};
  for (const [access, paths] of [["读取", file.read], ["写入", file.write]]) {
    for (const path of paths || []) lines.push(`${access}：${path}`);
  }
  const special = { root: "所有路径", minimal: "系统必要路径", project_roots: "项目目录", tmpdir: "临时目录", slash_tmp: "/tmp" };
  for (const entry of file.entries || []) {
    const p = entry.path;
    const target = p.path || p.pattern || `${special[p.value?.kind] || p.value?.path || p.value?.kind}${p.value?.subpath ? `/${p.value.subpath}` : ""}`;
    lines.push(`${{ read: "读取", write: "写入", deny: "禁止访问" }[entry.access]}：${target}`);
  }
  return lines.join("\n");
}

export function interactiveRequest(record) {
  const { method, params = {} } = record.message;
  const choices = decisions(record).map(({ result, ...choice }) => choice);
  if (method === COMMAND || method === FILE) return { choices };
  if (method === PERMISSIONS) return { type: "permissions", title: "允许访问这些资源吗？", detail: permissionDetail(params.permissions), choices };
  if (method === INPUT) return {
    type: "userInput", title: "需要你确认", detail: "", isBlocking: params.isBlocking !== false,
    questions: params.questions.map((q) => ({ id: q.id, header: q.header, question: q.question, isSecret: Boolean(q.isSecret), options: q.options || [] })),
  };
  if (method === MCP) {
    const fields = elicitationFields(params.requestedSchema);
    let url = "";
    if (params.mode === "url") {
      try { const parsed = new URL(params.url); if (["https:", "http:"].includes(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } catch { /* No link for invalid URLs. */ }
    }
    const supported = params.mode === "url" ? Boolean(url) : fields !== null;
    return { type: "elicitation", title: params.serverName || "补充信息", detail: params.message || "", mode: params.mode, fields: fields || [], url,
      supported, choices: [
        ...(supported ? [{ id: "accept", label: params.mode === "url" ? "已完成，继续" : "提交" }] : []),
        { id: "decline", label: "拒绝" }, { id: "cancel", label: "取消" },
      ],
    };
  }
  return null;
}

function validField(field, value) {
  if (field.type === "array") {
    return Array.isArray(value) && new Set(value).size === value.length
      && value.every((v) => field.options.some((o) => o.value === v))
      && (field.minItems == null || value.length >= field.minItems)
      && (field.maxItems == null || value.length <= field.maxItems);
  }
  if (field.type === "boolean") return typeof value === "boolean";
  if (["number", "integer"].includes(field.type)) return typeof value === "number" && Number.isFinite(value)
    && (field.type !== "integer" || Number.isInteger(value))
    && (field.minimum == null || value >= field.minimum) && (field.maximum == null || value <= field.maximum);
  if (typeof value !== "string" || value.length > 12_000) return false;
  if (field.options && !field.options.some((o) => o.value === value)) return false;
  const length = [...value].length;
  if (field.minLength != null && length < field.minLength || field.maxLength != null && length > field.maxLength) return false;
  if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  if (field.format === "uri") { try { new URL(value); } catch { return false; } }
  if (field.format === "date" || field.format === "date-time") {
    const date = value.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) return false;
    if (field.format === "date" && value !== date) return false;
    if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value)))) return false;
  }
  return true;
}

export function parseServerRequestResponse(record, value) {
  if (!object(value)) throw invalid();
  const { method, params = {} } = record.message;
  if ([COMMAND, FILE, PERMISSIONS].includes(method)) {
    const choice = decisions(record).find((option) => value.choice === option.id
      || (value.choice === undefined && typeof option.result.decision === "string" && value.decision === option.result.decision));
    if (!choice) throw invalid("这个审批选项不可用");
    return choice.result;
  }
  if (method === INPUT) {
    if (value.skip === true && params.isBlocking === false) return { answers: {} };
    if (!object(value.answers)) throw invalid("请回答所有问题");
    const ids = new Set(params.questions.map((q) => q.id));
    if (Object.keys(value.answers).some((id) => !ids.has(id))) throw invalid("问题已经变更，请刷新后重试");
    const answers = Object.create(null);
    for (const q of params.questions) {
      const answer = value.answers[q.id]?.answers;
      if (!Array.isArray(answer) || answer.length !== 1 || typeof answer[0] !== "string" || !answer[0].trim() || answer[0].length > 12_000) throw invalid("请回答所有问题");
      answers[q.id] = { answers: [answer[0]] };
    }
    return { answers };
  }
  if (method === MCP) {
    if (!["accept", "decline", "cancel"].includes(value.action)) throw invalid();
    if (value.action !== "accept") return { action: value.action };
    if (!interactiveRequest(record).supported) throw invalid("暂不支持填写此表单", 409);
    if (params.mode === "url") return { action: "accept" };
    const fields = elicitationFields(params.requestedSchema);
    if (!object(value.content) || Object.keys(value.content).some((id) => !fields.some((f) => f.id === id))) throw invalid();
    const content = Object.create(null);
    for (const field of fields) {
      if (!Object.hasOwn(value.content, field.id)) {
        if (field.required) throw invalid(`请填写：${field.label}`);
        continue;
      }
      if (!validField(field, value.content[field.id])) throw invalid(`请检查：${field.label}`);
      content[field.id] = value.content[field.id];
    }
    return { action: "accept", content };
  }
  throw invalid("此请求暂不支持在网页上回复", 409);
}
