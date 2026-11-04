import { expect, test, type Page } from "@playwright/test";
import { activeLayers, focusBody, gotoDashboard, leftColumn, rightColumn, switchCity, trackConsole } from "./helpers";

const storyCard = (page: Page) => page.locator("[data-story-card]");

async function startStory(page: Page) {
  await page.getByRole("button", { name: /^เล่าเรื่องเมือง/ }).click();
  await expect(storyCard(page)).toBeVisible();
}

async function next(page: Page) {
  await storyCard(page).getByRole("button", { name: /^ถัดไป/ }).click();
}

/** A non-default prior state the tour must give back on exit. */
async function customiseView(page: Page) {
  await leftColumn(page).getByRole("switch", { name: "ขยะต่อคน" }).click();
  await leftColumn(page).getByRole("switch", { name: "ฝนจากสถานีตรวจวัด" }).click();
  await expect.poll(() => activeLayers(page)).toEqual(expect.arrayContaining(["ขยะต่อคน", "ฝนจากสถานีตรวจวัด"]));
}

test.describe("guided story (desktop)", () => {
  test("walks all 8 steps with progress, back and finish", async ({ page }) => {
    await gotoDashboard(page);
    await startStory(page);
    const progress = storyCard(page).getByRole("list", { name: "ความคืบหน้าของทัวร์" });
    await expect(progress.getByRole("button")).toHaveCount(8);
    for (let i = 1; i <= 7; i++) {
      await expect(progress.getByRole("button").nth(i - 1)).toHaveAttribute("aria-current", "step");
      await next(page);
    }
    await expect(progress.getByRole("button").nth(7)).toHaveAttribute("aria-current", "step");
    await storyCard(page).getByRole("button", { name: "ย้อนกลับ" }).click();
    await expect(progress.getByRole("button").nth(6)).toHaveAttribute("aria-current", "step");
    await progress.getByRole("button").nth(7).click();
    await storyCard(page).getByRole("button", { name: "จบทัวร์" }).click();
    await expect(storyCard(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^เล่าเรื่องเมือง/ })).toHaveAttribute("aria-pressed", "false");
  });

  test("auto-play advances and can be paused", async ({ page }) => {
    await gotoDashboard(page);
    await startStory(page);
    const progress = storyCard(page).getByRole("list", { name: "ความคืบหน้าของทัวร์" });
    const play = storyCard(page).getByRole("button", { name: "เล่นอัตโนมัติ (ขั้นละ 8 วินาที)" });
    await play.click();
    const pause = storyCard(page).getByRole("button", { name: "หยุดเล่นอัตโนมัติ" });
    await expect(pause).toHaveAttribute("aria-pressed", "true");
    await expect(progress.getByRole("button").nth(1)).toHaveAttribute("aria-current", "step", { timeout: 20_000 });
    await pause.click();
    await expect(storyCard(page).getByRole("button", { name: "เล่นอัตโนมัติ (ขั้นละ 8 วินาที)" })).toHaveAttribute("aria-pressed", "false");
  });

  test("exit from the first step restores the previous layers", async ({ page }) => {
    await gotoDashboard(page);
    await customiseView(page);
    const before = (await activeLayers(page)).sort();
    await startStory(page);
    await storyCard(page).getByRole("button", { name: "ออกจากทัวร์และกลับสู่มุมมองเดิม (Esc)" }).click();
    await expect(storyCard(page)).toHaveCount(0);
    await expect.poll(async () => (await activeLayers(page)).sort()).toEqual(before);
  });

  test("exit after the scenario steps restores the previous layers, mode and view", async ({ page }) => {
    const errors = trackConsole(page);
    await gotoDashboard(page);
    await customiseView(page);
    const before = (await activeLayers(page)).sort();
    await startStory(page);
    for (let i = 0; i < 5; i++) await next(page);
    await expect(page.getByRole("button", { name: /^โหมดข้อมูล: การจำลอง/ }).first()).toBeVisible();
    await focusBody(page);
    await page.keyboard.press("Escape");
    await expect(storyCard(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^โหมดข้อมูล: ข้อมูลย้อนหลัง/ }).first()).toBeVisible();
    await expect(page.getByRole("radio", { name: "แผนที่ 2 มิติ" }).first()).toBeChecked();
    await expect(rightColumn(page).getByRole("heading", { level: 2, name: "กรุงเทพมหานคร" })).toBeVisible();
    await expect.poll(async () => (await activeLayers(page)).sort(), { message: "layers changed by the tour were not restored" }).toEqual(before);
    expect(errors, "story transitions must not produce invalid map colours").toEqual([]);
  });

  test("switching city interrupts the tour cleanly", async ({ page }) => {
    await gotoDashboard(page);
    await startStory(page);
    await next(page);
    await next(page);
    await switchCity(page, "hatyai");
    await expect(storyCard(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^เล่าเรื่องเมือง/ })).toHaveAttribute("aria-pressed", "false");
  });

  test("Hat Yai tour runs to the end", async ({ page }) => {
    await gotoDashboard(page);
    await switchCity(page, "hatyai");
    await startStory(page);
    const progress = storyCard(page).getByRole("list", { name: "ความคืบหน้าของทัวร์" });
    const steps = await progress.getByRole("button").count();
    expect(steps).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < steps; i++) await next(page);
    await storyCard(page).getByRole("button", { name: "จบทัวร์" }).click();
    await expect(storyCard(page)).toHaveCount(0);
  });
});
