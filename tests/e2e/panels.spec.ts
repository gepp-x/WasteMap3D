import { expect, test, type Page } from "@playwright/test";
import { dock, gotoDashboard, openDock, rightColumn, searchSelect, selectPopup, switchCity, trackConsole } from "./helpers";

const DETAIL_TABS = ["ภาพรวม", "ขยะ", "ฝนและการระบายน้ำ", "ปัจจัยน้ำท่วม", "ข้อมูล"] as const;

async function walkDetailTabs(page: Page) {
  const right = rightColumn(page);
  for (const name of DETAIL_TABS) {
    const tab = right.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(right.getByRole("tabpanel")).toBeVisible();
  }
}

test.describe("area details, rankings, rainfall, drainage and compare (desktop)", () => {
  test("Bangkok district: every detail tab renders with sourced values", async ({ page }) => {
    const errors = trackConsole(page);
    await gotoDashboard(page);
    await searchSelect(page, "จตุจักร", "จตุจักร");
    const right = rightColumn(page);
    await expect(right.getByText("154,513").first()).toBeVisible();
    await walkDetailTabs(page);
    // the data tab lists provenance for every metric
    await right.getByRole("tab", { name: "ข้อมูล", exact: true }).click();
    await expect(right.getByRole("table").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("every detail tab is reachable without horizontal scrolling at the default column width", async ({ page }) => {
    await gotoDashboard(page);
    await searchSelect(page, "จตุจักร", "จตุจักร");
    const right = rightColumn(page);
    const column = await right.boundingBox();
    for (const name of DETAIL_TABS) {
      const box = await right.getByRole("tab", { name, exact: true }).boundingBox();
      expect(box, `tab ${name}`).not.toBeNull();
      expect(box!.x + box!.width, `tab "${name}" is clipped by the details column`).toBeLessThanOrEqual(column!.x + column!.width);
    }
  });

  test("the provenance table fits the details column (no 900 px table in a 384 px column)", async ({ page }) => {
    await gotoDashboard(page);
    await searchSelect(page, "จตุจักร", "จตุจักร");
    const right = rightColumn(page);
    await right.getByRole("tab", { name: "ข้อมูล", exact: true }).click();
    const table = right.getByRole("table").first();
    await expect(table).toBeVisible();
    const sizes = await table.evaluate((t) => ({ table: t.scrollWidth, host: t.parentElement!.clientWidth }));
    expect(sizes.table, "provenance table is wider than its column").toBeLessThanOrEqual(sizes.host + 1);
  });

  test("Hat Yai zone: tabs, communities list and demonstration-position labels", async ({ page }) => {
    const errors = trackConsole(page);
    await gotoDashboard(page);
    await switchCity(page, "hatyai");
    await searchSelect(page, "เขต 2", "เขต 2");
    await walkDetailTabs(page);
    const right = rightColumn(page);
    await right.getByRole("tab", { name: "ภาพรวม", exact: true }).click();
    await expect(right.getByRole("heading", { name: "ชุมชนในเขตนี้" })).toBeVisible();
    await expect(right.getByText("ตำแหน่งสาธิต ไม่ใช่พิกัดจริง").first()).toBeVisible();
    // hourly rain for the Nov 2025 event is shown on the rain tab
    await right.getByRole("tab", { name: "ฝนและการระบายน้ำ", exact: true }).click();
    await expect(right.getByText(/ฝนรายชั่วโมง/).first()).toBeVisible();
    await expect(right.getByText(/สถานีวัดระดับน้ำ/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("ranking: every metric, sort toggle, row click selects the area", async ({ page }) => {
    await gotoDashboard(page);
    await openDock(page);
    const d = dock(page);
    const metric = d.getByRole("combobox", { name: "ตัวชี้วัดสำหรับจัดอันดับ" });
    await metric.click();
    const options = selectPopup(page).getByRole("option");
    await expect(options.first()).toBeVisible();
    const names = await options.allTextContents();
    expect(names.length).toBeGreaterThanOrEqual(8);
    await page.keyboard.press("Escape");
    const list = d.getByRole("listbox", { name: /รายการพื้นที่เรียงตาม/ });
    for (let i = 0; i < names.length; i++) {
      await metric.click();
      const option = selectPopup(page).getByRole("option").nth(i);
      await expect(option).toBeVisible();
      await option.click();
      await expect(list.getByRole("option")).toHaveCount(50);
      await expect(list.getByRole("option").first()).toHaveAccessibleName(/^#1 /);
    }
    const sort = d.getByRole("button", { name: /^สลับลำดับการเรียง/ });
    const firstBefore = await list.getByRole("option").first().getAttribute("aria-label");
    await sort.click();
    await expect(sort).toHaveAccessibleName(/น้อยไปมาก/);
    await expect.poll(() => list.getByRole("option").first().getAttribute("aria-label")).not.toBe(firstBefore);
    const row = list.getByRole("option").nth(2);
    const label = (await row.getAttribute("aria-label")) ?? "";
    const area = label.replace(/^#\d+ /, "").replace(/:.*$/, "");
    await row.click();
    await expect(rightColumn(page).getByRole("heading", { level: 2, name: area })).toBeVisible({ timeout: 45_000 });
    await expect(row).toHaveAttribute("aria-selected", "true");
  });

  test("rainfall tab: daily chart, hourly event chart and jump to the wettest day", async ({ page }) => {
    await gotoDashboard(page);
    await openDock(page);
    const d = dock(page);
    await d.getByRole("tab", { name: "ฝน", exact: true }).click();
    await expect(d.getByText(/ฝนรายวันเฉลี่ยทั้งเมือง/)).toBeVisible();
    await expect(d.getByText(/ฝนรายชั่วโมง ช่วงฝนตกหนักกรุงเทพฯ/)).toBeAttached();
    await expect(d.getByText("197.1")).toBeAttached();
    const jump = d.getByRole("button", { name: /^ไปยังวันที่ฝนหนักที่สุดบนไทม์ไลน์/ });
    await jump.scrollIntoViewIfNeeded();
    await jump.click();
    await expect(page.getByRole("slider", { name: "เลือกวันที่ของฝนย้อนหลัง" })).toHaveAttribute("aria-valuetext", /26 กันยายน 2569/);
  });

  test("drainage tab: modelled stress, official pump registry and water-level snapshot", async ({ page }) => {
    await gotoDashboard(page);
    await openDock(page);
    const d = dock(page);
    await d.getByRole("tab", { name: "การระบายน้ำ", exact: true }).click();
    await expect(d.getByText(/แรงกดดันระบบระบายน้ำรายพื้นที่/)).toBeVisible();
    await expect(d.getByText("ทะเบียนทางการ กทม. (สำนักการระบายน้ำ)")).toBeAttached();
    await expect(d.getByText("255 สถานี")).toBeAttached();
    await expect(d.getByText(/ไม่ใช่ข้อมูลสด/).first()).toBeAttached();
  });

  test("drainage tab: no untranslated raw category keys", async ({ page }) => {
    await gotoDashboard(page);
    await openDock(page);
    const d = dock(page);
    await d.getByRole("tab", { name: "การระบายน้ำ", exact: true }).click();
    await expect(d.getByText(/โครงสร้างที่ทำแผนที่ไว้/)).toBeAttached();
    await expect(d.getByText("water-area", { exact: true })).toHaveCount(0);
  });

  test("compare: choose A and B, swap, same area cannot be picked twice", async ({ page }) => {
    await gotoDashboard(page);
    await openDock(page);
    const d = dock(page);
    await d.getByRole("tab", { name: "เปรียบเทียบ", exact: true }).click();
    const swap = d.getByRole("button", { name: "สลับพื้นที่ A และ B" });
    await expect(swap).toBeDisabled();
    const pick = async (label: string, area: string) => {
      await d.getByRole("combobox", { name: label }).click();
      const option = selectPopup(page).getByRole("option", { name: area, exact: true });
      await expect(option).toBeVisible();
      await option.click();
      await expect(d.getByRole("combobox", { name: label })).toContainText(area);
    };
    await pick("เลือกพื้นที่ A", "จตุจักร");
    await pick("เลือกพื้นที่ B", "ปทุมวัน");
    await expect(d.getByText("+115,953")).toBeVisible();
    await expect(swap).toBeEnabled();
    await swap.click();
    await expect(d.getByRole("combobox", { name: "เลือกพื้นที่ A" })).toContainText("ปทุมวัน");
    await expect(d.getByRole("combobox", { name: "เลือกพื้นที่ B" })).toContainText("จตุจักร");
    await d.getByRole("combobox", { name: "เลือกพื้นที่ B" }).click();
    await expect(selectPopup(page).getByRole("option", { name: "ปทุมวัน", exact: true })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
  });
});
