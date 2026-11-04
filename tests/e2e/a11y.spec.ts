import AxeBuilder from "@axe-core/playwright";
import { devices, expect, test, type Page } from "@playwright/test";

/**
 * Accessibility gate (WCAG 2.1 AA): no serious/critical axe violations in every major UI state,
 * plus the keyboard contracts axe cannot see (skip link, dialog focus in / trap / Esc / focus return).
 *
 * Runs with `prefers-reduced-motion: reduce`. That is a supported mode of the app (it must be
 * accessible too) and it stops the continuous map / water animations, which keeps software-WebGL CI
 * runners at a usable frame rate so entrance tweens settle before axe inspects the DOM.
 */

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const BLOCKING = new Set(["serious", "critical"]);

// Only the desktop project matches this file (playwright.config: mobile runs mobile.spec.ts only);
// the phone layout is emulated explicitly in the last describe block.
test.use({ reducedMotion: "reduce" });

type AxeOptions = {
  /**
   * WCAG 2.5.3 "label in name" is checked by axe with whitespace tokenisation, which cannot segment
   * Thai (no spaces between words) and reports false positives such as "ข้อค้นพบ" ⊂ "ข้อค้นพบสำคัญ".
   * Thai-language states skip that one rule; `english state` runs it for real.
   */
  thai?: boolean;
};

async function expectNoBlockingViolations(page: Page, state: string, { thai = true }: AxeOptions = {}) {
  let builder = new AxeBuilder({ page }).withTags(WCAG);
  if (thai) builder = builder.disableRules(["label-content-name-mismatch"]);
  const { violations } = await builder.analyze();
  const blocking = violations
    .filter((v) => BLOCKING.has(v.impact ?? ""))
    .map((v) => `${v.impact} ${v.id} (${v.nodes.length}): ${v.help}\n    ${v.nodes.slice(0, 5).map((n) => n.target.join(" ")).join("\n    ")}`);
  // soft: keep walking the remaining states so one run reports every failing state
  expect.soft(blocking, `serious/critical axe violations in "${state}"`).toEqual([]);
}

async function openApp(page: Page) {
  await page.goto("/");
  await expect(page.locator(".maplibregl-canvas")).toBeVisible();
  await expect(page.getByRole("heading", { name: "กรุงเทพมหานคร" }).first()).toBeVisible();
}

async function selectArea(page: Page, query: string) {
  await page.keyboard.press("/");
  await page.keyboard.type(query);
  await page.keyboard.press("Enter");
}

/** Accessible name of the focused element and whether it sits inside an open dialog. */
function focusInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      name: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim(),
      inDialog: Boolean(el?.closest('[role="dialog"]')),
    };
  });
}

test.describe("axe: desktop states", () => {
  test("initial Bangkok view", async ({ page }) => {
    await openApp(page);
    await expectNoBlockingViolations(page, "initial Bangkok view");
  });

  test("English UI (label-in-name checked)", async ({ page }) => {
    await openApp(page);
    await page.getByRole("radio", { name: "English" }).first().click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expectNoBlockingViolations(page, "English UI", { thai: false });
  });

  test("district details, every tab", async ({ page }) => {
    await openApp(page);
    await selectArea(page, "จตุจักร");
    await expect(page.getByText("Chatuchak").first()).toBeVisible();
    const tabs = page.locator('[role="tab"][id^="area-details-"]');
    await expect(tabs.first()).toBeVisible();
    const count = await tabs.count();
    expect(count).toBeGreaterThan(1);
    for (let i = 0; i < count; i++) {
      const tab = tabs.nth(i);
      const label = (await tab.innerText()).trim();
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectNoBlockingViolations(page, `district tab "${label}"`);
    }
  });

  test("analysis dock, every tab", async ({ page }) => {
    await openApp(page);
    await selectArea(page, "จตุจักร");
    const toggle = page.locator('button[aria-controls="bottom-dock-body"]');
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const tabs = page.locator('[role="tab"][id^="bottom-dock-tab-"]');
    for (let i = 0; i < (await tabs.count()); i++) {
      const tab = tabs.nth(i);
      const label = (await tab.innerText()).trim();
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectNoBlockingViolations(page, `dock tab "${label}"`);
    }
  });

  test("Scenario Lab open with a preset applied", async ({ page }) => {
    await openApp(page);
    await page.locator(".maplibregl-canvas").focus();
    await page.keyboard.press("s");
    await page.getByRole("button", { name: /ฝนตกหนักมาก/ }).first().click();
    await expect(page.getByText("SIMULATION — NOT AN OFFICIAL FLOOD FORECAST").first()).toBeVisible();
    await expectNoBlockingViolations(page, "Scenario Lab");
  });

  for (const [state, opener] of [
    ["data sources drawer", "แหล่งข้อมูลและวิธีการ"],
    ["settings dialog", "การตั้งค่า"],
    ["Insight Explorer", "ข้อค้นพบสำคัญ"],
  ] as const) {
    test(state, async ({ page }) => {
      await openApp(page);
      await page.getByRole("button", { name: opener, exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoBlockingViolations(page, state);
    });
  }

  test("Hat Yai with a community zone selected", async ({ page }) => {
    await openApp(page);
    await page.getByText("หาดใหญ่", { exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "เทศบาลนครหาดใหญ่" }).first()).toBeVisible();
    await expectNoBlockingViolations(page, "Hat Yai overview");
  });

  test("3D digital-twin view", async ({ page }) => {
    await openApp(page);
    await page.locator(".maplibregl-canvas").focus();
    await page.keyboard.press("2");
    await expect(page.getByRole("region", { name: "ดิจิทัลทวิน 3 มิติของเมือง" })).toBeVisible();
    await expectNoBlockingViolations(page, "3D view");
  });
});

test.describe("keyboard contracts", () => {
  test("skip link is the first stop, becomes visible and moves focus to the stage", async ({ page }) => {
    await openApp(page);
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "ข้ามไปยังแผนที่" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("#stage"))), { message: "focus inside #stage after the skip link" })
      .toBe(true);
  });

  for (const [dialog, opener] of [
    ["data sources drawer", "แหล่งข้อมูลและวิธีการ"],
    ["settings dialog", "การตั้งค่า"],
    ["Insight Explorer", "ข้อค้นพบสำคัญ"],
  ] as const) {
    test(`${dialog}: focus moves in, Tab stays in, one Esc closes, focus returns`, async ({ page }) => {
      await openApp(page);
      const trigger = page.getByRole("button", { name: opener, exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect.poll(async () => (await focusInfo(page)).inDialog, { message: "initial focus inside the dialog" }).toBe(true);

      // Brisk, human-like tabbing in both directions must never reach the page behind the modal.
      const escaped: string[] = [];
      for (const key of ["Tab", "Shift+Tab"]) {
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press(key);
          await page.waitForTimeout(60);
          const f = await focusInfo(page);
          if (!f.inDialog) escaped.push(`${key} #${i + 1} → "${f.name.slice(0, 40)}"`);
        }
      }
      expect(escaped, "focus left the modal dialog").toEqual([]);

      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
});

test.describe("phone layout", () => {
  // Pixel 7 emulation without `defaultBrowserType` (not allowed inside a describe block).
  const { defaultBrowserType: _ignored, ...pixel7 } = devices["Pixel 7"];
  void _ignored;
  test.use({ ...pixel7 });

  test("bottom sheet, every tab", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".maplibregl-canvas")).toBeVisible();
    await expectNoBlockingViolations(page, "phone initial");
    const tabs = page.locator('[role="tab"]:not([inert] *)');
    for (let i = 0; i < (await tabs.count()); i++) {
      const tab = tabs.nth(i);
      if (!(await tab.isVisible())) continue;
      const label = (await tab.innerText()).trim();
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
      await expectNoBlockingViolations(page, `phone sheet tab "${label}"`);
    }
  });
});
