/** Sound-event captions ([music], sfx captions, [ambient sound]); re-exported from pipeline.ts. */
import type { CaptionWord } from "@video-studio/media";

// ------------------------------------------------------------------------------------ sound-event captions

/** Shortest stretch with only the music bed that gets a `[music]` cue. */
export const MUSIC_CUE_MIN_GAP_MS = 2000;
/** A cue after speech starts this late, so the last spoken caption keeps its display time. */
export const CUE_SETTLE_MS = 300;
/** Longest a `[music]` / `[ambient sound]` cue stays up (it names the sound; it need not last). */
export const CUE_MAX_MS = 3000;
/** How long an sfx caption stays up (the effect's length is not probed). */
export const SFX_CUE_MS = 1500;
/** Cues shorter than this are dropped. */
export const MIN_CUE_MS = 500;
/** Scene id prefix of cue words: cues form their own captions (never merged with speech). */
export const SOUND_CUE_SCENE_PREFIX = "sound:";

export interface SoundCueScene {
  id: string;
  start_ms: number;
  end_ms: number;
  /** The footage's own sound plays (audio mode native or mix, a video with an audio stream). */
  footage_sound?: boolean;
  /** The music bed is silenced here (footage scene in native or mute mode). */
  bed_muted?: boolean;
  /** Sound effects with a caption, at absolute video time. */
  sfx?: Array<{ at_ms: number; caption: string }>;
}

export interface SoundCueInput {
  scenes: SoundCueScene[];
  /** Spoken words (voiceover or transcript) on the video timeline, sorted. */
  speech: ReadonlyArray<{ start_ms: number; end_ms: number }>;
  /** A music bed plays under the video. */
  music: boolean;
  total_ms: number;
}

type Span = { start_ms: number; end_ms: number };

/** `spans` minus `cut`, both as [start, end) intervals. */
function subtractSpans(spans: readonly Span[], cut: readonly Span[]): Span[] {
  let out = spans.map((s) => ({ ...s }));
  for (const c of cut) {
    const next: Span[] = [];
    for (const s of out) {
      if (c.end_ms <= s.start_ms || c.start_ms >= s.end_ms) {
        next.push(s);
        continue;
      }
      if (c.start_ms > s.start_ms) next.push({ start_ms: s.start_ms, end_ms: c.start_ms });
      if (c.end_ms < s.end_ms) next.push({ start_ms: c.end_ms, end_ms: s.end_ms });
    }
    out = next;
  }
  return out;
}

/** `[applause]` stays; `applause` becomes `[applause]`. */
export function bracketCue(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  return /^\[.*\]$/.test(t) ? t : `[${t.replace(/^\[|\]$/g, "")}]`;
}

/** True for a sound-event cue word such as `[music]`. */
export function isSoundCue(word: { word: string; scene_id?: string }): boolean {
  return word.scene_id?.startsWith(SOUND_CUE_SCENE_PREFIX) ?? /^\[.*\]$/.test(word.word);
}

/**
 * Bracketed sound-event cues for accessibility, as caption "words" (one cue = one word, which may
 * contain spaces) that never overlap speech:
 * - each sfx `caption` at its time, for up to {@link SFX_CUE_MS} (dropped, with a warning, when
 *   the effect starts during speech);
 * - `[ambient sound]` at the start of a footage scene whose own sound plays and that has no
 *   spoken words;
 * - `[music]` where only the music bed plays for at least {@link MUSIC_CUE_MIN_GAP_MS} (no speech,
 *   no footage sound, bed not muted), shown at the start of that stretch.
 * Cue words carry scene_id `sound:<scene id>`, so the caption engine gives them captions of their own.
 */
export function soundEventCues(i: SoundCueInput, warnings: string[] = []): CaptionWord[] {
  const speech: Span[] = i.speech.map((w) => ({ start_ms: w.start_ms, end_ms: Math.max(w.end_ms, w.start_ms + 1) }));
  const sceneAt = (ms: number) => i.scenes.find((s) => ms >= s.start_ms && ms < s.end_ms) ?? i.scenes[i.scenes.length - 1];
  const cues: CaptionWord[] = [];
  const push = (word: string, start: number, end: number) => cues.push({ word, start_ms: Math.round(start), end_ms: Math.round(end), scene_id: `${SOUND_CUE_SCENE_PREFIX}${sceneAt(start)?.id ?? ""}` });
  const nextSpeechStart = (ms: number) => speech.find((s) => s.start_ms >= ms)?.start_ms ?? Number.POSITIVE_INFINITY;

  // 1. sfx captions
  const sfx = i.scenes.flatMap((s) => (s.sfx ?? []).map((x) => ({ ...x, scene: s }))).sort((a, b) => a.at_ms - b.at_ms);
  sfx.forEach((x, k) => {
    const text = x.caption.trim();
    if (!text || text === "[]") return;
    const word = bracketCue(text);
    if (x.at_ms >= i.total_ms) return;
    if (speech.some((s) => x.at_ms >= s.start_ms && x.at_ms < s.end_ms)) {
      warnings.push(`captions: sfx caption ${word} in ${x.scene.id} starts during speech; not shown (move the effect into a pause)`);
      return;
    }
    const end = Math.min(x.at_ms + SFX_CUE_MS, i.total_ms, nextSpeechStart(x.at_ms), sfx[k + 1]?.at_ms ?? Number.POSITIVE_INFINITY);
    if (end - x.at_ms < MIN_CUE_MS) {
      warnings.push(`captions: sfx caption ${word} in ${x.scene.id} has under ${MIN_CUE_MS} ms before the next speech or effect; not shown`);
      return;
    }
    push(word, x.at_ms, end);
  });
  const taken = (): Span[] => [...speech, ...cues];

  // 2. ambient sound of footage scenes without speech
  for (const s of i.scenes) {
    if (!s.footage_sound) continue;
    if (speech.some((w) => w.start_ms < s.end_ms && w.end_ms > s.start_ms)) continue;
    const free = subtractSpans([{ start_ms: s.start_ms, end_ms: s.end_ms }], taken()).find((f) => f.end_ms - f.start_ms >= MIN_CUE_MS);
    if (free) push("[ambient sound]", free.start_ms, Math.min(free.end_ms, free.start_ms + CUE_MAX_MS));
  }

  // 3. music-only stretches
  if (i.music) {
    const blocked = [
      ...taken(),
      ...i.scenes.filter((s) => s.footage_sound || s.bed_muted).map((s) => ({ start_ms: s.start_ms, end_ms: s.end_ms })),
    ];
    for (const f of subtractSpans([{ start_ms: 0, end_ms: i.total_ms }], blocked)) {
      if (f.end_ms - f.start_ms < MUSIC_CUE_MIN_GAP_MS) continue;
      const afterSpeech = speech.some((w) => Math.abs(w.end_ms - f.start_ms) <= 1);
      const start = f.start_ms + (afterSpeech ? CUE_SETTLE_MS : 0);
      push("[music]", start, Math.min(f.end_ms, start + CUE_MAX_MS));
    }
  }
  return cues.sort((a, b) => a.start_ms - b.start_ms);
}
