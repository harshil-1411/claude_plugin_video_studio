import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SceneVoiceTrack } from "@video-studio/schema";
import { ensureDir } from "@video-studio/core";
import { estimateWordTimings, tokenize } from "./estimate.js";
import { defaultResolver, defaultRunner, runChecked, type CommandRunner, type ToolResolver } from "./exec.js";
import { detectEdgeSilence, probeDurationMs, toWav48kMono, type FfTools } from "./ffmpeg.js";
import type { Availability, Env, SynthesisContext, SynthesisInput, VoiceBackend } from "./types.js";

export const DEFAULT_RATE_WPM = 180;
export const DEFAULT_SAY_VOICE = "Samantha";
/** Audio shorter than this from a non-empty script is treated as a failed synthesis. */
const MIN_AUDIO_MS = 50;

export interface SayVoice {
  name: string;
  locale: string;
  sample: string;
}

/**
 * Parse `say -v '?'` output. Lines look like
 * `Samantha            en_US    # Hello! My name is Samantha.` and names may contain spaces and
 * parentheses, e.g. `Eddy (English (US)) en_US    # Hello!`.
 */
export function parseSayVoices(output: string): SayVoice[] {
  const voices: SayVoice[] = [];
  for (const line of output.split("\n")) {
    const m = /^(.+?)\s+([a-z]{2,3}(?:[_-][A-Za-z0-9]+)+)\s+#\s?(.*)$/.exec(line.trimEnd());
    if (m) voices.push({ name: m[1]!.trim(), locale: m[2]!, sample: m[3]! });
  }
  return voices;
}

export type SystemEngine = "say" | "espeak-ng";

export interface SystemBackendOptions {
  runner?: CommandRunner;
  resolver?: ToolResolver;
  platform?: NodeJS.Platform;
  /** Words per minute (default 180). */
  rate?: number;
  /** Default voice when the scene requests none. */
  voice?: string;
  /**
   * Detect leading/trailing silence with ffmpeg `silencedetect` so estimated words don't start in
   * the silence `say` pads at the edges (default true; falls back to no trimming on any error).
   */
  trimSilence?: boolean;
}

/**
 * Local OS text-to-speech: macOS `say`, or `espeak-ng` on Linux. Audio is converted to 48 kHz mono
 * WAV with ffmpeg; word timings are ESTIMATED (syllable-weighted over the measured duration).
 */
export function createSystemBackend(options: SystemBackendOptions = {}): Omit<VoiceBackend, "available"> & {
  available(env: Env): Availability;
  engine(env: Env): SystemEngine | undefined;
  listVoices(env: Env): Promise<SayVoice[]>;
} {
  const runner = options.runner ?? defaultRunner;
  const resolver = options.resolver ?? defaultResolver;
  const platform = options.platform ?? process.platform;
  const rate = Math.round(options.rate ?? DEFAULT_RATE_WPM);
  const trimSilence = options.trimSilence ?? true;
  let voiceCache: Promise<SayVoice[]> | undefined;

  const engine = (env: Env): SystemEngine | undefined => {
    if (platform === "darwin") return resolver("say", env) ? "say" : undefined;
    if (platform === "linux") return resolver("espeak-ng", env) ? "espeak-ng" : undefined;
    return undefined;
  };

  const listVoices = (env: Env): Promise<SayVoice[]> => {
    if (engine(env) !== "say") return Promise.resolve([]);
    voiceCache ??= runner(resolver("say", env)!, ["-v", "?"])
      .then((r) => (r.code === 0 ? parseSayVoices(r.stdout) : []))
      .catch(() => []);
    return voiceCache;
  };

  const resolveVoice = async (requested: string | undefined, env: Env): Promise<string | undefined> => {
    const eng = engine(env);
    if (eng === "espeak-ng") return requested ?? options.voice;
    if (eng !== "say") return undefined;
    const voices = await listVoices(env);
    const has = (n: string) => voices.some((v) => v.name === n);
    for (const candidate of [requested, options.voice, DEFAULT_SAY_VOICE]) {
      if (candidate && has(candidate)) return candidate;
    }
    return undefined; // system default voice
  };

  const available = (env: Env): Availability => {
    const eng = engine(env);
    if (!eng) {
      return {
        ok: false,
        reason:
          platform === "darwin"
            ? "macOS `say` not found"
            : platform === "linux"
              ? "`espeak-ng` not found on PATH"
              : `no system TTS supported on ${platform}`,
      };
    }
    if (!resolver("ffmpeg", env) || !resolver("ffprobe", env)) {
      return { ok: false, reason: `${eng} found but ffmpeg/ffprobe missing (set FFMPEG_PATH/FFPROBE_PATH or install ffmpeg)` };
    }
    return { ok: true, reason: `${eng} with ffmpeg` };
  };

  const synthesize = async (input: SynthesisInput, ctx: SynthesisContext): Promise<SceneVoiceTrack> => {
    const eng = engine(ctx.env);
    const ffmpeg = resolver("ffmpeg", ctx.env);
    const ffprobe = resolver("ffprobe", ctx.env);
    if (!eng || !ffmpeg || !ffprobe) throw new Error(`system voice backend unavailable: ${available(ctx.env).reason}`);
    const tools: FfTools = { ffmpeg, ffprobe, runner };
    const run = { signal: ctx.signal };
    const voice = await resolveVoice(input.voice, ctx.env);
    const words = tokenize(input.text);

    await ensureDir(ctx.outDir);
    const outFile = join(ctx.outDir, `${input.scene_id}.wav`);
    const work = await mkdtemp(join(tmpdir(), "vs-voice-"));
    try {
      const textFile = join(work, "text.txt");
      await writeFile(textFile, input.text, "utf8");
      if (eng === "say") {
        const raw = join(work, "say.aiff");
        const args = [...(voice ? ["-v", voice] : []), "-r", String(rate), "-o", raw, "-f", textFile];
        await runChecked(runner, resolver("say", ctx.env)!, args, "say", run);
        await toWav48kMono(tools, raw, outFile, run);
      } else {
        const raw = join(work, "espeak.wav");
        const args = [...(voice ? ["-v", voice] : []), "-s", String(rate), "-w", raw, "-f", textFile];
        await runChecked(runner, resolver("espeak-ng", ctx.env)!, args, "espeak-ng", run);
        await toWav48kMono(tools, raw, outFile, run);
      }
      const duration_ms = await probeDurationMs(tools, outFile, run);
      if (words.length > 0 && duration_ms < MIN_AUDIO_MS) {
        throw new Error(
          `${eng} produced no audio for scene ${input.scene_id} (${duration_ms} ms); it may be blocked by a sandbox`,
        );
      }
      const edges = trimSilence ? await detectEdgeSilence(tools, outFile, duration_ms, run) : { leadMs: 0, trailMs: 0 };
      return {
        scene_id: input.scene_id,
        audio_path: outFile,
        duration_ms,
        words: estimateWordTimings(words, duration_ms, edges),
        timing_source: "estimated",
        ...(voice ? { voice } : {}),
        provider: eng === "say" ? "system-say" : "system-espeak-ng",
      };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };

  return {
    id: "system",
    available,
    synthesize,
    resolveVoice,
    cacheOptions: () => ({ rate, platform, trimSilence }),
    engine,
    listVoices,
  };
}
