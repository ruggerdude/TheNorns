import { expect, test } from "@playwright/test";

// Smoke test only: proves the Playwright + real-Chromium layer actually
// works end to end (dev server boot, navigation, rendering) in this
// environment. The Login screen needs no backend calls, so this has no
// external dependencies beyond `vite dev`.
test("unauthenticated visitor sees the login screen", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /enter your workspace/i })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByLabel("Deploy setup key")).toHaveCount(0);
  await expect(page.getByPlaceholder("NORNS_TOKEN")).toHaveCount(0);
});
