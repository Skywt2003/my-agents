import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  reporter: [["list"]],
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    {
      name: "electron",
      testMatch: /migration-guard\.spec\.ts/,
    },
    {
      name: "browser",
      testMatch: /browser-debug\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
