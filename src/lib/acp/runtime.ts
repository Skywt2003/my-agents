import "server-only";

import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AuthMethod,
  ClientConnection,
  InitializeResponse,
  PermissionOption as AcpPermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import type {
  AgentAuthMethod,
  AgentCapabilities,
  AgentId,
  ChatMessage,
  PermissionRequest,
  SessionSource,
  SessionStatus,
  SessionStreamEvent,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";
import {
  listInstalledAgents,
  requireInstalledAgent,
} from "@/lib/acp/agents";
import { projectFromWorkingDirectory } from "@/lib/myagents/project";
import {
  getPersistedSession,
  listPersistedSessions,
  persistActivity,
  persistDiscoveredSession,
  persistMessage,
  persistSession,
  replaceSessionContent,
  updateAgentError,
  updateAgentHandshake,
  type InstalledAgent,
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
  capabilities: AgentCapabilities;
  hydrating: boolean;
  error?: string;
};

type OpenAgent = {
  agent: InstalledAgent;
  process: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  initialize: InitializeResponse;
  capabilities: AgentCapabilities;
};

type RuntimeStore = {
  version: 2;
  sessions: Map<string, SessionRuntime>;
  activations: Map<string, Promise<SessionRuntime>>;
  sync: Promise<Partial<Record<AgentId, string>>> | null;
};

declare global {
  var __myAgentsRuntimeStore: RuntimeStore | undefined;
}

const previousStore = globalThis.__myAgentsRuntimeStore;
if (previousStore && previousStore.version !== 2) {
  for (const session of previousStore.sessions.values()) {
    session.connection.close();
    session.process.kill();
  }
}
const store =
  previousStore?.version === 2
    ? previousStore
    : (globalThis.__myAgentsRuntimeStore = {
        version: 2,
        sessions: new Map(),
        activations: new Map(),
        sync: null,
      });

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
    resumable:
      runtime.capabilities.loadSession || runtime.capabilities.resumeSession,
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

function capabilitiesFromInitialize(
  initialize: InitializeResponse,
): AgentCapabilities {
  const capabilities = initialize.agentCapabilities;
  return {
    loadSession: Boolean(capabilities?.loadSession),
    listSessions: Boolean(capabilities?.sessionCapabilities?.list),
    resumeSession: Boolean(capabilities?.sessionCapabilities?.resume),
    closeSession: Boolean(capabilities?.sessionCapabilities?.close),
    promptImage: Boolean(capabilities?.promptCapabilities?.image),
    promptAudio: Boolean(capabilities?.promptCapabilities?.audio),
    promptEmbeddedContext: Boolean(
      capabilities?.promptCapabilities?.embeddedContext,
    ),
  };
}

function authMethodDescriptor(method: AuthMethod): AgentAuthMethod {
  const type = "type" in method ? method.type : "agent";
  return {
    id: method.id,
    name: method.name,
    description: method.description ?? undefined,
    type:
      type === "agent" || type === "env_var" || type === "terminal"
        ? type
        : "unknown",
  };
}

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 20_000) {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function openAgent(
  agent: InstalledAgent,
  cwd: string,
  runtime: () => SessionRuntime | undefined,
  label: string,
): Promise<OpenAgent> {
  const child = spawn(agent.command, agent.args, {
    cwd,
    env: {
      ...process.env,
      ...agent.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", reject);
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
      console.error(`[${agent.id}-acp:${label}] ${chunk.trim()}`);
    }
  });

  try {
    const initialize = await withTimeout(
      Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "MyAgents", version: "0.1.0" },
        }),
        spawnError,
      ]),
      `${agent.name} ACP initialization`,
    );
    if (initialize.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `${agent.name} negotiated unsupported ACP protocol version ${initialize.protocolVersion}.`,
      );
    }
    const capabilities = capabilitiesFromInitialize(initialize);
    updateAgentHandshake(
      agent.id,
      capabilities,
      (initialize.authMethods ?? []).map(authMethodDescriptor),
    );
    return { agent, process: child, connection, initialize, capabilities };
  } catch (error) {
    updateAgentError(agent.id, processError(error));
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
  const agent = requireInstalledAgent(agentId);
  const id = randomUUID();
  const now = new Date().toISOString();
  let runtime: SessionRuntime | undefined;
  const opened = await openAgent(agent, cwd, () => runtime, id);

  try {
    const response = await withTimeout(
      opened.connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      }),
      `${agent.name} session creation`,
      60_000,
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
      capabilities: opened.capabilities,
      hydrating: false,
    };
    store.sessions.set(id, runtime);
    persistRuntime(runtime);
    watchConnection(runtime);
    return serialize(runtime);
  } catch (error) {
    const message = processError(error);
    updateAgentError(agent.id, message);
    opened.connection.close(error);
    opened.process.kill();
    const authMethods = (opened.initialize.authMethods ?? [])
      .map(({ name }) => name)
      .join(", ");
    throw new Error(
      /auth/i.test(message) && authMethods
        ? `${message}. Available authentication: ${authMethods}.`
        : message,
    );
  }
}

export async function authenticateAgent(
  agentId: AgentId,
  methodId: string,
  cwd = process.cwd(),
) {
  await validateWorkingDirectory(cwd);
  const agent = requireInstalledAgent(agentId);
  const opened = await openAgent(
    agent,
    cwd,
    () => undefined,
    "authenticate",
  );
  try {
    const method = (opened.initialize.authMethods ?? []).find(
      ({ id }) => id === methodId,
    );
    if (!method) throw new Error("The agent did not advertise this auth method.");
    const type = "type" in method ? method.type : "agent";
    if (type === "terminal") {
      throw new Error(
        `${agent.name} requires an interactive terminal authentication flow, which MyAgents does not expose yet.`,
      );
    }
    if (type === "env_var") {
      throw new Error(
        `${agent.name} requires credentials in its configured environment variables.`,
      );
    }
    await withTimeout(
      opened.connection.agent.request(acp.methods.agent.authenticate, {
        methodId,
      }),
      `${agent.name} authentication`,
      5 * 60_000,
    );
    updateAgentError(agent.id);
    return { ok: true };
  } finally {
    opened.connection.close();
    opened.process.kill();
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
    const agent = requireInstalledAgent(saved.agentId);

    const holder: { runtime?: SessionRuntime } = {};
    const opened = await openAgent(
      agent,
      saved.cwd,
      () => holder.runtime,
      id,
    );
    if (!opened.capabilities.loadSession && !opened.capabilities.resumeSession) {
      opened.connection.close();
      opened.process.kill();
      throw new Error(
        `${agent.name} does not advertise session/load or session/resume; this saved session cannot be continued after its ACP process exits.`,
      );
    }
    const loadsHistory = opened.capabilities.loadSession;

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
      messages: loadsHistory ? [] : [...saved.messages],
      activities: new Map(
        loadsHistory
          ? []
          : saved.activities.map((activity) => [activity.id, activity]),
      ),
      permissions: new Map(),
      listeners: new Set(),
      process: opened.process,
      connection: opened.connection,
      capabilities: opened.capabilities,
      hydrating: loadsHistory,
    };
    holder.runtime = runtime;
    store.sessions.set(id, runtime);

    try {
      if (loadsHistory) {
        await opened.connection.agent.request(acp.methods.agent.session.load, {
          sessionId: saved.acpSessionId,
          cwd: saved.cwd,
          mcpServers: [],
        });
      } else {
        await opened.connection.agent.request(acp.methods.agent.session.resume, {
          sessionId: saved.acpSessionId,
          cwd: saved.cwd,
          mcpServers: [],
        });
      }
      runtime.hydrating = false;
      runtime.status = "ready";
      runtime.error = undefined;
      if (loadsHistory) {
        replaceSessionContent(
          runtime.id,
          runtime.messages,
          Array.from(runtime.activities.values()),
        );
      }
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

async function syncAgentSessionsFor(agent: InstalledAgent) {
  const opened = await openAgent(
    agent,
    process.cwd(),
    () => undefined,
    "session-list",
  );
  try {
    if (!opened.capabilities.listSessions) return;

    let cursor: string | null | undefined;
    do {
      const response = await opened.connection.agent.request(
        acp.methods.agent.session.list,
        cursor ? { cursor } : {},
      );
      response.sessions.forEach((session) =>
        persistAgentSession(agent.id, session),
      );
      cursor = response.nextCursor;
    } while (cursor);
  } finally {
    opened.connection.close();
    opened.process.kill();
  }
}

export async function syncAgentSessions() {
  if (store.sync) return store.sync;

  store.sync = (async () => {
    const agents = listInstalledAgents().filter(
      ({ enabled, available }) => enabled && available,
    );
    const results = await Promise.allSettled(
      agents.map(({ id }) => syncAgentSessionsFor(requireInstalledAgent(id))),
    );
    return results.reduce<Partial<Record<AgentId, string>>>(
      (errors, result, index) => {
        if (result.status === "rejected") {
          const id = agents[index].id;
          const message = processError(result.reason);
          errors[id] = message;
          updateAgentError(id, message);
        }
        return errors;
      },
      {},
    );
  })();

  try {
    return await store.sync;
  } finally {
    store.sync = null;
  }
}

export async function listSessions(sync = false) {
  const agents = listInstalledAgents();
  const syncErrors = sync ? await syncAgentSessions() : {};

  const sessions = listPersistedSessions()
    .map((saved) => {
      const active = store.sessions.get(saved.id);
      return active ? serialize(active) : saved;
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    sessions,
    agents: sync ? listInstalledAgents() : agents,
    syncErrors,
  };
}

export async function getSession(id: string) {
  const saved = getPersistedSession(id);
  if (!saved) throw new Error("Session not found.");
  try {
    return serialize(await activatePersistedSession(id));
  } catch (error) {
    return {
      ...saved,
      status: "error" as const,
      error: processError(error),
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

export async function closeSession(id: string) {
  const runtime = store.sessions.get(id);
  if (!runtime) return;
  store.sessions.delete(id);
  try {
    if (runtime.capabilities.closeSession) {
      await runtime.connection.agent.request(acp.methods.agent.session.close, {
        sessionId: runtime.acpSessionId,
      });
    }
  } finally {
    runtime.connection.close();
    runtime.process.kill();
  }
}

export function defaultWorkingDirectory() {
  return process.cwd();
}

export function listAgents() {
  return listInstalledAgents();
}
