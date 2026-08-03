import type { SessionSummary } from "@/lib/myagents/types";

export function sessionFixture(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: "session-1",
    acpSessionId: "acp-session-1",
    agentId: "fake-agent",
    agentName: "Fake Agent",
    project: {
      id: "path:/workspace",
      name: "workspace",
      path: "/workspace",
    },
    title: "New session",
    agentTitle: "New session",
    titleMode: "default",
    cwd: "/workspace",
    source: "myagents",
    status: "ready",
    resumable: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messages: [],
    activities: [],
    conversation: [],
    configOptions: [],
    pendingPermissions: [],
    ...overrides,
  };
}
