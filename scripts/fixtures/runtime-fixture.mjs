import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function fakeRuntime() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pocket test \u6d4b\u8bd5 "));
  const fixture = fileURLToPath(new URL("./fake-codex.mjs", import.meta.url));
  const command = path.join(directory, process.platform === "win32" ? "codex.cmd" : "codex");
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await fs.writeFile(command, process.platform === "win32"
    ? `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
  return { directory, command, cleanup: () => fs.rm(directory, {
    recursive: true, force: true, maxRetries: 10, retryDelay: 100,
  }) };
}
