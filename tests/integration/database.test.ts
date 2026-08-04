import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  createProject,
  databasePath,
  deleteAgentInstallation,
  getAgentInstallation,
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
    expect(
      (db.pragma("table_info(messages)") as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toContain("content_blocks_json");
    db.close();
  });

  it("migrates legacy codex-acp data image links into structured image blocks", () => {
    const session = sessionFixture();
    persistSession(session);
    closeDatabase();

    const legacy = [
      "Before image\n",
      "[@image](data:image/png;base64,aGVsbG8=)",
      "\nAfter image",
    ].join("");
    const db = new Database(databasePath());
    db.prepare(`
      INSERT INTO messages (
        id, session_id, role, content, content_blocks_json, created_at, sequence
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)
    `).run("legacy-user", session.id, "user", legacy, "2026-01-01T00:00:01.000Z", 0);
    db.prepare(`
      INSERT INTO conversation_items (session_id, item_type, item_id, sequence)
      VALUES (?, 'message', ?, 0)
    `).run(session.id, "legacy-user");
    db.close();

    const restored = getPersistedSession(session.id)?.messages[0];
    expect(restored?.content).toBe("Before image\n\nAfter image");
    expect(restored?.content).not.toContain("base64");
    expect(restored?.contentBlocks).toEqual([
      { type: "text", text: "Before image\n" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      { type: "text", text: "\nAfter image" },
    ]);

    closeDatabase();
    const migratedDb = new Database(databasePath(), { readonly: true });
    const migrated = migratedDb.prepare(`
        SELECT content, content_blocks_json
        FROM messages
        WHERE session_id = ? AND id = ?
      `)
      .get(session.id, "legacy-user") as {
        content: string;
        content_blocks_json: string;
      };
    expect(migrated.content).not.toContain("data:image");
    expect(migrated.content_blocks_json).toContain('"type":"image"');
    migratedDb.close();
  });

  it("keeps session history while disabling a removed Agent", () => {
    persistSession(sessionFixture());

    deleteAgentInstallation("fake-agent");

    expect(getAgentInstallation("fake-agent")).toMatchObject({ enabled: false });
    expect(getPersistedSession("session-1")).toMatchObject({
      id: "session-1",
      agentId: "fake-agent",
    });
    const db = new Database(databasePath(), { readonly: true });
    expect(db.pragma("foreign_key_check")).toEqual([]);
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
