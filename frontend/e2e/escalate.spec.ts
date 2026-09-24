import { expect, test, type Page } from "@playwright/test";
import { UI_USER_EMAIL, injectToken, readState } from "./helpers";

// The POST is intercepted on purpose. Dev stacks usually have EmailJS
// configured, so a real escalation would email the support team on every run,
// and escalations can't be deleted — only re-statused — so rows would pile up
// in /admin/escalations. The API half (validation, persistence, admin triage)
// is covered for real by tier-1: test_escalation_create_and_admin_flow.
// This spec covers what only the browser can: the modal's validation, the
// payload it builds, and what the user sees afterwards.

const SUBMIT_TOAST = "Solicitud enviada. Una persona del equipo te contactará.";

async function openModal(page: Page) {
  await page.getByRole("button", { name: "Solicitar ayuda" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Solicitar ayuda" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Answer the modal's POST in the browser and record what it sent. */
async function stubSubmit(page: Page, reply: { status: number; body?: string }) {
  const sent: Record<string, unknown>[] = [];
  await page.route("**/api/escalations", (route) => {
    if (route.request().method() !== "POST") return route.continue();
    sent.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "application/json", body: "{}", ...reply });
  });
  return sent;
}

test.describe("escalation modal", () => {
  test.beforeEach(async ({ page }) => {
    // Fail-safe under stubSubmit (Playwright runs the latest matching route
    // first): if the modal's URL ever drifts past that glob, the POST is
    // aborted here — the test fails — instead of reaching the backend and
    // emailing the support team.
    await page.route(/escalation/i, (route) =>
      route.request().method() === "POST" ? route.abort() : route.continue(),
    );
    await injectToken(page, readState().uiToken);
    await page.goto("/chat");
  });

  test("validates the form, sends the right payload and confirms", async ({ page }) => {
    const sent = await stubSubmit(page, { status: 201, body: JSON.stringify({ id: "e2e-fake" }) });

    const dialog = await openModal(page);
    const send = dialog.getByRole("button", { name: "Enviar solicitud" });

    // Prefilled from the account.
    await expect(dialog.getByLabel("Correo electrónico")).toHaveValue(UI_USER_EMAIL);

    await dialog.getByLabel("Nombre *").fill("Ana Prueba");
    await dialog.getByLabel("¿En qué necesitas ayuda? *").fill("corto");
    await expect(send).toBeDisabled(); // description under 10 characters

    await dialog.getByLabel("¿En qué necesitas ayuda? *").fill("No puedo facturar un pedido de mostrador.");
    await dialog.getByLabel("Teléfono (10 dígitos)").fill("12345");
    await expect(send).toBeDisabled(); // a filled-but-malformed phone blocks instead of being dropped

    await dialog.getByLabel("Teléfono (10 dígitos)").fill("55 1234 5678");
    await expect(send).toBeEnabled();
    await send.click();

    await expect(page.getByText(SUBMIT_TOAST)).toBeVisible();
    await expect(dialog).toHaveCount(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: "Ana Prueba",
      email: UI_USER_EMAIL,
      phone: "5512345678", // normalized to digits
      reason: "No puedo facturar un pedido de mostrador.",
    });
  });

  test("the contact is remembered for the next request", async ({ page }) => {
    const sent = await stubSubmit(page, { status: 201 });
    let dialog = await openModal(page);
    await dialog.getByLabel("Nombre *").fill("Ana Recordada");
    await dialog.getByLabel("Teléfono (10 dígitos)").fill("5512345678");
    await dialog.getByLabel("¿En qué necesitas ayuda? *").fill("Necesito ayuda con el corte de caja.");
    await dialog.getByRole("button", { name: "Enviar solicitud" }).click();
    await expect(page.getByText(SUBMIT_TOAST)).toBeVisible();
    expect(sent).toHaveLength(1);

    dialog = await openModal(page);
    await expect(dialog.getByLabel("Nombre *")).toHaveValue("Ana Recordada");
    await expect(dialog.getByLabel("Teléfono (10 dígitos)")).toHaveValue("5512345678");
  });

  test("a failed request keeps the form open and says so", async ({ page }) => {
    const sent = await stubSubmit(page, { status: 500, body: JSON.stringify({ detail: "boom" }) });
    const dialog = await openModal(page);
    await dialog.getByLabel("Nombre *").fill("Ana Prueba");
    await dialog.getByLabel("¿En qué necesitas ayuda? *").fill("No puedo facturar un pedido de mostrador.");
    await dialog.getByRole("button", { name: "Enviar solicitud" }).click();

    await expect(page.getByText("No se pudo enviar la solicitud. Intenta de nuevo.")).toBeVisible();
    expect(sent).toHaveLength(1); // the stub's 500, not the fail-safe's abort
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Nombre *")).toHaveValue("Ana Prueba"); // nothing lost
  });

  test("Escape closes the modal and returns focus to the trigger", async ({ page }) => {
    const trigger = page.getByRole("button", { name: "Solicitar ayuda" }).first();
    const dialog = await openModal(page);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
