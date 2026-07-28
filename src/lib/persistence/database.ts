import "server-only";

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import type {
  AgentAuthMethod,
  AgentCapabilities,
  AgentId,
  AgentInput,
  AgentSource,
  ChatMessage,
  SessionSource,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";
import { projectFromWorkingDirectory } from "@/lib/myagents/project";

export type InstalledAgent = {
  id: AgentId;
  registryId?: string;
  name: string;
  version?: string;
  description?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  source: AgentSource;
  enabled: boolean;
  capabilities?: AgentCapabilities;
  authMethods: AgentAuthMethod[];
  error?: string;
};

type AgentRow = {
  id: string;
  registry_id: string | null;
  name: string;
  version: string | null;
  description: string | null;
  command: string;
  args_json: string;
  env_json: string;
  source: AgentSource;
  enabled: number;
  capabilities_json: string | null;
  auth_methods_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  acp_session_id: string;
  agent_id: AgentId;
  agent_name: string;
  agent_capabilities_json: string | null;
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
  return (
    process.env.MYAGENTS_DATA_DIR ??
    join(/*turbopackIgnore: true*/ process.cwd(), ".myagents")
  );
}

export function databasePath() {
  return join(dataDirectory(), "myagents.db");
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function createSessionsTable(db: Database.Database, table = "sessions") {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      acp_session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('myagents', 'agent')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (agent_id, acp_session_id)
    )
  `);
}

function migrateSessionsToDynamicAgents(db: Database.Database) {
  const sessions = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get() as { sql: string } | undefined;

  if (!sessions) {
    createSessionsTable(db);
    return;
  }

  if (!sessions.sql.includes("CHECK (agent_id IN")) return;

  db.prepare(`
    INSERT OR IGNORE INTO agents (
      id, registry_id, name, command, args_json, env_json, source,
      enabled, created_at, updated_at
    )
    SELECT DISTINCT
      agent_id, NULL, agent_id, agent_id, '[]', '{}', 'system',
      1, datetime('now'), datetime('now')
    FROM sessions
  `).run();

  db.pragma("foreign_keys = OFF");
  db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS sessions_dynamic_agents");
    createSessionsTable(db, "sessions_dynamic_agents");
    db.exec(`
      INSERT INTO sessions_dynamic_agents (
        id, acp_session_id, agent_id, title, cwd, source, created_at, updated_at
      )
      SELECT id, acp_session_id, agent_id, title, cwd, source, created_at, updated_at
      FROM sessions;
      DROP TABLE sessions;
      ALTER TABLE sessions_dynamic_agents RENAME TO sessions;
    `);
  })();
  db.pragma("foreign_keys = ON");
}

function getDatabase() {
  if (database) return database;

  mkdirSync(dataDirectory(), { recursive: true });
  database = new Database(databasePath());
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      registry_id TEXT,
      name TEXT NOT NULL,
      version TEXT,
      description TEXT,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL CHECK (source IN ('bundled', 'system', 'registry', 'custom')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      capabilities_json TEXT,
      auth_methods_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  migrateSessionsToDynamicAgents(database);
  database.exec(`
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

    CREATE INDEX IF NOT EXISTS sessions_updated_at_idx
      ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS messages_session_sequence_idx
      ON messages(session_id, sequence);
    CREATE INDEX IF NOT EXISTS activities_session_sequence_idx
      ON activities(session_id, sequence);
    CREATE INDEX IF NOT EXISTS agents_registry_id_idx
      ON agents(registry_id);
  `);

  const foreignKeyErrors = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error("MyAgents database migration failed its foreign-key check.");
  }
  return database;
}

function toInstalledAgent(row: AgentRow): InstalledAgent {
  return {
    id: row.id,
    registryId: row.registry_id ?? undefined,
    name: row.name,
    version: row.version ?? undefined,
    description: row.description ?? undefined,
    command: row.command,
    args: parseJson(row.args_json, []),
    env: parseJson(row.env_json, {}),
    source: row.source,
    enabled: Boolean(row.enabled),
    capabilities: parseJson<AgentCapabilities | undefined>(
      row.capabilities_json,
      undefined,
    ),
    authMethods: parseJson(row.auth_methods_json, []),
    error: row.last_error ?? undefined,
  };
}

export function listAgentInstallations() {
  return (getDatabase()
    .prepare("SELECT * FROM agents ORDER BY name COLLATE NOCASE, id")
    .all() as AgentRow[]).map(toInstalledAgent);
}

export function getAgentInstallation(id: AgentId) {
  const row = getDatabase().prepare("SELECT * FROM agents WHERE id = ?").get(id) as
    | AgentRow
    | undefined;
  return row ? toInstalledAgent(row) : null;
}

export function upsertAgentInstallation(input: AgentInput & { id: string }) {
  const now = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO agents (
      id, registry_id, name, version, description, command, args_json,
      env_json, source, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      registry_id = excluded.registry_id,
      name = excluded.name,
      version = excluded.version,
      description = excluded.description,
      command = excluded.command,
      args_json = excluded.args_json,
      env_json = excluded.env_json,
      source = excluded.source,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    input.id,
    input.registryId ?? null,
    input.name,
    input.version ?? null,
    input.description ?? null,
    input.command,
    JSON.stringify(input.args ?? []),
    JSON.stringify(input.env ?? {}),
    input.source,
    input.enabled === false ? 0 : 1,
    now,
    now,
  );
  return getAgentInstallation(input.id)!;
}

export function updateAgentHandshake(
  id: AgentId,
  capabilities: AgentCapabilities,
  authMethods: AgentAuthMethod[],
) {
  getDatabase().prepare(`
    UPDATE agents
    SET capabilities_json = ?, auth_methods_json = ?, last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(capabilities),
    JSON.stringify(authMethods),
    new Date().toISOString(),
    id,
  );
}

export function updateAgentError(id: AgentId, error?: string) {
  getDatabase().prepare(`
    UPDATE agents SET last_error = ?, updated_at = ? WHERE id = ?
  `).run(error ?? null, new Date().toISOString(), id);
}

export function deleteAgentInstallation(id: AgentId) {
  const session = getDatabase()
    .prepare("SELECT 1 FROM sessions WHERE agent_id = ? LIMIT 1")
    .get(id);
  if (session) throw new Error("This agent still has sessions and cannot be removed.");
  getDatabase().prepare("DELETE FROM agents WHERE id = ?").run(id);
}

function toSummary(
  row: SessionRow,
  messages: ChatMessage[] = [],
  activities: ToolActivity[] = [],
): SessionSummary {
  const capabilities = parseJson<AgentCapabilities | undefined>(
    row.agent_capabilities_json,
    undefined,
  );
  return {
    id: row.id,
    acpSessionId: row.acp_session_id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    project: projectFromWorkingDirectory(row.cwd),
    title: row.title,
    cwd: row.cwd,
    source: row.source,
    status: "ready",
    resumable: Boolean(capabilities?.loadSession || capabilities?.resumeSession),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
    activities,
    pendingPermissions: [],
  };
}

const sessionSelect = `
  SELECT
    sessions.*,
    agents.name AS agent_name,
    agents.capabilities_json AS agent_capabilities_json
  FROM sessions
  JOIN agents ON agents.id = sessions.agent_id
`;

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
    .prepare(`${sessionSelect} ORDER BY sessions.updated_at DESC`)
    .all() as SessionRow[];
  return rows.map((row) => toSummary(row));
}

export function getPersistedSession(id: string) {
  const db = getDatabase();
  const row = db.prepare(`${sessionSelect} WHERE sessions.id = ?`).get(id) as
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
