import "server-only";

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { spawn, type IPty } from "node-pty";

import type {
  TerminalInfo,
  TerminalStreamEvent,
} from "@/lib/myagents/types";

type TerminalListener = (event: TerminalStreamEvent) => void;

type TerminalRuntime = TerminalInfo & {
  process: IPty;
  history: string;
  listeners: Set<TerminalListener>;
};

type TerminalStore = {
  version: 1;
  terminals: Map<string, TerminalRuntime>;
};

declare global {
  var __myAgentsTerminalStore: TerminalStore | undefined;
}

const MAX_HISTORY_LENGTH = 1_000_000;
const store =
  globalThis.__myAgentsTerminalStore?.version === 1
    ? globalThis.__myAgentsTerminalStore
    : (globalThis.__myAgentsTerminalStore = {
        version: 1,
        terminals: new Map(),
      });

function terminalInfo(runtime: TerminalRuntime): TerminalInfo {
  return {
    id: runtime.id,
    title: runtime.title,
    cwd: runtime.cwd,
    status: runtime.status,
    exitCode: runtime.exitCode,
  };
}

function requireTerminal(id: string) {
  const runtime = store.terminals.get(id);
  if (!runtime) throw new Error("Terminal not found.");
  return runtime;
}

function publish(runtime: TerminalRuntime, event: TerminalStreamEvent) {
  for (const listener of runtime.listeners) listener(event);
}

async function validateWorkingDirectory(cwd: string) {
  if (!cwd || !cwd.startsWith("/")) {
    throw new Error("Working directory must be an absolute path.");
  }
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error("Working directory does not exist.");
}

function defaultShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "powershell.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
}

export async function createTerminal(
  cwd: string,
  cols = 80,
  rows = 24,
): Promise<TerminalInfo> {
  await validateWorkingDirectory(cwd);
  const shell = defaultShell();
  const id = randomUUID();
  const child = spawn(shell, [], {
    name: "xterm-256color",
    cols: Math.max(2, Math.floor(cols)),
    rows: Math.max(1, Math.floor(rows)),
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  });
  const runtime: TerminalRuntime = {
    id,
    title: basename(shell),
    cwd,
    status: "running",
    process: child,
    history: "",
    listeners: new Set(),
  };
  store.terminals.set(id, runtime);

  child.onData((data) => {
    runtime.history = `${runtime.history}${data}`.slice(-MAX_HISTORY_LENGTH);
    publish(runtime, { type: "output", data });
  });
  child.onExit(({ exitCode }) => {
    runtime.status = "exited";
    runtime.exitCode = exitCode;
    publish(runtime, { type: "exit", exitCode });
  });

  return terminalInfo(runtime);
}

export function writeTerminal(id: string, data: string) {
  const runtime = requireTerminal(id);
  if (runtime.status !== "running") throw new Error("Terminal has exited.");
  runtime.process.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number) {
  const runtime = requireTerminal(id);
  if (runtime.status !== "running") return;
  runtime.process.resize(
    Math.max(2, Math.floor(cols)),
    Math.max(1, Math.floor(rows)),
  );
}

export function closeTerminal(id: string) {
  const runtime = requireTerminal(id);
  if (runtime.status === "running") runtime.process.kill();
  store.terminals.delete(id);
}

export function subscribeTerminal(id: string, listener: TerminalListener) {
  const runtime = requireTerminal(id);
  const history = runtime.history;
  runtime.listeners.add(listener);
  return {
    history,
    info: terminalInfo(runtime),
    unsubscribe: () => runtime.listeners.delete(listener),
  };
}
