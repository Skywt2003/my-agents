import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cancelSession,
  closeSession,
  createSession,
  listSessions,
  promptSession,
  reloadSession,
  resolvePermission,
  setSessionConfigOption,
  shutdownRuntime,
  subscribe,
  testAgentSession,
} from "@/lib/acp/runtime";
import type { SessionStreamEvent } from "@/lib/myagents/types";
import {
  closeDatabase,
  getPersistedSession,
  upsertAgentInstallation,
} from "@/lib/persistence/database";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "fake-acp-agent.mjs",
);
const minimalFixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "minimal-acp-agent.mjs",
);

let root: string;
let workspace: string;
let logPath: string;

async function readLog() {
  const content = await readFile(logPath, "utf8").catch(() => "");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: unknown });
}

async function waitForEvent(
  events: SessionStreamEvent[],
  predicate: (event: SessionStreamEvent) => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for fake ACP event.");
}

async function waitForLogMethod(method: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await readLog()).some((entry) => entry.method === method)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${method}.`);
}

beforeEach(async () => {
  shutdownRuntime();
  closeDatabase();
  root = await mkdtemp(join(tmpdir(), "myagents-runtime-test-"));
  workspace = join(root, "workspace");
  logPath = join(root, "fake-agent.log");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  process.env.MYAGENTS_DATA_DIR = join(root, "data");
  process.env.MYAGENTS_DISABLE_DEFAULT_AGENTS = "1";
  upsertAgentInstallation({
    id: "fake-agent",
    name: "Fake Agent",
    command: process.execPath,
    args: [fixturePath],
    env: { FAKE_ACP_LOG: logPath },
    source: "system",
  });
});

afterEach(async () => {
  shutdownRuntime();
  closeDatabase();
  delete process.env.MYAGENTS_DATA_DIR;
  delete process.env.MYAGENTS_DISABLE_DEFAULT_AGENTS;
  await rm(root, { recursive: true, force: true });
});

describe("ACP runtime with a deterministic stdio agent", () => {
  it("tests real session creation without persisting a MyAgents session", async () => {
    upsertAgentInstallation({
      id: "fake-agent",
      name: "Fake Agent",
      command: process.execPath,
      args: [minimalFixturePath],
      env: { FAKE_ACP_LOG: logPath },
      source: "system",
    });
    await expect(testAgentSession("fake-agent", workspace)).resolves.toContain(
      "created a test session successfully",
    );

    const methods = (await readLog()).map(({ method }) => method);
    expect(methods).toEqual(
      expect.arrayContaining(["initialize", "session/new", "session/close"]),
    );
    expect((await listSessions()).sessions).toHaveLength(0);
  });

  it("creates, streams, persists, configures, and closes a session", async () => {
    const session = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
    );
    expect(session.configOptions[0]).toMatchObject({
      id: "model",
      currentValue: "fast",
    });

    const events: SessionStreamEvent[] = [];
    const unsubscribe = subscribe(session.id, (event) => events.push(event));
    await promptSession(session.id, "hello");

    expect(events.filter(({ type }) => type === "assistant_delta")).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "tool",
          activity: expect.objectContaining({ id: "tool-1", status: "completed" }),
        }),
        { type: "done", stopReason: "end_turn" },
      ]),
    );
    expect(getPersistedSession(session.id)).toMatchObject({
      status: "ready",
      messages: [
        expect.objectContaining({ role: "user", content: "hello" }),
        expect.objectContaining({
          role: "assistant",
          content: "Hello from fake agent",
        }),
      ],
      activities: [expect.objectContaining({ id: "tool-1", status: "completed" })],
    });
    expect(
      getPersistedSession(session.id)?.conversation.map((item) => item.type),
    ).toEqual(["message", "tool", "message"]);

    const configured = await setSessionConfigOption(session.id, "model", "accurate");
    expect(configured.configOptions[0]).toMatchObject({ currentValue: "accurate" });
    unsubscribe();
    await closeSession(session.id);

    const methods = (await readLog()).map(({ method }) => method);
    expect(methods).toEqual(
      expect.arrayContaining([
        "initialize",
        "session/new",
        "session/prompt",
        "session/set_config_option",
        "session/close",
      ]),
    );
  });

  it("combines streamed agent chunks when a legacy agent omits message IDs", async () => {
    upsertAgentInstallation({
      id: "fake-agent",
      name: "Fake Agent",
      command: process.execPath,
      args: [fixturePath],
      env: {
        FAKE_ACP_LOG: logPath,
        FAKE_ACP_SCENARIO: "missing-message-ids",
      },
      source: "system",
    });
    const session = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
    );
    const events: SessionStreamEvent[] = [];
    subscribe(session.id, (event) => events.push(event));

    await promptSession(session.id, "hello");

    const assistantDeltas = events.filter(
      (event) => event.type === "assistant_delta",
    );
    expect(assistantDeltas).toHaveLength(2);
    expect(new Set(assistantDeltas.map((event) => event.messageId)).size).toBe(1);
    expect(getPersistedSession(session.id)?.messages).toMatchObject([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Hello from fake agent" },
    ]);
  });

  it("keeps a prepared session as a draft until its first prompt", async () => {
    const draft = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
      { persist: false },
    );

    expect(getPersistedSession(draft.id)).toBeNull();
    expect((await listSessions()).sessions).not.toContainEqual(
      expect.objectContaining({ id: draft.id }),
    );

    await setSessionConfigOption(draft.id, "model", "accurate");
    expect(getPersistedSession(draft.id)).toBeNull();

    await promptSession(draft.id, "start the session");
    expect(getPersistedSession(draft.id)).toMatchObject({
      id: draft.id,
      title: "start the session",
    });
    expect(
      (await listSessions()).sessions.find(({ id }) => id === draft.id)?.configOptions,
    ).toEqual([expect.objectContaining({ currentValue: "accurate" })]);
  });

  it("normalizes and updates legacy ACP model state", async () => {
    upsertAgentInstallation({
      id: "fake-agent",
      name: "Fake Agent",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_ACP_LOG: logPath, FAKE_ACP_SCENARIO: "legacy-models" },
      source: "system",
    });
    const session = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
      { persist: false },
    );

    expect(session.configOptions).toEqual([
      expect.objectContaining({
        id: "model",
        category: "model",
        currentValue: "fast",
      }),
    ]);

    const configured = await setSessionConfigOption(
      session.id,
      "model",
      "accurate",
    );
    expect(configured.configOptions[0]).toMatchObject({
      currentValue: "accurate",
    });
    const methods = (await readLog()).map(({ method }) => method);
    expect(methods).toContain("session/set_model");
    expect(methods).not.toContain("session/set_config_option");
  });

  it("keeps an unpersisted draft active when the selected-session view reloads", async () => {
    const draft = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
      { persist: false },
    );

    await expect(reloadSession(draft.id)).resolves.toMatchObject({
      id: draft.id,
      status: "ready",
    });
    await expect(promptSession(draft.id, "first message")).resolves.toBeUndefined();
    expect(getPersistedSession(draft.id)).toMatchObject({
      id: draft.id,
      title: "first message",
    });
  });

  it("keeps a healthy idle runtime active when the selected-session view reloads", async () => {
    const session = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
    );

    await expect(reloadSession(session.id)).resolves.toMatchObject({
      id: session.id,
      status: "ready",
    });
    expect((await readLog()).map(({ method }) => method)).not.toContain("session/load");
  });

  it("loads an inactive persisted session and replaces it with ordered agent history", async () => {
    upsertAgentInstallation({
      id: "fake-agent",
      name: "Fake Agent",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_ACP_LOG: logPath, FAKE_ACP_SCENARIO: "load-history" },
      source: "system",
    });
    const session = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
    );
    shutdownRuntime();

    const reloaded = await reloadSession(session.id);

    expect(reloaded.conversation.map((item) => item.type)).toEqual([
      "message",
      "tool",
      "message",
    ]);
    expect(reloaded.activities).toEqual([
      expect.objectContaining({ id: "loaded-tool", status: "completed" }),
    ]);
    expect(getPersistedSession(session.id)?.conversation).toMatchObject([
      { type: "message", message: { content: "Loaded question" } },
      { type: "tool", activity: { id: "loaded-tool" } },
      { type: "message", message: { content: "Loaded answer" } },
    ]);
    expect((await readLog()).map(({ method }) => method)).toContain("session/load");
  });

  it("keeps persisted conversation content visible while session history reloads", async () => {
    upsertAgentInstallation({
      id: "fake-agent",
      name: "Fake Agent",
      command: process.execPath,
      args: [fixturePath],
      env: {
        FAKE_ACP_LOG: logPath,
        FAKE_ACP_SCENARIO: "load-history",
        FAKE_ACP_SESSION_LOAD_DELAY_MS: "200",
      },
      source: "system",
    });
    const session = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
    );
    await promptSession(session.id, "Cached question");
    shutdownRuntime();

    const reload = reloadSession(session.id);
    await waitForLogMethod("session/load");
    const loadingSnapshot = (await listSessions()).sessions.find(
      ({ id }) => id === session.id,
    );

    expect(loadingSnapshot).toMatchObject({ status: "connecting" });
    expect(loadingSnapshot?.conversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ content: "Cached question" }),
        }),
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ content: "Hello from fake agent" }),
        }),
      ]),
    );

    await expect(reload).resolves.toMatchObject({ status: "ready" });
  });

  it("round-trips selected and cancelled permission outcomes", async () => {
    const session = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
    );
    const events: SessionStreamEvent[] = [];
    subscribe(session.id, (event) => events.push(event));

    const allowedPrompt = promptSession(session.id, "request permission");
    const allowed = await waitForEvent(events, (event) => event.type === "permission");
    if (allowed.type !== "permission") throw new Error("Expected permission event.");
    resolvePermission(session.id, allowed.permission.id, "allow");
    await allowedPrompt;
    expect(
      getPersistedSession(session.id)?.messages.find(
        ({ id }) => id === "assistant-1",
      )?.content,
    ).toContain("permission-allow");

    events.length = 0;
    const cancelledPrompt = promptSession(session.id, "request permission again");
    const cancelled = await waitForEvent(events, (event) => event.type === "permission");
    if (cancelled.type !== "permission") throw new Error("Expected permission event.");
    resolvePermission(session.id, cancelled.permission.id);
    await cancelledPrompt;
    expect(
      getPersistedSession(session.id)?.messages.find(
        ({ id }) => id === "assistant-2",
      )?.content,
    ).toContain("permission-cancelled");
  });

  it("notifies cancellation and allows the pending prompt to finish", async () => {
    const session = await createSession(
      { id: "project-1", name: "Workspace", path: workspace },
      "fake-agent",
    );
    const prompt = promptSession(session.id, "wait for cancel");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await cancelSession(session.id);
    await prompt;

    expect((await readLog()).map(({ method }) => method)).toContain("session/cancel");
  }, 10_000);

  it("collects every session/list page before reconciling", async () => {
    upsertAgentInstallation({
      id: "fake-agent",
      name: "Fake Agent",
      command: process.execPath,
      args: [fixturePath],
      env: { FAKE_ACP_LOG: logPath, FAKE_ACP_SCENARIO: "paginated-list" },
      source: "system",
    });

    const result = await listSessions(true);
    expect(result.syncErrors).toEqual({});
    expect(result.sessions.map(({ acpSessionId }) => acpSessionId).sort()).toEqual([
      "listed-1",
      "listed-2",
    ]);
    const listCalls = (await readLog()).filter(({ method }) => method === "session/list");
    expect(listCalls.map(({ params }) => params)).toEqual([{}, { cursor: "page-2" }]);
  });
});
