import type { ShotCard } from "@video-studio/schema";

/** One finding about a shot card or its compiled prompt; `fix` says what to change. */
export interface PromptIssue {
  code: string;
  path: string;
  message: string;
  fix?: string;
}

/** Camera move vocabulary, each alternative a distinct move (synonyms share a group). */
const CAMERA_MOVES: readonly [string, RegExp][] = [
  ["pan", /\bpan(s|ning|ned)?\b/i],
  ["tilt", /\btilt(s|ing|ed)?\b/i],
  ["push", /\b(push(es|ing)?|dolly|dollies|dollying)\b(?![- ](out|back))/i],
  ["pull", /\b(pull(s|ing)?[- ]?(out|back)|dolly[- ](out|back))\b/i],
  ["truck", /\btruck(s|ing)?\b/i],
  ["zoom", /\bzoom(s|ing)?\b/i],
  ["orbit", /\b(orbit(s|ing)?|arc(s|ing)?)\b/i],
  ["crane", /\b(crane|boom|pedestal)(s|ing)?\b/i],
  ["track", /\b(track(s|ing)?|follow(s|ing)?)\b/i],
  ["roll", /\b(roll(s|ing)?|dutch)\b/i],
  ["whip", /\bwhip\b/i],
  ["handheld", /\b(handheld|shake|shaky)\b/i],
];

const SEQUENCE = /\b(and then|then|followed by|after that|afterwards|before (it|she|he|they|the camera)|next,)\b/i;

/** Text, brand marks or prices that belong in the edit, not in generated pixels. */
const BRAND_TEXT = /(\b(logos?|wordmarks?|prices?|price tags?|pricing|text overlays?|captions?|subtitles?|title cards?|headlines?|lettering|typography|on-screen text|UI|watermarks?)\b|[$€£₹]\s?\d)/i;

/**
 * Director checks on one shot card (provider-independent): one camera move, one action, at most
 * 3 SFX, brand text and prices composited in post, dialogue by a known subject. Heuristic: every
 * finding is a warning with a fix, never a hard error.
 */
export function directorChecks(card: ShotCard, at = "shot"): PromptIssue[] {
  const out: PromptIssue[] = [];
  const moves = CAMERA_MOVES.filter(([, re]) => re.test(card.camera)).map(([name]) => name);
  if (moves.length > 1 || (moves.length === 1 && SEQUENCE.test(card.camera))) {
    out.push({
      code: "camera_compound",
      path: `${at}.camera`,
      message: `"${card.camera}" reads as more than one camera move (${moves.join(", ")})`,
      fix: "keep one camera move per shot (or \"locked\"); give the second move its own shot",
    });
  }
  if (SEQUENCE.test(card.action)) {
    out.push({
      code: "action_compound",
      path: `${at}.action`,
      message: `"${card.action}" chains several actions`,
      fix: "keep one clear action per shot; split the rest into the next shot (chain it with first_frame_from)",
    });
  }
  const sfx = card.audio?.sfx ?? [];
  if (sfx.length > 3) {
    out.push({ code: "sfx_count", path: `${at}.audio.sfx`, message: `${sfx.length} sound effects; at most 3 read clearly`, fix: "keep the 3 tied to the most visible events" });
  }
  const textMode = card.on_screen_text ?? "post";
  if (textMode === "generated") {
    out.push({
      code: "generated_text",
      path: `${at}.on_screen_text`,
      message: "generated text, logos and prices are unreliable (misspelt, warped, off-brand)",
      fix: 'set on_screen_text: "post" and composite the text in the edit',
    });
  } else {
    for (const field of ["action", "environment", "look"] as const) {
      const value = card[field];
      const m = value ? BRAND_TEXT.exec(value) : null;
      if (m) {
        out.push({
          code: "brand_text_in_post",
          path: `${at}.${field}`,
          message: `mentions "${m[0].trim()}", but on-screen text, logos and prices are composited in post`,
          fix: "describe a clean surface where the text or logo goes and add it in the edit (on_screen_text: post)",
        });
      }
    }
  }
  const ids = new Set((card.subjects ?? []).map((s) => s.id));
  if (ids.size) {
    for (const [i, d] of (card.audio?.dialogue ?? []).entries()) {
      if (!ids.has(d.speaker)) {
        out.push({ code: "unknown_speaker", path: `${at}.audio.dialogue.${i}.speaker`, message: `speaker "${d.speaker}" is not one of the shot's subjects`, fix: `use one of ${[...ids].join(", ")} or add the speaker to subjects` });
      }
    }
  }
  return out;
}
