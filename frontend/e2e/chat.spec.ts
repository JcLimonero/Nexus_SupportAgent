import { expect, test } from "@playwright/test";
import { UI_DOC_NAME, UI_FACT_CODE, UI_QUESTION, injectToken, readState } from "./helpers";

test.describe("chat flow", () => {
  test.beforeEach(async ({ page }) => {
    await injectToken(page, readState().uiToken);
    await page.goto("/chat");
  });

  test("ask → streamed answer with citation, source panel, feedback", async ({ page }) => {
    const input = page.getByPlaceholder("Escribe tu pregunta sobre TotalDealer...");
    await input.fill(UI_QUESTION);
    await input.press("Enter");

    // The answer must cite the fact only the uploaded doc contains.
    await expect(page.getByText(UI_FACT_CODE).first()).toBeVisible({ timeout: 90_000 });

    // Source chip for the doc appears under the answer.
    const chip = page.getByRole("button", { name: new RegExp(UI_DOC_NAME) }).first();
    await expect(chip).toBeVisible();

    // Thumbs-up sticks (icon becomes filled).
    const up = page.locator('button[title="Respuesta útil"]').last();
    await up.click();
    await expect(up.locator("svg")).toHaveAttribute("fill", "currentColor");

    // Source panel opens with the exact excerpt.
    await chip.click();
    const panel = page.getByRole("dialog");
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Texto extraído por el modelo")).toBeVisible();
    await expect(panel.getByText(UI_FACT_CODE).first()).toBeVisible();

    // "Ver documento" opens the signed streaming URL in a new tab.
    const popupPromise = page.waitForEvent("popup");
    await panel.getByRole("button", { name: "Ver documento" }).click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(popup.url()).toContain("/api/media/stream/");
    await popup.close();

    // Escape closes the panel.
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
  });

  test("Enter sends, Shift+Enter makes a new line", async ({ page }) => {
    const input = page.getByPlaceholder("Escribe tu pregunta sobre TotalDealer...");
    await input.fill("línea uno");
    await input.press("Shift+Enter");
    await input.type("línea dos");
    await expect(input).toHaveValue("línea uno\nlínea dos");
  });
});
