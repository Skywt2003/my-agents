import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configureCodexCommand,
  listInstalledAgents,
} from "@/lib/acp/agents";
import {
  closeDatabase,
  upsertAgentInstallation,
} from "@/lib/persistence/database";

let dataDirectory: string;

beforeEach(async () => {
  closeDatabase();
  dataDirectory = await mkdtemp(join(tmpdir(), "myagents-agent-descriptor-test-"));
  process.env.MYAGENTS_DATA_DIR = dataDirectory;
  process.env.MYAGENTS_DISABLE_DEFAULT_AGENTS = "1";
});

afterEach(async () => {
  closeDatabase();
  delete process.env.MYAGENTS_DATA_DIR;
  delete process.env.MYAGENTS_DISABLE_DEFAULT_AGENTS;
  await rm(dataDirectory, { recursive: true, force: true });
});

describe("installed Agent descriptors", () => {
  it("shows the command passed into the Codex ACP adapter", () => {
    upsertAgentInstallation({
      id: "codex",
      registryId: "codex-acp",
      name: "Codex",
      command: process.execPath,
      args: ["/opt/myagents/codex-acp/dist/index.js"],
      env: { CODEX_PATH: "/opt/bin/codex" },
      source: "system",
    });

    expect(listInstalledAgents()).toEqual([
      expect.objectContaining({
        id: "codex",
        displayCommand: "/opt/bin/codex",
        adapter: "codex-acp",
      }),
    ]);
  });

  it("shows the complete launch command for a direct ACP Agent", () => {
    upsertAgentInstallation({
      id: "opencode",
      name: "OpenCode",
      command: "/opt/bin/opencode",
      args: ["acp"],
      source: "system",
    });

    expect(listInstalledAgents()).toEqual([
      expect.objectContaining({
        id: "opencode",
        displayCommand: "/opt/bin/opencode acp",
        adapter: undefined,
      }),
    ]);
  });

  it("persists a user-selected Codex executable", () => {
    upsertAgentInstallation({
      id: "codex",
      registryId: "codex-acp",
      name: "Codex",
      command: process.execPath,
      args: ["/opt/myagents/codex-acp/dist/index.js"],
      env: { CODEX_PATH: "codex" },
      source: "system",
    });

    const agents = configureCodexCommand(process.execPath);

    expect(agents).toEqual([
      expect.objectContaining({
        id: "codex",
        displayCommand: process.execPath,
        available: true,
      }),
    ]);
  });

  it("keeps a configured Codex executable while refreshing default metadata", () => {
    delete process.env.MYAGENTS_DISABLE_DEFAULT_AGENTS;
    upsertAgentInstallation({
      id: "codex",
      registryId: "codex-acp",
      name: "Codex",
      command: process.execPath,
      args: ["/opt/myagents/codex-acp/dist/index.js"],
      env: { CODEX_PATH: process.execPath },
      source: "system",
    });

    const codex = listInstalledAgents().find(({ id }) => id === "codex");

    expect(codex).toMatchObject({
      displayCommand: process.execPath,
      available: true,
      iconUrl: expect.stringContaining("codex-acp.svg"),
    });
  });
});
