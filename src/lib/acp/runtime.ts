import "server-only";

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import * as acp from "@agentclientprotocol/sdk";
import type {
  ClientConnection,
  InitializeResponse,
  PermissionOption as AcpPermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import type {
  AgentDescriptor,
  AgentId,
  ChatMessage,
  PermissionRequest,
  SessionSource,
  SessionStatus,
  SessionStreamEvent,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";
import { projectFromWorkingDirectory } from "@/lib/myagents/project";
import {
  getPersistedSession,
  listPersistedSessions,
  persistActivity,
  persistDiscoveredSession,
  persistMessage,
  persistSession,
  replaceSessionContent,
} from "@/lib/persistence/database";

type Listener = (event: SessionStreamEvent) => void;

type PendingPermission = {
  request: PermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
};

type SessionRuntime = {
  id: string;
  acpSessionId: string;
  agentId: AgentId;
  agentName: string;
  title: string;
  cwd: string;
  source: SessionSource;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  activities: Map<string, ToolActivity>;
  permissions: Map<string, PendingPermission>;
  listeners: Set<Listener>;
  process: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  hydrating: boolean;
  error?: string;
};

type OpenAgent = {
  process: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  initialize: InitializeResponse;
};

type RuntimeStore = {
  sessions: Map<string, SessionRuntime>;
  activations: Map<string, Promise<SessionRuntime>>;
  sync: Promise<Partial<Record<AgentId, string>>> | null;
};

declare global {
  var __myAgentsRuntimeStore: RuntimeStore | undefined;
}

const store =
  globalThis.__myAgentsRuntimeStore ??
  (globalThis.__myAgentsRuntimeStore = {
    sessions: new Map(),
    activations: new Map(),
    sync: null,
  });

const agents: AgentDescriptor[] = [
  { id: "codex", name: "Codex" },
  { id: "opencode", name: "OpenCode" },
];
const execFileAsync = promisify(execFile);

function agentDescriptor(agentId: AgentId) {
  const agent = agents.find(({ id }) => id === agentId);
  if (!agent) throw new Error(`Unknown ACP agent: ${agentId}`);
  return agent;
}

function codexAdapterPath() {
  return (
    process.env.MYAGENTS_ACP_PATH ??
    join(
      process.cwd(),
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
      "dist",
      "index.js",
    )
  );
}

function openCodePath() {
  return process.env.MYAGENTS_OPENCODE_PATH ?? "opencode";
}

function serialize(runtime: SessionRuntime): SessionSummary {
  return {
    id: runtime.id,
    acpSessionId: runtime.acpSessionId,
    agentId: runtime.agentId,
    agentName: runtime.agentName,
    project: projectFromWorkingDirectory(runtime.cwd),
    title: runtime.title,
    cwd: runtime.cwd,
    source: runtime.source,
    status: runtime.status,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    messages: runtime.messages,
    activities: Array.from(runtime.activities.values()),
    pendingPermissions: Array.from(runtime.permissions.values()).map(
      ({ request }) => request,
    ),
    error: runtime.error,
  };
}

function persistRuntime(runtime: SessionRuntime) {
  persistSession(serialize(runtime));
}

function publish(runtime: SessionRuntime, event: SessionStreamEvent) {
  for (const listener of runtime.listeners) listener(event);
}

function setStatus(runtime: SessionRuntime, status: SessionStatus) {
  runtime.status = status;
  runtime.updatedAt = new Date().toISOString();
  persistRuntime(runtime);
  publish(runtime, { type: "status", status });
}

function permissionOption(option: AcpPermissionOption) {
  return {
    optionId: option.optionId,
    name: option.name,
    kind: option.kind,
  };
}

function handlePermission(
  runtime: SessionRuntime,
  params: RequestPermissionRequest,
) {
  return new Promise<RequestPermissionResponse>((resolve) => {
    const id = randomUUID();
    const request: PermissionRequest = {
      id,
      toolCallId: params.toolCall.toolCallId,
      title:
        params.toolCall.title ?? `${runtime.agentName} is requesting permission`,
      options: params.options.map(permissionOption),
    };

    runtime.permissions.set(id, { request, resolve });
    publish(runtime, { type: "permission", permission: request });
  });
}

function upsertMessage(
  runtime: SessionRuntime,
  role: ChatMessage["role"],
  messageId: string,
  text: string,
) {
  const existing = runtime.messages.find((message) => message.id === messageId);
  if (existing) {
    existing.content += text;
  } else {
    runtime.messages.push({
      id: messageId,
      role,
      content: text,
      createdAt: new Date().toISOString(),
    });
  }
  runtime.updatedAt = new Date().toISOString();

  if (!runtime.hydrating) {
    const message = runtime.messages.find((item) => item.id === messageId)!;
    persistMessage(runtime.id, message, runtime.messages.indexOf(message));
    persistRuntime(runtime);
  }
}

function handleToolUpdate(runtime: SessionRuntime, update: SessionUpdate) {
  if (
    update.sessionUpdate !== "tool_call" &&
    update.sessionUpdate !== "tool_call_update"
  ) {
    return;
  }

  const previous = runtime.activities.get(update.toolCallId);
  const activity: ToolActivity = {
    id: update.toolCallId,
    title: update.title ?? previous?.title ?? "Working",
    kind: update.kind ?? previous?.kind ?? "other",
    status: update.status ?? previous?.status ?? "in_progress",
  };
  runtime.activities.set(activity.id, activity);
  if (!runtime.hydrating) {
    const activities = Array.from(runtime.activities.values());
    persistActivity(runtime.id, activity, activities.indexOf(activity));
  }
  publish(runtime, { type: "tool", activity });
}

function handleSessionUpdate(runtime: SessionRuntime, update: SessionUpdate) {
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      if (!runtime.hydrating || update.content.type !== "text") return;
      const messageId = update.messageId ?? `user-${runtime.messages.length}`;
      upsertMessage(runtime, "user", messageId, update.content.text);
      return;
    }
    case "agent_message_chunk": {
      if (update.content.type !== "text") return;
      const messageId = update.messageId ?? `assistant-${runtime.messages.length}`;
      upsertMessage(runtime, "assistant", messageId, update.content.text);
      publish(runtime, {
        type: "assistant_delta",
        messageId,
        text: update.content.text,
      });
      return;
    }
    case "agent_thought_chunk":
      if (update.content.type === "text" && !runtime.hydrating) {
        publish(runtime, { type: "thought_delta", text: update.content.text });
      }
      return;
    case "tool_call":
    case "tool_call_update":
      handleToolUpdate(runtime, update);
      return;
    case "plan":
      if (!runtime.hydrating) {
        publish(runtime, {
          type: "plan",
          entries: update.entries.map(({ content, status }) => ({
            content,
            status,
          })),
        });
      }
      return;
    case "session_info_update":
      if (update.title) runtime.title = update.title;
      if (update.updatedAt) runtime.updatedAt = update.updatedAt;
      persistRuntime(runtime);
      return;
    default:
      return;
  }
}

function processError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The ACP agent failed unexpectedly.";
}

async function openAgent(
  agentId: AgentId,
  cwd: string,
  runtime: () => SessionRuntime | undefined,
  label: string,
): Promise<OpenAgent> {
  const command =
    agentId === "codex"
      ? process.execPath
      : openCodePath();
  const args =
    agentId === "codex" ? [codexAdapterPath()] : ["acp", "--cwd", cwd];
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      NO_BROWSER: process.env.NO_BROWSER ?? "1",
      ...(agentId === "codex" && process.env.MYAGENTS_CODEX_PATH
        ? { CODEX_PATH: process.env.MYAGENTS_CODEX_PATH }
        : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const app = acp
    .client({ name: "MyAgents" })
    .onRequest(acp.methods.client.session.requestPermission, ({ params }) => {
      const current = runtime();
      return current
        ? handlePermission(current, params)
        : { outcome: { outcome: "cancelled" as const } };
    })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      const current = runtime();
      if (current && params.sessionId === current.acpSessionId) {
        handleSessionUpdate(current, params.update);
      }
    });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (process.env.NODE_ENV !== "production") {
      console.error(`[${agentId}-acp:${label}] ${chunk.trim()}`);
    }
  });

  try {
    const initialize = await connection.agent.request(
      acp.methods.agent.initialize,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "MyAgents", version: "0.1.0" },
      },
    );
    return { process: child, connection, initialize };
  } catch (error) {
    connection.close(error);
    child.kill();
    throw error;
  }
}

function watchConnection(runtime: SessionRuntime) {
  void runtime.connection.closed.then(() => {
    const current = store.sessions.get(runtime.id);
    if (current !== runtime) return;
    current.error = `The ${current.agentName} ACP connection closed. Reopen the session to retry.`;
    current.status = "error";
    publish(current, { type: "error", message: current.error });
    store.sessions.delete(runtime.id);
  });
}

export async function validateWorkingDirectory(cwd: string) {
  if (!cwd.startsWith("/")) {
    throw new Error("Working directory must be an absolute path.");
  }

  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error("Working directory does not exist.");
}

export async function createSession(
  cwd: string,
  agentId: AgentId = "codex",
): Promise<SessionSummary> {
  await validateWorkingDirectory(cwd);
  const agent = agentDescriptor(agentId);
  const id = randomUUID();
  const now = new Date().toISOString();
  let runtime: SessionRuntime | undefined;
  const opened = await openAgent(agentId, cwd, () => runtime, id);

  try {
    const response = await opened.connection.agent.request(
      acp.methods.agent.session.new,
      { cwd, mcpServers: [] },
    );
    runtime = {
      id,
      acpSessionId: response.sessionId,
      agentId,
      agentName: agent.name,
      title: "New session",
      cwd,
      source: "myagents",
      status: "ready",
      createdAt: now,
      updatedAt: now,
      messages: [],
      activities: new Map(),
      permissions: new Map(),
      listeners: new Set(),
      process: opened.process,
      connection: opened.connection,
      hydrating: false,
    };
    store.sessions.set(id, runtime);
    persistRuntime(runtime);
    watchConnection(runtime);
    return serialize(runtime);
  } catch (error) {
    opened.connection.close(error);
    opened.process.kill();
    throw new Error(processError(error));
  }
}

async function activatePersistedSession(id: string) {
  const active = store.sessions.get(id);
  if (active && !active.connection.signal.aborted) return active;

  const pending = store.activations.get(id);
  if (pending) return pending;

  const activation = (async () => {
    const saved = getPersistedSession(id);
    if (!saved) throw new Error("Session not found.");
    await validateWorkingDirectory(saved.cwd);

    const holder: { runtime?: SessionRuntime } = {};
    const opened = await openAgent(
      saved.agentId,
      saved.cwd,
      () => holder.runtime,
      id,
    );
    if (!opened.initialize.agentCapabilities?.loadSession) {
      opened.connection.close();
      opened.process.kill();
      throw new Error("This agent does not support loading existing sessions.");
    }

    const runtime: SessionRuntime = {
      id: saved.id,
      acpSessionId: saved.acpSessionId,
      agentId: saved.agentId,
      agentName: saved.agentName,
      title: saved.title,
      cwd: saved.cwd,
      source: saved.source,
      status: "connecting",
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
      messages: [],
      activities: new Map(),
      permissions: new Map(),
      listeners: new Set(),
      process: opened.process,
      connection: opened.connection,
      hydrating: true,
    };
    holder.runtime = runtime;
    store.sessions.set(id, runtime);

    try {
      await opened.connection.agent.request(acp.methods.agent.session.load, {
        sessionId: saved.acpSessionId,
        cwd: saved.cwd,
        mcpServers: [],
      });
      runtime.hydrating = false;
      runtime.status = "ready";
      runtime.error = undefined;
      replaceSessionContent(
        runtime.id,
        runtime.messages,
        Array.from(runtime.activities.values()),
      );
      persistRuntime(runtime);
      watchConnection(runtime);
      return runtime;
    } catch (error) {
      store.sessions.delete(id);
      opened.connection.close(error);
      opened.process.kill();
      throw new Error(processError(error));
    }
  })();

  store.activations.set(id, activation);
  try {
    return await activation;
  } finally {
    store.activations.delete(id);
  }
}

function persistAgentSession(agentId: AgentId, session: SessionInfo) {
  const updatedAt = session.updatedAt ?? new Date().toISOString();
  persistDiscoveredSession({
    agentId,
    acpSessionId: session.sessionId,
    title: session.title?.trim() || basename(session.cwd) || "Untitled session",
    cwd: session.cwd,
    updatedAt,
  });
}

async function syncAgentSessionsFor(agentId: AgentId) {
  const opened = await openAgent(
    agentId,
    process.cwd(),
    () => undefined,
    "session-list",
  );
  try {
    if (!opened.initialize.agentCapabilities?.sessionCapabilities?.list) {
      throw new Error(`${agentDescriptor(agentId).name} does not support listing sessions.`);
    }

    try {
      let cursor: string | null | undefined;
      do {
        const response = await opened.connection.agent.request(
          acp.methods.agent.session.list,
          { cwd: process.cwd(), ...(cursor ? { cursor } : {}) },
        );
        response.sessions.forEach((session) => persistAgentSession(agentId, session));
        cursor = response.nextCursor;
      } while (cursor);
    } catch (error) {
      if (agentId !== "opencode") throw error;
      await syncOpenCodeSessionsFromCli(process.cwd());
      throw new Error(
        `${processError(error)} Sessions were imported through the OpenCode CLI fallback.`,
      );
    }
  } finally {
    opened.connection.close();
    opened.process.kill();
  }
}

type OpenCodeCliSession = {
  id: string;
  title: string;
  directory: string;
  updated: number;
};

async function syncOpenCodeSessionsFromCli(cwd: string) {
  const { stdout } = await execFileAsync(
    openCodePath(),
    ["session", "list", "--format", "json", "-n", "100"],
    {
      cwd,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const sessions = JSON.parse(stdout || "[]") as OpenCodeCliSession[];
  sessions.forEach((session) =>
    persistDiscoveredSession({
      agentId: "opencode",
      acpSessionId: session.id,
      title: session.title?.trim() || basename(session.directory) || "Untitled session",
      cwd: session.directory,
      updatedAt: new Date(session.updated).toISOString(),
    }),
  );
}

type OpenCodeExport = {
  messages?: Array<{
    info: {
      id: string;
      role: "user" | "assistant";
      time?: { created?: number };
    };
    parts?: Array<{ type: string; text?: string }>;
  }>;
};

async function importOpenCodeSessionHistory(session: SessionSummary) {
  const { stdout } = await execFileAsync(
    openCodePath(),
    ["export", session.acpSessionId],
    {
      cwd: session.cwd,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) throw new Error("OpenCode did not return an export payload.");
  const exported = JSON.parse(stdout.slice(jsonStart)) as OpenCodeExport;
  const messages = (exported.messages ?? []).flatMap<ChatMessage>((message) => {
    const content = (message.parts ?? [])
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n");
    if (!content) return [];
    return [{
      id: message.info.id,
      role: message.info.role,
      content,
      createdAt: new Date(message.info.time?.created ?? Date.now()).toISOString(),
    }];
  });
  replaceSessionContent(session.id, messages, []);
}

export async function syncAgentSessions() {
  if (store.sync) return store.sync;

  store.sync = (async () => {
    const results = await Promise.allSettled(
      agents.map(({ id }) => syncAgentSessionsFor(id)),
    );
    return results.reduce<Partial<Record<AgentId, string>>>((errors, result, index) => {
      if (result.status === "rejected") {
        errors[agents[index].id] = processError(result.reason);
      }
      return errors;
    }, {});
  })();

  try {
    return await store.sync;
  } finally {
    store.sync = null;
  }
}

export async function listSessions() {
  const syncErrors = await syncAgentSessions();

  const sessions = listPersistedSessions()
    .map((saved) => {
      const active = store.sessions.get(saved.id);
      return active ? serialize(active) : saved;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { sessions, agents, syncErrors };
}

export async function getSession(id: string) {
  const saved = getPersistedSession(id);
  if (!saved) throw new Error("Session not found.");

  try {
    return serialize(await activatePersistedSession(id));
  } catch (error) {
    if (saved.agentId !== "opencode") throw error;
    await importOpenCodeSessionHistory(saved);
    const imported = getPersistedSession(id)!;
    return {
      ...imported,
      status: "error" as const,
      error: `OpenCode ACP load is unavailable: ${processError(error)} History is shown through the OpenCode CLI fallback.`,
    };
  }
}

function requireActiveSession(id: string) {
  const runtime = store.sessions.get(id);
  if (!runtime) throw new Error("Session is not active.");
  return runtime;
}

export function subscribe(id: string, listener: Listener) {
  const runtime = requireActiveSession(id);
  runtime.listeners.add(listener);
  return () => runtime.listeners.delete(listener);
}

export async function prepareSession(id: string) {
  await activatePersistedSession(id);
}

export async function promptSession(id: string, text: string) {
  const runtime = await activatePersistedSession(id);
  if (runtime.status === "running") {
    throw new Error("Session is already running.");
  }

  const userMessage: ChatMessage = {
    id: randomUUID(),
    role: "user",
    content: text,
    createdAt: new Date().toISOString(),
  };
  runtime.messages.push(userMessage);
  persistMessage(runtime.id, userMessage, runtime.messages.length - 1);
  if (runtime.title === "New session") {
    runtime.title = text.length > 38 ? `${text.slice(0, 38).trim()}…` : text;
  }
  setStatus(runtime, "running");

  try {
    const response = await runtime.connection.agent.request(
      acp.methods.agent.session.prompt,
      {
        sessionId: runtime.acpSessionId,
        prompt: [{ type: "text", text }],
      },
    );
    setStatus(runtime, "ready");
    publish(runtime, { type: "done", stopReason: response.stopReason });
  } catch (error) {
    const message = processError(error);
    runtime.error = message;
    setStatus(runtime, "error");
    publish(runtime, { type: "error", message });
    throw error;
  }
}

export function resolvePermission(
  id: string,
  permissionId: string,
  optionId?: string,
) {
  const runtime = requireActiveSession(id);
  const pending = runtime.permissions.get(permissionId);
  if (!pending) throw new Error("Permission request not found.");

  if (
    optionId &&
    !pending.request.options.some(
      (option: PermissionRequest["options"][number]) =>
        option.optionId === optionId,
    )
  ) {
    throw new Error("Permission option not found.");
  }

  pending.resolve({
    outcome: optionId
      ? { outcome: "selected", optionId }
      : { outcome: "cancelled" },
  });
  runtime.permissions.delete(permissionId);
  publish(runtime, { type: "permission_resolved", permissionId });
}

export async function cancelSession(id: string) {
  const runtime = store.sessions.get(id);
  if (!runtime || runtime.status !== "running") return;
  await runtime.connection.agent.notify(acp.methods.agent.session.cancel, {
    sessionId: runtime.acpSessionId,
  });
}

export function defaultWorkingDirectory() {
  return process.cwd();
}

export function listAgents() {
  return agents;
}
