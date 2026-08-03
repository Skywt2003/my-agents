import { contextBridge, ipcRenderer } from "electron";

import type { DesktopApi } from "@/lib/myagents/desktop-api";
import type {
  SessionStreamEvent,
  TerminalStreamEvent,
} from "@/lib/myagents/types";

let subscriptionSequence = 0;

function nextSubscriptionId(prefix: string) {
  subscriptionSequence += 1;
  return `${prefix}-${Date.now()}-${subscriptionSequence}`;
}

const api: DesktopApi = {
  transport: "electron",
  sessions: {
    list: (sync = false) => ipcRenderer.invoke("sessions:list", sync),
    get: (id) => ipcRenderer.invoke("sessions:get", id),
    reload: (id) => ipcRenderer.invoke("sessions:reload", id),
    create: (projectId, agentId) =>
      ipcRenderer.invoke("sessions:create", { projectId, agentId }),
    discard: (id) => ipcRenderer.invoke("sessions:discard", id),
    prompt: (id, message, onEvent) => {
      const subscriptionId = nextSubscriptionId("session");
      const channel = `sessions:event:${subscriptionId}`;
      const listener = (_event: Electron.IpcRendererEvent, value: SessionStreamEvent) =>
        onEvent(value);
      ipcRenderer.on(channel, listener);
      return ipcRenderer
        .invoke("sessions:prompt", { id, message, subscriptionId })
        .finally(() => ipcRenderer.removeListener(channel, listener));
    },
    setConfigOption: (id, configId, value) =>
      ipcRenderer.invoke("sessions:set-config-option", { id, configId, value }),
    cancel: (id) => ipcRenderer.invoke("sessions:cancel", id),
    resolvePermission: (id, permissionId, optionId) =>
      ipcRenderer.invoke("sessions:resolve-permission", {
        id,
        permissionId,
        optionId,
      }),
    updateTitle: (id, titleMode, customTitle) =>
      ipcRenderer.invoke("sessions:update-title", { id, titleMode, customTitle }),
  },
  projects: {
    create: (name, path) => ipcRenderer.invoke("projects:create", { name, path }),
  },
  agents: {
    registry: () => ipcRenderer.invoke("agents:registry"),
    install: (registryId) => ipcRenderer.invoke("agents:install", registryId),
    remove: (id) => ipcRenderer.invoke("agents:remove", id),
  },
  terminals: {
    create: (cwd, cols, rows) =>
      ipcRenderer.invoke("terminals:create", { cwd, cols, rows }),
    close: (id) => ipcRenderer.invoke("terminals:close", id),
    write: (id, data) => ipcRenderer.invoke("terminals:write", { id, data }),
    resize: (id, cols, rows) =>
      ipcRenderer.invoke("terminals:resize", { id, cols, rows }),
    subscribe: (id, onEvent) => {
      const subscriptionId = nextSubscriptionId("terminal");
      const channel = `terminals:event:${subscriptionId}`;
      const listener = (_event: Electron.IpcRendererEvent, value: TerminalStreamEvent) =>
        onEvent(value);
      ipcRenderer.on(channel, listener);
      void ipcRenderer.invoke("terminals:subscribe", { id, subscriptionId }).catch(() => {
        ipcRenderer.removeListener(channel, listener);
      });
      return () => {
        ipcRenderer.removeListener(channel, listener);
        void ipcRenderer.invoke("terminals:unsubscribe", subscriptionId);
      };
    },
  },
};

contextBridge.exposeInMainWorld("myagents", api);
