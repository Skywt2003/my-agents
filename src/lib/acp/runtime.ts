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
  ClientConnection,
  InitializeResponse,
  PermissionOption as AcpPermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionInfo,
  SessionUpdate,
} from "@agentclientprotocol/sdk";

import type {
  AgentCapabilities,
  AgentId,
  ChatMessage,
  ConversationItem,
  MessageContentBlock,
  PermissionRequest,
  SessionProject,
  SessionSource,
  SessionStatus,
  SessionStreamEvent,
  SessionConfigOption,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";
import {
  appendMessageContent,
  messageContentBlocksFromAcp,
  messageText,
  textContentBlock,
} from "@/lib/myagents/message-content";
import {
  listInstalledAgents,
  requireInstalledAgent,
} from "@/lib/acp/agents";
import {
  getPersistedSession,
  listPersistedSessions,
  persistActivity,
  persistConversationActivity,
  persistConversationMessage,
  reconcileDiscoveredSessions,
  persistMessage,
  persistSession,
  replaceSessionContent,
  updateAgentError,
  updateAgentHandshake,
  updatePersistedSessionTitlePreference,
  type InstalledAgent,
} from "@/lib/persistence/database";

type Listener = (event: SessionStreamEvent) => void;

type PendingPermission = {
  request: PermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
};

type LegacySessionModel = {
  modelId: string;
  name: string;
  description?: string | null;
};

type LegacySessionModelState = {
  currentModelId: string;
  availableModels: LegacySessionModel[];
};

type SessionRuntime = {
  id: string;
  acpSessionId: string;
  agentId: AgentId;
  agentName: string;
  agentIconUrl?: string;
  title: string;
  titleMode: SessionSummary["titleMode"];
  customTitle?: string;
  cwd: string;
  project: SessionProject;
  source: SessionSource;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  activities: Map<string, ToolActivity>;
  conversation: ConversationItem[];
  configOptions: SessionConfigOption[];
  legacyModels?: LegacySessionModelState;
  permissions: Map<string, PendingPermission>;
  listeners: Set<Listener>;
  process: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  capabilities: AgentCapabilities;
  hydrating: boolean;
  persisted: boolean;
  error?: string;
};

type OpenAgent = {
  agent: InstalledAgent;
  process: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  initialize: InitializeResponse;
  capabilities: AgentCapabilities;
  stderrTail: () => string;
};

type RuntimeStore = {
  version: 7;
  sessions: Map<string, SessionRuntime>;
  activations: Map<string, Promise<SessionRuntime>>;
  sync: Promise<Partial<Record<AgentId, string>>> | null;
};

declare global {
  var __myAgentsRuntimeStore: RuntimeStore | undefined;
}

const previousStore = globalThis.__myAgentsRuntimeStore;
if (previousStore && previousStore.version !== 7) {
  for (const session of previousStore.sessions.values()) {
    session.connection.close();
    session.process.kill();
  }
}
const store =
  previousStore?.version === 7
    ? previousStore
    : (globalThis.__myAgentsRuntimeStore = {
        version: 7,
        sessions: new Map(),
        activations: new Map(),
        sync: null,
      });

function serialize(runtime: SessionRuntime): SessionSummary {
  const cached = runtime.hydrating ? getPersistedSession(runtime.id) : null;
  return {
    id: runtime.id,
    acpSessionId: runtime.acpSessionId,
    agentId: runtime.agentId,
    agentName: runtime.agentName,
    agentIconUrl: runtime.agentIconUrl,
    project: runtime.project,
    title: runtime.titleMode === "custom" && runtime.customTitle
      ? runtime.customTitle
      : runtime.title,
    agentTitle: runtime.title,
    titleMode: runtime.titleMode,
    customTitle: runtime.customTitle,
    cwd: runtime.cwd,
    source: runtime.source,
    status: runtime.status,
    resumable:
      runtime.capabilities.loadSession || runtime.capabilities.resumeSession,
    createdAt: runtime.createdAt,
    updatedAt: runtime.updatedAt,
    messages: cached?.messages ?? runtime.messages,
    activities: cached?.activities ?? Array.from(runtime.activities.values()),
    conversation: cached?.conversation ?? runtime.conversation,
    configOptions: runtime.configOptions,
    pendingPermissions: Array.from(runtime.permissions.values()).map(
      ({ request }) => request,
    ),
    error: runtime.error,
  };
}

function persistRuntime(runtime: SessionRuntime) {
  persistSession(serialize(runtime));
  runtime.persisted = true;
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
    runtime.conversation.push({ type: "permission", permission: request });
    publish(runtime, { type: "permission", permission: request });
  });
}

function upsertMessage(
  runtime: SessionRuntime,
  role: ChatMessage["role"],
  messageId: string,
  contentBlocks: MessageContentBlock[],
) {
  const existing = runtime.messages.find((message) => message.id === messageId);
  if (existing) {
    Object.assign(existing, appendMessageContent(existing, contentBlocks));
  } else {
    const message: ChatMessage = {
      id: messageId,
      role,
      content: messageText(contentBlocks),
      contentBlocks,
      createdAt: new Date().toISOString(),
    };
    runtime.messages.push(message);
    runtime.conversation.push({ type: "message", message });
  }
  runtime.updatedAt = new Date().toISOString();

  if (!runtime.hydrating) {
    const message = runtime.messages.find((item) => item.id === messageId)!;
    if (existing) {
      persistMessage(runtime.id, message, runtime.messages.indexOf(message));
    } else {
      const item = runtime.conversation.find(
        (entry) => entry.type === "message" && entry.message.id === messageId,
      );
      if (item?.type === "message") {
        persistConversationMessage(
          runtime.id,
          message,
          runtime.messages.indexOf(message),
          runtime.conversation.indexOf(item),
        );
      }
    }
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
  if (previous) {
    const index = runtime.conversation.findIndex(
      (item) => item.type === "tool" && item.activity.id === activity.id,
    );
    if (index >= 0) runtime.conversation[index] = { type: "tool", activity };
  } else {
    runtime.conversation.push({ type: "tool", activity });
  }
  if (!runtime.hydrating) {
    const activities = Array.from(runtime.activities.values());
    if (previous) {
      persistActivity(runtime.id, activity, activities.indexOf(activity));
    } else {
      const item = runtime.conversation.at(-1);
      if (item?.type === "tool") {
        persistConversationActivity(
          runtime.id,
          activity,
          activities.indexOf(activity),
          runtime.conversation.length - 1,
        );
      }
    }
  }
  publish(runtime, { type: "tool", activity });
}

function messageIdForChunk(
  runtime: SessionRuntime,
  role: ChatMessage["role"],
  messageId: string | null | undefined,
) {
  if (messageId != null) return messageId;

  const previousMessage = runtime.messages.at(-1);
  return previousMessage?.role === role
    ? previousMessage.id
    : `${role}-${runtime.messages.length}`;
}

function handleSessionUpdate(runtime: SessionRuntime, update: SessionUpdate) {
  switch (update.sessionUpdate) {
    case "user_message_chunk": {
      if (!runtime.hydrating) return;
      const contentBlocks = messageContentBlocksFromAcp(update.content, true);
      if (contentBlocks.length === 0) return;
      const messageId = messageIdForChunk(
        runtime,
        "user",
        update.messageId,
      );
      upsertMessage(runtime, "user", messageId, contentBlocks);
      return;
    }
    case "agent_message_chunk": {
      const contentBlocks = messageContentBlocksFromAcp(update.content);
      if (contentBlocks.length === 0) return;
      const messageId = messageIdForChunk(
        runtime,
        "assistant",
        update.messageId,
      );
      upsertMessage(runtime, "assistant", messageId, contentBlocks);
      for (const block of contentBlocks) {
        publish(runtime, block.type === "text"
          ? { type: "assistant_delta", messageId, text: block.text }
          : { type: "assistant_content", messageId, block });
      }
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
    case "config_option_update":
      runtime.legacyModels = undefined;
      runtime.configOptions = update.configOptions;
      publish(runtime, {
        type: "config_options",
        configOptions: runtime.configOptions,
      });
      return;
    default:
      return;
  }
}

function legacyModelsFromResponse(response: unknown): LegacySessionModelState | undefined {
  if (!response || typeof response !== "object" || !("models" in response)) {
    return undefined;
  }
  const models = response.models;
  if (!models || typeof models !== "object") return undefined;

  const currentModelId = "currentModelId" in models
    ? models.currentModelId
    : undefined;
  const availableModels = "availableModels" in models
    ? models.availableModels
    : undefined;
  if (typeof currentModelId !== "string" || !Array.isArray(availableModels)) {
    return undefined;
  }

  const normalized = availableModels.flatMap((model) => {
    if (!model || typeof model !== "object") return [];
    const modelId = "modelId" in model ? model.modelId : undefined;
    const name = "name" in model ? model.name : undefined;
    const description = "description" in model ? model.description : undefined;
    if (typeof modelId !== "string" || typeof name !== "string") return [];
    return [{
      modelId,
      name,
      ...(typeof description === "string" ? { description } : {}),
    }];
  });
  if (!normalized.some(({ modelId }) => modelId === currentModelId)) {
    return undefined;
  }
  return { currentModelId, availableModels: normalized };
}

function legacyModelConfigOption(models: LegacySessionModelState): SessionConfigOption {
  return {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: models.currentModelId,
    options: models.availableModels.map(({ modelId, name, description }) => ({
      value: modelId,
      name,
      ...(description ? { description } : {}),
    })),
  };
}

function sessionConfigFromResponse(response: unknown) {
  const configOptions = response && typeof response === "object" &&
      "configOptions" in response && Array.isArray(response.configOptions)
    ? response.configOptions as SessionConfigOption[]
    : [];
  if (configOptions.length > 0) {
    return { configOptions, legacyModels: undefined };
  }

  const legacyModels = legacyModelsFromResponse(response);
  return {
    configOptions: legacyModels ? [legacyModelConfigOption(legacyModels)] : configOptions,
    legacyModels,
  };
}

function processError(error: unknown) {
  return error instanceof Error
    ? error.message
    : "The ACP agent failed unexpectedly.";
}

function agentProcessError(opened: OpenAgent, error: unknown) {
  const message = processError(error);
  const detail = opened.stderrTail().trim();
  return detail && message === "ACP connection closed"
    ? `${opened.agent.name} ACP process exited: ${detail}`
    : message;
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
      ...(agent.command === process.execPath
        ? { ELECTRON_RUN_AS_NODE: "1" }
        : {}),
      ...agent.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", reject);
  });
  let exitDescription = "";
  const processExit = new Promise<never>((_resolve, reject) => {
    child.once("exit", (code, signal) => {
      exitDescription = `${agent.name} ACP process exited (${signal ?? code ?? "unknown"}).`;
      reject(new Error(exitDescription));
    });
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

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
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
        processExit,
      ]),
      `${agent.name} ACP initialization`,
    );
    if (initialize.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `${agent.name} negotiated unsupported ACP protocol version ${initialize.protocolVersion}.`,
      );
    }
    const capabilities = capabilitiesFromInitialize(initialize);
    updateAgentHandshake(agent.id, capabilities);
    return {
      agent,
      process: child,
      connection,
      initialize,
      capabilities,
      stderrTail: () => stderr,
    };
  } catch (error) {
    await new Promise<void>((resolveImmediate) => setImmediate(resolveImmediate));
    const message = stderr.trim() && processError(error) === "ACP connection closed"
      ? `${agent.name} ACP process exited: ${stderr.trim()}`
      : exitDescription || processError(error);
    updateAgentError(agent.id, message);
    connection.close(error);
    child.kill();
    throw new Error(message);
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
  project: SessionProject,
  agentId: AgentId = "codex",
  { persist = true }: { persist?: boolean } = {},
): Promise<SessionSummary> {
  const cwd = project.path;
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
    const sessionConfig = sessionConfigFromResponse(response);
    runtime = {
      id,
      acpSessionId: response.sessionId,
      agentId,
      agentName: agent.name,
      agentIconUrl: agent.iconUrl,
      title: "New session",
      titleMode: "default",
      customTitle: undefined,
      cwd,
      project,
      source: "myagents",
      status: "ready",
      createdAt: now,
      updatedAt: now,
      messages: [],
      activities: new Map(),
      conversation: [],
      configOptions: sessionConfig.configOptions,
      legacyModels: sessionConfig.legacyModels,
      permissions: new Map(),
      listeners: new Set(),
      process: opened.process,
      connection: opened.connection,
      capabilities: opened.capabilities,
      hydrating: false,
      persisted: persist,
    };
    store.sessions.set(id, runtime);
    if (persist) persistRuntime(runtime);
    watchConnection(runtime);
    return serialize(runtime);
  } catch (error) {
    const message = agentProcessError(opened, error);
    updateAgentError(agent.id, message);
    opened.connection.close(error);
    opened.process.kill();
    throw new Error(message);
  }
}

export async function testAgentSession(agentId: AgentId, cwd: string) {
  await validateWorkingDirectory(cwd);
  const agent = requireInstalledAgent(agentId);
  const opened = await openAgent(agent, cwd, () => undefined, "test");
  let sessionId: string | undefined;

  try {
    const response = await withTimeout(
      opened.connection.agent.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers: [],
      }),
      `${agent.name} test session creation`,
      60_000,
    );
    sessionId = response.sessionId;
    if (!sessionId) throw new Error(`${agent.name} returned an invalid session ID.`);
    updateAgentError(agent.id);
    return `${agent.name} initialized and created a test session successfully.`;
  } catch (error) {
    const message = agentProcessError(opened, error);
    updateAgentError(agent.id, message);
    throw new Error(message);
  } finally {
    if (sessionId && opened.capabilities.closeSession) {
      await withTimeout(
        opened.connection.agent.request(acp.methods.agent.session.close, {
          sessionId,
        }),
        `${agent.name} test session cleanup`,
        5_000,
      ).catch(() => {});
    }
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
      agentIconUrl: agent.iconUrl ?? saved.agentIconUrl,
      title: saved.agentTitle,
      titleMode: saved.titleMode,
      customTitle: saved.customTitle,
      cwd: saved.cwd,
      project: saved.project,
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
      conversation: loadsHistory ? [] : [...saved.conversation],
      configOptions: [],
      permissions: new Map(),
      listeners: new Set(),
      process: opened.process,
      connection: opened.connection,
      capabilities: opened.capabilities,
      hydrating: loadsHistory,
      persisted: true,
    };
    holder.runtime = runtime;
    store.sessions.set(id, runtime);

    try {
      const response = loadsHistory
        ? await opened.connection.agent.request(acp.methods.agent.session.load, {
          sessionId: saved.acpSessionId,
          cwd: saved.cwd,
          mcpServers: [],
        })
        : await opened.connection.agent.request(acp.methods.agent.session.resume, {
          sessionId: saved.acpSessionId,
          cwd: saved.cwd,
          mcpServers: [],
        });
      const sessionConfig = sessionConfigFromResponse(response);
      runtime.configOptions = sessionConfig.configOptions;
      runtime.legacyModels = sessionConfig.legacyModels;
      runtime.hydrating = false;
      runtime.status = "ready";
      runtime.error = undefined;
      if (loadsHistory) {
        replaceSessionContent(
          runtime.id,
          runtime.messages,
          Array.from(runtime.activities.values()),
          runtime.conversation,
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

function discoveredAgentSession(session: SessionInfo) {
  const updatedAt = session.updatedAt ?? new Date().toISOString();
  return {
    acpSessionId: session.sessionId,
    title: session.title?.trim() || basename(session.cwd) || "Untitled session",
    cwd: session.cwd,
    updatedAt,
  };
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

    const sessions: ReturnType<typeof discoveredAgentSession>[] = [];
    let cursor: string | null | undefined;
    do {
      const response = await opened.connection.agent.request(
        acp.methods.agent.session.list,
        cursor ? { cursor } : {},
      );
      sessions.push(...response.sessions.map(discoveredAgentSession));
      cursor = response.nextCursor;
    } while (cursor);
    reconcileDiscoveredSessions(agent.id, sessions);
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

export async function reloadSession(id: string) {
  const active = store.sessions.get(id);
  if (active && !active.connection.signal.aborted) {
    return serialize(active);
  }
  if (active) {
    store.sessions.delete(id);
    active.connection.close();
    active.process.kill();
  }
  return getSession(id);
}

export function updateSessionTitlePreference(
  id: string,
  titleMode: SessionSummary["titleMode"],
  customTitle?: string,
) {
  if (titleMode !== "default" && titleMode !== "custom") {
    throw new Error("Session title mode must be default or custom.");
  }
  const normalizedCustomTitle = customTitle?.trim();
  if (titleMode === "custom" && !normalizedCustomTitle) {
    throw new Error("Custom session name is required.");
  }
  if (normalizedCustomTitle && normalizedCustomTitle.length > 200) {
    throw new Error("Custom session name must be 200 characters or fewer.");
  }

  const active = store.sessions.get(id);
  if (active) {
    active.titleMode = titleMode;
    active.customTitle = titleMode === "custom" ? normalizedCustomTitle : undefined;
    active.updatedAt = new Date().toISOString();
    persistRuntime(active);
    return serialize(active);
  }

  updatePersistedSessionTitlePreference(id, titleMode, normalizedCustomTitle);
  const saved = getPersistedSession(id);
  if (!saved) throw new Error("Session not found.");
  return saved;
}

function requireActiveSession(id: string): SessionRuntime {
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

export async function promptSession(id: string, text: string, listener?: Listener) {
  const runtime = await activatePersistedSession(id);
  if (runtime.status === "running") {
    throw new Error("Session is already running.");
  }

  if (listener) runtime.listeners.add(listener);

  try {
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: text,
      contentBlocks: [textContentBlock(text)],
      createdAt: new Date().toISOString(),
    };
    if (!runtime.persisted) persistRuntime(runtime);
    runtime.messages.push(userMessage);
    const userItem: ConversationItem = { type: "message", message: userMessage };
    runtime.conversation.push(userItem);
    persistConversationMessage(
      runtime.id,
      userMessage,
      runtime.messages.length - 1,
      runtime.conversation.length - 1,
    );
    if (runtime.title === "New session") {
      runtime.title = text.length > 38 ? `${text.slice(0, 38).trim()}…` : text;
    }
    setStatus(runtime, "running");

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
  } finally {
    if (listener) runtime.listeners.delete(listener);
  }
}

export async function setSessionConfigOption(
  id: string,
  configId: string,
  value: string | boolean,
) {
  const runtime = await activatePersistedSession(id);
  if (runtime.status === "running") {
    throw new Error("Session configuration cannot change while the agent is working.");
  }

  const option = runtime.configOptions.find(
    (item: SessionConfigOption) => item.id === configId,
  );
  if (!option) throw new Error("Session configuration option not found.");
  if (option.type === "boolean" && typeof value !== "boolean") {
    throw new Error("This session configuration option requires a boolean value.");
  }
  if (option.type === "select" && typeof value !== "string") {
    throw new Error("This session configuration option requires a selected value.");
  }

  if (
    runtime.legacyModels &&
    option.id === "model" &&
    typeof value === "string"
  ) {
    const response = await runtime.connection.agent.request(
      "session/set_model",
      { sessionId: runtime.acpSessionId, modelId: value },
    );
    runtime.legacyModels = legacyModelsFromResponse(response) ?? {
      ...runtime.legacyModels,
      currentModelId: value,
    };
    runtime.configOptions = [legacyModelConfigOption(runtime.legacyModels)];
    publish(runtime, {
      type: "config_options",
      configOptions: runtime.configOptions,
    });
    return serialize(runtime);
  }

  const params = typeof value === "boolean"
    ? {
        sessionId: runtime.acpSessionId,
        configId,
        type: "boolean" as const,
        value,
      }
    : { sessionId: runtime.acpSessionId, configId, value };
  const response = await runtime.connection.agent.request(
    acp.methods.agent.session.setConfigOption,
    params,
  );
  runtime.configOptions = response.configOptions;
  publish(runtime, {
    type: "config_options",
    configOptions: runtime.configOptions,
  });
  return serialize(runtime);
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
  runtime.conversation = runtime.conversation.filter(
    (item) =>
      item.type !== "permission" || item.permission.id !== permissionId,
  );
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

export function shutdownAgentRuntime(agentId: AgentId) {
  for (const [id, runtime] of store.sessions) {
    if (runtime.agentId !== agentId) continue;
    for (const permission of runtime.permissions.values()) {
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
    runtime.permissions.clear();
    store.sessions.delete(id);
    runtime.connection.close();
    runtime.process.kill();
  }
}

export function shutdownRuntime() {
  for (const runtime of store.sessions.values()) {
    for (const permission of runtime.permissions.values()) {
      permission.resolve({ outcome: { outcome: "cancelled" } });
    }
    runtime.permissions.clear();
    runtime.connection.close();
    runtime.process.kill();
  }
  store.sessions.clear();
  store.activations.clear();
  store.sync = null;
}

export function defaultWorkingDirectory() {
  return process.cwd();
}

export function listAgents() {
  return listInstalledAgents();
}
