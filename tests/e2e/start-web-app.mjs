import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const sourceDirectory = process.cwd();
const dataDirectory = "/tmp/myagents-playwright-data";
const workspace = "/tmp/myagents-playwright-workspace";
rmSync(dataDirectory, { recursive: true, force: true });
rmSync(workspace, { recursive: true, force: true });
mkdirSync(dataDirectory, { recursive: true });
mkdirSync(workspace, { recursive: true });

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = {
  ...process.env,
  NEXT_TELEMETRY_DISABLED: "1",
  MYAGENTS_NEXT_DIST_DIR: ".next-e2e",
  MYAGENTS_DATA_DIR: dataDirectory,
  MYAGENTS_DISABLE_DEFAULT_AGENTS: "1",
  MYAGENTS_TEST_AGENT_PATH: resolve(
    sourceDirectory,
    "tests/fixtures/fake-acp-agent.mjs",
  ),
  FAKE_ACP_LOG: "/tmp/myagents-playwright-fake-agent.log",
};

const build = spawnSync(npm, ["run", "build"], {
  cwd: sourceDirectory,
  env: environment,
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const child = spawn(
  npm,
  ["run", "start", "--", "--hostname", "127.0.0.1", "--port", "3210"],
  {
    cwd: sourceDirectory,
    env: environment,
    stdio: "inherit",
  },
);

const forward = (signal) => {
  child.kill(signal);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
