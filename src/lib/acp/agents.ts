import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
} from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import type {
  AgentDescriptor,
  AgentInput,
  RegistryAgent,
  RegistryBinaryTarget,
} from "@/lib/myagents/types";
import {
  dataDirectory,
  deleteAgentInstallation,
  getAgentInstallation,
  listAgentInstallations,
  upsertAgentInstallation,
  type InstalledAgent,
} from "@/lib/persistence/database";

const execFileAsync = promisify(execFile);
const REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_CACHE_MS = 5 * 60 * 1000;
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

let registryCache: { expiresAt: number; agents: RegistryAgent[] } | null = null;

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
  const configuredCodex = process.env.MYAGENTS_CODEX_PATH ?? "codex";
  return agent.source === "system" && agent.env.CODEX_PATH !== configuredCodex;
}

function seedAgent(input: AgentInput & { id: string }) {
  const existing = getAgentInstallation(input.id);
  if (
    !existing ||
    shouldReplaceLegacyPlaceholder(existing) ||
    shouldRefreshSystemCodex(existing) ||
    (!existing.iconUrl && Boolean(input.iconUrl))
  ) {
    upsertAgentInstallation(input);
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
  return listAgentInstallations().map((agent) => ({
    id: agent.id,
    registryId: agent.registryId,
    name: agent.name,
    iconUrl: agent.iconUrl,
    version: agent.version,
    description: agent.description,
    command: agent.command,
    args: agent.args,
    source: agent.source,
    enabled: agent.enabled,
    available: Boolean(findCommand(agent.command)),
    capabilities: agent.capabilities,
    error: agent.error,
  }));
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
  if (!agent || agent.source !== "registry") {
    throw new Error("Only Registry-installed agents can be removed.");
  }
  deleteAgentInstallation(id);
  await rm(join(/*turbopackIgnore: true*/ dataDirectory(), "agents", id), {
    recursive: true,
    force: true,
  });
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
  if (registryCache && registryCache.expiresAt > Date.now()) {
    return registryCache.agents;
  }
  const response = await fetch(REGISTRY_URL, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`ACP Registry returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as { agents?: unknown[] };
  const agents = (payload.agents ?? []).filter(isRegistryAgent);
  registryCache = { agents, expiresAt: Date.now() + REGISTRY_CACHE_MS };
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
  if (spec.startsWith("@")) {
    const separator = spec.indexOf("@", 1);
    return separator > 0 ? spec.slice(0, separator) : spec;
  }
  const separator = spec.lastIndexOf("@");
  return separator > 0 ? spec.slice(0, separator) : spec;
}

function packageDirectory(root: string, packageName: string) {
  return join(
    /*turbopackIgnore: true*/ root,
    "node_modules",
    ...packageName.split("/"),
  );
}

async function installNpxAgent(agent: RegistryAgent) {
  const distribution = agent.distribution.npx!;
  const root = join(
    /*turbopackIgnore: true*/ dataDirectory(),
    "agents",
    agent.id,
    agent.version,
  );
  mkdirSync(root, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await execFileAsync(
    npm,
    [
      "install",
      "--prefix",
      root,
      "--no-audit",
      "--no-fund",
      distribution.package,
    ],
    { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
  );

  const packageName = packageNameFromSpec(distribution.package);
  const packageJson = JSON.parse(
    await readFile(
      /*turbopackIgnore: true*/ join(
        packageDirectory(root, packageName),
        "package.json",
      ),
      "utf8",
    ),
  ) as { bin?: string | Record<string, string> };
  const binName = typeof packageJson.bin === "string"
    ? packageName.split("/").at(-1)
    : Object.keys(packageJson.bin ?? {})[0];
  if (!binName) throw new Error(`${agent.name} package does not expose an executable.`);
  const command = join(
    /*turbopackIgnore: true*/ root,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${binName}.cmd` : binName,
  );
  if (!existsSync(/*turbopackIgnore: true*/ command)) {
    throw new Error(`${agent.name} executable was not installed at ${command}.`);
  }
  return { command, args: distribution.args ?? [], env: distribution.env ?? {} };
}

function validateArchiveEntries(entries: string[]) {
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      normalized.split("/").includes("..") ||
      /^[a-zA-Z]:\//.test(normalized)
    ) {
      throw new Error(`Unsafe path in agent archive: ${entry}`);
    }
  }
}

function safeInstalledPath(root: string, candidate: string) {
  const path = resolve(/*turbopackIgnore: true*/ root, candidate);
  const relation = relative(root, path);
  if (relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error("Agent manifest command points outside its install directory.");
  }
  return path;
}

async function extractBinaryArchive(
  archivePath: string,
  fileName: string,
  destination: string,
) {
  if (/\.(zip)$/i.test(fileName)) {
    const { stdout } = await execFileAsync("unzip", ["-Z1", archivePath], {
      maxBuffer: 16 * 1024 * 1024,
    });
    validateArchiveEntries(stdout.split("\n").filter(Boolean));
    await execFileAsync("unzip", ["-q", archivePath, "-d", destination], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return;
  }
  if (/\.(tar\.gz|tgz|tar\.bz2|tbz2)$/i.test(fileName)) {
    const { stdout } = await execFileAsync("tar", ["-tf", archivePath], {
      maxBuffer: 16 * 1024 * 1024,
    });
    validateArchiveEntries(stdout.split("\n").filter(Boolean));
    await execFileAsync("tar", ["-xf", archivePath, "-C", destination], {
      maxBuffer: 16 * 1024 * 1024,
    });
    return;
  }
  throw new Error(`Unsupported binary archive format: ${fileName}`);
}

async function installBinaryAgent(agent: RegistryAgent, target: RegistryBinaryTarget) {
  const response = await fetch(target.archive, { cache: "no-store" });
  if (!response.ok) throw new Error(`Agent download returned HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_ARCHIVE_BYTES) throw new Error("Agent archive is too large.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error("Agent archive is too large.");
  if (target.sha256) {
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest.toLowerCase() !== target.sha256.toLowerCase()) {
      throw new Error("Agent archive checksum verification failed.");
    }
  }

  const agentsRoot = join(/*turbopackIgnore: true*/ dataDirectory(), "agents");
  const installRoot = join(
    /*turbopackIgnore: true*/ agentsRoot,
    agent.id,
    agent.version,
  );
  const staging = await mkdtemp(
    join(/*turbopackIgnore: true*/ tmpdir(), `myagents-${agent.id}-`),
  );
  try {
    const fileName = new URL(target.archive).pathname.split("/").at(-1) || "agent";
    const archivePath = join(/*turbopackIgnore: true*/ staging, fileName);
    const extracted = join(/*turbopackIgnore: true*/ staging, "extracted");
    mkdirSync(extracted, { recursive: true });
    await writeFile(archivePath, bytes);
    if (/\.(zip|tar\.gz|tgz|tar\.bz2|tbz2)$/i.test(fileName)) {
      await extractBinaryArchive(archivePath, fileName, extracted);
    } else {
      const rawCommand = safeInstalledPath(extracted, target.cmd);
      mkdirSync(dirname(rawCommand), { recursive: true });
      await writeFile(rawCommand, bytes);
    }

    const stagedCommand = safeInstalledPath(extracted, target.cmd);
    if (!existsSync(/*turbopackIgnore: true*/ stagedCommand)) {
      throw new Error(`${agent.name} archive does not contain ${target.cmd}.`);
    }
    chmodSync(stagedCommand, 0o755);
    mkdirSync(dirname(installRoot), { recursive: true });
    await rm(installRoot, { recursive: true, force: true });
    await rename(extracted, installRoot);
    const command = safeInstalledPath(installRoot, target.cmd);
    return { command, args: target.args ?? [], env: target.env ?? {} };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function installRegistryAgent(registryId: string) {
  validateAgentId(registryId);
  const registry = await fetchAgentRegistry();
  const agent = registry.find(({ id }) => id === registryId);
  if (!agent) throw new Error("Agent was not found in the ACP Registry.");

  const existing = listAgentInstallations().find(
    ({ registryId: installedRegistryId }) => installedRegistryId === registryId,
  );
  if (existing) return existing;

  let launch: { command: string; args: string[]; env: Record<string, string> };
  if (agent.distribution.npx) {
    launch = await installNpxAgent(agent);
  } else if (agent.distribution.uvx) {
    const uvx = findCommand("uvx");
    if (!uvx) throw new Error("This agent requires uvx, which is not installed.");
    launch = {
      command: uvx,
      args: [agent.distribution.uvx.package, ...(agent.distribution.uvx.args ?? [])],
      env: agent.distribution.uvx.env ?? {},
    };
  } else {
    const platform = platformTarget();
    const target = platform ? agent.distribution.binary?.[platform] : undefined;
    if (!platform || !target) {
      throw new Error(`${agent.name} has no distribution for this platform.`);
    }
    launch = await installBinaryAgent(agent, target);
  }

  return upsertAgentInstallation({
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
}
