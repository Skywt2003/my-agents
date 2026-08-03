import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, _electron as electron } from "@playwright/test";

import { exerciseCoreWorkflow } from "./core-workflow";

const testDataDirectory = "/tmp/myagents-playwright-data";
const testWorkspace = "/tmp/myagents-playwright-workspace";

test("preserves the core Electron workflow", async () => {
  await rm(testDataDirectory, { recursive: true, force: true });
  await mkdir(testWorkspace, { recursive: true });
  const executablePath = process.env.MYAGENTS_E2E_EXECUTABLE;
  const electronApp = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? ["--no-sandbox"] : ["--no-sandbox", "."],
    env: {
      ...process.env,
      MYAGENTS_DATA_DIR: testDataDirectory,
      MYAGENTS_DISABLE_DEFAULT_AGENTS: "1",
      MYAGENTS_TEST_AGENT_PATH: resolve("tests/fixtures/fake-acp-agent.mjs"),
    },
  });
  const page = await electronApp.firstWindow();

  try {
    await expect(
      page.evaluate(() => window.myagents.transport),
    ).resolves.toBe("electron");
    await exerciseCoreWorkflow(page);
  } finally {
    await electronApp.close();
  }
});
