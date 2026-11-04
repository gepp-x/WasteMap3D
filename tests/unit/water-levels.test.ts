import { describe, expect, it } from "vitest";
import { classBySituation, situationLabel } from "@/lib/map/water-levels";

/**
 * Every situation wording present in public/data/<city>/water-levels.json (HII ThaiWater scale tables
 * and the BMA canal watch/critical levels). The BMA wording "ต่ำกว่าระดับเฝ้าระวัง" (below the watch
 * level) contains "เฝ้าระวัง" and must NOT be classed as high.
 */
describe("classBySituation", () => {
  it.each([
    ["ต่ำกว่าระดับเฝ้าระวัง", "normal"],
    ["ถึงระดับเฝ้าระวัง", "high"],
    ["ถึงระดับวิกฤต", "overflow"],
    ["น้ำล้นตลิ่ง", "overflow"],
    ["น้ำมาก", "high"],
    ["น้ำปกติ", "normal"],
    ["น้ำน้อย", "low"],
    ["น้ำน้อยวิกฤติ", "criticalLow"],
    ["Below the watch (warning) level", "normal"],
    ["", "unknown"],
  ] as const)("%s → %s", (text, cls) => {
    expect(classBySituation(text)).toBe(cls);
  });

  it("treats null/undefined as unknown", () => {
    expect(classBySituation(null)).toBe("unknown");
    expect(classBySituation(undefined)).toBe("unknown");
  });
});

describe("situationLabel", () => {
  it("translates published Thai wording and keeps the original", () => {
    expect(situationLabel("ต่ำกว่าระดับเฝ้าระวัง")).toEqual({ th: "ต่ำกว่าระดับเฝ้าระวัง", en: "Below the watch (warning) level" });
    expect(situationLabel(" น้ำปกติ ").en).toBe("Normal (> 30–70 %)");
  });
  it("falls back to the published text for unknown wording", () => {
    expect(situationLabel("สถานะใหม่")).toEqual({ th: "สถานะใหม่", en: "สถานะใหม่" });
  });
});
