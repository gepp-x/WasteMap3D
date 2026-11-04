import { expect, test } from "@playwright/test";
import { gotoDashboard, openDock, searchSelect } from "./helpers";

test.describe("tablet layout (1024 × 768)", () => {
  test("controls drawer, details overlay and no horizontal overflow", async ({ page }) => {
    await gotoDashboard(page);
    await page.getByRole("button", { name: "เปิดแผงควบคุมและชั้นข้อมูล" }).click();
    const drawer = page.getByRole("dialog", { name: "แผงควบคุมและชั้นข้อมูล" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("switch", { name: "ปริมาณขยะ" })).toBeVisible();
    await searchSelect(page, "บางรัก", "บางรัก");
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("tab", { name: "ภาพรวม", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "ปิดแผงรายละเอียด" }).first().click();
    await expect(page.getByRole("tab", { name: "ภาพรวม", exact: true })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });

  test("map controls stay inside the stage when the analysis dock is open", async ({ page }) => {
    await gotoDashboard(page);
    await openDock(page);
    const stage = (await page.getByRole("region", { name: "พื้นที่แสดงผลแผนที่และแบบจำลอง" }).boundingBox())!;
    for (const name of ["ขยายเข้า", "มุมมองเอียง (อาคาร 3 มิติ)"]) {
      const b = (await page.getByRole("button", { name }).boundingBox())!;
      expect(b.y, `${name} starts above the stage`).toBeGreaterThanOrEqual(stage.y);
      expect(b.y + b.height, `${name} ends below the stage`).toBeLessThanOrEqual(stage.y + stage.height);
    }
  });

  test("timeline scrubber is wide enough to use", async ({ page }) => {
    await gotoDashboard(page);
    const slider = page.getByRole("slider", { name: "เลือกวันที่ของฝนย้อนหลัง" });
    await slider.focus();
    await slider.press("End");
    await expect(slider).toHaveAttribute("aria-valuetext", /28 ตุลาคม 2569/);
    expect((await slider.boundingBox())!.width).toBeGreaterThanOrEqual(200);
  });
});
