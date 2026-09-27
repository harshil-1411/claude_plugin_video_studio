import { z } from "zod";
import { Id, NonEmptyString } from "./common.js";

/**
 * A provider-neutral shot card for generated footage (Phase 7). Prompt compilers turn it into
 * each provider's syntax; the card itself never names a provider or model. Duration and aspect
 * ratio come from the scene and the spec.
 */

/** The one job a shot does in the sequence. */
export const ShotPurpose = z.enum(["emotion", "plot", "pressure"]);

export const ShotSubject = z
  .strictObject({
    id: Id.describe("Stable name used across shots, e.g. hero or product."),
    role: NonEmptyString.describe("What the reference is for, e.g. 'identity, wardrobe' or 'camera movement only'."),
    asset: Id.optional().describe("ContentIR asset id of the reference image or clip."),
  })
  .describe("A character, product or location bound to a reference.");

export const ShotAudio = z
  .strictObject({
    dialogue: z.array(z.strictObject({ speaker: Id, line: NonEmptyString })).optional(),
    sfx: z.array(NonEmptyString).max(3).optional().describe("At most 3 specific sounds, each tied to a visible event."),
    ambience: z.string().optional(),
    music: z.string().optional().describe("Music cue; the licensed or synthesized bed is usually added in the edit instead."),
  })
  .describe("What the shot sounds like.");

export const ShotCard = z
  .strictObject({
    purpose: ShotPurpose,
    subjects: z.array(ShotSubject).max(9).optional(),
    action: NonEmptyString.describe("One clear subject action (timed beats inside it if the shot is over 4 s)."),
    camera: NonEmptyString.describe('One clear camera move, or "locked".'),
    environment: z.string().optional().describe("Location, time, weather and one environmental detail."),
    look: z.string().optional().describe("Lighting, lens, grade and texture."),
    audio: ShotAudio.optional(),
    on_screen_text: z
      .enum(["post", "generated"])
      .optional()
      .describe("post (default): logos, prices, UI and copy are composited afterwards, never generated."),
    continuity: z.array(NonEmptyString).optional().describe("What must stay identical to the previous shot (count, wardrobe, props, handedness)."),
    end_state: z.string().optional().describe("The final image of the shot; lets the next shot start from it."),
    first_frame_from: Id.optional().describe("Scene id whose approved last frame is this shot's first frame."),
    exclusions: z.array(NonEmptyString).optional().describe("Things the model must not do (compiled only where the provider accepts negatives)."),
  })
  .describe("Provider-neutral shot card for a generated_video or avatar scene.");

export type ShotPurpose = z.infer<typeof ShotPurpose>;
export type ShotSubject = z.infer<typeof ShotSubject>;
export type ShotAudio = z.infer<typeof ShotAudio>;
export type ShotCard = z.infer<typeof ShotCard>;
