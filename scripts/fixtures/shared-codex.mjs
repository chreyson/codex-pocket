import { WebSocketServer } from "ws";

if (process.argv.includes("--version")) {
  console.log("codex-cli shared-fixture 1.0.0");
  process.exit(0);
}

const url = new URL(process.argv[process.argv.indexOf("--listen") + 1]);
const server = new WebSocketServer({ host: url.hostname, port: Number(url.port) });
server.on("connection", (socket) => socket.on("message", (data) => {
  const { id, method } = JSON.parse(data);
  if (id === undefined) return;
  socket.send(JSON.stringify({ id, result: { pid: process.pid } }));
  if (method === "test/shutdown") setTimeout(() => process.exit(0), 20);
}));
