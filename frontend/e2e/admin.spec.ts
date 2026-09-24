import { expect, test } from "@playwright/test";
import { API_URL, UI_FACT_CODE, UI_USER_EMAIL, createSessionViaApi, injectToken, readState } from "./helpers";

const BROWSER_DOC = "e2e_browser_upload.txt";
const CREATED_EMAIL = "e2e-ui-created@nexus.local";

test.describe("admin panel", () => {
  test.beforeEach(async ({ page }) => {
    await injectToken(page, readState().adminToken);
  });

  test("upload a document, see it indexed, delete it", async ({ page }) => {
    await page.goto("/admin");
    // exact: the empty-state line "No hay documentos indexados aún." also matches
    // a substring search while the list is still loading.
    await expect(page.getByText("Documentos indexados", { exact: true })).toBeVisible();

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

  test("tab bar and quick-access cards move between admin sections", async ({ page }) => {
    await page.goto("/admin");
    const nav = page.getByRole("navigation", { name: "Secciones de administración" });
    await expect(nav.getByRole("link", { name: /Resumen/ })).toHaveAttribute("aria-current", "page");

    await nav.getByRole("link", { name: /Usuarios/ }).click();
    await expect(page).toHaveURL(/\/admin\/users$/);
    await expect(nav.getByRole("link", { name: /Usuarios/ })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: /Resumen/ })).not.toHaveAttribute("aria-current");

    await nav.getByRole("link", { name: /Resumen/ }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await page.getByTestId("admin-quick-links").getByRole("link", { name: /Escalaciones/ }).click();
    await expect(page).toHaveURL(/\/admin\/escalations$/);
    await expect(nav.getByRole("link", { name: /Escalaciones/ })).toHaveAttribute("aria-current", "page");

    await nav.getByRole("link", { name: /Avisos/ }).click();
    await expect(page).toHaveURL(/\/admin\/avisos$/);
    await expect(page.getByRole("heading", { name: "Avisos de servicio" })).toBeVisible();

    await page.getByRole("link", { name: "← Chat" }).click();
    await expect(page).toHaveURL(/\/chat$/);
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

  test("the conversation viewer opens a user's conversation", async ({ page, request }) => {
    const state = readState();
    // Global setup's cache pre-warm already left the UI user a conversation.
    // Reuse it: this spec's upload/delete test flushes the semantic cache, so
    // asking again here would be a real (slow, quota-burning) Gemini call.
    const existing = await request.get(`${API_URL}/api/admin/conversations?user_id=${state.uiUserId}`, {
      headers: { Authorization: `Bearer ${state.adminToken}` },
    });
    expect(existing.ok(), `conversation list failed: ${existing.status()}`).toBeTruthy();
    if (((await existing.json()) as unknown[]).length === 0) await createSessionViaApi(request, state.uiToken);
    await page.goto(`/admin/conversations?user=${state.uiUserId}`);

    // Not the question: it is also the session title, so the list row itself
    // would match it. The answer's code only exists in the opened thread.
    const row = page.getByRole("button", { name: UI_USER_EMAIL }).first();
    await expect(row).toBeVisible();
    await expect(page.getByText(UI_FACT_CODE)).toHaveCount(0);
    await row.click();
    await expect(page.getByText(UI_FACT_CODE).first()).toBeVisible();
  });
});
