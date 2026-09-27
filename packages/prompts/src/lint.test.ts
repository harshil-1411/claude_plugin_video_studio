import type { ShotCard } from "@video-studio/schema";
import { describe, expect, it } from "vitest";
import { directorChecks } from "./lint.js";

const card: ShotCard = {
  purpose: "emotion",
  subjects: [{ id: "hero", role: "identity, wardrobe", asset: "a_hero" }],
  action: "The hero lifts the steaming cup and smiles",
  camera: "slow push in",
};
const codes = (c: ShotCard) => directorChecks(c).map((i) => i.code);

describe("directorChecks", () => {
  it("passes a clean card", () => {
    expect(directorChecks(card)).toEqual([]);
    expect(codes({ ...card, camera: "locked" })).toEqual([]);
  });

  it("flags compound camera moves", () => {
    expect(codes({ ...card, camera: "push in and then pan left" })).toEqual(["camera_compound"]);
    expect(codes({ ...card, camera: "slow dolly with a tilt up" })).toEqual(["camera_compound"]);
    const issue = directorChecks({ ...card, camera: "orbit, then zoom" })[0]!;
    expect(issue.path).toBe("shot.camera");
    expect(issue.fix).toMatch(/one camera move/);
  });

  it("flags compound actions", () => {
    expect(codes({ ...card, action: "The hero opens the door and then runs down the stairs" })).toEqual(["action_compound"]);
    expect(codes({ ...card, action: "She sits. After that she reads the letter" })).toEqual(["action_compound"]);
  });

  it("keeps brand text, logos and prices in post", () => {
    expect(codes({ ...card, action: "The hero holds the box with the logo facing the lens" })).toEqual(["brand_text_in_post"]);
    expect(codes({ ...card, look: "a price tag reading $19.99 in the corner" })).toEqual(["brand_text_in_post"]);
    expect(codes({ ...card, environment: "a cafe with a text overlay of the menu" })).toEqual(["brand_text_in_post"]);
    expect(codes({ ...card, on_screen_text: "generated" })).toEqual(["generated_text"]);
  });

  it("caps sound effects and checks speakers", () => {
    const loud = { ...card, audio: { sfx: ["a", "b", "c", "d"] } } as unknown as ShotCard;
    expect(codes(loud)).toEqual(["sfx_count"]);
    expect(codes({ ...card, audio: { dialogue: [{ speaker: "villain", line: "Hello" }] } })).toEqual(["unknown_speaker"]);
    expect(codes({ ...card, audio: { dialogue: [{ speaker: "hero", line: "Hello" }] } })).toEqual([]);
  });
});
