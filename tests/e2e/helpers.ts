import { expect, type Locator, type Page } from "@playwright/test";

/** Console noise from the software (SwiftShader) WebGL driver used in CI — not app errors. */
const DRIVER_NOISE = /GL Driver Message|GPU stall|WebGL-0x|Automatic fallback to software WebGL|Failed to load resource: net::ERR_/;

/** Collects page errors, console errors and MapLibre style warnings (e.g. unparseable colours). */
export function trackConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const text = m.text();
    if (DRIVER_NOISE.test(text)) return;
    if (m.type() === "error") errors.push(`console.error: ${text}`);
    // MapLibre reports invalid paint values as warnings; they are real rendering bugs
    else if (m.type() === "warning" && /Could not parse|Expected value to be of type/.test(text)) errors.push(`console.warn: ${text}`);
  });
  return errors;
}

/** Load the dashboard and wait until the map canvas and the shell are ready. */
export async function gotoDashboard(page: Page) {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("radiogroup", { name: "เลือกเมือง" })).toBeVisible();
}

export const leftColumn = (page: Page) => page.locator("#shell-left-column");
export const rightColumn = (page: Page) => page.locator("#shell-right-column");
export const dock = (page: Page) => page.getByRole("region", { name: "แผงวิเคราะห์ด้านล่าง" });
export const timeline = (page: Page) => page.getByRole("region", { name: "ไทม์ไลน์" });
export const kpiStrip = (page: Page) => page.getByRole("region", { name: "ตัวชี้วัดหลักของเมือง" });

export async function switchCity(page: Page, city: "bangkok" | "hatyai") {
  const name = city === "bangkok" ? "กรุงเทพมหานคร" : "เทศบาลนครหาดใหญ่";
  await page.getByRole("radiogroup", { name: "เลือกเมือง" }).getByRole("radio", { name }).click();
  await expect(page.getByRole("radiogroup", { name: "เลือกเมือง" }).getByRole("radio", { name })).toHaveAttribute("aria-checked", "true");
  await expect(rightColumn(page).getByRole("heading", { level: 2, name })).toBeVisible({ timeout: 30_000 });
}

/** Select an area through the sidebar search (type, wait for the matching option, Enter). */
export async function searchSelect(page: Page, query: string, expectedHeading: string | RegExp) {
  const box = page.getByRole("combobox", { name: "ค้นหาพื้นที่ตามชื่อหรือรหัส" });
  await box.click();
  await box.fill(query);
  await expect(page.locator("[role=listbox] [role=option]").first()).toBeVisible();
  await box.press("Enter");
  // desktop shows details in the right column; tablet / mobile in an overlay or sheet
  const scope = (await rightColumn(page).count()) ? rightColumn(page) : page;
  await expect(scope.getByRole("heading", { level: 2, name: expectedHeading }).first()).toBeVisible({ timeout: 45_000 });
  // focus stays in the search box after Enter; move it away so single-key shortcuts work
  await box.blur();
}

/** Put keyboard focus on the page body (outside any text field) before single-key shortcuts. */
export async function focusBody(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

/** The KPI tile whose accessible name starts with `prefix`. */
export function kpi(page: Page, prefix: string | RegExp): Locator {
  return kpiStrip(page).getByRole("button", { name: typeof prefix === "string" ? new RegExp(`^${escapeRe(prefix)}`) : prefix });
}

export function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Open the analysis dock if it is collapsed (default on screens shorter than 1050 px). */
export async function openDock(page: Page) {
  const show = page.getByRole("button", { name: /^แสดงแผงวิเคราะห์/ });
  if (await show.isVisible()) await show.click();
  await expect(page.getByRole("button", { name: /^ซ่อนแผงวิเคราะห์/ })).toBeVisible();
}

/** Names of the layer switches that are currently on in the left sidebar. */
export async function activeLayers(page: Page) {
  return leftColumn(page)
    .getByRole("switch")
    .evaluateAll((els) => els.filter((e) => e.getAttribute("aria-checked") === "true").map((e) => e.getAttribute("aria-label") ?? e.textContent ?? ""));
}

/** Number of dialogs that are open (Base UI keeps closing dialogs mounted with data-closed). */
export async function openDialogCount(page: Page) {
  return page.locator("[role=dialog]:not([data-closed]), [role=alertdialog]:not([data-closed])").count();
}

/** The open Base UI Select popup list (distinct from in-page listboxes such as the ranking list). */
export function selectPopup(page: Page) {
  return page.locator("[role=listbox][id^='base-ui']").last();
}
