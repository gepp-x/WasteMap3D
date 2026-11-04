import { expect, test } from "@playwright/test";
import { focusBody, gotoDashboard, kpiStrip, searchSelect, trackConsole } from "./helpers";

test.describe("layout, resizable columns and 3D controls (desktop)", () => {
  test("columns resize with the keyboard, reset on double-click and persist across reloads", async ({ page }) => {
    await gotoDashboard(page);
    const left = page.getByRole("separator", { name: /^ปรับความกว้างแผงควบคุม/ });
    const right = page.getByRole("separator", { name: /^ปรับความกว้างแผงรายละเอียด/ });
    const leftStart = Number(await left.getAttribute("aria-valuenow"));
    await left.focus();
    for (let i = 0; i < 4; i++) await left.press("ArrowRight");
    await expect.poll(async () => Number(await left.getAttribute("aria-valuenow"))).toBeGreaterThan(leftStart);
    const rightStart = Number(await right.getAttribute("aria-valuenow"));
    await right.focus();
    for (let i = 0; i < 4; i++) await right.press("ArrowLeft");
    await expect.poll(async () => Number(await right.getAttribute("aria-valuenow"))).toBeGreaterThan(rightStart);
    const persisted = await right.getAttribute("aria-valuenow");
    await left.dblclick();
    await expect(left).toHaveAttribute("aria-valuenow", String(leftStart));
    await page.reload();
    await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 45_000 });
    await expect(page.getByRole("separator", { name: /^ปรับความกว้างแผงรายละเอียด/ })).toHaveAttribute("aria-valuenow", persisted!);
    // the stage never gets narrower than its minimum
    const stage = await page.getByRole("region", { name: "พื้นที่แสดงผลแผนที่และแบบจำลอง" }).boundingBox();
    expect(stage!.width).toBeGreaterThanOrEqual(479);
  });

  test("KPI values and units are not clipped at 1440 × 900", async ({ page }) => {
    await gotoDashboard(page);
    const clipped = await kpiStrip(page)
      .getByRole("button")
      .evaluateAll((tiles) =>
        tiles.flatMap((tile) =>
          [...tile.querySelectorAll<HTMLElement>("*")]
            .filter((e) => e.children.length === 0 && e.textContent!.trim() && /\d/.test(tile.textContent!) && e.scrollWidth > e.clientWidth + 1 && e.clientWidth < 12)
            .map((e) => `${tile.getAttribute("aria-label")!.slice(0, 30)} → "${e.textContent!.trim()}" (${e.clientWidth}px of ${e.scrollWidth}px)`),
        ),
      );
    expect(clipped, "units squeezed to a few pixels inside KPI tiles").toEqual([]);
  });

  test("3D twin: camera presets, quality cycle, neighbourhood scope and split pane resize", async ({ page }) => {
    const errors = trackConsole(page);
    await gotoDashboard(page);
    await focusBody(page);
    await page.keyboard.press("2");
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll("canvas")).some((c) => !c.classList.contains("maplibregl-canvas") && c.width > 0 && !!(c.getContext("webgl2") || c.getContext("webgl"))),
          ),
        { timeout: 30_000 },
      )
      .toBe(true);
    for (const name of ["มุมเฉียง (ไอโซเมตริก)", "มุมบนลงล่าง", "ภาพรวม"]) await page.getByRole("button", { name, exact: true }).click();
    const neighbourhood = page.getByRole("button", { name: "ย่าน", exact: true });
    await expect(neighbourhood).toHaveAttribute("aria-disabled", "true");
    const quality = page.getByRole("button", { name: /^คุณภาพการแสดงผล/ });
    const labels = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const label = (await quality.getAttribute("aria-label"))!;
      labels.add(label.replace(/\..*/, ""));
      await quality.click();
      await expect(quality).not.toHaveAttribute("aria-label", label);
    }
    expect(labels.size).toBe(4);
    await searchSelect(page, "จตุจักร", "จตุจักร");
    await expect(neighbourhood).not.toHaveAttribute("aria-disabled", "true");
    await neighbourhood.click();
    await expect(neighbourhood).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText(/OpenStreetMap contributors/).first()).toBeVisible();
    await page.getByRole("button", { name: "รีเซ็ตมุมมอง (กลับสู่ภาพรวมเมือง)" }).click();
    await expect(page.getByRole("button", { name: "เมือง", exact: true })).toHaveAttribute("aria-pressed", "true");

    await focusBody(page);
    await page.keyboard.press("3");
    const split = page.getByRole("separator", { name: "ปรับสัดส่วนแผนที่และมุมมอง 3 มิติ" });
    await expect(split).toHaveAttribute("aria-valuenow", "50");
    await split.focus();
    for (let i = 0; i < 3; i++) await split.press("ArrowLeft");
    await expect.poll(async () => Number(await split.getAttribute("aria-valuenow"))).toBeLessThan(50);
    expect(errors).toEqual([]);
  });
});
