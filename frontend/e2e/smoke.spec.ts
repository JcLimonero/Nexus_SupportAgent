import { expect, test } from "@playwright/test";
import { injectToken, readState } from "./helpers";

test("theme toggle switches and persists", async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  const wasDark = await html.evaluate((el) => el.classList.contains("dark"));

  await page.getByLabel(wasDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro").click();
  await expect(html).toHaveClass(wasDark ? /^(?!.*dark)/ : /dark/);

  await page.reload();
  const stillToggled = await html.evaluate((el) => el.classList.contains("dark"));
  expect(stillToggled).toBe(!wasDark);

  // Restore the original theme.
  await page.getByLabel(wasDark ? "Cambiar a modo oscuro" : "Cambiar a modo claro").click();
});

test("mobile viewport opens the sidebar as an overlay", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await injectToken(page, readState().uiToken);
  await page.goto("/chat");

  // The desktop sidebar stays in the DOM (`hidden md:flex`) — assert on
  // visibility, not existence.
  const newChat = page.getByRole("button", { name: "Nueva conversación" });
  await expect(newChat.first()).not.toBeVisible();
  await page.getByLabel("Abrir menú de conversaciones").click();
  await expect(newChat.filter({ visible: true })).toHaveCount(1);
});

test("TotalDealer branding follows the theme", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/TotalDealer/);

  // Both wordmarks are in the DOM; CSS shows the one that fits the theme.
  const html = page.locator("html");
  const wasDark = await html.evaluate((el) => el.classList.contains("dark"));
  const visibleLogo = () => page.getByAltText("TotalDealer").filter({ visible: true });
  await expect(visibleLogo()).toHaveCount(1);
  await expect(visibleLogo()).toHaveAttribute("src", wasDark ? /td-logo-white/ : /td-logo\.png/);

  await page.getByLabel(wasDark ? "Cambiar a modo claro" : "Cambiar a modo oscuro").click();
  await expect(visibleLogo()).toHaveAttribute("src", wasDark ? /td-logo\.png/ : /td-logo-white/);

  // Restore the original theme.
  await page.getByLabel(wasDark ? "Cambiar a modo oscuro" : "Cambiar a modo claro").click();
});
