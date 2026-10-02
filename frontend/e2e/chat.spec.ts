import { APIRequestContext, Page, expect, test } from "@playwright/test";
import { API_URL, UI_DOC_NAME, UI_FACT_CODE, UI_QUESTION, injectToken, readState } from "./helpers";

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

  for (const [label, viewport] of [
    ["desktop", { width: 1200, height: 560 }],
    ["mobile", { width: 390, height: 640 }],
  ] as const) {
    // Regression: auto-scroll used scrollIntoView, which also scrolled the
    // overflow-hidden page row (inflated by absolutely positioned sr-only labels),
    // so each message shoved the whole UI further up with no way to scroll back.
    test(`the page never scrolls as messages pile up (${label})`, async ({ page, request }) => {
      // Leave no session behind: more than 4 makes the sidebar grow a search input,
      // which breaks the rename spec's `aside input` locator.
      const before = await listSessionIds(request);
      try {
        await runScrollCheck(page, viewport);
      } finally {
        const after = await listSessionIds(request);
        for (const id of after.filter((s) => !before.includes(s))) {
          await request.delete(`${API_URL}/api/sessions/${id}`, {
            headers: { Authorization: `Bearer ${readState().uiToken}` },
          });
        }
      }
    });
  }

  async function listSessionIds(request: APIRequestContext): Promise<string[]> {
    const res = await request.get(`${API_URL}/api/sessions`, {
      headers: { Authorization: `Bearer ${readState().uiToken}` },
    });
    return ((await res.json()) as { id: string }[]).map((s) => s.id);
  }

  async function runScrollCheck(page: Page, viewport: { width: number; height: number }) {
    await page.setViewportSize(viewport);
    const input = page.getByPlaceholder("Escribe tu pregunta sobre TotalDealer...");
    // The same question again is a semantic-cache hit: fast, and no extra Gemini call.
    for (let i = 0; i < 3; i++) {
      await input.fill(UI_QUESTION);
      await input.press("Enter");
      await expect(page.getByText(UI_FACT_CODE).nth(i)).toBeVisible({ timeout: 90_000 });
      await expect(input).toBeEnabled({ timeout: 30_000 });
    }

    const scrolled = await page.evaluate(() => {
      const log = document.querySelector('[role="log"]') as HTMLElement;
      const offenders: string[] = [];
      for (let el = log.parentElement; el; el = el.parentElement) {
        if (el.scrollTop !== 0) offenders.push(`${el.tagName}.${el.className}=${el.scrollTop}`);
      }
      return { offenders, composerBottom: document.querySelector("form")!.getBoundingClientRect().bottom, vh: innerHeight };
    });
    expect(scrolled.offenders).toEqual([]);
    expect(scrolled.composerBottom).toBeLessThanOrEqual(scrolled.vh);
    // The list itself does scroll (and the composer stays on screen).
    expect(await page.locator('[role="log"]').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  }

  test("Enter sends, Shift+Enter makes a new line", async ({ page }) => {
    const input = page.getByPlaceholder("Escribe tu pregunta sobre TotalDealer...");
    await input.fill("línea uno");
    await input.press("Shift+Enter");
    await input.type("línea dos");
    await expect(input).toHaveValue("línea uno\nlínea dos");
  });
});
