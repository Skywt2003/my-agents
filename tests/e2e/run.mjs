import { spawn } from "node:child_process";
import { resolve } from "node:path";

const playwrightCli = resolve("node_modules/@playwright/test/cli.js");
const needsVirtualDisplay = process.platform === "linux" && !process.env.DISPLAY;
const command = needsVirtualDisplay ? "xvfb-run" : process.execPath;
const args = needsVirtualDisplay
  ? ["-a", process.execPath, playwrightCli, "test", "--project=electron"]
  : [playwrightCli, "test", "--project=electron"];

const child = spawn(command, args, { stdio: "inherit", env: process.env });
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
