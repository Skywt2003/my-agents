import "server-only";

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import type {
  AgentId,
  ChatMessage,
  SessionSource,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";
import { projectFromWorkingDirectory } from "@/lib/myagents/project";

type SessionRow = {
  id: string;
  acp_session_id: string;
  agent_id: AgentId;
  title: string;
  cwd: string;
  source: SessionSource;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type ActivityRow = {
  id: string;
  title: string;
  kind: string;
  status: ToolActivity["status"];
};

let database: Database.Database | null = null;

export function dataDirectory() {
  return process.env.MYAGENTS_DATA_DIR ?? join(process.cwd(), ".myagents");
}

export function databasePath() {
  return join(dataDirectory(), "myagents.db");
}

function getDatabase() {
  if (database) return database;

  mkdirSync(dataDirectory(), { recursive: true });
  database = new Database(databasePath());
  database.pragma("journal_mode = WAL");
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      acp_session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL CHECK (agent_id IN ('codex', 'opencode')),
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('myagents', 'agent')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (agent_id, acp_session_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );

    CREATE TABLE IF NOT EXISTS activities (
      id TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );

  `);

  const columns = database.pragma("table_info(sessions)") as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "agent_id")) {
    database.pragma("foreign_keys = OFF");
    database.transaction(() => {
      database!.exec(`
        DROP TABLE IF EXISTS sessions_with_agents;
        CREATE TABLE sessions_with_agents (
          id TEXT PRIMARY KEY,
          acp_session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL CHECK (agent_id IN ('codex', 'opencode')),
          title TEXT NOT NULL,
          cwd TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('myagents', 'agent')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (agent_id, acp_session_id)
        );
        INSERT INTO sessions_with_agents (
          id, acp_session_id, agent_id, title, cwd, source, created_at, updated_at
        )
        SELECT id, acp_session_id, 'codex', title, cwd, source, created_at, updated_at
        FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_with_agents RENAME TO sessions;
      `);
    })();
  }

  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE INDEX IF NOT EXISTS sessions_updated_at_idx
      ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS messages_session_sequence_idx
      ON messages(session_id, sequence);
    CREATE INDEX IF NOT EXISTS activities_session_sequence_idx
      ON activities(session_id, sequence);
  `);

  const foreignKeyErrors = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error("Session database migration failed its foreign-key check.");
  }
  return database;
}

function toSummary(
  row: SessionRow,
  messages: ChatMessage[] = [],
  activities: ToolActivity[] = [],
): SessionSummary {
  return {
    id: row.id,
    acpSessionId: row.acp_session_id,
    agentId: row.agent_id,
    agentName: row.agent_id === "codex" ? "Codex" : "OpenCode",
    project: projectFromWorkingDirectory(row.cwd),
    title: row.title,
    cwd: row.cwd,
    source: row.source,
    status: "ready",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
    activities,
    pendingPermissions: [],
  };
}

export function persistSession(session: SessionSummary) {
  getDatabase()
    .prepare(`
      INSERT INTO sessions (
        id, acp_session_id, agent_id, title, cwd, source, created_at, updated_at
      ) VALUES (
        @id, @acpSessionId, @agentId, @title, @cwd, @source, @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        acp_session_id = excluded.acp_session_id,
        agent_id = excluded.agent_id,
        title = excluded.title,
        cwd = excluded.cwd,
        source = excluded.source,
        updated_at = excluded.updated_at
    `)
    .run(session);
}

export function persistDiscoveredSession(input: {
  agentId: AgentId;
  acpSessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
}) {
  const db = getDatabase();
  const existing = db
    .prepare("SELECT id FROM sessions WHERE agent_id = ? AND acp_session_id = ?")
    .get(input.agentId, input.acpSessionId) as { id: string } | undefined;
  const id = existing?.id ?? crypto.randomUUID();
  const createdAt = input.updatedAt;

  db.prepare(`
    INSERT INTO sessions (
      id, acp_session_id, agent_id, title, cwd, source, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'agent', ?, ?)
    ON CONFLICT(agent_id, acp_session_id) DO UPDATE SET
      title = excluded.title,
      cwd = excluded.cwd,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.acpSessionId,
    input.agentId,
    input.title,
    input.cwd,
    createdAt,
    input.updatedAt,
  );
}

export function listPersistedSessions() {
  const rows = getDatabase()
    .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
    .all() as SessionRow[];
  return rows.map((row) => toSummary(row));
}

export function getPersistedSession(id: string) {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | SessionRow
    | undefined;
  if (!row) return null;

  const messages = db
    .prepare(`
      SELECT id, role, content, created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY sequence
    `)
    .all(id) as MessageRow[];
  const activities = db
    .prepare(`
      SELECT id, title, kind, status
      FROM activities
      WHERE session_id = ?
      ORDER BY sequence
    `)
    .all(id) as ActivityRow[];

  return toSummary(
    row,
    messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.created_at,
    })),
    activities,
  );
}

export function persistMessage(
  sessionId: string,
  message: ChatMessage,
  sequence: number,
) {
  getDatabase()
    .prepare(`
      INSERT INTO messages (
        id, session_id, role, content, created_at, sequence
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET
        role = excluded.role,
        content = excluded.content,
        created_at = excluded.created_at,
        sequence = excluded.sequence
    `)
    .run(
      message.id,
      sessionId,
      message.role,
      message.content,
      message.createdAt,
      sequence,
    );
}

export function persistActivity(
  sessionId: string,
  activity: ToolActivity,
  sequence: number,
) {
  getDatabase()
    .prepare(`
      INSERT INTO activities (
        id, session_id, title, kind, status, sequence
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, id) DO UPDATE SET
        title = excluded.title,
        kind = excluded.kind,
        status = excluded.status,
        sequence = excluded.sequence
    `)
    .run(
      activity.id,
      sessionId,
      activity.title,
      activity.kind,
      activity.status,
      sequence,
    );
}

export function replaceSessionContent(
  sessionId: string,
  messages: ChatMessage[],
  activities: ToolActivity[],
) {
  const db = getDatabase();
  db.transaction(() => {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM activities WHERE session_id = ?").run(sessionId);
    messages.forEach((message, index) => persistMessage(sessionId, message, index));
    activities.forEach((activity, index) =>
      persistActivity(sessionId, activity, index),
    );
  })();
}
