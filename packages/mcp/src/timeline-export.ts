/**
 * NLE timeline export (Phase 6.6 item 8): `dist/timeline/` with the scene clips, the final audio
 * mix and the captions under `media/`, plus `project.fcpxml` (FCPXML 1.10, Final Cut Pro and
 * DaVinci Resolve) and `project.otio` (OpenTimelineIO JSON) that lay them out frame-accurately.
 *
 * Choices (documented in the generated README too):
 * - **Placement:** scenes sit back to back on the frame grid the assembly used: scene i has
 *   `round(duration_ms * fps / 1000)` frames (at least 1) and starts where scene i-1 ends. The
 *   assembly keeps every scene on its slot boundary even with a transition (the outgoing picture
 *   holds its last frame and is blended into the incoming scene's first frames), so plain cuts at
 *   those bounds reproduce the reel's timing exactly; only the blend itself is not rebuilt.
 *   Each transition is recorded as a marker on the incoming clip (kind and length) so the editor
 *   can re-apply it; an NLE transition would need clip handles the scene renders do not have.
 * - **Audio:** the delivered mix (voice, music, scene audio, loudness-normalized), decoded from the
 *   clean master to 48 kHz stereo PCM and padded/trimmed to the exact sequence length, as one
 *   connected clip (FCPXML lane -1) / one audio track spanning the sequence. Scene clips that
 *   carry their own audio are placed video-only so nothing plays twice.
 * - **Captions:** a sidecar `media/captions.srt` named in a sequence note (FCPXML) and in the
 *   timeline metadata (OTIO). Both Final Cut Pro (File > Import > Captions) and Resolve
 *   (File > Import > Subtitle) import SRT; FCPXML `<caption>` elements are Final Cut-specific and
 *   Resolve's FCPXML import handles them unreliably, so the sidecar is the more robust choice.
 *
 * Everything written is deterministic: the same render gives the same bytes. The export is
 * unverified until someone imports it into an editor.
 */
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffprobe, runFfmpeg, type FfmpegTools } from "@video-studio/media";

export const TIMELINE_FORMATS = ["fcpxml", "otio"] as const;
export type TimelineFormat = (typeof TIMELINE_FORMATS)[number];
export const TIMELINE_STATUS = "unverified until imported into an editor";
export const TIMELINE_AUDIO_RATE = 48_000;

/** Frame duration as a rational number of seconds: `num/den` s (1/30 for 30 fps, 1001/30000 for 29.97). */
export interface FrameRational {
  num: number;
  den: number;
}

export function frameRational(fps: number): FrameRational {
  if (!(fps > 0)) throw new Error(`timeline: fps must be > 0 (got ${fps})`);
  if (Number.isInteger(fps)) return { num: 1, den: fps };
  // NTSC rates: 23.976, 29.97, 59.94 → 1001/(k*1000).
  const k = Math.round((fps * 1001) / 1000);
  if (Math.abs((k * 1000) / 1001 - fps) < 0.01) return { num: 1001, den: k * 1000 };
  throw new Error(`timeline: unsupported frame rate ${fps} (integer or NTSC 1000/1001 rates only)`);
}

/** Frames on the assembly's grid for a slot of `ms` (same rounding as the concat). */
export const slotFrames = (ms: number, fps: number) => Math.max(1, Math.round((ms * fps) / 1000));

export interface TimelineClip {
  id: string;
  /** Path relative to the timeline folder, e.g. `media/s01.mp4`. */
  media: string;
  /** Start on the sequence, in frames. */
  offset: number;
  /** Length on the sequence, in frames. */
  duration: number;
  /** Length of the media file, in whole frames (≥ duration). */
  media_frames: number;
  /** The clip file has its own audio stream (placed video-only: the mix already has it). */
  has_audio: boolean;
  placeholder?: boolean;
  /** Transition the reel draws over this clip's first frames. */
  transition_in?: { kind: string; frames: number };
}

export interface TimelineModel {
  title: string;
  generator: { name: string; version: string };
  width: number;
  height: number;
  fps: number;
  frame: FrameRational;
  total_frames: number;
  clips: TimelineClip[];
  /** The final mix, spanning the sequence. */
  audio?: { media: string; samples: number; channels: number };
  captions?: { media: string };
}

// ------------------------------------------------------------------------------------ text helpers

export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    // XML 1.0 forbids most control characters, even escaped.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

/** A relative URL for a timeline-relative path: each segment percent-encoded. */
export function relUrl(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** `n` frames as an FCPXML rational time: `0s`, or `<n*num>/<den>s`. */
export function fcpTime(frames: number, f: FrameRational): string {
  if (!Number.isInteger(frames) || frames < 0) throw new Error(`timeline: frame count must be a non-negative integer (got ${frames})`);
  return frames === 0 ? "0s" : `${frames * f.num}/${f.den}s`;
}

const attrs = (a: Record<string, string | number | undefined>) =>
  Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${xmlEscape(String(v))}"`)
    .join("");

const transitionNote = (t: { kind: string; frames: number }, fps: number) =>
  `transition: ${t.kind}, ${t.frames} frame(s) (${((t.frames / fps) * 1000).toFixed(0)} ms) blended over the start of this clip in reel.mp4; re-apply it in the editor`;

// ------------------------------------------------------------------------------------ FCPXML 1.10

export function buildFcpxml(m: TimelineModel): string {
  const f = m.frame;
  const t = (n: number) => fcpTime(n, f);
  const L: string[] = [];
  L.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  L.push(`<!DOCTYPE fcpxml>`);
  L.push(`<fcpxml version="1.10">`);
  L.push(`  <resources>`);
  L.push(`    <format${attrs({ id: "r1", frameDuration: `${f.num}/${f.den}s`, width: m.width, height: m.height, colorSpace: "1-1-1 (Rec. 709)" })}/>`);
  // Asset ids: r2.. for the scene clips (in order), then the audio mix.
  const assetId = (i: number) => `r${i + 2}`;
  m.clips.forEach((c, i) => {
    L.push(
      `    <asset${attrs({
        id: assetId(i),
        name: c.id,
        start: "0s",
        duration: t(c.media_frames),
        hasVideo: 1,
        format: "r1",
        videoSources: 1,
        hasAudio: c.has_audio ? 1 : 0,
        ...(c.has_audio ? { audioSources: 1, audioChannels: 2, audioRate: TIMELINE_AUDIO_RATE } : {}),
      })}>`,
    );
    L.push(`      <media-rep${attrs({ kind: "original-media", src: relUrl(c.media) })}/>`);
    L.push(`    </asset>`);
  });
  const audioId = assetId(m.clips.length);
  if (m.audio) {
    L.push(
      `    <asset${attrs({ id: audioId, name: "audio mix", start: "0s", duration: `${m.audio.samples}/${TIMELINE_AUDIO_RATE}s`, hasVideo: 0, hasAudio: 1, audioSources: 1, audioChannels: m.audio.channels, audioRate: TIMELINE_AUDIO_RATE })}>`,
    );
    L.push(`      <media-rep${attrs({ kind: "original-media", src: relUrl(m.audio.media) })}/>`);
    L.push(`    </asset>`);
  }
  L.push(`  </resources>`);
  L.push(`  <library>`);
  L.push(`    <event${attrs({ name: m.title })}>`);
  L.push(`      <project${attrs({ name: m.title })}>`);
  L.push(`        <sequence${attrs({ format: "r1", duration: t(m.total_frames), tcStart: "0s", tcFormat: "NDF", audioLayout: "stereo", audioRate: "48k" })}>`);
  const notes = [
    `Exported by ${m.generator.name} ${m.generator.version}; ${TIMELINE_STATUS}.`,
    ...(m.captions ? [`Captions: ${m.captions.media} (SRT sidecar; import it with File > Import > Captions in Final Cut Pro or File > Import > Subtitle in DaVinci Resolve).`] : []),
  ];
  L.push(`          <note>${xmlEscape(notes.join(" "))}</note>`);
  L.push(`          <spine>`);
  m.clips.forEach((c, i) => {
    L.push(
      `            <asset-clip${attrs({ ref: assetId(i), offset: t(c.offset), name: c.id, start: "0s", duration: t(c.duration), format: "r1", tcFormat: "NDF", ...(c.has_audio ? { srcEnable: "video" } : {}) })}>`,
    );
    if (c.placeholder) L.push(`              <note>${xmlEscape("placeholder card: replace with the real shot")}</note>`);
    // The mix hangs off the first clip (anchored at its start) and runs the whole sequence.
    if (i === 0 && m.audio) {
      L.push(`              <asset-clip${attrs({ ref: audioId, lane: -1, offset: "0s", name: "audio mix", start: "0s", duration: t(m.total_frames), audioRole: "dialogue" })}/>`);
    }
    if (c.transition_in) L.push(`              <marker${attrs({ start: "0s", duration: t(Math.min(c.transition_in.frames, c.duration)), value: transitionNote(c.transition_in, m.fps) })}/>`);
    L.push(`            </asset-clip>`);
  });
  L.push(`          </spine>`);
  L.push(`        </sequence>`);
  L.push(`      </project>`);
  L.push(`    </event>`);
  L.push(`  </library>`);
  L.push(`</fcpxml>`);
  return L.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------ OTIO

/** A JSON number that must be written as a float (`15.0`): OTIO's RationalTime fields are doubles. */
class F {
  constructor(readonly v: number) {}
}
type J = null | boolean | string | number | F | J[] | { [k: string]: J };

function stringifyJson(v: J, indent = ""): string {
  const next = indent + "    ";
  if (v instanceof F) return Number.isInteger(v.v) ? v.v.toFixed(1) : String(v.v);
  if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => next + stringifyJson(x, next)).join(",\n")}\n${indent}]` : "[]";
  const keys = Object.keys(v);
  return keys.length ? `{\n${keys.map((k) => `${next}${JSON.stringify(k)}: ${stringifyJson(v[k]!, next)}`).join(",\n")}\n${indent}}` : "{}";
}

export function buildOtio(m: TimelineModel): string {
  const rate = m.frame.den / m.frame.num;
  const rt = (frames: number): J => ({ OTIO_SCHEMA: "RationalTime.1", rate: new F(rate), value: new F(frames) });
  const range = (start: number, dur: number): J => ({ OTIO_SCHEMA: "TimeRange.1", duration: rt(dur), start_time: rt(start) });
  const ref = (url: string, frames: number): J => ({ OTIO_SCHEMA: "ExternalReference.1", available_range: range(0, frames), metadata: {}, name: "", target_url: relUrl(url) });
  const clip = (name: string, url: string, mediaFrames: number, dur: number, markers: J[], meta: Record<string, J>): J => ({
    OTIO_SCHEMA: "Clip.1",
    effects: [],
    enabled: true,
    markers,
    media_reference: ref(url, mediaFrames),
    metadata: meta,
    name,
    source_range: range(0, dur),
  });
  const track = (name: string, kind: "Video" | "Audio", children: J[]): J => ({
    OTIO_SCHEMA: "Track.1",
    children,
    effects: [],
    enabled: true,
    kind,
    markers: [],
    metadata: {},
    name,
    source_range: null,
  });
  const video = m.clips.map((c) =>
    clip(
      c.id,
      c.media,
      c.media_frames,
      c.duration,
      c.transition_in
        ? [
            {
              OTIO_SCHEMA: "Marker.2",
              color: "RED",
              marked_range: range(0, Math.min(c.transition_in.frames, c.duration)),
              metadata: { "video-studio": { transition: c.transition_in.kind, frames: c.transition_in.frames } },
              name: transitionNote(c.transition_in, m.fps),
            },
          ]
        : [],
      { "video-studio": { scene_id: c.id, sequence_offset_frames: c.offset, ...(c.has_audio ? { clip_audio: "muted: the mix on the audio track has it" } : {}), ...(c.placeholder ? { placeholder: true } : {}) } },
    ),
  );
  // An audio clip reference in frames: the wav is padded/trimmed to exactly the sequence length.
  const audio = m.audio ? [clip("audio mix", m.audio.media, m.total_frames, m.total_frames, [], { "video-studio": { role: "final mix", sample_rate: TIMELINE_AUDIO_RATE, samples: m.audio.samples } })] : [];
  const doc: J = {
    OTIO_SCHEMA: "Timeline.1",
    global_start_time: rt(0),
    metadata: {
      "video-studio": {
        generator: m.generator.name,
        version: m.generator.version,
        status: TIMELINE_STATUS,
        width: m.width,
        height: m.height,
        fps: m.fps,
        total_frames: m.total_frames,
        ...(m.captions ? { captions: relUrl(m.captions.media) } : {}),
      },
    },
    name: m.title,
    tracks: { OTIO_SCHEMA: "Stack.1", children: [track("Video 1", "Video", video), track("Audio 1", "Audio", audio)], effects: [], enabled: true, markers: [], metadata: {}, name: "tracks", source_range: null },
  };
  return stringifyJson(doc) + "\n";
}

// ------------------------------------------------------------------------------------ README

export function buildTimelineReadme(m: TimelineModel, formats: readonly TimelineFormat[]): string {
  const secs = ((m.total_frames * m.frame.num) / m.frame.den).toFixed(3);
  const L = [
    `# ${m.title}: editor timeline`,
    "",
    `Exported by ${m.generator.name} ${m.generator.version}. **Status: ${TIMELINE_STATUS}.** Nobody has opened this timeline in an editor yet; if an import fails or looks wrong, report what the editor said.`,
    "",
    `- Sequence: ${m.width}x${m.height}, ${m.fps} fps, ${m.total_frames} frames (${secs} s).`,
    `- Files: ${formats.map((f) => `\`project.${f}\``).join(", ")}; media in \`media/\` (${m.clips.length} scene clip(s)${m.audio ? ", `audio.wav` (the final mix)" : ""}${m.captions ? ", `captions.srt`" : ""}).`,
    "- Scenes are placed back to back at the frame bounds the reel uses. Transitions the reel draws are listed as markers on the incoming clip; re-apply them in the editor if you want them.",
    "- Media paths are relative to this folder: keep `media/` next to the project files. If the editor shows media offline, relink it to this `media/` folder.",
    "",
    "## DaVinci Resolve (free)",
    "",
    "1. File > Import > Timeline… and pick `project.fcpxml` (or `project.otio` on Resolve 18.5+).",
    "2. When asked, leave \"Automatically import source clips into media pool\" on; if clips are offline, right-click them in the media pool > Relink Selected Clips… > this `media/` folder.",
    `3. Check the timeline is ${m.width}x${m.height} at ${m.fps} fps and ${m.total_frames} frames long, each scene starts on its cut, and the audio track lines up with the picture.`,
    ...(m.captions ? ["4. Captions: File > Import > Subtitle… > `media/captions.srt`, then drag it onto the timeline at 00:00:00:00."] : []),
    "",
    "## Final Cut Pro",
    "",
    "1. File > Import > XML… and pick `project.fcpxml` (Final Cut Pro 10.6 or later reads FCPXML 1.10). It creates an event and a project with the same name.",
    "2. If clips are offline: select them > File > Relink Files… > this `media/` folder.",
    `3. Check the project is ${m.width}x${m.height} at ${m.fps} fps, the scenes sit on the primary storyline back to back, and the audio mix is a connected clip under them for the whole length.`,
    ...(m.captions ? ["4. Captions: File > Import > Captions… > `media/captions.srt`."] : []),
    "",
  ];
  return L.join("\n");
}

// ------------------------------------------------------------------------------------ writer

export interface TimelineSceneInput {
  scene_id: string;
  /** Absolute path of the rendered scene clip. */
  clip: string;
  duration_ms: number;
  placeholder?: boolean;
  /** The transition the reel drew into this scene (0-length transitions are dropped). */
  transition_in?: { kind: string; ms: number };
}

export interface WriteTimelineInput {
  /** dist/timeline (recreated). */
  dir: string;
  formats: readonly TimelineFormat[];
  title: string;
  generator: { name: string; version: string };
  target: { width: number; height: number; fps: number };
  scenes: TimelineSceneInput[];
  /** A video file whose audio is the final mix (the clean master). */
  mixSource: string;
  /** Captions SRT to ship as a sidecar. */
  captionsSrt?: string;
  tools?: FfmpegTools;
  signal?: AbortSignal;
}

export interface TimelineExport {
  dir: string;
  status: typeof TIMELINE_STATUS;
  formats: TimelineFormat[];
  fcpxml?: string;
  otio?: string;
  readme: string;
  media: string[];
  total_frames: number;
  fps: number;
  transitions: "markers on the incoming clip (the reel's blends are not rebuilt; clips sit at their exact frame bounds)";
  captions: "sidecar SRT (media/captions.srt), named in the FCPXML sequence note and the OTIO metadata" | "none";
  warnings: string[];
}

const safeName = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

export async function writeTimeline(input: WriteTimelineInput): Promise<TimelineExport> {
  const formats = TIMELINE_FORMATS.filter((f) => input.formats.includes(f));
  if (!formats.length) throw new Error(`timeline: no known format in [${input.formats.join(", ")}] (use ${TIMELINE_FORMATS.join(", ")})`);
  if (!input.scenes.length) throw new Error("timeline: the render has no scenes");
  const { fps, width, height } = input.target;
  const frame = frameRational(fps);
  const run = { ...(input.tools ? { tools: input.tools } : {}), ...(input.signal ? { signal: input.signal } : {}) };
  const warnings: string[] = [];
  await rm(input.dir, { recursive: true, force: true });
  const mediaDir = join(input.dir, "media");
  await mkdir(mediaDir, { recursive: true });
  const media: string[] = [];

  const clips: TimelineClip[] = [];
  let offset = 0;
  for (const s of input.scenes) {
    const duration = slotFrames(s.duration_ms, fps);
    const rel = `media/${safeName(s.scene_id)}.mp4`;
    const out = join(input.dir, rel);
    const probe = await ffprobe(s.clip, run);
    // Whole frames the file really has (a hair of tolerance for container rounding).
    let conformed = false;
    let mediaFrames = Math.floor(probe.duration_s * fps + 1e-3);
    if (probe.width !== width || probe.height !== height) warnings.push(`${s.scene_id}: clip is ${probe.width}x${probe.height}, the sequence ${width}x${height}; the editor scales it (the reel pads to fit)`);
    if (mediaFrames < duration) {
      // The reel holds the clip's last frame to fill its slot: bake that hold into a conformed copy.
      await runFfmpeg(
        ["-y", "-i", s.clip, "-map", "0:v:0", "-vf", `fps=${fps},tpad=stop_mode=clone:stop_duration=${((duration / fps) + 1).toFixed(3)},trim=end_frame=${duration},setpts=PTS-STARTPTS`, "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", out],
        run,
      );
      warnings.push(`${s.scene_id}: clip has ${mediaFrames} frame(s), its slot ${duration}; exported a conformed copy that holds the last frame (as the reel does)`);
      mediaFrames = duration;
      conformed = true;
    } else {
      await copyFile(s.clip, out);
    }
    media.push(out);
    const tf = s.transition_in ? Math.round((s.transition_in.ms * fps) / 1000) : 0;
    clips.push({
      id: s.scene_id,
      media: rel,
      offset,
      duration,
      media_frames: mediaFrames,
      has_audio: probe.has_audio && !conformed,
      ...(s.placeholder ? { placeholder: true } : {}),
      ...(s.transition_in && tf > 0 ? { transition_in: { kind: s.transition_in.kind, frames: tf } } : {}),
    });
    offset += duration;
  }
  const total = offset;

  // The final mix: decoded from the clean master, exactly the sequence length in samples.
  const samples = Math.round((total * frame.num * TIMELINE_AUDIO_RATE) / frame.den);
  const audioRel = "media/audio.wav";
  const audioOut = join(input.dir, audioRel);
  const src = await ffprobe(input.mixSource, run);
  if (src.has_audio) {
    await runFfmpeg(
      ["-y", "-i", input.mixSource, "-map", "0:a:0", "-vn", "-af", `aresample=${TIMELINE_AUDIO_RATE},apad,atrim=end_sample=${samples}`, "-ac", "2", "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", audioOut],
      run,
    );
  } else {
    warnings.push("the clean master has no audio stream; audio.wav is silence");
    await runFfmpeg(
      ["-y", "-f", "lavfi", "-i", `anullsrc=r=${TIMELINE_AUDIO_RATE}:cl=stereo`, "-af", `atrim=end_sample=${samples}`, "-c:a", "pcm_s16le", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:a", "+bitexact", audioOut],
      run,
    );
  }
  media.push(audioOut);

  let captions: TimelineModel["captions"];
  if (input.captionsSrt) {
    const rel = "media/captions.srt";
    await copyFile(input.captionsSrt, join(input.dir, rel));
    media.push(join(input.dir, rel));
    captions = { media: rel };
  }

  const model: TimelineModel = {
    title: input.title,
    generator: input.generator,
    width,
    height,
    fps,
    frame,
    total_frames: total,
    clips,
    audio: { media: audioRel, samples, channels: 2 },
    ...(captions ? { captions } : {}),
  };
  const result: TimelineExport = {
    dir: input.dir,
    status: TIMELINE_STATUS,
    formats: [...formats],
    readme: join(input.dir, "README.md"),
    media,
    total_frames: total,
    fps,
    transitions: "markers on the incoming clip (the reel's blends are not rebuilt; clips sit at their exact frame bounds)",
    captions: captions ? "sidecar SRT (media/captions.srt), named in the FCPXML sequence note and the OTIO metadata" : "none",
    warnings,
  };
  if (formats.includes("fcpxml")) {
    result.fcpxml = join(input.dir, "project.fcpxml");
    await writeFile(result.fcpxml, buildFcpxml(model));
  }
  if (formats.includes("otio")) {
    result.otio = join(input.dir, "project.otio");
    await writeFile(result.otio, buildOtio(model));
  }
  await writeFile(result.readme, buildTimelineReadme(model, formats));
  return result;
}
