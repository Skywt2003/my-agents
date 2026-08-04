import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { ipcMain } from "electron";

import { createDesktopService } from "@/lib/myagents/desktop-service";
import type {
  SessionStreamEvent,
  TerminalStreamEvent,
} from "@/lib/myagents/types";

type Cleanup = () => void;

export function registerIpc(mainWindow: BrowserWindow) {
  const service = createDesktopService();
  const terminalSubscriptions = new Map<string, Cleanup>();

  function assertSender(event: IpcMainInvokeEvent) {
    if (event.sender !== mainWindow.webContents) {
      throw new Error("IPC request came from an untrusted renderer.");
    }
  }

  function handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown,
  ) {
    ipcMain.handle(channel, (event, ...args) => {
      assertSender(event);
      return listener(event, ...args as never[]);
    });
  }

  handle("sessions:list", (_event, sync = false) =>
    service.sessions.list(Boolean(sync)),
  );
  handle("sessions:get", (_event, id: string) => service.sessions.get(id));
  handle("sessions:reload", (_event, id: string) => service.sessions.reload(id));
  handle(
    "sessions:create",
    (_event, input: { projectId: string; agentId: string }) =>
      service.sessions.create(input.projectId, input.agentId),
  );
  handle("sessions:discard", (_event, id: string) =>
    service.sessions.discard(id),
  );
  handle(
    "sessions:prompt",
    (
      event,
      input: { id: string; message: string; subscriptionId: string },
    ) => service.sessions.prompt(input.id, input.message, (value: SessionStreamEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(`sessions:event:${input.subscriptionId}`, value);
      }
    }),
  );
  handle(
    "sessions:set-config-option",
    (_event, input: { id: string; configId: string; value: string | boolean }) =>
      service.sessions.setConfigOption(input.id, input.configId, input.value),
  );
  handle("sessions:cancel", (_event, id: string) =>
    service.sessions.cancel(id),
  );
  handle(
    "sessions:resolve-permission",
    (_event, input: { id: string; permissionId: string; optionId?: string }) =>
      service.sessions.resolvePermission(
        input.id,
        input.permissionId,
        input.optionId,
      ),
  );
  handle(
    "sessions:update-title",
    (
      _event,
      input: {
        id: string;
        titleMode: "default" | "custom";
        customTitle?: string;
      },
    ) => service.sessions.updateTitle(
      input.id,
      input.titleMode,
      input.customTitle,
    ),
  );

  handle(
    "projects:create",
    (_event, input: { name: string; path: string }) =>
      service.projects.create(input.name, input.path),
  );

  handle("agents:registry", () => service.agents.registry());
  handle("agents:install", (_event, registryId: string) =>
    service.agents.install(registryId),
  );
  handle("agents:remove", (_event, id: string) =>
    service.agents.remove(id),
  );
  handle("agents:configure-codex", (_event, command: string) =>
    service.agents.configureCodex(command),
  );
  handle("agents:test", (_event, id: string) => service.agents.test(id));

  handle(
    "terminals:create",
    (_event, input: { cwd: string; cols?: number; rows?: number }) =>
      service.terminals.create(input.cwd, input.cols, input.rows),
  );
  handle("terminals:close", (_event, id: string) =>
    service.terminals.close(id),
  );
  handle(
    "terminals:write",
    (_event, input: { id: string; data: string }) =>
      service.terminals.write(input.id, input.data),
  );
  handle(
    "terminals:resize",
    (_event, input: { id: string; cols: number; rows: number }) =>
      service.terminals.resize(input.id, input.cols, input.rows),
  );
  handle(
    "terminals:subscribe",
    (event, input: { id: string; subscriptionId: string }) => {
      terminalSubscriptions.get(input.subscriptionId)?.();
      const channel = `terminals:event:${input.subscriptionId}`;
      const unsubscribe = service.terminals.subscribe(
        input.id,
        (value: TerminalStreamEvent) => {
          if (!event.sender.isDestroyed()) event.sender.send(channel, value);
        },
      );
      terminalSubscriptions.set(input.subscriptionId, unsubscribe);
    },
  );
  handle("terminals:unsubscribe", (_event, subscriptionId: string) => {
    terminalSubscriptions.get(subscriptionId)?.();
    terminalSubscriptions.delete(subscriptionId);
  });

  return () => {
    for (const cleanup of terminalSubscriptions.values()) cleanup();
    terminalSubscriptions.clear();
    service.shutdown();
    ipcMain.removeHandler("sessions:list");
    ipcMain.removeHandler("sessions:get");
    ipcMain.removeHandler("sessions:reload");
    ipcMain.removeHandler("sessions:create");
    ipcMain.removeHandler("sessions:discard");
    ipcMain.removeHandler("sessions:prompt");
    ipcMain.removeHandler("sessions:set-config-option");
    ipcMain.removeHandler("sessions:cancel");
    ipcMain.removeHandler("sessions:resolve-permission");
    ipcMain.removeHandler("sessions:update-title");
    ipcMain.removeHandler("projects:create");
    ipcMain.removeHandler("agents:registry");
    ipcMain.removeHandler("agents:install");
    ipcMain.removeHandler("agents:remove");
    ipcMain.removeHandler("agents:configure-codex");
    ipcMain.removeHandler("agents:test");
    ipcMain.removeHandler("terminals:create");
    ipcMain.removeHandler("terminals:close");
    ipcMain.removeHandler("terminals:write");
    ipcMain.removeHandler("terminals:resize");
    ipcMain.removeHandler("terminals:subscribe");
    ipcMain.removeHandler("terminals:unsubscribe");
  };
}
