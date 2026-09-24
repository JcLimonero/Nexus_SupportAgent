import { expect, test } from "@playwright/test";
import { injectToken, readState } from "./helpers";

// Browser-side access control. The API refuses these requests on its own
// (tier-1 covers that); these specs check that the UI routes people to the
// right place instead of showing a broken or empty admin page.

const ADMIN_ROUTES = ["/admin", "/admin/users", "/admin/conversations", "/admin/escalations", "/admin/avisos"];

test.describe("access control", () => {
  test("signed-out visitors are sent from /chat to the login page", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByRole("button", { name: "Iniciar sesión" })).toBeVisible();
    await expect(page).not.toHaveURL(/\/chat/);
  });

  for (const route of ADMIN_ROUTES) {
    test(`a non-admin user is sent away from ${route}`, async ({ page }) => {
      await injectToken(page, readState().uiToken);
      await page.goto(route);
      await expect(page).toHaveURL(/\/chat$/);
      await expect(page.getByRole("navigation", { name: "Secciones de administración" })).toHaveCount(0);
    });
  }

  test("a non-admin user has no way into the admin panel from the sidebar", async ({ page }) => {
    await injectToken(page, readState().uiToken);
    await page.goto("/chat");
    await expect(page.getByRole("button", { name: "Nueva conversación" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Administrar documentos" })).toHaveCount(0);
  });

  test("guests get the chat without sidebar, help requests or admin", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continuar como invitado" }).click();
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByText("Modo invitado")).toBeVisible();

    await expect(page.getByRole("button", { name: "Nueva conversación" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Solicitar ayuda" })).toHaveCount(0);

    // /chat, not just "anywhere but /admin": a guest bounced to the login page
    // (session lost on navigation) is a different bug that must not pass here.
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.getByText("Modo invitado")).toBeVisible();
  });

  test("logging out clears the session", async ({ page }) => {
    // Set the token once instead of injectToken: its init script re-adds the
    // token on every load, so a reload could never show the user signed out.
    await page.goto("/");
    await page.evaluate((t) => window.localStorage.setItem("nexus_token", t), readState().uiToken);
    await page.goto("/chat");
    await page.getByRole("button", { name: "Cerrar sesión" }).click();
    await expect(page.getByRole("button", { name: "Iniciar sesión" })).toBeVisible();
    expect(await page.evaluate(() => window.localStorage.getItem("nexus_token"))).toBeNull();

    await page.goto("/chat");
    await expect(page.getByRole("button", { name: "Iniciar sesión" })).toBeVisible();
    await expect(page).not.toHaveURL(/\/chat/);
  });

  test("an unknown shared link shows a clear message, not an error page", async ({ page }) => {
    await page.goto("/shared/e2e-token-que-no-existe");
    await expect(page.getByText("Conversación no disponible")).toBeVisible();
    await expect(page.getByAltText("TotalDealer").filter({ visible: true })).toHaveCount(1);
  });
});
