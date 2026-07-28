export type SessionStatus = "connecting" | "ready" | "running" | "error";
export type SessionSource = "myagents" | "agent";
export type AgentId = string;
export type AgentSource = "bundled" | "system" | "registry" | "custom";

export type AgentCapabilities = {
  loadSession: boolean;
  listSessions: boolean;
  resumeSession: boolean;
  closeSession: boolean;
  promptImage: boolean;
  promptAudio: boolean;
  promptEmbeddedContext: boolean;
};

export type AgentAuthMethod = {
  id: string;
  name: string;
  description?: string;
  type: "agent" | "env_var" | "terminal" | "unknown";
};

export type AgentDescriptor = {
  id: AgentId;
  registryId?: string;
  name: string;
  version?: string;
  description?: string;
  command: string;
  args: string[];
  source: AgentSource;
  enabled: boolean;
  available: boolean;
  capabilities?: AgentCapabilities;
  authMethods: AgentAuthMethod[];
  error?: string;
};

export type AgentInput = {
  id?: string;
  registryId?: string;
  name: string;
  version?: string;
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  source: AgentSource;
  enabled?: boolean;
};

export type RegistryPackageDistribution = {
  package: string;
  args?: string[];
  env?: Record<string, string>;
};

export type RegistryBinaryTarget = {
  archive: string;
  sha256?: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
};

export type RegistryAgent = {
  id: string;
  name: string;
  version: string;
  description: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution: {
    binary?: Partial<Record<string, RegistryBinaryTarget>>;
    npx?: RegistryPackageDistribution;
    uvx?: RegistryPackageDistribution;
  };
};

export type SessionProject = {
  id: string;
  name: string;
  path: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

export type ToolActivity = {
  id: string;
  title: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed";
};

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: string;
};

export type PermissionRequest = {
  id: string;
  toolCallId: string;
  title: string;
  options: PermissionOption[];
};

export type SessionSummary = {
  id: string;
  acpSessionId: string;
  agentId: AgentId;
  agentName: string;
  project: SessionProject;
  title: string;
  cwd: string;
  source: SessionSource;
  status: SessionStatus;
  resumable: boolean;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
  activities: ToolActivity[];
  pendingPermissions: PermissionRequest[];
  error?: string;
};

export type SessionStreamEvent =
  | { type: "assistant_delta"; messageId: string; text: string }
  | { type: "thought_delta"; text: string }
  | { type: "tool"; activity: ToolActivity }
  | { type: "plan"; entries: Array<{ content: string; status: string }> }
  | { type: "permission"; permission: PermissionRequest }
  | { type: "permission_resolved"; permissionId: string }
  | { type: "status"; status: SessionStatus }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };
