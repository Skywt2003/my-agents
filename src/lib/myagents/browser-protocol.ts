import type {
  SessionStreamEvent,
  TerminalStreamEvent,
} from "@/lib/myagents/types";

export const BROWSER_RPC_PATH = "/__myagents/ws";
export const BROWSER_HEALTH_PATH = "/__myagents/health";

export type BrowserRpcMethod =
  | "sessions.list"
  | "sessions.get"
  | "sessions.reload"
  | "sessions.create"
  | "sessions.discard"
  | "sessions.prompt"
  | "sessions.setConfigOption"
  | "sessions.cancel"
  | "sessions.resolvePermission"
  | "sessions.updateTitle"
  | "projects.create"
  | "agents.registry"
  | "agents.install"
  | "agents.remove"
  | "agents.configureCodex"
  | "agents.test"
  | "terminals.create"
  | "terminals.close"
  | "terminals.write"
  | "terminals.resize"
  | "terminals.subscribe"
  | "terminals.unsubscribe";

export type BrowserClientMessage =
  | { type: "authenticate"; token: string }
  | {
      type: "request";
      id: string;
      method: BrowserRpcMethod;
      parameters: unknown[];
    };

export type BrowserServerMessage =
  | { type: "authenticated" }
  | { type: "response"; id: string; result?: unknown; error?: string }
  | {
      type: "event";
      subscriptionId: string;
      event: SessionStreamEvent | TerminalStreamEvent;
    }
  | { type: "fatal"; error: string };
