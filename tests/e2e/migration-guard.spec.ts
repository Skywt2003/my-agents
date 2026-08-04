import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { expect, test, _electron as electron } from "@playwright/test";

import {
  closeDatabase,
  databasePath,
  persistConversationItem,
  persistMessage,
  persistSession,
  upsertAgentInstallation,
} from "@/lib/persistence/database";
import { exerciseCoreWorkflow } from "./core-workflow";
import { sessionFixture } from "../helpers/session";

const testDataDirectory = "/tmp/myagents-playwright-data";
const testWorkspace = "/tmp/myagents-playwright-workspace";
const telemetryDataDirectory = "/tmp/myagents-playwright-telemetry-data";
const imageDataDirectory = "/tmp/myagents-playwright-image-data";
const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlKf8cAAAAASUVORK5CYII=";

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
    await electronApp.evaluate(({ dialog }, selectedDirectory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedDirectory],
      });
    }, testWorkspace);
    await page.getByRole("button", { name: "Add project" }).first().click();
    const projectDialog = page.getByRole("dialog", { name: "Add project" });
    await projectDialog.getByRole("button", { name: "Choose…" }).click();
    await expect(projectDialog.getByLabel("Directory")).toHaveValue(testWorkspace);
    await projectDialog.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Privacy" }).click();
    await expect(page.getByRole("radio", { name: "Off" })).toBeChecked();
    await page.getByRole("radio", { name: "Anonymous" }).click();
    await expect(page.getByRole("radio", { name: "Anonymous" })).toBeChecked();
    await page.getByRole("button", { name: "Close" }).click();
    await exerciseCoreWorkflow(page);
  } finally {
    await electronApp.close();
  }
});

test("migrates and renders legacy image history without base64 text", async () => {
  await rm(imageDataDirectory, { recursive: true, force: true });
  process.env.MYAGENTS_DATA_DIR = imageDataDirectory;
  upsertAgentInstallation({
    id: "fake-agent",
    name: "Fake Agent",
    command: process.execPath,
    source: "system",
  });
  const session = sessionFixture({
    id: "image-session",
    acpSessionId: "image-acp-session",
    title: "Image history",
    agentTitle: "Image history",
  });
  persistSession(session);
  persistMessage(session.id, {
    id: "legacy-image",
    role: "user",
    content: "Screenshot attached",
    createdAt: "2026-01-01T00:00:01.000Z",
  }, 0);
  persistConversationItem(session.id, {
    type: "message",
    message: {
      id: "legacy-image",
      role: "user",
      content: "Screenshot attached",
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  }, 0);
  closeDatabase();
  const legacyDb = new Database(databasePath());
  legacyDb.prepare(`
    UPDATE messages
    SET content = ?, content_blocks_json = NULL
    WHERE session_id = ? AND id = ?
  `).run(
    `Screenshot attached\n[@image](data:image/png;base64,${onePixelPng})`,
    session.id,
    "legacy-image",
  );
  legacyDb.close();
  delete process.env.MYAGENTS_DATA_DIR;

  const executablePath = process.env.MYAGENTS_E2E_EXECUTABLE;
  const electronApp = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? ["--no-sandbox"] : ["--no-sandbox", "."],
    env: {
      ...process.env,
      MYAGENTS_DATA_DIR: imageDataDirectory,
      MYAGENTS_DISABLE_DEFAULT_AGENTS: "1",
      MYAGENTS_TEST_AGENT_PATH: resolve("tests/fixtures/fake-acp-agent.mjs"),
      FAKE_ACP_SESSION_LOAD_DELAY_MS: "20000",
    },
  });
  const page = await electronApp.firstWindow();

  try {
    await expect(page.getByRole("heading", { name: "Image history" })).toBeVisible();
    const image = page.getByRole("img", { name: "Message attachment" });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/);
    await expect(page.locator("body")).not.toContainText("data:image/png;base64");
  } finally {
    await electronApp.close();
  }
});

test("initializes each enabled Sentry policy in both Electron processes", async () => {
  for (const mode of ["anonymous", "developer"] as const) {
    const dataDirectory = `${telemetryDataDirectory}-${mode}`;
    await rm(dataDirectory, { recursive: true, force: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(
      resolve(dataDirectory, "privacy-settings.json"),
      JSON.stringify({ version: 1, telemetryMode: mode }),
      "utf8",
    );

    const executablePath = process.env.MYAGENTS_E2E_EXECUTABLE;
    const electronApp = await electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: executablePath ? ["--no-sandbox"] : ["--no-sandbox", "."],
      env: {
        ...process.env,
        MYAGENTS_DATA_DIR: dataDirectory,
        MYAGENTS_DISABLE_DEFAULT_AGENTS: "1",
        MYAGENTS_SENTRY_DSN: "http://public@127.0.0.1:9/1",
      },
    });
    const page = await electronApp.firstWindow();

    try {
      await expect(page.evaluate(() =>
        window.myagents.telemetry?.getSettings()
      )).resolves.toMatchObject({
        activeMode: mode,
        configured: true,
        mode,
        restartRequired: false,
      });
    } finally {
      await electronApp.close();
    }
  }
});
