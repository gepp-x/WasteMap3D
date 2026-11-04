import { expect, test } from "@playwright/test";

test("mobile layout keeps the map first with a bottom sheet", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  for (const tab of ["รายละเอียด", "ชั้นข้อมูล", "สถานการณ์"]) {
    await expect(page.getByText(tab, { exact: true }).first()).toBeVisible();
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test.describe("mobile bottom sheet", () => {
  const handle = (page: import("@playwright/test").Page) => page.getByRole("button", { name: /^ปรับขนาดแผงข้อมูล/ });

  test("sheet tabs switch content and the handle cycles collapsed → half → full → collapsed", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 45_000 });
    await expect(handle(page)).toHaveAccessibleName(/ย่ออยู่/);
    for (const [tab, marker] of [
      ["ชั้นข้อมูล", page.getByRole("switch", { name: "ปริมาณขยะ" })],
      ["สถานการณ์", page.getByRole("button", { name: "ปิดห้องทดลองสถานการณ์", exact: true })],
      ["วิเคราะห์", page.getByRole("combobox", { name: "ตัวชี้วัดสำหรับจัดอันดับ" })],
      ["รายละเอียด", page.getByRole("heading", { level: 2, name: "กรุงเทพมหานคร" })],
    ] as const) {
      await page.getByRole("tab", { name: tab }).tap();
      await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      await expect(marker.first()).toBeVisible();
    }
    await expect(handle(page)).toHaveAccessibleName(/ครึ่งจอ/);
    await handle(page).tap();
    await expect(handle(page)).toHaveAccessibleName(/เต็มจอ/);
    await handle(page).tap();
    await expect(handle(page)).toHaveAccessibleName(/ย่ออยู่/);
  });

  test("tapping the already-selected tab expands a collapsed sheet", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("tab", { name: "รายละเอียด" })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "รายละเอียด" }).tap();
    await expect(handle(page)).not.toHaveAccessibleName(/ย่ออยู่/);
  });

  test("search selects an area and opens its details; more-menu lists every tool", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 45_000 });
    await page.getByRole("button", { name: "ค้นหาพื้นที่" }).tap();
    const box = page.getByRole("combobox", { name: "ค้นหาพื้นที่ตามชื่อหรือรหัส" });
    await box.fill("ปทุมวัน");
    await expect(page.getByRole("option", { name: /ปทุมวัน/ }).first()).toBeVisible();
    await box.press("Enter");
    await expect(page.getByRole("heading", { level: 2, name: "ปทุมวัน" })).toBeVisible({ timeout: 45_000 });
    await expect(handle(page)).toHaveAccessibleName(/ครึ่งจอ/);
    await page.getByRole("button", { name: "เมนูเพิ่มเติม" }).tap();
    for (const item of ["เล่าเรื่องเมือง", "ข้อค้นพบสำคัญ", "แหล่งข้อมูลและวิธีการ", "การตั้งค่า", "Switch to English", "เต็มจอ"]) {
      await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
    }
    await page.getByRole("menuitem", { name: "แหล่งข้อมูลและวิธีการ" }).tap();
    await expect(page.getByRole("dialog", { name: "แหล่งข้อมูลและวิธีการ" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("map legend does not cover the basemap attribution", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 45_000 });
    const legend = (await page.getByRole("button", { name: "แสดง/ซ่อนคำอธิบายแผนที่" }).boundingBox())!;
    const attribution = (await page.locator(".maplibregl-ctrl-attrib").first().boundingBox())!;
    const overlaps =
      legend.x < attribution.x + attribution.width && attribution.x < legend.x + legend.width && legend.y < attribution.y + attribution.height && attribution.y < legend.y + legend.height;
    expect(overlaps).toBe(false);
  });
});
