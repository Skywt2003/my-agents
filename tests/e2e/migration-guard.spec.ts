import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, _electron as electron } from "@playwright/test";

import { exerciseCoreWorkflow } from "./core-workflow";

const testDataDirectory = "/tmp/myagents-playwright-data";
const testWorkspace = "/tmp/myagents-playwright-workspace";

test("excludes browser debug code from the Electron renderer bundle", async () => {
  const assetsDirectory = resolve("out/renderer/assets");
  const javascriptFiles = (await readdir(assetsDirectory))
    .filter((file) => file.endsWith(".js"));
  const bundle = (await Promise.all(
    javascriptFiles.map((file) => readFile(resolve(assetsDirectory, file), "utf8")),
  )).join("\n");

  for (const browserDebugMarker of [
    "Browser debug",
    "browser-debug-token",
    "/__myagents/ws",
    "installBrowserApi",
    'transport:"browser"',
  ]) {
    expect(bundle).not.toContain(browserDebugMarker);
  }
});

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
    await page.waitForFunction(() =>
      document.documentElement.dataset.platform === window.myagents.platform
    );
    await expect(page.evaluate(() => ({
      transport: window.myagents.transport,
      platform: window.myagents.platform,
      documentPlatform: document.documentElement.dataset.platform,
    }))).resolves.toEqual({
      transport: "electron",
      platform: process.platform,
      documentPlatform: process.platform,
    });
    await expect(page.getByText("Browser debug", { exact: true })).toHaveCount(0);
    await exerciseCoreWorkflow(page);
  } finally {
    await electronApp.close();
  }
});
