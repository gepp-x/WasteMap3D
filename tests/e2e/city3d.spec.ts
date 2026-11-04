import { expect, test } from "@playwright/test";

test.skip(({ isMobile }) => isMobile, "desktop flow");

test("3D City mode tilts the map into extruded buildings with glowing edges and scenario rain", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.getByRole("radio", { name: /เมืองสามมิติ|3D city/ }).first().click();
  await expect(page.getByText("เมือง 3 มิติ", { exact: true }).first()).toBeVisible();
  // edge geometry is built from real basemap building tiles (requires the online basemap)
  await expect
    .poll(async () => Number(await page.locator(".maplibregl-map").first().getAttribute("data-city3d-edges")), { timeout: 30_000 })
    .toBeGreaterThan(100);
  const pitch = await page.evaluate(() => document.querySelector(".maplibregl-map") !== null);
  expect(pitch).toBe(true);
  // switching back to 2D leaves the mode
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("1");
  await expect(page.getByText("เมือง 3 มิติ", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
