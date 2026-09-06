import { createServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
// UI checks mock every API call; this server only serves workspace assets.
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://localhost").pathname;
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(root, relative);
  if (!file.startsWith(root)) { response.writeHead(404).end(); return; }
  try {
    const body = await fs.readFile(file);
    response.writeHead(200, { "Content-Type": `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8` });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
process.env.POCKET_TEST_URL = `http://127.0.0.1:${server.address().port}`;
try {
  await import("./check-queue.mjs");
  await import("./check-qr.mjs");
  await import("./check-mobile.mjs");
  await import("./check-design.mjs");
  await import("./check-image-viewer.mjs");
  await import("./check-polling.mjs");
  await import("./check-permissions.mjs");
  await import("./check-model-picker.mjs");
  await import("./check-markdown.mjs");
  await import("./check-sidebar.mjs");
  await import("./check-management.mjs");
  await import("./check-user-requests.mjs");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
