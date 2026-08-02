import { expect, test } from "@playwright/test";

test("preserves the core desktop workflow", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Start a new session" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Add project" }).first().click();
  const projectDialog = page.getByRole("dialog", { name: "Add project" });
  await projectDialog.getByLabel("Project name").fill("Playwright project");
  await projectDialog
    .getByLabel("Directory")
    .fill("/tmp/myagents-playwright-workspace");
  await projectDialog.getByRole("button", { name: "Add project" }).click();

  await page
    .getByPlaceholder("What would you like to work on?")
    .fill("hello migration guard");
  await page
    .getByRole("button", { name: "Start session and send message" })
    .click();
  await expect(page.getByText("Hello from fake agent")).toBeVisible();
  await expect(page.getByText("1 tool call")).toBeVisible();

  const model = page.getByRole("combobox", { name: "Model" });
  await model.click();
  await page.getByRole("option", { name: "Accurate" }).click();
  await expect(model).toContainText("Accurate");

  await page.getByPlaceholder("Message Fake Agent…").fill("request permission");
  await page.getByRole("button", { name: "Send message" }).click();
  await page.getByText("Permission required").click();
  await page.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByText(/permission-allow/)).toBeVisible();

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
  await expect(page.getByText(/permission-allow/)).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
    "Accurate",
  );
});
