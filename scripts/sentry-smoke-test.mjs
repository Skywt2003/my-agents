import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

import { _electron as electron } from "@playwright/test";

const scriptPath = fileURLToPath(import.meta.url);
const dsn = process.env.MYAGENTS_SENTRY_DSN ?? process.env.SENTRY_DSN;

if (!dsn) {
  throw new Error("Set SENTRY_DSN or MYAGENTS_SENTRY_DSN before running this smoke test.");
}

if (process.platform === "linux" && !process.env.DISPLAY && !process.env.MYAGENTS_SENTRY_XVFB) {
  const child = spawnSync(
    "xvfb-run",
    ["-a", process.execPath, scriptPath],
    {
      env: { ...process.env, MYAGENTS_SENTRY_XVFB: "1" },
      stdio: "inherit",
    },
  );
  process.exit(child.status ?? 1);
}

const dsnUrl = new URL(dsn);
const dataDirectory = await mkdtemp(join(tmpdir(), "myagents-sentry-smoke-"));
const requestFilter = `${dsnUrl.protocol}//${dsnUrl.host}/*`;
const executablePath = process.env.MYAGENTS_E2E_EXECUTABLE;
let electronApp;

try {
  await writeFile(
    join(dataDirectory, "privacy-settings.json"),
    JSON.stringify({ version: 1, telemetryMode: "developer" }),
    "utf8",
  );

  electronApp = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath ? ["--no-sandbox"] : ["--no-sandbox", "."],
    env: {
      ...process.env,
      MYAGENTS_DATA_DIR: dataDirectory,
      MYAGENTS_DISABLE_DEFAULT_AGENTS: "1",
      MYAGENTS_SENTRY_DSN: dsn,
    },
  });
  const page = await electronApp.firstWindow();

  const telemetry = await page.evaluate(() =>
    globalThis.window.myagents.telemetry?.getSettings()
  );
  if (!telemetry?.configured || telemetry.activeMode !== "developer") {
    throw new Error(`Unexpected telemetry state: ${JSON.stringify(telemetry)}`);
  }

  await electronApp.evaluate(({ session }, filter) => {
    globalThis.__myagentsSentrySmokeRequests = [];
    session.fromPartition("sentry-electron").webRequest.onCompleted(
      { urls: [filter] },
      ({ error, method, statusCode, url }) => {
        globalThis.__myagentsSentrySmokeRequests.push({
          error,
          method,
          statusCode,
          url: new globalThis.URL(url).pathname,
        });
      },
    );
  }, requestFilter);

  const mainFailures = await page.evaluate(async () => {
    const results = await Promise.allSettled([
      globalThis.window.myagents.sessions.get("[Sentry smoke test] missing session"),
      globalThis.window.myagents.agents.test("[Sentry smoke test] missing agent"),
    ]);
    return results.map((result) =>
      result.status === "rejected" ? String(result.reason) : "unexpected success"
    );
  });

  await page.evaluate(() => {
    globalThis.window.setTimeout(() => {
      throw new Error("[Sentry smoke test] renderer uncaught exception");
    }, 0);
    void Promise.reject(
      new Error("[Sentry smoke test] renderer unhandled rejection"),
    );
  });

  let requests = [];
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    requests = await electronApp.evaluate(() =>
      globalThis.__myagentsSentrySmokeRequests ?? []
    );
    if (requests.filter(({ statusCode }) => statusCode >= 200 && statusCode < 300).length >= 4) {
      break;
    }
  }

  console.log(JSON.stringify({
    mainFailures,
    mode: telemetry.activeMode,
    projectId: dsnUrl.pathname.split("/").filter(Boolean).at(-1),
    requests,
  }, null, 2));

  if (!requests.some(({ statusCode }) => statusCode >= 200 && statusCode < 300)) {
    throw new Error("Sentry did not return a successful ingestion response within 20 seconds.");
  }
} finally {
  if (electronApp) await electronApp.close();
  await rm(dataDirectory, { recursive: true, force: true });
}
