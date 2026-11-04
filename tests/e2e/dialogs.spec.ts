import { expect, test, type Page } from "@playwright/test";
import { focusBody, gotoDashboard, kpi, leftColumn, openDialogCount, rightColumn, trackConsole } from "./helpers";

const SOURCES = "แหล่งข้อมูลและวิธีการ";

async function expectOnlyDialog(page: Page, title: string) {
  await expect(page.getByRole("dialog", { name: title })).toBeVisible();
  await expect.poll(() => openDialogCount(page)).toBe(1);
}

async function escapeAll(page: Page) {
  await page.keyboard.press("Escape");
  await expect.poll(() => openDialogCount(page)).toBe(0);
}

test.describe("dialogs, settings, insights and shortcuts (desktop)", () => {
  test("the data-sources drawer opens every time after other dialogs are closed with Escape", async ({ page }) => {
    const errors = trackConsole(page);
    await gotoDashboard(page);
    const sources = page.getByRole("button", { name: SOURCES });
    for (let round = 0; round < 3; round++) {
      for (const other of ["การตั้งค่า", "ข้อค้นพบสำคัญ"]) {
        await page.getByRole("button", { name: other }).click();
        await expect.poll(() => openDialogCount(page)).toBe(1);
        await escapeAll(page);
        await sources.click();
        await expectOnlyDialog(page, SOURCES);
        await escapeAll(page);
      }
      await focusBody(page);
      await page.keyboard.press("Shift+Slash");
      await expectOnlyDialog(page, "แป้นพิมพ์ลัด");
      await escapeAll(page);
      await sources.click();
      await expectOnlyDialog(page, SOURCES);
      await page.getByRole("dialog", { name: SOURCES }).getByRole("button", { name: /^ปิด/ }).first().click();
      await expect.poll(() => openDialogCount(page)).toBe(0);
    }
    // the header data-range chip opens the same drawer
    await page.getByRole("button", { name: /^ช่วงเวลาของชุดข้อมูล/ }).click();
    await expectOnlyDialog(page, SOURCES);
    expect(errors).toEqual([]);
  });

  test("a single Escape closes the settings dialog every time it is reopened", async ({ page }) => {
    await gotoDashboard(page);
    const settings = page.getByRole("button", { name: "การตั้งค่า" });
    for (let i = 0; i < 3; i++) {
      await settings.click();
      await expect(page.getByRole("dialog", { name: "การตั้งค่า" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect.poll(() => openDialogCount(page), { message: `settings still open after one Escape (open #${i + 1})` }).toBe(0);
    }
  });

  test("settings: language, quality, reduced motion, effects and a confirmed reset", async ({ page }) => {
    await gotoDashboard(page);
    await page.getByRole("button", { name: "การตั้งค่า" }).click();
    const dlg = page.getByRole("dialog", { name: "การตั้งค่า" });
    await dlg.getByRole("radio", { name: /^สูง/ }).dispatchEvent("click");
    await expect(dlg.getByText("ระดับที่ใช้งานอยู่ขณะนี้: สูง")).toBeVisible();
    await dlg.getByRole("radio", { name: /^ประหยัด/ }).dispatchEvent("click");
    await expect(dlg.getByText("ระดับที่ใช้งานอยู่ขณะนี้: ประหยัด")).toBeVisible();
    await dlg.getByRole("switch", { name: "ลดการเคลื่อนไหว" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
    const effects = dlg.getByRole("switch", { name: "เอฟเฟกต์ภาพ" });
    await effects.click();
    await expect(effects).toHaveAttribute("aria-checked", "false");
    // reset needs a second press to confirm
    await dlg.getByRole("button", { name: "รีเซ็ตแดชบอร์ด" }).click();
    await dlg.getByRole("button", { name: "ยืนยันการรีเซ็ต" }).click();
    await expect.poll(() => openDialogCount(page)).toBe(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-reduced-motion", "true");
    await page.getByRole("button", { name: "การตั้งค่า" }).click();
    await expect(dlg.getByRole("switch", { name: "เอฟเฟกต์ภาพ" })).toHaveAttribute("aria-checked", "true");
    await expect(dlg.getByRole("radio", { name: /^อัตโนมัติ/ })).toBeChecked();
    // language switch from the dialog
    await dlg.getByRole("radio", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { level: 2, name: "Bangkok" }).first()).toBeVisible();
  });

  test("English mode translates the shell (no Thai UI chrome left in KPI labels and tabs)", async ({ page }) => {
    await gotoDashboard(page);
    await page.getByRole("radio", { name: "English" }).first().click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const kpiNames = await page.getByRole("main").getByRole("region").first().getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
    expect(kpiNames.length).toBe(6);
    for (const n of kpiNames) expect(n, n).not.toMatch(/[฀-๿]{3,}/);
    await expect(page.getByRole("tab", { name: "Ranking" })).toBeAttached();
  });

  test("insights: locate selects in 2D, 3D opens the neighbourhood twin, the tour can start", async ({ page }) => {
    await gotoDashboard(page);
    await page.getByRole("button", { name: "ข้อค้นพบสำคัญ" }).click();
    const dlg = page.getByRole("dialog", { name: "ข้อค้นพบสำคัญ" });
    await expect(dlg.getByText(/จตุจักร มีปริมาณขยะที่จัดเก็บได้สูงที่สุดในเมือง 365\.4/)).toBeVisible();
    await dlg.getByRole("button", { name: "ระบุตำแหน่ง ปทุมวัน" }).click();
    await expect.poll(() => openDialogCount(page)).toBe(0);
    await expect(rightColumn(page).getByRole("heading", { level: 2, name: "ปทุมวัน" })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("radio", { name: "แผนที่ 2 มิติ" }).first()).toBeChecked();

    await page.getByRole("button", { name: "ข้อค้นพบสำคัญ" }).click();
    await dlg.getByRole("button", { name: "ดูแบบ 3 มิติ คลองสาน" }).click();
    await expect(rightColumn(page).getByRole("heading", { level: 2, name: "คลองสาน" })).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("radio", { name: "แบบจำลองเมือง 3 มิติ" }).first()).toBeChecked();
    await expect(page.getByRole("button", { name: "ย่าน", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("insight 'overlapping factors' lists as many areas as its headline count", async ({ page }) => {
    await gotoDashboard(page);
    await page.getByRole("button", { name: "ข้อค้นพบสำคัญ" }).click();
    const dlg = page.getByRole("dialog", { name: "ข้อค้นพบสำคัญ" });
    const headline = dlg.getByText(/^\d+ พื้นที่มีปัจจัยอย่างน้อย 3 จาก 4 ด้าน/);
    await expect(headline).toBeVisible();
    const count = Number((await headline.textContent())!.match(/^(\d+)/)![1]);
    // climb from the headline to the card that owns the per-area "locate" buttons
    const { listed, more } = await headline.evaluate((el) => {
      let card: Element | null = el;
      while (card && !card.querySelector("button[aria-label^='ระบุตำแหน่ง']")) card = card.parentElement;
      const buttons = card ? card.querySelectorAll("button[aria-label^='ระบุตำแหน่ง']").length : 0;
      return { listed: buttons, more: card ? /และอีก|แสดงทั้งหมด|\+\d+/.test(card.textContent ?? "") : false };
    });
    expect(listed === count || more, `headline says ${count} areas, card lists ${listed} with no "more" affordance`).toBe(true);
  });

  test("keyboard shortcuts: 1/2/3 views, L sidebar, S lab, / search, ? help, F fullscreen", async ({ page }) => {
    await gotoDashboard(page);
    await focusBody(page);
    await page.keyboard.press("3");
    await expect(page.getByRole("radio", { name: "แผนที่และ 3 มิติเคียงกัน" }).first()).toBeChecked();
    await page.keyboard.press("2");
    await expect(page.getByRole("radio", { name: "แบบจำลองเมือง 3 มิติ" }).first()).toBeChecked();
    await page.keyboard.press("1");
    await expect(page.getByRole("radio", { name: "แผนที่ 2 มิติ" }).first()).toBeChecked();
    await page.keyboard.press("l");
    await expect(page.getByRole("button", { name: "ขยายแผงควบคุม" })).toBeVisible();
    await page.keyboard.press("l");
    await expect(page.getByRole("button", { name: "ย่อเป็นแถบไอคอน" })).toBeVisible();
    await page.keyboard.press("s");
    await expect(leftColumn(page).getByRole("button", { name: "ปิดห้องทดลองสถานการณ์", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(leftColumn(page).getByRole("button", { name: "ปิดห้องทดลองสถานการณ์", exact: true })).toHaveCount(0);
    await page.keyboard.press("/");
    await expect(page.getByRole("combobox", { name: "ค้นหาพื้นที่ตามชื่อหรือรหัส" })).toBeFocused();
    await focusBody(page);
    await page.keyboard.press("Shift+Slash");
    await expect(page.getByRole("dialog", { name: "แป้นพิมพ์ลัด" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(() => openDialogCount(page)).toBe(0);
    await page.getByRole("button", { name: "เต็มจอ" }).click();
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
    await focusBody(page);
    await page.keyboard.press("f");
    await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    // the KPI strip stays intact after leaving fullscreen
    await expect(kpi(page, "ประชากรทั้งเมือง")).toBeVisible();
  });
});
