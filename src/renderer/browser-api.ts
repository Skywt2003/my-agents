import type { DesktopApi } from "@/lib/myagents/desktop-api";
import {
  BROWSER_RPC_PATH,
  type BrowserRpcMethod,
  type BrowserServerMessage,
} from "@/lib/myagents/browser-protocol";
import type {
  SessionStreamEvent,
  TerminalStreamEvent,
} from "@/lib/myagents/types";

type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

const TOKEN_STORAGE_KEY = "myagents:browser-debug-token";
const pendingRequests = new Map<string, PendingRequest>();
const eventListeners = new Map<
  string,
  (event: SessionStreamEvent | TerminalStreamEvent) => void
>();
let requestSequence = 0;
let subscriptionSequence = 0;
let socket: WebSocket | null = null;
let connection: Promise<WebSocket> | null = null;

function nextId(prefix: string) {
  const sequence = prefix === "request"
    ? ++requestSequence
    : ++subscriptionSequence;
  return `${prefix}-${Date.now()}-${sequence}`;
}

function readBrowserToken() {
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const fragmentToken = hash.get("token")?.trim();
  if (fragmentToken) {
    window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fragmentToken);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    return fragmentToken;
  }
  return window.sessionStorage.getItem(TOKEN_STORAGE_KEY)?.trim() ?? "";
}

function socketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${BROWSER_RPC_PATH}`;
}

function rejectPending(message: string) {
  const error = new Error(message);
  for (const pending of pendingRequests.values()) pending.reject(error);
  pendingRequests.clear();
}

function connect() {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  if (connection) return connection;

  const token = readBrowserToken();
  if (!token) {
    return Promise.reject(
      new Error(
        "Browser debug token is missing. Open the token URL printed by npm run dev:web.",
      ),
    );
  }

  connection = new Promise<WebSocket>((resolve, reject) => {
    const nextSocket = new WebSocket(socketUrl());
    let authenticated = false;

    nextSocket.addEventListener("open", () => {
      nextSocket.send(JSON.stringify({ type: "authenticate", token }));
    });
    nextSocket.addEventListener("message", (messageEvent) => {
      let message: BrowserServerMessage;
      try {
        message = JSON.parse(String(messageEvent.data)) as BrowserServerMessage;
      } catch {
        nextSocket.close(1002, "Invalid server message");
        return;
      }

      if (message.type === "authenticated") {
        authenticated = true;
        socket = nextSocket;
        resolve(nextSocket);
        return;
      }
      if (message.type === "fatal") {
        const error = new Error(message.error);
        if (!authenticated) reject(error);
        rejectPending(message.error);
        nextSocket.close(1008, "Server rejected connection");
        return;
      }
      if (message.type === "response") {
        const pending = pendingRequests.get(message.id);
        if (!pending) return;
        pendingRequests.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
        return;
      }
      eventListeners.get(message.subscriptionId)?.(message.event);
    });
    nextSocket.addEventListener("error", () => {
      if (!authenticated) reject(new Error("Browser debug connection failed."));
    });
    nextSocket.addEventListener("close", () => {
      if (!authenticated) reject(new Error("Browser debug authentication failed."));
      if (socket === nextSocket) socket = null;
      connection = null;
      rejectPending("Browser debug connection closed.");
    });
  });

  return connection;
}

async function request<Result>(
  method: BrowserRpcMethod,
  parameters: unknown[] = [],
): Promise<Result> {
  const activeSocket = await connect();
  const id = nextId("request");
  const response = new Promise<Result>((resolve, reject) => {
    pendingRequests.set(id, {
      resolve: (value) => resolve(value as Result),
      reject,
    });
  });
  activeSocket.send(JSON.stringify({ type: "request", id, method, parameters }));
  return response;
}

const browserApi: DesktopApi = {
  transport: "browser",
  platform: "browser",
  sessions: {
    list: (sync = false) => request("sessions.list", [sync]),
    get: (id) => request("sessions.get", [id]),
    reload: (id) => request("sessions.reload", [id]),
    create: (projectId, agentId) =>
      request("sessions.create", [projectId, agentId]),
    discard: (id) => request("sessions.discard", [id]),
    prompt: async (id, message, onEvent) => {
      const subscriptionId = nextId("session");
      eventListeners.set(subscriptionId, (event) =>
        onEvent(event as SessionStreamEvent),
      );
      try {
        await request("sessions.prompt", [id, message, subscriptionId]);
      } finally {
        eventListeners.delete(subscriptionId);
      }
    },
    setConfigOption: (id, configId, value) =>
      request("sessions.setConfigOption", [id, configId, value]),
    cancel: (id) => request("sessions.cancel", [id]),
    resolvePermission: (id, permissionId, optionId) =>
      request("sessions.resolvePermission", [id, permissionId, optionId]),
    updateTitle: (id, titleMode, customTitle) =>
      request("sessions.updateTitle", [id, titleMode, customTitle]),
  },
  projects: {
    create: (name, path) => request("projects.create", [name, path]),
  },
  agents: {
    registry: () => request("agents.registry"),
    install: (registryId) => request("agents.install", [registryId]),
    remove: (id) => request("agents.remove", [id]),
  },
  terminals: {
    create: (cwd, cols, rows) =>
      request("terminals.create", [cwd, cols, rows]),
    close: (id) => request("terminals.close", [id]),
    write: (id, data) => request("terminals.write", [id, data]),
    resize: (id, cols, rows) =>
      request("terminals.resize", [id, cols, rows]),
    subscribe: (id, onEvent) => {
      const subscriptionId = nextId("terminal");
      eventListeners.set(subscriptionId, (event) =>
        onEvent(event as TerminalStreamEvent),
      );
      void request("terminals.subscribe", [id, subscriptionId]).catch(() => {
        eventListeners.delete(subscriptionId);
      });
      return () => {
        eventListeners.delete(subscriptionId);
        void request("terminals.unsubscribe", [subscriptionId]).catch(() => {});
      };
    },
  },
};

export function installBrowserApi() {
  if (typeof window.myagents === "undefined") {
    window.myagents = browserApi;
  }
}
