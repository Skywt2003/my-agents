import { expect, type Page } from "@playwright/test";

async function expectBefore(
  earlier: ReturnType<Page["getByText"]>,
  later: ReturnType<Page["getByText"]>,
) {
  const laterElement = await later.elementHandle();
  expect(laterElement).not.toBeNull();
  expect(
    await earlier.evaluate(
      (element, following) =>
        Boolean(
          element.compareDocumentPosition(following) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      laterElement,
    ),
  ).toBe(true);
}

export async function exerciseCoreWorkflow(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Start a new session" }),
  ).toBeVisible();

  const sidebar = page.getByRole("complementary", { name: "Session sidebar" });
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(sidebar).toHaveCSS("width", "48px");
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(page.getByText("Projects", { exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar" }).click();
  await expect(page.getByRole("button", { name: "Collapse sidebar" })).toBeVisible();

  await page.getByRole("button", { name: "Add project" }).first().click();
  const projectDialog = page.getByRole("dialog", { name: "Add project" });
  await projectDialog.getByLabel("Project name").fill("Playwright project");
  await projectDialog
    .getByLabel("Directory")
    .fill("/tmp/myagents-playwright-workspace");
  await projectDialog.getByRole("button", { name: "Add project" }).click();

  const sessionDirectory = page.locator('[data-slot="session-directory"]');
  await expect(
    sessionDirectory.getByText("New session", { exact: true }),
  ).toHaveCount(0);

  const model = page.getByRole("combobox", { name: "Model" });
  await model.click();
  await page.getByRole("option", { name: "Accurate" }).click();
  await expect(model).toContainText("Accurate");
  await expect(
    sessionDirectory.getByText("New session", { exact: true }),
  ).toHaveCount(0);

  await page
    .getByPlaceholder("What would you like to work on?")
    .fill("hello migration guard");
  await page
    .getByRole("button", { name: "Start session and send message" })
    .click();
  await expect(page.getByText("Hello from fake agent")).toBeVisible();
  await expect(page.getByText("1 tool call")).toBeVisible();
  await expectBefore(
    page.getByText("1 tool call"),
    page.getByText("Hello from fake agent"),
  );
  await expect(
    sessionDirectory.getByText("hello migration guard", { exact: true }),
  ).toBeVisible();
  await expect(model).toContainText("Accurate");

  await page.getByPlaceholder("Message Fake Agent…").fill("request permission");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Permission required").click();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByText(/permission-allow/)).toBeVisible();
  await expect(page.getByText("Loading conversation", { exact: true })).toBeHidden();
  await expectBefore(
    page.getByText("1 tool call"),
    page.getByText("Hello from fake agent").first(),
  );

  await page.getByRole("button", { name: "Toggle terminal panel" }).click();
  await page.getByRole("button", { name: "New terminal" }).click();
  const terminalInput = page.locator(".xterm-helper-textarea");
  await expect(terminalInput).toBeAttached();
  await terminalInput.pressSequentially("printf MYAGENTS_TERMINAL_OK");
  await terminalInput.press("Enter");
  await expect(page.locator(".xterm-rows")).toContainText(
    "MYAGENTS_TERMINAL_OK",
  );

  await page.reload();
  await expect(
    page.getByRole("heading", { name: "hello migration guard" }),
  ).toBeVisible();
  if (await page.evaluate(() => window.myagents.transport === "browser")) {
    const conversationLoading = page.getByText("Loading conversation", { exact: true });
    const composer = page.getByPlaceholder("Message Fake Agent…");
    await expect(
      page.locator('[data-slot="conversation-scroll-area"]')
        .getByText("Loading conversation", { exact: true }),
    ).toHaveCount(0);
    await expect(conversationLoading).toBeHidden();
    await expect(composer).toBeEnabled();
    await expect(page.getByText(/permission-allow/)).toBeVisible();
  }
  await expect(page.getByText(/permission-allow/)).toBeVisible();
  const distanceFromBottom = await page.locator(
    '[data-slot="conversation-scroll-area"] [data-slot="scroll-area-viewport"]',
  ).evaluate((viewport) =>
    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
  );
  expect(distanceFromBottom).toBeLessThanOrEqual(1);
  await expect(page.getByText("Loading conversation", { exact: true })).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
    "Accurate",
  );

  await page
    .getByRole("button", { name: "New session in Playwright project" })
    .click();
  const cachedModel = page.getByRole("combobox", { name: "Model" });
  await cachedModel.click();
  await expect(
    page.getByRole("option", { name: "Accurate" }),
  ).toBeVisible({ timeout: 250 });
  await expect(
    sessionDirectory.getByText("New session", { exact: true }),
  ).toHaveCount(0);
}
