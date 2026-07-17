import { expect, test } from "@playwright/test";
import { UI_QUESTION, createSessionViaApi, injectToken, readState } from "./helpers";

test.describe("session sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await injectToken(page, readState().uiToken);
  });

  test("rename and delete a session", async ({ page, request }) => {
    await createSessionViaApi(request, readState().uiToken);
    await page.goto("/chat");

    const row = page.locator("aside .group").first();
    await expect(row).toBeVisible();

    // Rename (action icons appear on hover).
    await row.hover();
    await row.getByLabel("Renombrar conversación").click();
    const editInput = page.locator("aside input");
    await editInput.fill("Sesión renombrada UI");
    await editInput.press("Enter");
    await expect(page.locator("aside").getByText("Sesión renombrada UI")).toBeVisible();

    // Delete with inline confirmation. The row swaps its content for the
    // confirmation UI, so re-locate it by that text.
    const renamed = page.locator("aside .group").filter({ hasText: "Sesión renombrada UI" });
    await renamed.hover();
    await renamed.getByLabel("Eliminar conversación").click();
    const confirming = page.locator("aside .group").filter({ hasText: "¿Eliminar conversación?" });
    await expect(confirming).toBeVisible();
    await confirming.getByRole("button", { name: "Eliminar", exact: true }).click();
    await expect(page.locator("aside").getByText("Sesión renombrada UI")).toHaveCount(0);
  });

  test("search filter appears past 4 sessions and filters", async ({ page, request }) => {
    const token = readState().uiToken;
    for (let i = 0; i < 5; i++) await createSessionViaApi(request, token);
    await page.goto("/chat");

    const search = page.getByPlaceholder("Buscar conversación...");
    await expect(search).toBeVisible();
    await search.fill("zzz-sin-coincidencias");
    await expect(page.getByText("Sin resultados")).toBeVisible();
    await search.fill(UI_QUESTION.slice(0, 20));
    await expect(page.locator("aside .group").first()).toBeVisible();
  });

  test("collapse persists across reloads", async ({ page }) => {
    await page.goto("/chat");
    await expect(page.getByText("+ NUEVA CONVERSACIÓN")).toBeVisible();

    await page.getByLabel("Ocultar barra lateral").click();
    await expect(page.getByText("+ NUEVA CONVERSACIÓN")).toHaveCount(0);

    await page.reload();
    await expect(page.getByLabel("Mostrar barra lateral")).toBeVisible();
    await expect(page.getByText("+ NUEVA CONVERSACIÓN")).toHaveCount(0);

    await page.getByLabel("Mostrar barra lateral").click();
    await expect(page.getByText("+ NUEVA CONVERSACIÓN")).toBeVisible();
  });
});
