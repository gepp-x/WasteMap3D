import { expect, test, type Page } from "@playwright/test";

test.skip(({ isMobile }) => isMobile, "desktop flows");

function trackErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    // basemap tiles come from the network; a dropped connection is not an app error
    if (m.type() === "error" && !/Failed to load resource: net::ERR_/.test(m.text())) errors.push(m.text());
  });
  return errors;
}

async function selectDistrict(page: Page, name: string) {
  await page.keyboard.press("/");
  await page.keyboard.type(name);
  await page.keyboard.press("Enter");
}

test("loads Bangkok with map, KPIs and sourced figures", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.getByRole("heading", { name: "กรุงเทพมหานคร" }).first()).toBeVisible();
  // DOPA registered population at 31 Dec 2025 (BE 2568)
  await expect(page.getByText("5,422,568").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("selecting a district opens its details", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await selectDistrict(page, "จตุจักร");
  await expect(page.getByText("Chatuchak").first()).toBeVisible();
  await expect(page.getByText("154,513").first()).toBeVisible();
});

test("scenario preset shows the simulation disclaimer and updates modelled risk", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.keyboard.press("s");
  await page.getByRole("button", { name: /ฝนตกหนักมาก/ }).first().click();
  await expect(page.getByText("SIMULATION — NOT AN OFFICIAL FLOOD FORECAST").first()).toBeVisible();
  await expect(page.getByText("Simulation").first()).toBeVisible();
});

test("3D digital twin renders a WebGL canvas and neighbourhood buildings", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await selectDistrict(page, "จตุจักร");
  await page.locator("body").click({ position: { x: 4, y: 4 } });
  await page.keyboard.press("2");
  // R3F mounts lazily; wait until a non-map canvas exposes a WebGL context
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll("canvas")).some(
            (c) => !c.classList.contains("maplibregl-canvas") && c.width > 0 && !!(c.getContext("webgl2") || c.getContext("webgl")),
          ),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);
  await page.getByText("ย่าน", { exact: true }).first().click();
  await expect(page.getByText(/OpenStreetMap contributors/).first()).toBeVisible();
  expect(errors.filter((e) => !/GL Driver|GPU stall/.test(e))).toEqual([]);
});

test("switching to Hat Yai shows community zones flagged as approximate", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await page.getByText("หาดใหญ่", { exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "เทศบาลนครหาดใหญ่" }).first()).toBeVisible();
  await expect(page.getByText(/โดยประมาณ/).first()).toBeVisible();
  await expect(page.getByText("138,582").first()).toBeVisible();
});
