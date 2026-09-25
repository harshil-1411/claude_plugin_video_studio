import { join } from "node:path";
import type { AspectRatio } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { ZONES_VERSION, findPlatformSpecsDir, intersect, layoutZones, loadContracts, maskCollisions, shrinkAway, toPx } from "./index.js";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "specs");
const REAL_IDS = ["facebook-page-api", "instagram", "linkedin", "tiktok", "youtube-shorts"];
const PORTRAIT = { width: 1080, height: 1920, aspect_ratio: "9:16" as const };
/** v2 design caption region on 1080×1920. */
const DESIGN_CAPTION = { x: 90, y: 1260, w: 900, h: 270 };

async function realContracts() {
  const dir = findPlatformSpecsDir({});
  expect(dir).not.toBeNull();
  return loadContracts(dir!);
}

describe("platform-specs/ contracts", () => {
  it("has a valid contract for every supported target", async () => {
    const contracts = await realContracts();
    expect(contracts.map((c) => c.id)).toEqual(REAL_IDS);
    for (const c of contracts) {
      expect(c.verified).toBe("2026-09-25");
      expect(c.video.aspect_ratios).toContain("9:16");
      expect(c.ui_masks.length).toBeGreaterThan(0);
      expect(c.notes?.some((n) => /approximation/i.test(n))).toBe(true);
    }
  });

  it("leaves the design caption region mostly usable for every target", async () => {
    for (const c of await realContracts()) {
      const errors = c.ui_masks.filter((m) => m.severity === "error" && m.aspect_ratio === "9:16");
      const covered = errors.reduce((sum, m) => {
        const o = intersect(DESIGN_CAPTION, toPx(m.rect, 1080, 1920));
        return sum + (o ? o.w * o.h : 0);
      }, 0);
      expect(covered / (DESIGN_CAPTION.w * DESIGN_CAPTION.h), c.id).toBeLessThan(0.2);
    }
  });

  it("maps a caption at y 0.9 into the TikTok footer mask", async () => {
    const tiktok = (await realContracts()).filter((c) => c.id === "tiktok");
    const zones = layoutZones(PORTRAIT, tiktok);
    const low = { x: 90, y: Math.round(0.9 * 1920 - 135), w: 900, h: 270 };
    expect(maskCollisions(low, zones.masks, 1080, 1920).some((c) => c.mask.id === "footer")).toBe(true);
    expect(maskCollisions(zones.caption, zones.masks.filter((m) => m.severity === "error"), 1080, 1920)).toEqual([]);
  });
});

describe("layoutZones", () => {
  it("keeps the design grid without contracts", () => {
    const z = layoutZones(PORTRAIT);
    expect(z.version).toBe(ZONES_VERSION);
    expect(z.content).toEqual({ x: 72, y: 180, w: 936, h: 1060 });
    expect(z.caption).toEqual(DESIGN_CAPTION);
    expect(z.hook).toEqual({ x: 90, y: 180, w: 900, h: 420 });
    expect(z.masks).toEqual([]);
  });

  it("produces sensible zones for every aspect ratio without contracts", () => {
    const sizes: [AspectRatio, number, number][] = [
      ["9:16", 1080, 1920],
      ["9:16", 540, 960],
      ["16:9", 1920, 1080],
      ["1:1", 1080, 1080],
      ["4:5", 1080, 1350],
    ];
    for (const [aspect_ratio, width, height] of sizes) {
      const z = layoutZones({ width, height, aspect_ratio });
      for (const r of [z.content, z.caption, z.hook]) {
        expect(r.w).toBeGreaterThan(0);
        expect(r.h).toBeGreaterThan(0);
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(width);
        expect(r.y + r.h).toBeLessThanOrEqual(height);
      }
      expect(z.content.y + z.content.h, aspect_ratio).toBeLessThanOrEqual(z.caption.y);
      expect(intersect(z.hook, z.content)).toEqual(z.hook);
    }
  });

  it("shrinks content and caption away from every error mask of all targets", async () => {
    const contracts = await realContracts();
    for (const set of [...contracts.map((c) => [c]), contracts]) {
      const z = layoutZones(PORTRAIT, set);
      const errors = z.masks.filter((m) => m.severity === "error");
      const ids = set.map((c) => c.id).join("+");
      expect(maskCollisions(z.content, errors, 1080, 1920), ids).toEqual([]);
      expect(maskCollisions(z.caption, errors, 1080, 1920), ids).toEqual([]);
      expect(maskCollisions(z.hook, errors, 1080, 1920), ids).toEqual([]);
      expect(z.content.y + z.content.h).toBeLessThanOrEqual(z.caption.y);
      // Still most of the design caption width and all of its height.
      expect(z.caption.h, ids).toBe(DESIGN_CAPTION.h);
      expect(z.caption.w / DESIGN_CAPTION.w, ids).toBeGreaterThan(0.85);
      expect(z.targets).toEqual(set.map((c) => c.id));
    }
  });

  it("keeps the design caption region when masks leave less than a caption line", async () => {
    const [demo] = await loadContracts(FIXTURES);
    const blocked = { ...demo!, ui_masks: [{ id: "all", label: "everything", aspect_ratio: "9:16" as const, rect: { x: 0, y: 0.6, w: 1, h: 0.25 }, severity: "error" as const }] };
    const z = layoutZones(PORTRAIT, [blocked]);
    expect(z.caption).toEqual(DESIGN_CAPTION);
    expect(z.content.y + z.content.h).toBeLessThanOrEqual(Math.floor(0.6 * 1920));
  });

  it("ignores warning masks and masks of other aspect ratios", async () => {
    const [demo] = await loadContracts(FIXTURES);
    const soft = { ...demo!, ui_masks: demo!.ui_masks.map((m) => ({ ...m, severity: "warning" as const })) };
    expect(layoutZones(PORTRAIT, [soft]).content).toEqual(layoutZones(PORTRAIT).content);
    expect(layoutZones({ width: 1920, height: 1080, aspect_ratio: "16:9" }, [demo!])).toMatchObject({ masks: [], targets: ["demo-vertical"] });
  });
});

describe("shrinkAway", () => {
  it("cuts the side that keeps the most area", () => {
    expect(shrinkAway({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 90, y: 20, w: 10, h: 60 }])).toEqual({ x: 0, y: 0, w: 90, h: 100 });
    expect(shrinkAway({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 0, y: 80, w: 100, h: 20 }])).toEqual({ x: 0, y: 0, w: 100, h: 80 });
    expect(shrinkAway({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 0, y: 0, w: 100, h: 100 }])).toBeNull();
  });
});
