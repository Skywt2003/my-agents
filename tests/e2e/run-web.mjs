import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const origin = "http://127.0.0.1:3211";
const token = "browser-e2e-token-0123456789abcdef";
const dataDirectory = "/tmp/myagents-playwright-web-data";
const registryPath = `${dataDirectory}/registry.json`;
const tsxCli = resolve("node_modules/tsx/dist/cli.mjs");
const playwrightCli = resolve("node_modules/@playwright/test/cli.js");

await rm(dataDirectory, { recursive: true, force: true });
await mkdir(dataDirectory, { recursive: true });
await mkdir("/tmp/myagents-playwright-workspace", { recursive: true });
await writeFile(
  registryPath,
  JSON.stringify({
    agents: [
      {
        id: "local-fake-agent",
        name: "Local Fake Agent",
        version: "1.0.0",
        description: "Installed ACP Agent used by the settings E2E test",
        distribution: {
          npx: {
            package: "node",
            args: [resolve("tests/fixtures/minimal-acp-agent.mjs")],
          },
        },
      },
      {
        id: "missing-agent",
        name: "Missing Agent",
        version: "1.0.0",
        description: "Unavailable command used by the settings E2E test",
        distribution: {
          npx: { package: "myagents-definitely-missing-agent" },
        },
      },
    ],
  }),
  "utf8",
);

const environment = {
  ...process.env,
  MYAGENTS_DATA_DIR: dataDirectory,
  MYAGENTS_DISABLE_DEFAULT_AGENTS: "1",
  MYAGENTS_TEST_AGENT_PATH: resolve("tests/fixtures/fake-acp-agent.mjs"),
  MYAGENTS_REGISTRY_PATH: registryPath,
  FAKE_ACP_SESSION_NEW_DELAY_MS: "800",
  FAKE_ACP_SESSION_LOAD_DELAY_MS: "1000",
  FAKE_ACP_HISTORY_PATH: `${dataDirectory}/fake-acp-history.json`,
  MYAGENTS_WEB_HOST: "127.0.0.1",
  MYAGENTS_WEB_PORT: "3211",
  MYAGENTS_WEB_ORIGIN: origin,
  MYAGENTS_WEB_TOKEN: token,
  MYAGENTS_WEB_QUIET: "1",
};

const server = spawn(process.execPath, [tsxCli, "src/web/server.ts"], {
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverOutput = "";
server.stdout.on("data", (chunk) => {
  serverOutput += chunk;
});
server.stderr.on("data", (chunk) => {
  serverOutput += chunk;
});

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Browser debug server exited early.\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${origin}/__myagents/health`);
      const health = await response.json();
      if (response.ok && health.ok === true && health.mode === "browser-debug") {
        return;
      }
    } catch {
      // The server is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Browser debug server did not become ready.\n${serverOutput}`);
}

async function stopServer() {
  if (server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => server.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 5_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
}

try {
  await waitForServer();
  const tests = spawn(
    process.execPath,
    [playwrightCli, "test", "--project=browser"],
    { env: environment, stdio: "inherit" },
  );
  const exitCode = await new Promise((resolveExit, reject) => {
    tests.once("error", reject);
    tests.once("exit", (code) => resolveExit(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await stopServer();
}
