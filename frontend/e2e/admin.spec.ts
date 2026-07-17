import { expect, test } from "@playwright/test";
import { injectToken, readState } from "./helpers";

const BROWSER_DOC = "e2e_browser_upload.txt";
const CREATED_EMAIL = "e2e-ui-created@nexus.local";

test.describe("admin panel", () => {
  test.beforeEach(async ({ page }) => {
    await injectToken(page, readState().adminToken);
  });

  test("upload a document, see it indexed, delete it", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByText("Documentos indexados")).toBeVisible();

    await page.locator("#file-input").setInputFiles({
      name: BROWSER_DOC,
      mimeType: "text/plain",
      buffer: Buffer.from("Documento de prueba subido desde el navegador por la suite E2E."),
    });
    await expect(page.getByText("1 archivo(s) subido(s)")).toBeVisible({ timeout: 30_000 });

    // Background indexing publishes the doc; refresh the list until it shows.
    await expect(async () => {
      await page.getByRole("button", { name: "Actualizar" }).click();
      await expect(page.getByText(BROWSER_DOC)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 90_000 });

    // Delete via the confirmation modal.
    await page.locator("li", { hasText: BROWSER_DOC }).getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("Eliminar documento")).toBeVisible();
    await page.locator(".z-50").getByRole("button", { name: "Eliminar", exact: true }).click();
    await expect(page.getByText(`"${BROWSER_DOC}" eliminado del índice.`)).toBeVisible();
    await expect(page.locator("li", { hasText: BROWSER_DOC })).toHaveCount(0);
  });

  test("create, deactivate and delete a user", async ({ page }) => {
    await page.goto("/admin/users");
    await expect(page.getByText("Usuarios registrados")).toBeVisible();

    await page.getByPlaceholder("usuario@empresa.com").fill(CREATED_EMAIL);
    await page.getByPlaceholder("Mínimo 8 caracteres", { exact: true }).fill("Creado123!");
    await page.getByRole("button", { name: "Crear usuario" }).click();
    await expect(page.getByText(`Usuario ${CREATED_EMAIL} creado.`)).toBeVisible();

    const row = page.locator("tr", { hasText: CREATED_EMAIL });
    await expect(row).toBeVisible();
    await expect(row.getByText("Activo", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: "Desactivar" }).click();
    await expect(row.getByText("Inactivo", { exact: true })).toBeVisible();

    await row.getByRole("button", { name: "Eliminar" }).click();
    await expect(page.getByText("Eliminar usuario")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Eliminar", exact: true }).click();
    await expect(page.locator("tr", { hasText: CREATED_EMAIL })).toHaveCount(0);
  });
});
