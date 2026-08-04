import type {
  AgentDescriptor,
  AgentId,
  RegistryAgent,
  SessionConfigOption,
  SessionProject,
  SessionStreamEvent,
  SessionSummary,
  SessionTitleMode,
  TerminalInfo,
  TerminalStreamEvent,
} from "@/lib/myagents/types";
import type { TelemetryApi } from "@/lib/telemetry/types";

export type SessionsSnapshot = {
  sessions: SessionSummary[];
  agents: AgentDescriptor[];
  projects: SessionProject[];
  syncErrors: Partial<Record<AgentId, string>>;
};

export type RegistryAgentView = RegistryAgent & { installed: boolean };

export type AgentTestResult = {
  message: string;
  agents: AgentDescriptor[];
};

export type DesktopApi = {
  transport: "electron" | "browser";
  platform: NodeJS.Platform | "browser";
  telemetry?: TelemetryApi;
  sessions: {
    list(sync?: boolean): Promise<SessionsSnapshot>;
    get(id: string): Promise<SessionSummary>;
    reload(id: string): Promise<SessionSummary>;
    create(projectId: string, agentId: string): Promise<SessionSummary>;
    discard(id: string): Promise<void>;
    prompt(
      id: string,
      message: string,
      onEvent: (event: SessionStreamEvent) => void,
    ): Promise<void>;
    setConfigOption(
      id: string,
      configId: string,
      value: string | boolean,
    ): Promise<SessionSummary>;
    cancel(id: string): Promise<void>;
    resolvePermission(
      id: string,
      permissionId: string,
      optionId?: string,
    ): Promise<void>;
    updateTitle(
      id: string,
      titleMode: SessionTitleMode,
      customTitle?: string,
    ): Promise<SessionSummary>;
  };
  projects: {
    selectDirectory(): Promise<string | null>;
    create(name: string, path: string): Promise<SessionProject>;
  };
  agents: {
    registry(): Promise<RegistryAgentView[]>;
    install(registryId: string): Promise<AgentDescriptor[]>;
    remove(id: string): Promise<AgentDescriptor[]>;
    configureCodex(command: string): Promise<AgentDescriptor[]>;
    test(id: string): Promise<AgentTestResult>;
  };
  terminals: {
    create(cwd: string, cols?: number, rows?: number): Promise<TerminalInfo>;
    close(id: string): Promise<void>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    subscribe(id: string, onEvent: (event: TerminalStreamEvent) => void): () => void;
  };
};

declare global {
  interface Window {
    myagents: DesktopApi;
  }
}

export type SelectSessionConfigOption = Extract<
  SessionConfigOption,
  { type: "select" }
>;
