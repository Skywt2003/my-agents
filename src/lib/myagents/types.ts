export type SessionStatus = "connecting" | "ready" | "running" | "error";
export type SessionSource = "myagents" | "agent";
export type AgentId = "codex" | "opencode";

export type AgentDescriptor = {
  id: AgentId;
  name: string;
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
