import { expect, test, type Page } from "@playwright/test";

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Open settings" }).click();
  return page.getByRole("dialog", { name: "Settings" });
}

test.beforeEach(async ({ page }) => {
  const origin = process.env.MYAGENTS_WEB_ORIGIN;
  const token = process.env.MYAGENTS_WEB_TOKEN;
  if (!origin || !token) throw new Error("Browser E2E server configuration is missing.");
  await page.goto(`${origin}/#token=${encodeURIComponent(token)}`);
  await expect(page.getByText("Browser debug", { exact: true })).toBeVisible();
});

test("adds an installed Agent only after a successful ACP handshake", async ({
  page,
}) => {
  let settings = await openSettings(page);
  await settings.getByPlaceholder("Search agents").fill("Local Fake Agent");
  await settings.getByRole("button", { name: "Add", exact: true }).click();

  await expect(
    settings.getByRole("button", { name: "Added", exact: true }),
  ).toBeVisible();
  await expect(
    settings.getByRole("button", { name: "Remove Local Fake Agent" }),
  ).toBeVisible();

  await settings.getByRole("button", { name: "Test Local Fake Agent" }).click();
  await expect(settings.getByRole("status")).toContainText(
    "created a test session successfully",
  );

  await page.reload();
  settings = await openSettings(page);
  await expect(
    settings.getByRole("button", { name: "Remove Local Fake Agent" }),
  ).toBeVisible();

  await settings.getByRole("button", { name: "Remove Local Fake Agent" }).click();
  const confirmation = settings.getByRole("group", {
    name: "Confirm removing Local Fake Agent",
  });
  await confirmation.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Remove Local Fake Agent" }),
  ).toHaveCount(0);

  await settings.getByPlaceholder("Search agents").fill("Local Fake Agent");
  await expect(
    settings.getByRole("button", { name: "Add", exact: true }),
  ).toBeVisible();
  await expect(
    page.evaluate(async () =>
      (await window.myagents.sessions.list()).agents.some(
        ({ id }) => id === "local-fake-agent",
      )
    ),
  ).resolves.toBe(false);
});

test("rejects an Agent whose executable is not installed", async ({ page }) => {
  const settings = await openSettings(page);
  await settings.getByPlaceholder("Search agents").fill("Missing Agent");
  await settings.getByRole("button", { name: "Add", exact: true }).click();

  await expect(settings.getByRole("alert")).toContainText(
    "Missing Agent is not installed.",
  );
  await expect(settings.getByRole("alert")).toContainText(
    "myagents-definitely-missing-agent",
  );
  await expect(
    settings.getByRole("button", { name: "Add", exact: true }),
  ).toBeEnabled();
  await expect(
    page.evaluate(async () =>
      (await window.myagents.sessions.list()).agents.some(
        ({ id }) => id === "missing-agent",
      )
    ),
  ).resolves.toBe(false);
});
