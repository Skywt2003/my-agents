import { appendFileSync } from "node:fs";

import * as acp from "@agentclientprotocol/sdk";

const logPath = process.env.FAKE_ACP_LOG;
const scenario = process.env.FAKE_ACP_SCENARIO ?? "normal";
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

function configOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "fast", name: "Fast" },
        { value: "accurate", name: "Accurate" },
      ],
    },
  ];
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
  .onRequest(acp.methods.agent.session.new, (context) => {
    log("session/new", context.params);
    const sessionId = `fake-session-${nextSession++}`;
    sessions.set(sessionId, {
      sessionId,
      cwd: context.params.cwd,
      title: "New session",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    return { sessionId, configOptions: configOptions() };
  })
  .onRequest(acp.methods.agent.session.load, (context) => {
    log("session/load", context.params);
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
    return { sessions: Array.from(sessions.values()) };
  })
  .onRequest(acp.methods.agent.session.setConfigOption, (context) => {
    log("session/set_config_option", context.params);
    if (context.params.configId === "model" && typeof context.params.value === "string") {
      currentModel = context.params.value;
    }
    return {
      configOptions: configOptions(),
      currentValues: { model: currentModel },
    };
  })
  .onRequest(acp.methods.agent.session.prompt, async (context) => {
    log("session/prompt", context.params);
    const messageId = `assistant-${nextPrompt++}`;
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
        messageId,
        content: { type: "text", text: "Hello" },
      },
    });
    await context.client.notify(acp.methods.client.session.update, {
      sessionId: context.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
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

    const promptText = context.params.prompt
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
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
