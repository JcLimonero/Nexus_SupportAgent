import { expect, request as apiRequest, test } from "@playwright/test";
import { API_URL, injectToken, readState } from "./helpers";

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

// Banners are global: whatever a test publishes is deleted in afterEach, so no
// other spec ever runs with the chat paused.
const created: string[] = [];

async function publish(data: Record<string, unknown>): Promise<{ id: string }> {
  const api = await apiRequest.newContext({ baseURL: API_URL });
  const res = await api.post("/api/admin/banners", { headers: auth(readState().adminToken), data });
  if (!res.ok()) throw new Error(`banner create failed: ${res.status()} ${await res.text()}`);
  const body = await res.json();
  created.push(body.id);
  await api.dispose();
  return body;
}

test.describe("service status banners", () => {
  test.afterEach(async () => {
    const api = await apiRequest.newContext({ baseURL: API_URL });
    const { adminToken } = readState();
    for (const id of created.splice(0)) {
      await api.delete(`/api/admin/banners/${id}`, { headers: auth(adminToken) });
    }
    await api.dispose();
  });

  test("a critical notice shows on the login page and pauses the guest chat", async ({ page }) => {
    const message = `Encontramos el error y trabajamos en ello (${Date.now()})`;
    await publish({ message, severity: "critical", blocks_chat: true, contact: "45454545" });

    await page.goto("/");
    const onLogin = page.getByTestId("status-banner").filter({ hasText: message });
    await expect(onLogin).toBeVisible();
    await expect(onLogin.getByRole("link", { name: "45454545" })).toHaveAttribute("href", "tel:45454545");
    // Outages can't be closed.
    await expect(onLogin.getByRole("button", { name: "Cerrar aviso" })).toHaveCount(0);

    await page.getByRole("button", { name: "Continuar como invitado" }).click();
    await expect(page).toHaveURL(/\/chat/);
    await expect(page.getByTestId("status-banner").filter({ hasText: message })).toBeVisible();
    await expect(page.getByPlaceholder("El envío está pausado mientras restablecemos el servicio")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Enviar" })).toBeDisabled();
  });

  test("an informational notice can be closed and leaves the chat usable", async ({ page }) => {
    const message = `Mantenimiento programado esta noche (${Date.now()})`;
    await publish({ message, severity: "info" });

    await injectToken(page, readState().uiToken);
    await page.goto("/chat");
    const notice = page.getByTestId("status-banner").filter({ hasText: message });
    await expect(notice).toBeVisible();
    await expect(page.getByPlaceholder("Escribe tu pregunta sobre TotalDealer...")).toBeEnabled();

    await notice.getByRole("button", { name: "Cerrar aviso" }).click();
    await expect(notice).toHaveCount(0);
    // Closed stays closed across a reload.
    await page.reload();
    await expect(page.getByPlaceholder("Escribe tu pregunta sobre TotalDealer...")).toBeVisible();
    await expect(page.getByTestId("status-banner").filter({ hasText: message })).toHaveCount(0);
  });

  test("admin publishes, updates and ends a notice from /admin/avisos", async ({ page }) => {
    const message = `Aviso publicado desde el panel (${Date.now()})`;
    await injectToken(page, readState().adminToken);
    await page.goto("/admin/avisos");

    await page.getByLabel("Mensaje del aviso").fill(message);
    await page.getByRole("button", { name: "Advertencia" }).click();
    await page.getByLabel("Contacto").fill("45454545");
    await page.getByRole("button", { name: "30 min", exact: true }).click();
    await page.getByRole("button", { name: "Publicar aviso" }).click();
    await expect(page.getByText("Aviso publicado.")).toBeVisible();

    const row = page.getByTestId("banner-row").filter({ hasText: message });
    await expect(row).toBeVisible();
    const id = await row.getAttribute("data-banner-id");
    if (id) created.push(id);
    await expect(row.getByText(/Tiempo estimado de solución/)).toBeVisible();

    await row.getByRole("button", { name: "Agregar actualización" }).click();
    await row.getByLabel("Texto de la actualización").fill("Encontramos el error y trabajamos en ello");
    await row.getByRole("button", { name: "Publicar actualización" }).click();
    await expect(page.getByText("Actualización publicada.")).toBeVisible();
    await expect(row.getByText("Encontramos el error y trabajamos en ello")).toBeVisible();

    await row.getByRole("button", { name: "Finalizar ahora" }).click();
    await row.getByRole("button", { name: "Sí, finalizar" }).click();
    await expect(page.getByText("Aviso finalizado.")).toBeVisible();
    await page.getByRole("button", { name: /^Historial/ }).click();
    await expect(page.getByTestId("banner-row").filter({ hasText: message })).toBeVisible();
  });
});
