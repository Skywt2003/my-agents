import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  createProject,
  databasePath,
  getPersistedSession,
  listPersistedSessions,
  listProjects,
  persistActivity,
  persistConversationItem,
  persistMessage,
  persistSession,
  reconcileDiscoveredSessions,
  updatePersistedSessionTitlePreference,
  upsertAgentInstallation,
} from "@/lib/persistence/database";
import { sessionFixture } from "../helpers/session";

let dataDirectory: string;

beforeEach(async () => {
  closeDatabase();
  dataDirectory = await mkdtemp(join(tmpdir(), "myagents-database-test-"));
  process.env.MYAGENTS_DATA_DIR = dataDirectory;
  upsertAgentInstallation({
    id: "fake-agent",
    name: "Fake Agent",
    command: process.execPath,
    source: "system",
  });
});

afterEach(async () => {
  closeDatabase();
  delete process.env.MYAGENTS_DATA_DIR;
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("SQLite persistence", () => {
  it("initializes an idempotent schema with valid foreign keys", () => {
    expect(listPersistedSessions()).toEqual([]);
    closeDatabase();
    expect(listPersistedSessions()).toEqual([]);
    closeDatabase();

    const db = new Database(databasePath(), { readonly: true });
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(
      (db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>).map(({ name }) => name),
    ).toEqual(expect.arrayContaining([
      "agents",
      "projects",
      "sessions",
      "messages",
      "activities",
      "conversation_items",
    ]));
    db.close();
  });

  it("persists and restores a complete session in sequence", () => {
    const session = sessionFixture();
    persistSession(session);
    persistMessage(
      session.id,
      {
        id: "user-1",
        role: "user",
        content: "Hello",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      0,
    );
    persistConversationItem(
      session.id,
      {
        type: "message",
        message: {
          id: "user-1",
          role: "user",
          content: "Hello",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      },
      0,
    );
    persistMessage(
      session.id,
      {
        id: "assistant-1",
        role: "assistant",
        content: "Hi",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      1,
    );
    persistActivity(
      session.id,
      { id: "tool-1", title: "Read", kind: "read", status: "completed" },
      0,
    );
    persistConversationItem(
      session.id,
      {
        type: "tool",
        activity: {
          id: "tool-1",
          title: "Read",
          kind: "read",
          status: "completed",
        },
      },
      1,
    );
    persistConversationItem(
      session.id,
      {
        type: "message",
        message: {
          id: "assistant-1",
          role: "assistant",
          content: "Hi",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
      },
      2,
    );
    closeDatabase();

    const restored = getPersistedSession(session.id);
    expect(restored?.messages.map(({ content }) => content)).toEqual(["Hello", "Hi"]);
    expect(restored?.activities).toEqual([
      { id: "tool-1", title: "Read", kind: "read", status: "completed" },
    ]);
    expect(restored?.conversation.map((item) => item.type)).toEqual([
      "message",
      "tool",
      "message",
    ]);
    expect(restored?.project.path).toBe(session.cwd);
  });

  it("backfills a stable fallback timeline for databases without global order", () => {
    const session = sessionFixture();
    persistSession(session);
    persistMessage(
      session.id,
      {
        id: "message-1",
        role: "assistant",
        content: "Existing message",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      0,
    );
    persistActivity(
      session.id,
      { id: "tool-1", title: "Existing tool", kind: "read", status: "completed" },
      0,
    );
    closeDatabase();

    expect(
      getPersistedSession(session.id)?.conversation.map((item) => item.type),
    ).toEqual(["message", "tool"]);
  });

  it("preserves custom session titles across database restarts", () => {
    persistSession(sessionFixture());
    updatePersistedSessionTitlePreference("session-1", "custom", "Pinned name");
    closeDatabase();

    expect(getPersistedSession("session-1")).toMatchObject({
      title: "Pinned name",
      agentTitle: "New session",
      titleMode: "custom",
      customTitle: "Pinned name",
    });
  });

  it("reconciles duplicate discoveries and archives sessions missing from a later sync", () => {
    const discovered = {
      acpSessionId: "external-1",
      title: "External session",
      cwd: "/external/workspace",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    reconcileDiscoveredSessions("fake-agent", [discovered]);
    reconcileDiscoveredSessions("fake-agent", [
      { ...discovered, title: "Updated external session" },
    ]);

    expect(listPersistedSessions()).toHaveLength(1);
    expect(listPersistedSessions()[0].title).toBe("Updated external session");

    reconcileDiscoveredSessions("fake-agent", []);
    expect(listPersistedSessions()).toEqual([]);
    expect(listProjects()).toEqual([]);
  });

  it("does not prune an empty manually-created project", () => {
    const project = createProject({ name: "Manual project", path: "/manual/project" });
    reconcileDiscoveredSessions("fake-agent", []);

    expect(listProjects()).toEqual([project]);
  });
});
