import type { Scene } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { cutawayPicture } from "./select.js";

describe("cutaway picture", () => {
  const scene: Scene = {
    id: "s02",
    duration_sec: 4,
    purpose: "point",
    voiceover: "",
    visual_strategy: "user_asset",
    footage: { asset: "v1", in_sec: 12, out_sec: 16, cutaway: true },
    deterministic: { kind: "stat", props: { value: 40, unit: "%", label: "faster" } },
    visual_requirements: {},
    claim_refs: [],
  };

  it("renders the graphic alone, independent of the clip span", () => {
    const pic = cutawayPicture(scene);
    expect(pic.footage).toBeUndefined();
    expect(pic.visual_strategy).toBe("motion_graphic");
    expect(pic.deterministic).toEqual(scene.deterministic);
    expect(cutawayPicture({ ...scene, footage: { ...scene.footage!, in_sec: 30, out_sec: 34 } })).toEqual(pic);
  });

  it("leaves other scenes alone", () => {
    const plain = { ...scene, footage: { asset: "v1", in_sec: 0 } };
    expect(cutawayPicture(plain)).toBe(plain);
    const noGraphic = { ...scene, deterministic: undefined };
    expect(cutawayPicture(noGraphic)).toBe(noGraphic);
  });
});
