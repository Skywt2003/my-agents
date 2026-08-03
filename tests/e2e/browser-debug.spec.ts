import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";

import { exerciseCoreWorkflow } from "./core-workflow";

test("preserves the core workflow through browser RPC", async ({ page }) => {
  await mkdir("/tmp/myagents-playwright-workspace", { recursive: true });
  const origin = process.env.MYAGENTS_WEB_ORIGIN;
  const token = process.env.MYAGENTS_WEB_TOKEN;
  if (!origin || !token) throw new Error("Browser E2E server configuration is missing.");

  await page.goto(`${origin}/#token=${encodeURIComponent(token)}`);
  await expect(page.getByText("Browser debug", { exact: true })).toBeVisible();
  await expect(
    page.evaluate(() => window.myagents.transport),
  ).resolves.toBe("browser");
  await expect(page).not.toHaveURL(/token=/);
  await exerciseCoreWorkflow(page);
});
