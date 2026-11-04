import { expect, test } from "@playwright/test";
import { activeLayers, gotoDashboard, kpi, leftColumn, rightColumn, searchSelect, switchCity, trackConsole } from "./helpers";

test.describe("city, search, layers and KPIs (desktop)", () => {
  test("switching city both ways swaps every panel and keeps the console clean", async ({ page }) => {
    const errors = trackConsole(page);
    await gotoDashboard(page);
    await switchCity(page, "hatyai");
    await expect(kpi(page, "ประชากรทั้งเมือง")).toHaveAccessibleName(/138,582/);
    await expect(leftColumn(page).getByRole("switch", { name: "ชุมชน" })).toBeVisible();
    await switchCity(page, "bangkok");
    await expect(kpi(page, "ประชากรทั้งเมือง")).toHaveAccessibleName(/5,422,568/);
    // communities exist only for Hat Yai
    await expect(leftColumn(page).getByRole("switch", { name: "ชุมชน" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("search finds areas by Thai name, English name and code; no-match shows a message", async ({ page }) => {
    await gotoDashboard(page);
    const box = page.getByRole("combobox", { name: "ค้นหาพื้นที่ตามชื่อหรือรหัส" });
    await box.fill("Bang Rak");
    await expect(page.getByRole("option", { name: /บางรัก.*1004/ })).toBeVisible();
    await box.fill("1004");
    await expect(page.getByRole("option", { name: /บางรัก.*1004/ })).toBeVisible();
    await box.fill("zzzz");
    await expect(page.getByText(/ไม่พบพื้นที่ที่ตรงกับ/)).toBeVisible();
    await searchSelect(page, "จตุจักร", "จตุจักร");
    await expect(rightColumn(page).getByText("Chatuchak").first()).toBeVisible();
  });

  test("choropleth layers are mutually exclusive and overlays stack", async ({ page }) => {
    await gotoDashboard(page);
    const left = leftColumn(page);
    await left.getByRole("switch", { name: "ขยะต่อคน" }).click();
    await expect.poll(() => activeLayers(page)).toEqual(expect.arrayContaining(["ขยะต่อคน", "คลองและทางน้ำ"]));
    expect(await activeLayers(page)).not.toContain("ปริมาณขยะ");
    await left.getByRole("switch", { name: "ความหนาแน่นประชากร" }).click();
    await expect.poll(() => activeLayers(page)).not.toContain("ขยะต่อคน");
    // overlays stack with a choropleth
    for (const name of ["จุดเฝ้าระวังขยะ", "ฝนจากสถานีตรวจวัด", "ระดับน้ำในคลอง/แม่น้ำ"]) await left.getByRole("switch", { name }).click();
    await expect
      .poll(() => activeLayers(page))
      .toEqual(expect.arrayContaining(["ความหนาแน่นประชากร", "จุดเฝ้าระวังขยะ", "ฝนจากสถานีตรวจวัด", "ระดับน้ำในคลอง/แม่น้ำ"]));
    // the legend follows the active choropleth
    await expect(page.getByRole("button", { name: "แสดง/ซ่อนคำอธิบายแผนที่" })).toContainText("ความหนาแน่น");
    // switching every choropleth off leaves the map without a fill
    await left.getByRole("switch", { name: "ความหนาแน่นประชากร" }).click();
    await expect.poll(() => activeLayers(page)).not.toContain("ความหนาแน่นประชากร");
  });

  test("layer opacity slider changes the value with the keyboard", async ({ page }) => {
    await gotoDashboard(page);
    await leftColumn(page).getByRole("button", { name: "ปรับความทึบ: ปริมาณขยะ" }).click();
    const slider = leftColumn(page).getByRole("slider", { name: "ความทึบของชั้น ปริมาณขยะ" });
    await expect(slider).toBeVisible();
    const before = Number(await slider.getAttribute("aria-valuenow"));
    await slider.focus();
    for (let i = 0; i < 3; i++) await slider.press("ArrowLeft");
    await expect.poll(async () => Number(await slider.getAttribute("aria-valuenow"))).toBeLessThan(before);
  });

  test("every KPI tile is actionable", async ({ page }) => {
    await gotoDashboard(page);
    await kpi(page, "ประชากรทั้งเมือง").click();
    await expect.poll(() => activeLayers(page)).toContain("ความหนาแน่นประชากร");
    await expect(kpi(page, "ประชากรทั้งเมือง")).toHaveAttribute("aria-pressed", "true");
    await kpi(page, "ขยะที่จัดเก็บได้ต่อคนต่อวัน").click();
    await expect.poll(() => activeLayers(page)).toContain("ขยะต่อคน");
    await kpi(page, "ปริมาณฝนเฉลี่ยรายปีของเมือง").click();
    await expect.poll(() => activeLayers(page)).toContain("ฝนประมาณการรายพื้นที่");
    await kpi(page, "สัดส่วนประชากรในพื้นที่ความเสี่ยงน้ำท่วม").click();
    await expect.poll(() => activeLayers(page)).toContain("ความเสี่ยงน้ำท่วม (แบบจำลอง)");
    await kpi(page, "ปริมาณขยะที่จัดเก็บได้ทั้งเมือง").click();
    await expect.poll(() => activeLayers(page)).toContain("ปริมาณขยะ");
    // drainage KPI opens the dock on the drainage tab
    await kpi(page, "แรงกดดันระบบระบายน้ำ").click();
    await expect(page.getByRole("tab", { name: "การระบายน้ำ", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: /^ซ่อนแผงวิเคราะห์/ })).toBeVisible();
  });

  test("map controls: zoom, north, fit, focus enabled only with a selection, tilt toggles", async ({ page }) => {
    await gotoDashboard(page);
    const toolbar = page.getByRole("toolbar", { name: "ควบคุมแผนที่" });
    await expect(toolbar.getByRole("button", { name: "เลือกพื้นที่ก่อนเพื่อโฟกัส" })).toBeDisabled();
    for (const name of ["ขยายเข้า", "ย่อออก", "หันทิศเหนือขึ้นและปรับเป็นมุมตรง", "แสดงทั้งเมือง"]) await toolbar.getByRole("button", { name }).click();
    const tilt = toolbar.getByRole("button", { name: "มุมมองเอียง (อาคาร 3 มิติ)" });
    await tilt.click();
    await expect(tilt).toHaveAttribute("aria-pressed", "true");
    await tilt.click();
    await expect(tilt).toHaveAttribute("aria-pressed", "false");
    await searchSelect(page, "ปทุมวัน", "ปทุมวัน");
    await expect(toolbar.getByRole("button", { name: /^โฟกัส/ })).toBeEnabled();
  });

  test("legend toggles open and closed", async ({ page }) => {
    await gotoDashboard(page);
    const legend = page.getByRole("button", { name: "แสดง/ซ่อนคำอธิบายแผนที่" });
    const initial = await legend.getAttribute("aria-expanded");
    await legend.click();
    await expect(legend).toHaveAttribute("aria-expanded", initial === "true" ? "false" : "true");
    await legend.click();
    await expect(legend).toHaveAttribute("aria-expanded", initial ?? "false");
  });
});
