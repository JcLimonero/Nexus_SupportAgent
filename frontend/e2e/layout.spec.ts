import { expect, test, type Page } from "@playwright/test";
import { injectToken, readState } from "./helpers";

// Layout and accessibility guards for the TotalDealer UI. Cheap, no LLM calls:
// they catch the regressions a restyle tends to introduce — a row that no
// longer fits a phone, an icon button that lost its label, a surface that
// stays white in dark mode.

type Who = "anon" | "user" | "admin";
const PAGES: { path: string; who: Who }[] = [
  { path: "/", who: "anon" },
  { path: "/chat", who: "user" },
  { path: "/admin", who: "admin" },
  { path: "/admin/users", who: "admin" },
  { path: "/admin/conversations", who: "admin" },
  { path: "/admin/escalations", who: "admin" },
  { path: "/admin/avisos", who: "admin" },
];

async function visit(page: Page, path: string, who: Who) {
  const state = readState();
  if (who === "user") await injectToken(page, state.uiToken);
  if (who === "admin") await injectToken(page, state.adminToken);
  await page.goto(path);
  // Wait for the page's own content, not just the document, so auth has
  // resolved and the real layout is on screen. (Not the logo: the admin
  // header hides it below the sm breakpoint.)
  const ready = {
    anon: page.getByRole("button", { name: "Iniciar sesión" }),
    user: page.getByPlaceholder("Escribe tu pregunta sobre TotalDealer..."),
    admin: page.getByRole("navigation", { name: "Secciones de administración" }),
  }[who];
  await expect(ready).toBeVisible();
}

/** Visible buttons/links whose accessible name would be empty. */
async function unlabeledControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, a[href], [role=button]"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
      const labelledBy = el.getAttribute("aria-labelledby");
      const name =
        el.getAttribute("aria-label") ||
        (labelledBy && document.getElementById(labelledBy)?.textContent) ||
        el.textContent ||
        el.getAttribute("title") ||
        Array.from(el.querySelectorAll("img")).map((i) => i.alt).join(" ");
      if (!name || !name.trim()) out.push(el.outerHTML.slice(0, 120));
    }
    return out;
  });
}

/** Visible elements that stick out past the right edge of the viewport.
 *
 * Checking document.scrollWidth isn't enough: pages render inside the layout's
 * `overflow-y-auto` wrapper, which makes overflow-x auto as well, so a too-wide
 * page scrolls sideways *inside* that wrapper while the document stays put.
 * Areas that scroll sideways on purpose (tables, code blocks — marked with an
 * explicit overflow-x) are skipped. */
async function overflowingElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const intentional = (el: Element | null): boolean => {
      for (let n = el; n; n = n.parentElement) {
        const h = n as HTMLElement;
        if (h.style?.overflowX === "auto" || h.style?.overflowX === "scroll" || h.classList?.contains("overflow-x-auto")) return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.right <= vw + 1) continue;
      if (getComputedStyle(el).visibility === "hidden" || intentional(el.parentElement)) continue;
      out.push(`${el.tagName.toLowerCase()}.${el.className} right=${Math.round(r.right)}`.slice(0, 120));
    }
    return out;
  });
}

test.describe("layout", () => {
  for (const { path, who } of PAGES) {
    test(`${path} fits a 375px phone without horizontal scrolling`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 });
      await visit(page, path, who);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, "page is wider than the viewport").toBeLessThanOrEqual(0);
      expect(await overflowingElements(page), "elements past the right edge").toEqual([]);
    });

    test(`${path} has no unlabeled buttons or links`, async ({ page }) => {
      await visit(page, path, who);
      expect(await unlabeledControls(page)).toEqual([]);
    });
  }

  test("dark mode switches the header and page surfaces off white", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("theme", "dark"));
    await visit(page, "/admin", "admin");
    const colors = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      header: getComputedStyle(document.querySelector("header")!).backgroundColor,
    }));
    expect(colors.body).not.toBe("rgb(255, 255, 255)");
    expect(colors.header).not.toBe("rgb(255, 255, 255)");
  });

  test("the send button keeps its accessible name when its label is hidden on phones", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await visit(page, "/chat", "user");
    await expect(page.getByRole("button", { name: "Enviar" })).toBeVisible();
  });
});
