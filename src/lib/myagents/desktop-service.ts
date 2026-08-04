import {
  configureCodexCommand,
  fetchAgentRegistry,
  installRegistryAgent,
  listInstalledAgents,
  removeAgent,
} from "@/lib/acp/agents";
import {
  cancelSession,
  closeSession,
  createSession,
  getSession,
  listSessions,
  promptSession,
  reloadSession,
  resolvePermission,
  setSessionConfigOption,
  shutdownAgentRuntime,
  shutdownRuntime,
  testAgentSession,
  updateSessionTitlePreference,
  validateWorkingDirectory,
} from "@/lib/acp/runtime";
import type {
  RegistryAgentView,
  SessionsSnapshot,
} from "@/lib/myagents/desktop-api";
import type {
  SessionStreamEvent,
  SessionTitleMode,
  TerminalStreamEvent,
} from "@/lib/myagents/types";
import {
  closeDatabase,
  createProject,
  dataDirectory,
  getProject,
  listProjects,
} from "@/lib/persistence/database";
import {
  closeTerminal,
  createTerminal,
  resizeTerminal,
  shutdownTerminals,
  subscribeTerminal,
  writeTerminal,
} from "@/lib/terminal/runtime";

export function createDesktopService() {
  return {
    sessions: {
      async list(sync = false): Promise<SessionsSnapshot> {
        return {
          ...(await listSessions(sync)),
          projects: listProjects(),
        };
      },
      get: getSession,
      reload: reloadSession,
      async create(projectId: string, agentId: string) {
        const project = getProject(projectId);
        if (!project) {
          throw new Error("Choose a project before starting a session.");
        }
        return createSession(project, agentId || "codex", { persist: false });
      },
      discard: closeSession,
      async prompt(
        id: string,
        messageInput: string,
        onEvent: (event: SessionStreamEvent) => void,
      ) {
        const message = messageInput.trim();
        if (!message) throw new Error("Message is required.");
        await promptSession(id, message, onEvent);
      },
      setConfigOption: setSessionConfigOption,
      cancel: cancelSession,
      async resolvePermission(
        id: string,
        permissionId: string,
        optionId?: string,
      ) {
        resolvePermission(id, permissionId, optionId);
      },
      async updateTitle(
        id: string,
        titleMode: SessionTitleMode,
        customTitle?: string,
      ) {
        return updateSessionTitlePreference(id, titleMode, customTitle);
      },
    },
    projects: {
      async create(name: string, pathInput: string) {
        const path = pathInput.trim();
        await validateWorkingDirectory(path);
        return createProject({ name, path });
      },
    },
    agents: {
      async registry() {
        const [registry, installed] = await Promise.all([
          fetchAgentRegistry(),
          Promise.resolve(listInstalledAgents()),
        ]);
        const installedRegistryIds = new Set(
          installed.flatMap(({ registryId }) =>
            registryId ? [registryId] : [],
          ),
        );
        return registry.map((agent): RegistryAgentView => ({
          ...agent,
          installed: installedRegistryIds.has(agent.id),
        }));
      },
      async install(registryId: string) {
        await installRegistryAgent(registryId);
        return listInstalledAgents();
      },
      async remove(id: string) {
        shutdownAgentRuntime(id);
        await removeAgent(id);
        return listInstalledAgents();
      },
      async configureCodex(command: string) {
        return configureCodexCommand(command);
      },
      async test(id: string) {
        const message = await testAgentSession(id, dataDirectory());
        return { message, agents: listInstalledAgents() };
      },
    },
    terminals: {
      create: (cwd: string, cols?: number, rows?: number) =>
        createTerminal(cwd.trim(), cols, rows),
      async close(id: string) {
        closeTerminal(id);
      },
      async write(id: string, data: string) {
        writeTerminal(id, data);
      },
      async resize(id: string, cols: number, rows: number) {
        resizeTerminal(id, cols, rows);
      },
      subscribe(
        id: string,
        onEvent: (event: TerminalStreamEvent) => void,
      ) {
        const subscription = subscribeTerminal(id, onEvent);
        if (subscription.history) {
          onEvent({ type: "output", data: subscription.history });
        }
        if (subscription.info.status === "exited") {
          onEvent({
            type: "exit",
            exitCode: subscription.info.exitCode ?? 0,
          });
        }
        return subscription.unsubscribe;
      },
    },
    shutdown() {
      shutdownTerminals();
      shutdownRuntime();
      closeDatabase();
    },
  };
}

export type DesktopService = ReturnType<typeof createDesktopService>;
