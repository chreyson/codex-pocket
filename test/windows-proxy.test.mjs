import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareDesktopProxy } from "../src/desktop-launch.mjs";

test("Windows native proxy preserves Unicode, shell metacharacters, quotes and exit status", {
  skip: process.platform !== "win32", timeout: 60_000,
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "Pocket \u6d4b\u8bd5 & % ! "));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5 }));
  const proxy = await prepareDesktopProxy("auto", { dataDirectory: directory, codexPath: process.execPath });
  assert.match(proxy, /\.exe$/);
  const run = promisify(execFile);
  const values = ["", "\u4e2d\u6587", "& echo unexpected", "%PATH%", "!PATH!", 'a"b', "C:\\with space\\", "line\nfeed"];
  const { stdout } = await run(proxy, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", ...values], { timeout: 10_000 });
  assert.deepEqual(JSON.parse(stdout), values);
  await assert.rejects(run(proxy, ["-e", "process.exit(7)"], { timeout: 10_000 }), { code: 7 });
  assert.equal(await prepareDesktopProxy("auto", { dataDirectory: directory, codexPath: process.execPath }), proxy);
});
