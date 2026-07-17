import { expect, test } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers";

const CHAT_INPUT = "Escribe tu pregunta sobre TotalDealer...";

test.describe("login", () => {
  test("shows an error on bad credentials", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill("definitely-wrong");
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await expect(page.getByText("Correo electrónico o contraseña incorrectos")).toBeVisible();
  });

  test("valid credentials reach the chat", async ({ page }) => {
    await page.goto("/");
    await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
    await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: "Iniciar sesión" }).click();
    await expect(page.getByPlaceholder(CHAT_INPUT)).toBeVisible();
  });

  test("guest mode enters the chat without an account", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Continuar como invitado" }).click();
    await expect(page.getByText("Modo invitado")).toBeVisible();
    await expect(page.getByPlaceholder(CHAT_INPUT)).toBeVisible();
    // Guests have no history sidebar.
    await expect(page.getByText("+ NUEVA CONVERSACIÓN")).toHaveCount(0);
  });
});
