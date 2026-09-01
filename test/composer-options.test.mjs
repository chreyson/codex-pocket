import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeComposerCatalog,
  publicComposerCatalog,
  resolveComposerSelection,
} from "../src/composer-options.mjs";


function rawCatalog() {
  return {
    models: [
      {
        model: "gpt-balanced",
        displayName: "Balanced",
        description: "Everyday work",
        defaultReasoningEffort: "medium",
        inputModalities: ["text", "image"],
        isDefault: true,
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "Fast" },
          { reasoningEffort: "medium", description: "Balanced" },
        ],
      },
      {
        model: "hidden-model",
        displayName: "Hidden",
        hidden: true,
        supportedReasoningEfforts: [],
      },
    ],
    skillEntries: [{
      cwd: "D:\\work",
      skills: [{
        name: "docs",
        description: "Read official docs",
        path: "C:\\private\\docs\\SKILL.md",
        scope: "system",
        enabled: true,
        pluginId: null,
      }],
    }],
    modes: [{ name: "Plan", mode: "plan" }, { name: "Default", mode: "default" }],
    modeListSupported: true,
    goalSupported: true,
    goal: {
      threadId: "thread-1",
      objective: "Ship the feature",
      status: "active",
      tokensUsed: 12,
      timeUsedSeconds: 3,
      updatedAt: 1,
    },
  };
}

test("composer catalog exposes account options without leaking skill paths", () => {
  const catalog = normalizeComposerCatalog(rawCatalog());
  const publicValue = publicComposerCatalog(catalog);

  assert.equal(catalog.defaultModel, "gpt-balanced");
  assert.equal(catalog.defaultEffort, "medium");
  assert.deepEqual(catalog.modes, ["default", "plan"]);
  assert.equal(catalog.features.goal, true);
  assert.equal(publicValue.models[0].supportsImages, true);
  assert.deepEqual(publicValue.models[0].inputModalities, ["text", "image"]);
  assert.equal(publicValue.skills[0].name, "docs");
  assert.equal("path" in publicValue.skills[0], false);
  assert.equal(catalog.skills[0].path, "C:\\private\\docs\\SKILL.md");
});

test("composer selections validate model effort mode and selected skills", () => {
  const catalog = normalizeComposerCatalog(rawCatalog());
  const selection = resolveComposerSelection({
    text: "Investigate",
    model: "gpt-balanced",
    effort: "low",
    mode: "plan",
    skillNames: ["docs"],
  }, catalog);

  assert.deepEqual({
    model: selection.model,
    effort: selection.effort,
    mode: selection.mode,
    skills: selection.skills.map((skill) => skill.name),
  }, {
    model: "gpt-balanced",
    effort: "low",
    mode: "plan",
    skills: ["docs"],
  });
  assert.throws(
    () => resolveComposerSelection({ model: "gpt-balanced", effort: "max" }, catalog),
    (error) => error.status === 400,
  );
  assert.throws(
    () => resolveComposerSelection({ skillNames: ["unknown"] }, catalog),
    (error) => error.status === 400,
  );
});

test("malformed capability collections degrade to an empty catalog", () => {
  const catalog = normalizeComposerCatalog({
    models: {},
    skillEntries: [{ skills: {} }],
    modes: {},
  });

  assert.deepEqual(catalog.models, []);
  assert.deepEqual(catalog.skills, []);
  assert.deepEqual(catalog.modes, ["default"]);
  assert.deepEqual(publicComposerCatalog(catalog).skills, []);
});

test("models without configurable reasoning effort remain sendable", () => {
  const catalog = normalizeComposerCatalog({
    models: [{ model: "fixed-effort-model", isDefault: true }],
    modes: [],
  });

  assert.deepEqual(
    resolveComposerSelection({ model: "fixed-effort-model" }, catalog),
    {
      model: "fixed-effort-model",
      effort: "",
      mode: "default",
      skills: [],
    },
  );
  assert.throws(
    () => resolveComposerSelection({
      model: "fixed-effort-model",
      effort: "high",
    }, catalog),
    /不接受推理强度/,
  );
});

test("composer selections reject images for text-only models", () => {
  const catalog = normalizeComposerCatalog({
    models: [{
      model: "text-only",
      isDefault: true,
      inputModalities: ["text"],
    }],
    modes: [],
  });

  assert.equal(catalog.models[0].supportsImages, false);
  assert.throws(
    () => resolveComposerSelection({
      model: "text-only",
      text: "inspect",
      imageIds: [`img_${"a".repeat(32)}`],
    }, catalog),
    /不支持图片输入/,
  );
});

test("duplicate model records are collapsed before rendering the catalog", () => {
  const catalog = normalizeComposerCatalog({
    models: [
      { model: "gpt-test", displayName: "First", isDefault: true },
      { model: "gpt-test", displayName: "Duplicate" },
    ],
  });

  assert.equal(catalog.models.length, 1);
  assert.equal(catalog.models[0].name, "First");
});
