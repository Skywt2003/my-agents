import { describe, expect, it } from "vitest";

import { applySessionEvent } from "@/lib/myagents/session-reducer";
import { sessionFixture } from "../helpers/session";

describe("applySessionEvent", () => {
  it("appends and combines assistant streaming chunks", () => {
    const first = applySessionEvent(sessionFixture(), {
      type: "assistant_delta",
      messageId: "assistant-1",
      text: "Hello",
    });
    const second = applySessionEvent(first, {
      type: "assistant_delta",
      messageId: "assistant-1",
      text: " world",
    });

    expect(second.messages).toMatchObject([
      { id: "assistant-1", role: "assistant", content: "Hello world" },
    ]);
  });

  it("updates an existing tool activity without changing its position", () => {
    const session = sessionFixture({
      activities: [
        { id: "tool-1", title: "Read", kind: "read", status: "in_progress" },
        { id: "tool-2", title: "Search", kind: "search", status: "pending" },
      ],
    });
    const updated = applySessionEvent(session, {
      type: "tool",
      activity: {
        id: "tool-1",
        title: "Read file",
        kind: "read",
        status: "completed",
      },
    });

    expect(updated.activities.map(({ id }) => id)).toEqual(["tool-1", "tool-2"]);
    expect(updated.activities[0]).toMatchObject({
      title: "Read file",
      status: "completed",
    });
  });

  it("adds, replaces, and resolves permission requests", () => {
    const permission = {
      id: "permission-1",
      toolCallId: "tool-1",
      title: "Run command",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    };
    const added = applySessionEvent(sessionFixture(), {
      type: "permission",
      permission,
    });
    const replaced = applySessionEvent(added, {
      type: "permission",
      permission: { ...permission, title: "Run safe command" },
    });
    const resolved = applySessionEvent(replaced, {
      type: "permission_resolved",
      permissionId: permission.id,
    });

    expect(replaced.pendingPermissions).toHaveLength(1);
    expect(replaced.pendingPermissions[0].title).toBe("Run safe command");
    expect(resolved.pendingPermissions).toEqual([]);
  });

  it("applies status, configuration, and error events", () => {
    const running = applySessionEvent(sessionFixture(), {
      type: "status",
      status: "running",
    });
    const configured = applySessionEvent(running, {
      type: "config_options",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "fast",
          options: [{ value: "fast", name: "Fast" }],
        },
      ],
    });
    const failed = applySessionEvent(configured, {
      type: "error",
      message: "Agent exited",
    });

    expect(running.status).toBe("running");
    expect(configured.configOptions[0]).toMatchObject({
      id: "model",
      currentValue: "fast",
    });
    expect(failed).toMatchObject({ status: "error", error: "Agent exited" });
  });

  it("ignores informational events that do not mutate renderer state", () => {
    const session = sessionFixture();
    expect(
      applySessionEvent(session, { type: "thought_delta", text: "Thinking" }),
    ).toBe(session);
    expect(
      applySessionEvent(session, {
        type: "plan",
        entries: [{ content: "Inspect", status: "pending" }],
      }),
    ).toBe(session);
    expect(
      applySessionEvent(session, { type: "done", stopReason: "end_turn" }),
    ).toBe(session);
  });
});
