import { expect, test } from "@playwright/test";
import { focusBody, gotoDashboard, kpi, leftColumn, switchCity, timeline, trackConsole } from "./helpers";

test.describe("timeline and Scenario Lab (desktop)", () => {
  test("historical scrub with the keyboard, play / pause, speed cycle and clear", async ({ page }) => {
    const errors = trackConsole(page);
    await gotoDashboard(page);
    const tl = timeline(page);
    const slider = tl.getByRole("slider", { name: "เลือกวันที่ของฝนย้อนหลัง" });
    const clear = tl.getByRole("button", { name: "ล้างวันที่ — กลับสู่ค่าฐาน" });
    await expect(clear).toBeDisabled();
    await slider.focus();
    await slider.press("End");
    await expect(slider).toHaveAttribute("aria-valuetext", /28 ตุลาคม 2569/);
    await expect(kpi(page, "ปริมาณฝนเฉลี่ยทั้งเมืองของวันที่เลือก")).toBeVisible();
    await slider.press("ArrowLeft");
    await expect(slider).toHaveAttribute("aria-valuetext", /27 ตุลาคม 2569/);
    await slider.press("Home");
    await expect(slider).toHaveAttribute("aria-valuetext", /1 มกราคม 2567/);
    await expect(clear).toBeEnabled();

    const start = Number(await slider.getAttribute("aria-valuenow"));
    await tl.getByRole("button", { name: "เล่น", exact: true }).click();
    const pause = tl.getByRole("button", { name: "หยุดชั่วคราว" });
    await expect(pause).toBeVisible();
    await expect.poll(async () => Number(await slider.getAttribute("aria-valuenow")), { timeout: 20_000 }).toBeGreaterThan(start);
    await pause.click();
    const stopped = await slider.getAttribute("aria-valuenow");
    await page.waitForTimeout(1_000); // verify the value no longer advances
    expect(await slider.getAttribute("aria-valuenow")).toBe(stopped);

    const speed = tl.getByRole("button", { name: /^ความเร็วการเล่น/ });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      await speed.click();
      seen.push((await speed.getAttribute("aria-label")) ?? "");
    }
    expect(new Set(seen).size).toBe(4);

    await clear.click();
    await expect(slider).toHaveAttribute("aria-valuetext", /ยังไม่เลือกวันที่/);
    await expect(clear).toBeDisabled();
    await expect(kpi(page, "ปริมาณฝนเฉลี่ยรายปีของเมือง")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("flood-event markers jump to the event's wettest day in both cities", async ({ page }) => {
    await gotoDashboard(page);
    const slider = timeline(page).getByRole("slider", { name: "เลือกวันที่ของฝนย้อนหลัง" });
    await timeline(page).getByRole("button", { name: /^เหตุการณ์น้ำท่วม: ฝนตกหนักและน้ำท่วมขัง กรุงเทพฯ/ }).click();
    await expect(slider).toHaveAttribute("aria-valuetext", /26 กันยายน 2569/);
    await switchCity(page, "hatyai");
    await expect(slider).toHaveAttribute("aria-valuetext", /ยังไม่เลือกวันที่/);
    await timeline(page).getByRole("button", { name: /^เหตุการณ์น้ำท่วม: อุทกภัยหาดใหญ่/ }).click();
    await expect(slider).toHaveAttribute("aria-valuetext", /21 พฤศจิกายน 2568/);
  });

  test("the date scrubber keeps a usable width once a date is selected", async ({ page }) => {
    await gotoDashboard(page);
    const slider = timeline(page).getByRole("slider", { name: "เลือกวันที่ของฝนย้อนหลัง" });
    await timeline(page).getByRole("button", { name: /^เหตุการณ์น้ำท่วม:/ }).first().click();
    await expect(slider).toHaveAttribute("aria-valuetext", /2569/);
    const box = await slider.boundingBox();
    expect(box!.width, "scrubber collapses when the date read-out and hourly button appear").toBeGreaterThanOrEqual(120);
  });

  test("Scenario Lab: presets, every slider, compare-baseline and reset", async ({ page }) => {
    const errors = trackConsole(page);
    await gotoDashboard(page);
    await focusBody(page);
    await page.keyboard.press("s");
    const left = leftColumn(page);
    await expect(left.getByRole("button", { name: "ปิดห้องทดลองสถานการณ์", exact: true })).toBeVisible();
    const drainage = kpi(page, "แรงกดดันระบบระบายน้ำ");
    await expect(drainage).toHaveAccessibleName(/13\.1 %/);

    for (const preset of ["ฝนตกหนัก", "ฝนตกหนักมาก", "ท่อระบายน้ำอุดตัน", "แรงกดดันรวม"]) {
      const button = left.getByRole("button", { name: new RegExp(`^${preset}`) }).first();
      await button.click();
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(drainage).not.toHaveAccessibleName(/13\.1 %/);
    }
    await expect(page.getByText("SIMULATION — NOT AN OFFICIAL FLOOD FORECAST").first()).toBeVisible();

    const sliders = left.getByRole("slider");
    await expect(sliders).toHaveCount(6);
    for (let i = 0; i < 6; i++) {
      const s = sliders.nth(i);
      const before = await s.getAttribute("aria-valuetext");
      await s.focus();
      await s.press(i === 5 ? "ArrowLeft" : "ArrowRight");
      await expect.poll(() => s.getAttribute("aria-valuetext")).not.toBe(before);
    }

    const compare = left.getByRole("switch", { name: "เทียบกับสถานการณ์ฐาน" });
    await expect(compare).toHaveAttribute("aria-checked", "true");
    await compare.click();
    await expect(compare).toHaveAttribute("aria-checked", "false");
    await compare.click();

    const reset = left.getByRole("button", { name: "รีเซ็ตเป็นค่าฐาน" });
    await reset.click();
    await expect(reset).toBeDisabled();
    await expect(drainage).toHaveAccessibleName(/13\.1 %/);
    await expect(sliders.first()).toHaveAttribute("aria-valuetext", "10 มม./ชม.");
    await left.getByRole("button", { name: "ปิดห้องทดลองสถานการณ์", exact: true }).click();
    await expect(left.getByRole("button", { name: "เปิดห้องทดลองสถานการณ์", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("switching city resets an active scenario to the baseline", async ({ page }) => {
    await gotoDashboard(page);
    await leftColumn(page).getByRole("button", { name: /^ฝนตกหนักมาก/ }).first().click();
    await expect(page.getByRole("button", { name: /^โหมดข้อมูล: การจำลอง/ }).first()).toBeVisible();
    await switchCity(page, "hatyai");
    await expect(page.getByRole("button", { name: /^โหมดข้อมูล: ข้อมูลย้อนหลัง/ }).first()).toBeVisible();
    await expect(kpi(page, "แรงกดดันระบบระบายน้ำ")).toHaveAccessibleName(/15\.6 %/);
  });
});
