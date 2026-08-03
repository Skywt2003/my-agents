import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

import * as acp from "@agentclientprotocol/sdk";

const logPath = process.env.FAKE_ACP_LOG;
const scenario = process.env.FAKE_ACP_SCENARIO ?? "normal";
const sessionNewDelay = Number(process.env.FAKE_ACP_SESSION_NEW_DELAY_MS ?? 0);
const sessionLoadDelay = Number(process.env.FAKE_ACP_SESSION_LOAD_DELAY_MS ?? 0);
const historyPath = process.env.FAKE_ACP_HISTORY_PATH;
const sessions = new Map();
let nextSession = 1;
let nextPrompt = 1;
let currentModel = "fast";
let cancelPrompt;

function log(method, params = {}) {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify({ method, params })}\n`);
  }
}

function readHistory() {
  if (!historyPath) return {};
  try {
    return JSON.parse(readFileSync(historyPath, "utf8"));
  } catch {
    return {};
  }
}

function writeHistory(history) {
  if (historyPath) writeFileSync(historyPath, JSON.stringify(history));
}

function appendHistory(sessionId, items) {
  if (!historyPath) return;
  const history = readHistory();
  history[sessionId] = [...(history[sessionId] ?? []), ...items];
  if (history.__sessions?.[sessionId] && items[0]?.content) {
    history.__sessions[sessionId].title = items[0].content;
    history.__sessions[sessionId].updatedAt = new Date().toISOString();
  }
  writeHistory(history);
}

async function replayHistory(context) {
  const items = readHistory()[context.params.sessionId] ?? [];
  for (const item of items) {
    if (item.type === "tool") {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: item.id,
          title: item.title,
          kind: item.kind,
          status: "completed",
        },
      });
      continue;
    }
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: item.role === "user"
          ? "user_message_chunk"
          : "agent_message_chunk",
        messageId: item.id,
        content: { type: "text", text: item.content },
      },
    });
  }
}

function configOptions() {
  const selectedModel = readHistory().__model ?? currentModel;
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: selectedModel,
      options: [
        { value: "fast", name: "Fast" },
        { value: "accurate", name: "Accurate" },
      ],
    },
  ];
}

function legacyModels() {
  return {
    currentModelId: currentModel,
    availableModels: [
      { modelId: "fast", name: "Fast" },
      { modelId: "accurate", name: "Accurate" },
    ],
  };
}

const app = acp
  .agent({ name: "myagents-fake-agent" })
  .onRequest(acp.methods.agent.initialize, (context) => {
    log("initialize", context.params);
    if (scenario === "protocol-mismatch") {
      return {
        protocolVersion: 0,
        agentCapabilities: {},
        authMethods: [],
      };
    }
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
      authMethods: [],
    };
  })
  .onRequest(acp.methods.agent.session.new, async (context) => {
    log("session/new", context.params);
    if (sessionNewDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, sessionNewDelay));
    }
    const sessionId = `fake-session-${nextSession++}`;
    sessions.set(sessionId, {
      sessionId,
      cwd: context.params.cwd,
      title: "New session",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    if (historyPath) {
      const history = readHistory();
      history.__sessions = history.__sessions ?? {};
      history.__sessions[sessionId] = sessions.get(sessionId);
      writeHistory(history);
    }
    return scenario === "legacy-models"
      ? { sessionId, models: legacyModels() }
      : { sessionId, configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.load, async (context) => {
    log("session/load", context.params);
    if (sessionLoadDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, sessionLoadDelay));
    }
    if (historyPath) {
      await replayHistory(context);
    } else if (scenario === "load-history") {
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "loaded-user",
          content: { type: "text", text: "Loaded question" },
        },
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "loaded-tool",
          title: "Loaded tool",
          kind: "execute",
          status: "in_progress",
        },
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "loaded-tool",
          status: "completed",
        },
      });
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "loaded-assistant",
          content: { type: "text", text: "Loaded answer" },
        },
      });
    }
    return { configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.resume, (context) => {
    log("session/resume", context.params);
    return { configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.list, (context) => {
    log("session/list", context.params);
    if (scenario === "paginated-list") {
      if (!context.params.cursor) {
        return {
          sessions: [
            {
              sessionId: "listed-1",
              cwd: process.cwd(),
              title: "Listed first",
              updatedAt: "2026-01-02T00:00:00.000Z",
            },
          ],
          nextCursor: "page-2",
        };
      }
      return {
        sessions: [
          {
            sessionId: "listed-2",
            cwd: process.cwd(),
            title: "Listed second",
            updatedAt: "2026-01-03T00:00:00.000Z",
          },
        ],
      };
    }
    return {
      sessions: historyPath
        ? Object.values(readHistory().__sessions ?? {})
        : Array.from(sessions.values()),
    };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (context) => {
    log("session/set_config_option", context.params);
    if (context.params.configId === "model" && typeof context.params.value === "string") {
      currentModel = context.params.value;
      if (historyPath) {
        const history = readHistory();
        history.__model = currentModel;
        writeHistory(history);
      }
    }
    return {
      configOptions: configOptions(),
      currentValues: { model: currentModel },
    };
  })
  .onRequest("session/set_model", (params) => params, (context) => {
    log("session/set_model", context.params);
    if (typeof context.params.modelId === "string") {
      currentModel = context.params.modelId;
    }
    return { models: legacyModels() };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    log("session/prompt", context.params);
    const promptText = context.params.prompt
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    const historyIndex = (readHistory()[context.params.sessionId] ?? []).length;
    const messageId = historyPath
      ? `assistant-${Math.floor(historyIndex / 3) + 1}`
      : `assistant-${nextPrompt++}`;
    let assistantText = "Hello from fake agent";
    if (scenario === "crash-during-prompt") {
      process.exit(17);
    }

    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Inspect workspace",
        kind: "read",
        status: "in_progress",
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        ...(scenario === "missing-message-ids" ? {} : { messageId }),
        content: { type: "text", text: "Hello" },
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        ...(scenario === "missing-message-ids" ? {} : { messageId }),
        content: { type: "text", text: " from fake agent" },
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      },
    });

    if (promptText.includes("permission")) {
      const response = await context.client.request(
        acp.methods.client.session.requestPermission,
        {
          sessionId: context.params.sessionId,
          toolCall: { toolCallId: "permission-tool", title: "Run command" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
      );
      const suffix = response.outcome.outcome === "selected"
        ? response.outcome.optionId
        : "cancelled";
      assistantText += ` permission-${suffix}`;
      await context.client.notify(acp.methods.client.session.update, {
        sessionId: context.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: ` permission-${suffix}` },
        },
      });
    }
    if (promptText.includes("wait for cancel")) {
      await new Promise((resolve) => {
        cancelPrompt = resolve;
      });
    }
    appendHistory(context.params.sessionId, [
      {
        type: "message",
        id: `history-user-${historyIndex}`,
        role: "user",
        content: promptText,
      },
      {
        type: "tool",
        id: "tool-1",
        title: "Inspect workspace",
        kind: "read",
      },
      {
        type: "message",
        id: messageId,
        role: "assistant",
        content: assistantText,
      },
    ]);
    return { stopReason: "end_turn" };
  })
  .onNotification(acp.methods.agent.session.cancel, (context) => {
    log("session/cancel", context.params);
    cancelPrompt?.();
    cancelPrompt = undefined;
  })
  .onRequest(acp.methods.agent.session.close, (context) => {
    log("session/close", context.params);
    return {};
  });

app.connect(
  acp.ndJsonStream(
    new WritableStream({
      write(chunk) {
        return new Promise((resolve, reject) => {
          process.stdout.write(Buffer.from(chunk), (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      },
    }),
    new ReadableStream({
      start(controller) {
        process.stdin.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
        process.stdin.on("end", () => controller.close());
        process.stdin.on("error", (error) => controller.error(error));
      },
    }),
  ),
);

process.stdin.resume();
const keepAlive = setInterval(() => {}, 60_000);
process.on("SIGTERM", () => {
  clearInterval(keepAlive);
  process.exit(0);
});
