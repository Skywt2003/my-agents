import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { accessSync, constants } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

import type {
  AgentDescriptor,
  AgentCapabilities,
  AgentInput,
  RegistryAgent,
} from "@/lib/myagents/types";
import {
  dataDirectory,
  deleteAgentInstallation,
  getAgentInstallation,
  listAgentInstallations,
  updateAgentHandshake,
  updateAgentEnvironment,
  upsertAgentInstallation,
  type InstalledAgent,
} from "@/lib/persistence/database";

const REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_CACHE_MS = 5 * 60 * 1000;

let registryCache: {
  source: string;
  expiresAt: number;
  agents: RegistryAgent[];
} | null = null;

function registryIconUrl(registryId: string) {
  return `https://cdn.agentclientprotocol.com/registry/v1/latest/${registryId}.svg`;
}

function codexAdapterPath() {
  return (
    process.env.MYAGENTS_ACP_PATH ??
    join(
      process.env.MYAGENTS_APP_ROOT ?? process.cwd(),
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
      "dist",
      "index.js",
    )
  );
}

function findCommand(command: string) {
  if (isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    const path = resolve(/*turbopackIgnore: true*/ command);
    try {
      accessSync(/*turbopackIgnore: true*/ path, constants.X_OK);
      return path;
    } catch {
      return null;
    }
  }

  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const path = join(
        /*turbopackIgnore: true*/ directory,
        `${command}${extension}`,
      );
      try {
        accessSync(/*turbopackIgnore: true*/ path, constants.X_OK);
        return path;
      } catch {
        // Keep searching the configured PATH.
      }
    }
  }
  return null;
}

function shouldReplaceLegacyPlaceholder(agent: InstalledAgent | null) {
  return Boolean(
    agent &&
      agent.source === "system" &&
      !agent.registryId &&
      agent.command === agent.id &&
      agent.args.length === 0,
  );
}

function shouldRefreshSystemCodex(agent: InstalledAgent | null) {
  if (!agent || agent.id !== "codex" || agent.registryId !== "codex-acp") {
    return false;
  }
  const configuredCodex = process.env.MYAGENTS_CODEX_PATH?.trim();
  return agent.source === "system" && (
    configuredCodex
      ? agent.env.CODEX_PATH !== configuredCodex
      : !agent.env.CODEX_PATH
  );
}

function seedAgent(input: AgentInput & { id: string }) {
  const existing = getAgentInstallation(input.id);
  if (existing && !existing.enabled) return;
  const replaceLaunch =
    !existing ||
    shouldReplaceLegacyPlaceholder(existing) ||
    shouldRefreshSystemCodex(existing);
  if (replaceLaunch) {
    upsertAgentInstallation(input);
  } else if (!existing.iconUrl && input.iconUrl) {
    upsertAgentInstallation({
      ...input,
      command: existing.command,
      args: existing.args,
      env: existing.env,
      source: existing.source,
      enabled: existing.enabled,
    });
  }
}

export function ensureDefaultAgentInstallations() {
  const testAgentPath = process.env.MYAGENTS_TEST_AGENT_PATH;
  if (testAgentPath) {
    seedAgent({
      id: "fake-agent",
      name: "Fake Agent",
      description: "Deterministic ACP agent used by automated tests",
      command: process.execPath,
      args: [testAgentPath],
      source: "system",
    });
  }

  if (process.env.MYAGENTS_DISABLE_DEFAULT_AGENTS === "1") return;

  seedAgent({
    id: "codex",
    registryId: "codex-acp",
    name: "Codex",
    iconUrl: registryIconUrl("codex-acp"),
    version: "1.1.7",
    description: "ACP adapter for OpenAI Codex",
    command: process.execPath,
    args: [codexAdapterPath()],
    env: { CODEX_PATH: process.env.MYAGENTS_CODEX_PATH ?? "codex" },
    source: "system",
  });

  seedAgent({
    id: "opencode",
    registryId: "opencode",
    name: "OpenCode",
    iconUrl: registryIconUrl("opencode"),
    description: "OpenCode ACP server",
    command: process.env.MYAGENTS_OPENCODE_PATH ?? "opencode",
    args: ["acp"],
    source: "system",
  });

  if (findCommand(process.env.MYAGENTS_GROK_PATH ?? "grok")) {
    seedAgent({
      id: "grok-build",
      registryId: "grok-build",
      name: "Grok Build",
      iconUrl: registryIconUrl("grok-build"),
      description: "xAI Grok Build ACP agent",
      command: process.env.MYAGENTS_GROK_PATH ?? "grok",
      args: ["agent", "stdio"],
      source: "system",
    });
  }
}

export function listInstalledAgents(): AgentDescriptor[] {
  ensureDefaultAgentInstallations();
  return listAgentInstallations().filter(({ enabled }) => enabled).map((agent) => {
    const usesCodexAdapter =
      agent.id === "codex" && agent.registryId === "codex-acp";
    return {
      id: agent.id,
      registryId: agent.registryId,
      name: agent.name,
      iconUrl: agent.iconUrl,
      version: agent.version,
      description: agent.description,
      command: agent.command,
      args: agent.args,
      displayCommand: usesCodexAdapter
        ? (agent.env.CODEX_PATH ?? "codex")
        : [agent.command, ...agent.args].join(" "),
      adapter: usesCodexAdapter ? "codex-acp" : undefined,
      source: agent.source,
      enabled: agent.enabled,
      available: Boolean(
        findCommand(agent.command) &&
        (!usesCodexAdapter || findCommand(agent.env.CODEX_PATH ?? "codex")),
      ),
      capabilities: agent.capabilities,
      error: agent.error,
    };
  });
}

export function configureCodexCommand(commandInput: string) {
  const command = commandInput.trim();
  if (!command) throw new Error("Codex command is required.");
  const executable = findCommand(command);
  if (!executable) {
    throw new Error(`Codex executable was not found: ${command}`);
  }

  ensureDefaultAgentInstallations();
  const agent = getAgentInstallation("codex");
  if (!agent || agent.registryId !== "codex-acp") {
    throw new Error("The Codex ACP adapter is not installed.");
  }
  updateAgentEnvironment(agent.id, {
    ...agent.env,
    CODEX_PATH: executable,
  });
  return listInstalledAgents();
}

export function requireInstalledAgent(id: string) {
  ensureDefaultAgentInstallations();
  const agent = getAgentInstallation(id);
  if (!agent || !agent.enabled) throw new Error(`Unknown or disabled ACP agent: ${id}`);
  if (!findCommand(agent.command)) {
    throw new Error(`${agent.name} executable was not found: ${agent.command}`);
  }
  return agent;
}

function validateAgentId(id: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error("Agent ID must use lowercase letters, numbers, and hyphens.");
  }
}

export async function removeAgent(id: string) {
  validateAgentId(id);
  const agent = getAgentInstallation(id);
  if (!agent || !agent.enabled) {
    throw new Error("This Agent is not currently added.");
  }
  deleteAgentInstallation(id);
  if (agent.source === "registry") {
    await rm(join(/*turbopackIgnore: true*/ dataDirectory(), "agents", id), {
      recursive: true,
      force: true,
    });
  }
}

function isRegistryAgent(value: unknown): value is RegistryAgent {
  if (!value || typeof value !== "object") return false;
  const agent = value as Partial<RegistryAgent>;
  return Boolean(
    agent.id &&
      agent.name &&
      agent.version &&
      agent.description &&
      agent.distribution &&
      typeof agent.distribution === "object",
  );
}

export async function fetchAgentRegistry() {
  const localPath = process.env.MYAGENTS_REGISTRY_PATH;
  const source = localPath ? resolve(localPath) : REGISTRY_URL;
  if (
    registryCache &&
    registryCache.source === source &&
    registryCache.expiresAt > Date.now()
  ) {
    return registryCache.agents;
  }
  const payload = localPath
    ? JSON.parse(
        await readFile(/*turbopackIgnore: true*/ source, "utf8"),
      ) as { agents?: unknown[] }
    : await (async () => {
        const response = await fetch(REGISTRY_URL, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`ACP Registry returned HTTP ${response.status}.`);
        }
        return response.json() as Promise<{ agents?: unknown[] }>;
      })();
  const agents = (payload.agents ?? []).filter(isRegistryAgent);
  registryCache = {
    source,
    agents,
    expiresAt: Date.now() + REGISTRY_CACHE_MS,
  };
  return agents;
}

function platformTarget() {
  const os = process.platform === "darwin"
    ? "darwin"
    : process.platform === "win32"
      ? "windows"
      : process.platform === "linux"
        ? "linux"
        : null;
  const architecture = process.arch === "arm64"
    ? "aarch64"
    : process.arch === "x64"
      ? "x86_64"
      : null;
  return os && architecture ? `${os}-${architecture}` : null;
}

function packageNameFromSpec(spec: string) {
  const pythonVersion = spec.search(/[<>=!~]/);
  if (pythonVersion > 0) return spec.slice(0, pythonVersion);
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", 1);
    return separator > 0 ? spec.slice(0, separator) : spec;
  }
  const separator = spec.lastIndexOf("@");
  return separator > 0 ? spec.slice(0, separator) : spec;
}

type AgentLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

function executableNameFromPackage(spec: string) {
  return packageNameFromSpec(spec).split("/").at(-1) ?? spec;
}

function executableCandidates(agent: RegistryAgent) {
  const packageDistribution = agent.distribution.npx ?? agent.distribution.uvx;
  const platform = platformTarget();
  const binaryDistribution = platform
    ? agent.distribution.binary?.[platform]
    : undefined;
  const declared = packageDistribution
    ? executableNameFromPackage(packageDistribution.package)
    : binaryDistribution
      ? basename(binaryDistribution.cmd)
      : null;
  if (!declared) return [];
  const simplified = declared.replace(/-(?:cli|acp|agent)$/, "");
  return Array.from(new Set([
    ...(binaryDistribution ? [declared, agent.id] : [agent.id, declared]),
    simplified,
  ].filter(Boolean)));
}

function resolveInstalledLaunch(agent: RegistryAgent): AgentLaunch {
  const packageDistribution = agent.distribution.npx ?? agent.distribution.uvx;
  const platform = platformTarget();
  const binaryDistribution = platform
    ? agent.distribution.binary?.[platform]
    : undefined;
  const candidates = executableCandidates(agent);
  if (candidates.length === 0) {
    throw new Error(`${agent.name} has no launch command for this platform.`);
  }

  const command = candidates.map(findCommand).find(Boolean);
  if (!command) {
    throw new Error(
      `${agent.name} is not installed. Expected executable: ${candidates.join(" or ")}`,
    );
  }
  const distribution = packageDistribution ?? binaryDistribution!;
  return {
    command,
    args: distribution.args ?? [],
    env: distribution.env ?? {},
  };
}

function capabilitiesFromInitialize(
  initialize: acp.InitializeResponse,
): AgentCapabilities {
  const capabilities = initialize.agentCapabilities;
  return {
    loadSession: Boolean(capabilities?.loadSession),
    listSessions: Boolean(capabilities?.sessionCapabilities?.list),
    resumeSession: Boolean(capabilities?.sessionCapabilities?.resume),
    closeSession: Boolean(capabilities?.sessionCapabilities?.close),
    promptImage: Boolean(capabilities?.promptCapabilities?.image),
    promptAudio: Boolean(capabilities?.promptCapabilities?.audio),
    promptEmbeddedContext: Boolean(
      capabilities?.promptCapabilities?.embeddedContext,
    ),
  };
}

async function stopProbe(
  child: ChildProcessWithoutNullStreams,
  connection: acp.ClientConnection,
) {
  connection.close();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 1_000)),
  ]);
}

async function verifyAgentLaunch(
  agent: RegistryAgent,
  launch: AgentLaunch,
): Promise<AgentCapabilities> {
  const child = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...(launch.command === process.execPath
        ? { ELECTRON_RUN_AS_NODE: "1" }
        : {}),
      ...launch.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-4_096);
  });

  const app = acp.client({ name: "MyAgents" });
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = app.connect(stream);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const initialize = await Promise.race([
      connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "MyAgents", version: "0.1.0" },
      }),
      new Promise<never>((_resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => reject(new Error(
          `${agent.name} exited before ACP initialization (${signal ?? code ?? "unknown"}).`,
        )));
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${agent.name} ACP initialization timed out.`)),
          20_000,
        );
      }),
    ]);
    if (initialize.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(
        `${agent.name} negotiated unsupported ACP protocol version ${initialize.protocolVersion}.`,
      );
    }
    return capabilitiesFromInitialize(initialize);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail = stderr.trim();
    throw new Error(
      detail ? `${agent.name} could not start: ${message} (${detail})` :
        `${agent.name} could not start: ${message}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    await stopProbe(child, connection);
  }
}

export async function installRegistryAgent(registryId: string) {
  validateAgentId(registryId);
  const registry = await fetchAgentRegistry();
  const agent = registry.find(({ id }) => id === registryId);
  if (!agent) throw new Error("Agent was not found in the ACP Registry.");

  const existing = listAgentInstallations().find(
    ({ enabled, registryId: installedRegistryId }) =>
      enabled && installedRegistryId === registryId,
  );
  if (existing) return existing;

  const launch = resolveInstalledLaunch(agent);
  const capabilities = await verifyAgentLaunch(agent, launch);

  const installed = upsertAgentInstallation({
    id: agent.id,
    registryId: agent.id,
    name: agent.name,
    iconUrl: agent.icon,
    version: agent.version,
    description: agent.description,
    command: launch.command,
    args: launch.args,
    env: launch.env,
    source: "registry",
  });
  updateAgentHandshake(installed.id, capabilities);
  return getAgentInstallation(installed.id)!;
}
