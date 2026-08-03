import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { createServer, type Plugin } from "vite";
import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

import {
  BROWSER_HEALTH_PATH,
  BROWSER_RPC_PATH,
  type BrowserClientMessage,
  type BrowserRpcMethod,
  type BrowserServerMessage,
} from "@/lib/myagents/browser-protocol";
import { createDesktopService } from "@/lib/myagents/desktop-service";
import { dataDirectory } from "@/lib/persistence/database";
import type {
  SessionStreamEvent,
  TerminalStreamEvent,
} from "@/lib/myagents/types";

const browserTokenFileName = "browser-debug-token";
const browserEntryPlugin = {
  name: "myagents-browser-entry",
  transformIndexHtml(html) {
    return html.replace("./main.tsx", "./browser-main.tsx");
  },
} satisfies Plugin;
const healthEndpointPlugin = {
  name: "myagents-browser-health",
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (request.url !== BROWSER_HEALTH_PATH) {
        next();
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ ok: true, mode: "browser-debug" }));
    });
  },
} satisfies Plugin;

async function readBrowserToken(path: string) {
  const token = (await readFile(path, "utf8")).trim();
  if (token.length < 24) {
    throw new Error(`The browser debug token in ${path} is invalid.`);
  }
  await chmod(path, 0o600);
  return token;
}

async function browserToken() {
  const configuredToken = process.env.MYAGENTS_WEB_TOKEN?.trim();
  if (configuredToken) return configuredToken;

  const directory = dataDirectory();
  const path = join(directory, browserTokenFileName);
  await mkdir(directory, { recursive: true });

  try {
    return await readBrowserToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, `${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return readBrowserToken(path);
  }
}

async function main() {
const host = process.env.MYAGENTS_WEB_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.MYAGENTS_WEB_PORT ?? "3200");
const publicOrigin = process.env.MYAGENTS_WEB_ORIGIN?.trim();
const token = await browserToken();

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("MYAGENTS_WEB_PORT must be a valid TCP port.");
}
if (token.length < 24) {
  throw new Error("MYAGENTS_WEB_TOKEN must contain at least 24 characters.");
}

const localOrigin = `http://127.0.0.1:${port}`;
const allowedOrigins = new Set([
  localOrigin,
  `http://localhost:${port}`,
  ...(publicOrigin ? [publicOrigin] : []),
  ...(process.env.MYAGENTS_WEB_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
]);
const allowedHosts = Array.from(allowedOrigins, (origin) => {
  try {
    return new URL(origin).hostname;
  } catch {
    return "";
  }
}).filter(Boolean);

const service = createDesktopService();
const vite = await createServer({
  configFile: false,
  root: resolve("src/renderer"),
  plugins: [browserEntryPlugin, healthEndpointPlugin, react()],
  resolve: { alias: { "@": resolve("src") } },
  define: { __MYAGENTS_BROWSER_DEBUG__: "true" },
  server: {
    host,
    port,
    strictPort: true,
    allowedHosts,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  },
});

const httpServer = vite.httpServer;
if (!httpServer) throw new Error("Vite HTTP server is unavailable.");

const webSocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 1_048_576,
});

httpServer.on("upgrade", (request, socket, head) => {
  const pathname = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  ).pathname;
  if (pathname !== BROWSER_RPC_PATH) return;

  const origin = request.headers.origin;
  if (!origin || !allowedOrigins.has(origin)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request);
  });
});

function send(webSocket: WebSocket, message: BrowserServerMessage) {
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.send(JSON.stringify(message));
  }
}

function tokenMatches(input: string) {
  const expected = Buffer.from(token);
  const actual = Buffer.from(input);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseMessage(data: RawData): BrowserClientMessage {
  const value = JSON.parse(data.toString()) as unknown;
  if (!value || typeof value !== "object" || !("type" in value)) {
    throw new Error("Invalid browser RPC message.");
  }
  return value as BrowserClientMessage;
}

function requiredString(
  parameters: unknown[],
  index: number,
  name: string,
  maxLength = 4096,
) {
  const value = parameters[index];
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function optionalString(
  parameters: unknown[],
  index: number,
  name: string,
  maxLength = 4096,
) {
  const value = parameters[index];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function requiredNumber(parameters: unknown[], index: number, name: string) {
  const value = parameters[index];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Browser RPC request failed.";
}

webSocketServer.on("connection", (webSocket) => {
  let authenticated = false;
  const terminalSubscriptions = new Map<string, () => void>();
  const authenticationTimer = setTimeout(() => {
    if (!authenticated) webSocket.close(1008, "Authentication timeout");
  }, 5_000);

  const emitEvent = (
    subscriptionId: string,
    event: SessionStreamEvent | TerminalStreamEvent,
  ) => send(webSocket, { type: "event", subscriptionId, event });

  async function dispatch(
    method: BrowserRpcMethod,
    parameters: unknown[],
  ): Promise<unknown> {
    switch (method) {
      case "sessions.list":
        return service.sessions.list(parameters[0] === true);
      case "sessions.get":
        return service.sessions.get(requiredString(parameters, 0, "Session ID"));
      case "sessions.reload":
        return service.sessions.reload(requiredString(parameters, 0, "Session ID"));
      case "sessions.create":
        return service.sessions.create(
          requiredString(parameters, 0, "Project ID"),
          requiredString(parameters, 1, "Agent ID"),
        );
      case "sessions.discard":
        return service.sessions.discard(
          requiredString(parameters, 0, "Session ID"),
        );
      case "sessions.prompt": {
        const sessionId = requiredString(parameters, 0, "Session ID");
        const message = requiredString(parameters, 1, "Message", 1_000_000);
        const subscriptionId = requiredString(
          parameters,
          2,
          "Subscription ID",
          200,
        );
        return service.sessions.prompt(sessionId, message, (event) =>
          emitEvent(subscriptionId, event),
        );
      }
      case "sessions.setConfigOption": {
        const value = parameters[2];
        if (typeof value !== "string" && typeof value !== "boolean") {
          throw new Error("Configuration value is invalid.");
        }
        return service.sessions.setConfigOption(
          requiredString(parameters, 0, "Session ID"),
          requiredString(parameters, 1, "Configuration ID"),
          value,
        );
      }
      case "sessions.cancel":
        return service.sessions.cancel(requiredString(parameters, 0, "Session ID"));
      case "sessions.resolvePermission":
        return service.sessions.resolvePermission(
          requiredString(parameters, 0, "Session ID"),
          requiredString(parameters, 1, "Permission ID"),
          optionalString(parameters, 2, "Permission option ID"),
        );
      case "sessions.updateTitle": {
        const titleMode = parameters[1];
        if (titleMode !== "default" && titleMode !== "custom") {
          throw new Error("Session title mode is invalid.");
        }
        return service.sessions.updateTitle(
          requiredString(parameters, 0, "Session ID"),
          titleMode,
          optionalString(parameters, 2, "Custom title", 200),
        );
      }
      case "projects.create":
        return service.projects.create(
          requiredString(parameters, 0, "Project name", 200),
          requiredString(parameters, 1, "Project path"),
        );
      case "agents.registry":
        return service.agents.registry();
      case "agents.install":
        return service.agents.install(
          requiredString(parameters, 0, "Registry agent ID", 200),
        );
      case "agents.remove":
        return service.agents.remove(requiredString(parameters, 0, "Agent ID", 200));
      case "terminals.create":
        return service.terminals.create(
          requiredString(parameters, 0, "Working directory"),
          parameters[1] === undefined
            ? undefined
            : requiredNumber(parameters, 1, "Terminal columns"),
          parameters[2] === undefined
            ? undefined
            : requiredNumber(parameters, 2, "Terminal rows"),
        );
      case "terminals.close":
        return service.terminals.close(requiredString(parameters, 0, "Terminal ID"));
      case "terminals.write":
        return service.terminals.write(
          requiredString(parameters, 0, "Terminal ID"),
          optionalString(parameters, 1, "Terminal input", 65_536) ?? "",
        );
      case "terminals.resize":
        return service.terminals.resize(
          requiredString(parameters, 0, "Terminal ID"),
          requiredNumber(parameters, 1, "Terminal columns"),
          requiredNumber(parameters, 2, "Terminal rows"),
        );
      case "terminals.subscribe": {
        const terminalId = requiredString(parameters, 0, "Terminal ID");
        const subscriptionId = requiredString(
          parameters,
          1,
          "Subscription ID",
          200,
        );
        terminalSubscriptions.get(subscriptionId)?.();
        terminalSubscriptions.set(
          subscriptionId,
          service.terminals.subscribe(terminalId, (event) =>
            emitEvent(subscriptionId, event),
          ),
        );
        return undefined;
      }
      case "terminals.unsubscribe": {
        const subscriptionId = requiredString(
          parameters,
          0,
          "Subscription ID",
          200,
        );
        terminalSubscriptions.get(subscriptionId)?.();
        terminalSubscriptions.delete(subscriptionId);
        return undefined;
      }
    }
  }

  async function handleRequest(message: Extract<BrowserClientMessage, { type: "request" }>) {
    try {
      const result = await dispatch(message.method, message.parameters);
      send(webSocket, { type: "response", id: message.id, result });
    } catch (error) {
      send(webSocket, {
        type: "response",
        id: message.id,
        error: errorMessage(error),
      });
    }
  }

  webSocket.on("message", (data) => {
    try {
      const message = parseMessage(data);
      if (!authenticated) {
        if (
          message.type !== "authenticate" ||
          typeof message.token !== "string" ||
          !tokenMatches(message.token)
        ) {
          send(webSocket, { type: "fatal", error: "Authentication failed." });
          webSocket.close(1008, "Authentication failed");
          return;
        }
        authenticated = true;
        clearTimeout(authenticationTimer);
        send(webSocket, { type: "authenticated" });
        return;
      }
      if (message.type !== "request") {
        throw new Error("Unexpected browser RPC message.");
      }
      void handleRequest(message);
    } catch (error) {
      send(webSocket, { type: "fatal", error: errorMessage(error) });
      webSocket.close(1002, "Invalid browser RPC message");
    }
  });

  webSocket.on("close", () => {
    clearTimeout(authenticationTimer);
    for (const unsubscribe of terminalSubscriptions.values()) unsubscribe();
    terminalSubscriptions.clear();
  });
});

await vite.listen();

const tokenFragment = `#token=${encodeURIComponent(token)}`;
if (process.env.MYAGENTS_WEB_QUIET !== "1") {
  console.log(`Browser debug local:  ${localOrigin}/${tokenFragment}`);
  if (publicOrigin) {
    console.log(`Browser debug remote: ${publicOrigin}/${tokenFragment}`);
  }
  console.log(`Allowed WebSocket origins: ${Array.from(allowedOrigins).join(", ")}`);
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const client of webSocketServer.clients) client.close(1001, "Server shutdown");
  webSocketServer.close();
  service.shutdown();
  await vite.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
