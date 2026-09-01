const SUPPORTED_MODES = new Set(["default", "plan", "goal"]);

function cleanString(value, limit = 2_000) {
  const text = typeof value === "string" ? value.replaceAll("\0", "").trim() : "";
  return text.slice(0, limit);
}

function normalizedEfforts(model) {
  const seen = new Set();
  const efforts = [];
  const options = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : [];
  for (const option of options) {
    const id = cleanString(option?.reasoningEffort, 32);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    efforts.push({
      id,
      description: cleanString(option?.description, 500),
    });
  }
  return efforts;
}

function normalizedModels(value) {
  const seen = new Set();
  const normalized = [];
  for (const model of Array.isArray(value?.models) ? value.models : []) {
    if (!model || model.hidden) continue;
    const id = cleanString(model.model || model.id, 160);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const efforts = normalizedEfforts(model);
    const configuredDefault = cleanString(model.defaultReasoningEffort, 32);
    const defaultEffort = efforts.some((effort) => effort.id === configuredDefault)
      ? configuredDefault
      : efforts[0]?.id || "";
    const inputModalities = Array.isArray(model.inputModalities)
      ? [...new Set(model.inputModalities
        .map((item) => cleanString(item, 32))
        .filter((item) => ["text", "image", "audio"].includes(item)))]
      : [];
    normalized.push({
      id,
      name: cleanString(model.displayName || id, 160),
      description: cleanString(model.description, 600),
      specialty: cleanString(model.modelSpecialty, 160),
      isDefault: Boolean(model.isDefault),
      defaultEffort,
      efforts,
      inputModalities,
      supportsImages: inputModalities.length === 0 || inputModalities.includes("image"),
    });
  }
  return normalized;
}

function normalizedSkills(value) {
  const seen = new Set();
  const skills = [];
  const entries = Array.isArray(value?.skillEntries) ? value.skillEntries : [];
  for (const entry of entries) {
    const entrySkills = Array.isArray(entry?.skills) ? entry.skills : [];
    for (const skill of entrySkills) {
      const name = cleanString(skill?.name, 160);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      skills.push({
        name,
        description: cleanString(
          skill?.interface?.short_description
            || skill?.shortDescription
            || skill?.description,
          1_000,
        ),
        scope: cleanString(skill?.scope, 32),
        enabled: Boolean(skill?.enabled),
        pluginId: cleanString(skill?.pluginId, 160),
        path: cleanString(skill?.path, 2_000),
      });
    }
  }
  return skills;
}

function normalizedModes(value) {
  const available = new Set(["default"]);
  const modes = Array.isArray(value?.modes) ? value.modes : [];
  for (const mode of modes) {
    const id = cleanString(mode?.mode, 32);
    if (SUPPORTED_MODES.has(id)) available.add(id);
  }
  return [...available];
}

function normalizedGoal(goal) {
  if (!goal?.threadId || !goal.objective) return null;
  return {
    objective: cleanString(goal.objective, 12_000),
    status: cleanString(goal.status, 32) || "active",
    tokenBudget: Number.isFinite(goal.tokenBudget) ? goal.tokenBudget : null,
    tokensUsed: Number.isFinite(goal.tokensUsed) ? goal.tokensUsed : 0,
    timeUsedSeconds: Number.isFinite(goal.timeUsedSeconds) ? goal.timeUsedSeconds : 0,
    updatedAt: Number.isFinite(goal.updatedAt) ? goal.updatedAt : 0,
  };
}

export function publicGoal(goal) {
  return normalizedGoal(goal);
}

export function normalizeComposerCatalog(value = {}) {
  const models = normalizedModels(value);
  const skills = normalizedSkills(value);
  const modes = normalizedModes(value);
  const defaultModel = models.find((model) => model.isDefault) || models[0] || null;
  return {
    models,
    skills,
    modes,
    defaultModel: defaultModel?.id || "",
    defaultEffort: defaultModel?.defaultEffort || "",
    goal: normalizedGoal(value.goal),
    features: {
      plan: modes.includes("plan"),
      goal: Boolean(value.goalSupported),
      skills: skills.some((skill) => skill.enabled),
    },
  };
}

export function publicComposerCatalog(catalog) {
  return {
    ...catalog,
    skills: (Array.isArray(catalog?.skills) ? catalog.skills : [])
      .map(({ path: _path, ...skill }) => skill),
  };
}

function selectionError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

export function resolveComposerSelection(payload, catalog) {
  const modelId = payload.model || catalog.defaultModel;
  const model = catalog.models.find((item) => item.id === modelId);
  if (!model) throw selectionError("所选模型当前不可用，请重新选择");

  const effortId = payload.effort || model.defaultEffort;
  const effort = model.efforts.find((item) => item.id === effortId);
  if (model.efforts.length && !effort) {
    throw selectionError("所选推理强度不适用于这个模型");
  }
  if (!model.efforts.length && payload.effort) {
    throw selectionError("这个模型不接受推理强度设置");
  }
  if ((payload.imageIds || []).length && !model.supportsImages) {
    throw selectionError("所选模型不支持图片输入");
  }

  const mode = payload.mode || "default";
  if (!SUPPORTED_MODES.has(mode)) throw selectionError("所选工作模式无效");
  if (mode === "plan" && !catalog.features.plan) {
    throw selectionError("当前 Codex 版本不支持计划模式");
  }
  if (mode === "goal" && !catalog.features.goal) {
    throw selectionError("当前 Codex 版本不支持目标模式");
  }

  const skills = [];
  for (const name of payload.skillNames || []) {
    const skill = catalog.skills.find((item) => item.name === name && item.enabled);
    if (!skill) throw selectionError(`Skill 当前不可用：${name}`);
    skills.push(skill);
  }

  return {
    model: model.id,
    effort: effort?.id || "",
    mode,
    skills,
  };
}
