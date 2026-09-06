import assert from "node:assert/strict";
import test from "node:test";
import { desktopLaunchConfig, withDesktopLaunchConfig } from "../src/desktop-proxy-config.mjs";

test("desktop MCP launch definition survives the later enabled_tools override", () => {
  const defaults = desktopLaunchConfig(["app-server", "-c", 'mcp_servers.codex_app={command="/path with spaces/tool",args=["--stdio"],env={PIPE="local-pipe"}}', "--enable", "memories"]);
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const result = withDesktopLaunchConfig({ method, params: { threadId: "same", config: { "mcp_servers.codex_app.enabled_tools": ["list_threads"] } } }, defaults);
    assert.deepEqual(result.params.config.mcp_servers.codex_app, {
      command: "/path with spaces/tool", args: ["--stdio"], env: { PIPE: "local-pipe" }, enabled_tools: ["list_threads"],
    });
    assert.equal(result.params.threadId, "same");
  }
  assert.equal(defaults.mcp_servers.codex_app.enabled_tools, undefined);
});

test("quoted names, Windows paths and per-task disabling retain their meaning", () => {
  const defaults = desktopLaunchConfig(["--config", String.raw`mcp_servers.codex_app={command='C:\Program Files\Codex\tools.exe',enabled=true}`, "--config=model=unquoted-model", "--config", 'plugins."name.with.dots".enabled=true', "--disable", "memories"]);
  assert.equal(defaults.mcp_servers.codex_app.command, String.raw`C:\Program Files\Codex\tools.exe`);
  assert.equal(defaults.plugins["name.with.dots"].enabled, true);
  const result = withDesktopLaunchConfig({ method: "thread/start", params: { config: {
    "mcp_servers.codex_app": { command: "", enabled: false }, model: "task-model",
  } } }, defaults);
  assert.equal(result.params.config.mcp_servers.codex_app.enabled, false);
  assert.equal(result.params.config.mcp_servers.codex_app.command, "");
  assert.equal(result.params.config.model, "task-model");
  assert.equal(defaults.model, "unquoted-model");
});

test("non-config requests and responses are untouched, prototype keys stay inert", () => {
  const message = { id: "approval", result: { decision: "decline" } };
  assert.equal(withDesktopLaunchConfig(message, { features: { memories: true } }), message);
  const result = withDesktopLaunchConfig({ method: "thread/start", params: { config: JSON.parse('{"__proto__.polluted":true}') } }, { model: "test" });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.hasOwn(result.params.config, "__proto__"), true);
});
