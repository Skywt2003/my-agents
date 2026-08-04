import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const logPath = process.env.FAKE_ACP_LOG;
let sessionSequence = 0;

function log(method, params) {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ method, params })}\n`);
  }
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  log(message.method, message.params ?? {});

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: { close: {} },
        },
        authMethods: [],
      });
      break;
    case "session/new":
      sessionSequence += 1;
      respond(message.id, { sessionId: `minimal-session-${sessionSequence}` });
      break;
    case "session/close":
      respond(message.id, {});
      break;
    default:
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported method: ${message.method}` },
      })}\n`);
  }
});

process.stdin.resume();
const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGTERM", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
