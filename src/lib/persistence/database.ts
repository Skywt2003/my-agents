import "server-only";

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

import type {
  AgentCapabilities,
  AgentId,
  AgentInput,
  AgentSource,
  ChatMessage,
  ProjectInput,
  SessionSource,
  SessionProject,
  SessionSummary,
  ToolActivity,
} from "@/lib/myagents/types";
import { projectFromWorkingDirectory } from "@/lib/myagents/project";

export type InstalledAgent = {
  id: AgentId;
  registryId?: string;
  name: string;
  iconUrl?: string;
  version?: string;
  description?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  source: AgentSource;
  enabled: boolean;
  capabilities?: AgentCapabilities;
  error?: string;
};

type AgentRow = {
  id: string;
  registry_id: string | null;
  name: string;
  icon_url: string | null;
  version: string | null;
  description: string | null;
  command: string;
  args_json: string;
  env_json: string;
  source: AgentSource;
  enabled: number;
  capabilities_json: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type SessionRow = {
  id: string;
  acp_session_id: string;
  agent_id: AgentId;
  agent_name: string;
  agent_icon_url: string | null;
  agent_capabilities_json: string | null;
  title: string;
  title_mode: "default" | "custom";
  custom_title: string | null;
  cwd: string;
  source: SessionSource;
  agent_visibility: "active" | "archived" | "unknown";
  last_seen_sync: string | null;
  created_at: string;
  updated_at: string;
  project_id: string | null;
  project_name: string | null;
  project_path: string | null;
};

type ProjectRow = {
  id: string;
  name: string;
  path: string;
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

function createAgentsTable(db: Database.Database, table = "agents") {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      registry_id TEXT,
      name TEXT NOT NULL,
      icon_url TEXT,
      version TEXT,
      description TEXT,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL CHECK (source IN ('system', 'registry')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      capabilities_json TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function migrateAgentsToSystemSources(db: Database.Database) {
  const table = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agents'")
    .get() as { sql: string } | undefined;
  if (!table) {
    createAgentsTable(db);
    return;
  }

  const columns = db.pragma("table_info(agents)") as Array<{ name: string }>;
  const hasAuthMethods = columns.some(({ name }) => name === "auth_methods_json");
  if (
    !table.sql.includes("'bundled'") &&
    !table.sql.includes("'custom'") &&
    !hasAuthMethods
  ) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec("DROP TABLE IF EXISTS agents_system_sources");
      createAgentsTable(db, "agents_system_sources");
      db.exec(`
        INSERT INTO agents_system_sources (
          id, registry_id, name, version, description, command, args_json,
          env_json, source, enabled, capabilities_json, last_error,
          created_at, updated_at
        )
        SELECT
          id, registry_id, name, version, description, command, args_json,
          env_json,
          CASE WHEN source IN ('bundled', 'custom') THEN 'system' ELSE source END,
          enabled, capabilities_json, last_error, created_at, updated_at
        FROM agents;
        DROP TABLE agents;
        ALTER TABLE agents_system_sources RENAME TO agents;
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function addAgentIconColumn(db: Database.Database) {
  const columns = db.pragma("table_info(agents)") as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "icon_url")) {
    db.exec("ALTER TABLE agents ADD COLUMN icon_url TEXT");
  }
  db.exec(`
    UPDATE agents
    SET icon_url = 'https://cdn.agentclientprotocol.com/registry/v1/latest/'
      || registry_id || '.svg'
    WHERE icon_url IS NULL AND registry_id IS NOT NULL
  `);
}

function createSessionsTable(db: Database.Database, table = "sessions") {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      acp_session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL REFERENCES agents(id),
      title TEXT NOT NULL,
      title_mode TEXT NOT NULL DEFAULT 'default'
        CHECK (title_mode IN ('default', 'custom')),
      custom_title TEXT,
      cwd TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('myagents', 'agent')),
      agent_visibility TEXT NOT NULL DEFAULT 'unknown'
        CHECK (agent_visibility IN ('active', 'archived', 'unknown')),
      last_seen_sync TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (agent_id, acp_session_id)
    )
  `);
}

function createProjectsTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'discovered')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function addProjectSourceColumn(db: Database.Database) {
  const columns = db.pragma("table_info(projects)") as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "source")) {
    db.exec(`
      ALTER TABLE projects ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'discovered'))
    `);
    db.exec(`
      UPDATE projects
      SET source = 'discovered'
      WHERE id LIKE 'git:%' OR id LIKE 'path:%'
    `);
  }
}

function pruneDiscoveredProjects(db: Database.Database) {
  db.exec(`
    DELETE FROM projects
    WHERE source = 'discovered'
      AND NOT EXISTS (
        SELECT 1
        FROM sessions
        WHERE sessions.cwd = projects.path
          AND sessions.agent_visibility <> 'archived'
      )
  `);
}

function migrateSessionProjects(db: Database.Database) {
  const rows = db.prepare("SELECT DISTINCT cwd FROM sessions").all() as Array<{
    cwd: string;
  }>;
  const insert = db.prepare(`
    INSERT INTO projects (id, name, path, source, created_at, updated_at)
    VALUES (?, ?, ?, 'discovered', ?, ?)
    ON CONFLICT(path) DO NOTHING
  `);
  const now = new Date().toISOString();
  for (const { cwd } of rows) {
    const discovered = projectFromWorkingDirectory(cwd);
    const project = { id: `path:${cwd}`, name: discovered.name, path: cwd };
    insert.run(project.id, project.name, project.path, now, now);
  }
}

function projectForSessionWorkingDirectory(cwd: string): SessionProject {
  const discovered = projectFromWorkingDirectory(cwd);
  return { id: `path:${cwd}`, name: discovered.name, path: cwd };
}

function addSessionVisibilityColumns(db: Database.Database) {
  const columns = db.pragma("table_info(sessions)") as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "agent_visibility")) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN agent_visibility TEXT NOT NULL
        DEFAULT 'unknown'
        CHECK (agent_visibility IN ('active', 'archived', 'unknown'))
    `);
  }
  if (!columns.some(({ name }) => name === "last_seen_sync")) {
    db.exec("ALTER TABLE sessions ADD COLUMN last_seen_sync TEXT");
  }
}

function addSessionTitleColumns(db: Database.Database) {
  const columns = db.pragma("table_info(sessions)") as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "title_mode")) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN title_mode TEXT NOT NULL
        DEFAULT 'default'
        CHECK (title_mode IN ('default', 'custom'))
    `);
  }
  if (!columns.some(({ name }) => name === "custom_title")) {
    db.exec("ALTER TABLE sessions ADD COLUMN custom_title TEXT");
  }
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
  createAgentsTable(database);
  migrateAgentsToSystemSources(database);
  addAgentIconColumn(database);

  migrateSessionsToDynamicAgents(database);
  addSessionVisibilityColumns(database);
  addSessionTitleColumns(database);
  createProjectsTable(database);
  addProjectSourceColumn(database);
  migrateSessionProjects(database);
  pruneDiscoveredProjects(database);
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
    iconUrl: row.icon_url ?? undefined,
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
      id, registry_id, name, icon_url, version, description, command, args_json,
      env_json, source, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      registry_id = excluded.registry_id,
      name = excluded.name,
      icon_url = excluded.icon_url,
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
    input.iconUrl ?? null,
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
) {
  getDatabase().prepare(`
    UPDATE agents
    SET capabilities_json = ?, last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(
    JSON.stringify(capabilities),
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
    agentIconUrl: row.agent_icon_url ?? undefined,
    project: row.project_id && row.project_name && row.project_path
      ? { id: row.project_id, name: row.project_name, path: row.project_path }
      : projectForSessionWorkingDirectory(row.cwd),
    title: row.title_mode === "custom" && row.custom_title
      ? row.custom_title
      : row.title,
    agentTitle: row.title,
    titleMode: row.title_mode,
    customTitle: row.custom_title ?? undefined,
    cwd: row.cwd,
    source: row.source,
    status: "ready",
    resumable: Boolean(capabilities?.loadSession || capabilities?.resumeSession),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages,
    activities,
    configOptions: [],
    pendingPermissions: [],
  };
}

const sessionSelect = `
  SELECT
    sessions.*,
    agents.name AS agent_name,
    agents.icon_url AS agent_icon_url,
    agents.capabilities_json AS agent_capabilities_json,
    projects.id AS project_id,
    projects.name AS project_name,
    projects.path AS project_path
  FROM sessions
  JOIN agents ON agents.id = sessions.agent_id
  LEFT JOIN projects ON projects.path = sessions.cwd
`;

export function listProjects() {
  const db = getDatabase();
  pruneDiscoveredProjects(db);
  return (db
    .prepare("SELECT id, name, path FROM projects ORDER BY name COLLATE NOCASE, path")
    .all() as ProjectRow[]) satisfies SessionProject[];
}

export function getProject(id: string) {
  return (getDatabase()
    .prepare("SELECT id, name, path FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined) ?? null;
}

export function createProject(input: ProjectInput) {
  const name = input.name.trim();
  const path = input.path.trim();
  if (!name) throw new Error("Project name is required.");
  if (!path) throw new Error("Project directory is required.");
  const now = new Date().toISOString();
  try {
    const project: SessionProject = { id: crypto.randomUUID(), name, path };
    getDatabase().prepare(`
      INSERT INTO projects (id, name, path, source, created_at, updated_at)
      VALUES (@id, @name, @path, 'manual', @now, @now)
    `).run({ ...project, now });
    return project;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new Error("This directory is already bound to a project.");
    }
    throw error;
  }
}

function ensureProject(project: SessionProject) {
  const now = new Date().toISOString();
  getDatabase().prepare(`
    INSERT INTO projects (id, name, path, source, created_at, updated_at)
    VALUES (?, ?, ?, 'discovered', ?, ?)
    ON CONFLICT(path) DO NOTHING
  `).run(project.id, project.name, project.path, now, now);
}

export function persistSession(session: SessionSummary) {
  ensureProject(session.project);
  getDatabase()
    .prepare(`
      INSERT INTO sessions (
        id, acp_session_id, agent_id, title, title_mode, custom_title, cwd,
        source, agent_visibility, created_at, updated_at
      ) VALUES (
        @id, @acpSessionId, @agentId, @agentTitle, @titleMode, @customTitle,
        @cwd, @source, 'active', @createdAt, @updatedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        acp_session_id = excluded.acp_session_id,
        agent_id = excluded.agent_id,
        title = excluded.title,
        title_mode = excluded.title_mode,
        custom_title = excluded.custom_title,
        cwd = excluded.cwd,
        source = excluded.source,
        agent_visibility = excluded.agent_visibility,
        updated_at = excluded.updated_at
    `)
    .run({ ...session, customTitle: session.customTitle ?? null });
}

export function updatePersistedSessionTitlePreference(
  id: string,
  titleMode: SessionSummary["titleMode"],
  customTitle?: string,
) {
  const result = getDatabase().prepare(`
    UPDATE sessions
    SET title_mode = ?, custom_title = ?, updated_at = ?
    WHERE id = ?
  `).run(
    titleMode,
    titleMode === "custom" ? customTitle ?? null : null,
    new Date().toISOString(),
    id,
  );
  if (result.changes === 0) throw new Error("Session not found.");
}

type DiscoveredSession = {
  agentId: AgentId;
  acpSessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
};

export function reconcileDiscoveredSessions(
  agentId: AgentId,
  sessions: Omit<DiscoveredSession, "agentId">[],
) {
  const db = getDatabase();
  const syncId = crypto.randomUUID();
  const findExisting = db.prepare(
    "SELECT id FROM sessions WHERE agent_id = ? AND acp_session_id = ?",
  );
  const upsert = db.prepare(`
    INSERT INTO sessions (
      id, acp_session_id, agent_id, title, cwd, source, agent_visibility,
      last_seen_sync, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'agent', 'active', ?, ?, ?)
    ON CONFLICT(agent_id, acp_session_id) DO UPDATE SET
      title = excluded.title,
      cwd = excluded.cwd,
      agent_visibility = 'active',
      last_seen_sync = excluded.last_seen_sync,
      updated_at = excluded.updated_at
  `);

  db.transaction(() => {
    for (const session of sessions) {
      ensureProject(projectForSessionWorkingDirectory(session.cwd));
      const existing = findExisting.get(agentId, session.acpSessionId) as
        | { id: string }
        | undefined;
      upsert.run(
        existing?.id ?? crypto.randomUUID(),
        session.acpSessionId,
        agentId,
        session.title,
        session.cwd,
        syncId,
        session.updatedAt,
        session.updatedAt,
      );
    }

    db.prepare(`
      UPDATE sessions
      SET agent_visibility = 'archived'
      WHERE agent_id = ?
        AND (last_seen_sync IS NULL OR last_seen_sync <> ?)
    `).run(agentId, syncId);
    pruneDiscoveredProjects(db);
  })();
}

export function listPersistedSessions() {
  const rows = getDatabase()
    .prepare(`
      ${sessionSelect}
      WHERE sessions.agent_visibility <> 'archived'
      ORDER BY sessions.updated_at DESC
    `)
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
