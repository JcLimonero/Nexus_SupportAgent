import { expect, test } from "@playwright/test";
import { UI_QUESTION, createSessionViaApi, injectToken, readState } from "./helpers";

test("share a conversation and open the public link without auth", async ({ page, request, browser }) => {
  const token = readState().uiToken;
  await createSessionViaApi(request, token);

  await injectToken(page, token);
  await page.goto("/chat");
  await page.locator("aside .group").first().click();
  await expect(page.getByRole("button", { name: "Compartir" })).toBeVisible();

  await page.getByRole("button", { name: "Compartir" }).click();
  await expect(page.getByText("Enlace copiado")).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toContain("/shared/");

  // A fresh, unauthenticated browser context can read the conversation.
  const anon = await browser.newContext();
  const publicPage = await anon.newPage();
  await publicPage.goto(url);
  await expect(publicPage.getByText(UI_QUESTION).first()).toBeVisible();
  await anon.close();
});
