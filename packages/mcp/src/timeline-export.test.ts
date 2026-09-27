import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initProject } from "@video-studio/core";
import { ffprobe, runFfmpeg } from "@video-studio/media";
import { createFfmpegRenderer } from "@video-studio/renderer";
import type { VideoSpec } from "@video-studio/schema";
import { exportProject, renderProject } from "./pipeline.js";
import { TIMELINE_STATUS, type TimelineModel, buildFcpxml, buildOtio, fcpTime, frameRational, relUrl, slotFrames, writeTimeline, xmlEscape } from "./timeline-export.js";

// Tiny fixtures only: 180x320, 15 fps, ≤ 1.2 s clips, x264 ultrafast.
const T = 60_000;
let tmp: string;

interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlEl[];
  text: string;
}

/** Minimal well-formedness check and tree builder (no DTD processing): throws on any malformation. */
function parseXml(src: string): XmlEl {
  let i = 0;
  const root: XmlEl = { name: "#doc", attrs: {}, children: [], text: "" };
  const stack: XmlEl[] = [root];
  const nameRe = /^[A-Za-z_][\w.-]*/;
  const decode = (s: string) => {
    if (/&(?!(amp|lt|gt|quot|apos);)/.test(s)) throw new Error(`bad entity in ${JSON.stringify(s)}`);
    if (s.includes("<")) throw new Error("raw < in text/attribute");
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  };
  while (i < src.length) {
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      if (end < 0) throw new Error("unterminated PI");
      i = end + 2;
    } else if (src.startsWith("<!DOCTYPE", i)) {
      const end = src.indexOf(">", i);
      if (stack.length !== 1 || root.children.length) throw new Error("DOCTYPE after root");
      i = end + 1;
    } else if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      const name = src.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`mismatched </${name}> (open: ${top?.name})`);
      i = end + 1;
    } else if (src[i] === "<") {
      i++;
      const name = nameRe.exec(src.slice(i))?.[0];
      if (!name) throw new Error(`bad tag name at ${i}`);
      i += name.length;
      const el: XmlEl = { name, attrs: {}, children: [], text: "" };
      for (;;) {
        while (/\s/.test(src[i]!)) i++;
        if (src.startsWith("/>", i)) {
          i += 2;
          stack.at(-1)!.children.push(el);
          break;
        }
        if (src[i] === ">") {
          i++;
          stack.at(-1)!.children.push(el);
          stack.push(el);
          break;
        }
        const an = nameRe.exec(src.slice(i))?.[0];
        if (!an) throw new Error(`bad attribute at ${i} in <${name}>`);
        i += an.length;
        if (src[i] !== "=" || src[i + 1] !== '"') throw new Error(`attribute ${an} not ="..."`);
        const end = src.indexOf('"', i + 2);
        if (an in el.attrs) throw new Error(`duplicate attribute ${an}`);
        el.attrs[an] = decode(src.slice(i + 2, end));
        i = end + 1;
      }
      if (stack.length === 2 && root.children.length > 1) throw new Error("more than one root element");
    } else {
      const end = src.indexOf("<", i) < 0 ? src.length : src.indexOf("<", i);
      const text = src.slice(i, end);
      if (stack.length === 1 && text.trim()) throw new Error("text outside the root");
      stack.at(-1)!.text += decode(text);
      i = end;
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed <${stack.at(-1)!.name}>`);
  if (root.children.length !== 1) throw new Error("no single root element");
  return root.children[0]!;
}

const all = (el: XmlEl, name: string): XmlEl[] => [...(el.name === name ? [el] : []), ...el.children.flatMap((c) => all(c, name))];

/** `N/Ds` or `0s` → exact frames on the grid, or throws when off-grid. */
function framesOf(t: string, fps: number): number {
  if (t === "0s") return 0;
  const m = /^(\d+)\/(\d+)s$/.exec(t);
  if (!m) throw new Error(`not a rational time: ${t}`);
  const f = (Number(m[1]) * fps) / Number(m[2]);
  if (!Number.isInteger(f)) throw new Error(`${t} is not a whole number of frames at ${fps} fps`);
  return f;
}

const model2: TimelineModel = {
  title: 'Tiny "A & B" <reel>',
  generator: { name: "video-studio", version: "0.0.0-test" },
  width: 180,
  height: 320,
  fps: 15,
  frame: { num: 1, den: 15 },
  total_frames: 33,
  clips: [
    { id: "s01", media: "media/s01.mp4", offset: 0, duration: 15, media_frames: 15, has_audio: false },
    { id: "s02", media: "media/s02 clip.mp4", offset: 15, duration: 18, media_frames: 18, has_audio: true, transition_in: { kind: "crossfade", frames: 6 } },
  ],
  audio: { media: "media/audio.wav", samples: 105_600, channels: 2 },
  captions: { media: "media/captions.srt" },
};

describe("timeline helpers", () => {
  it("frame rationals and times", () => {
    expect(frameRational(30)).toEqual({ num: 1, den: 30 });
    expect(frameRational(29.97)).toEqual({ num: 1001, den: 30000 });
    expect(frameRational(23.976)).toEqual({ num: 1001, den: 24000 });
    expect(() => frameRational(12.5)).toThrow(/unsupported/);
    expect(fcpTime(0, { num: 1, den: 30 })).toBe("0s");
    expect(fcpTime(45, { num: 1001, den: 30000 })).toBe("45045/30000s");
    expect(() => fcpTime(1.5, { num: 1, den: 30 })).toThrow();
    expect(slotFrames(1000, 15)).toBe(15);
    expect(slotFrames(10, 15)).toBe(1);
    expect(xmlEscape(`a&b<"c'>`)).toBe("a&amp;b&lt;&quot;c&apos;&gt;");
    expect(relUrl("media/s02 clip#1.mp4")).toBe("media/s02%20clip%231.mp4");
  });

  it("FCPXML for a 2-scene fixture is well-formed 1.10, on the frame grid, and stable", () => {
    const xml = buildFcpxml(model2);
    const doc = parseXml(xml);
    expect(doc.name).toBe("fcpxml");
    expect(doc.attrs.version).toBe("1.10");
    const seq = all(doc, "sequence")[0]!;
    expect(framesOf(seq.attrs.duration!, 15)).toBe(33);
    const spine = all(doc, "spine")[0]!.children.filter((c) => c.name === "asset-clip");
    expect(spine.map((c) => [framesOf(c.attrs.offset!, 15), framesOf(c.attrs.duration!, 15)])).toEqual([
      [0, 15],
      [15, 18],
    ]);
    expect(spine[1]!.attrs.srcEnable).toBe("video");
    const audio = all(doc, "asset-clip").find((c) => c.attrs.lane === "-1")!;
    expect(framesOf(audio.attrs.duration!, 15)).toBe(33);
    expect(all(doc, "project")[0]!.attrs.name).toBe('Tiny "A & B" <reel>');
    expect(all(doc, "note")[0]!.text).toContain("media/captions.srt");
    expect(all(doc, "marker")[0]!.attrs.value).toMatch(/^transition: crossfade, 6 frame/);
    expect(all(doc, "media-rep").map((r) => r.attrs.src)).toEqual(["media/s01.mp4", "media/s02%20clip.mp4", "media/audio.wav"]);
    expect(buildFcpxml(model2)).toBe(xml);
    expect(xml).toMatchSnapshot();
  });

  it("OTIO for the fixture has the schema fields, float times and relative URLs", () => {
    const text = buildOtio(model2);
    const doc = JSON.parse(text);
    expect(doc.OTIO_SCHEMA).toBe("Timeline.1");
    expect(doc.global_start_time).toEqual({ OTIO_SCHEMA: "RationalTime.1", rate: 15, value: 0 });
    expect(text).toContain('"rate": 15.0');
    expect(doc.metadata["video-studio"]).toMatchObject({ generator: "video-studio", version: "0.0.0-test", captions: "media/captions.srt" });
    expect(doc.tracks.OTIO_SCHEMA).toBe("Stack.1");
    const [v, a] = doc.tracks.children;
    expect([v.OTIO_SCHEMA, v.kind, a.OTIO_SCHEMA, a.kind]).toEqual(["Track.1", "Video", "Track.1", "Audio"]);
    expect(v.children.map((c: { OTIO_SCHEMA: string; media_reference: { OTIO_SCHEMA: string; target_url: string }; source_range: { OTIO_SCHEMA: string; duration: { value: number } } }) => [c.OTIO_SCHEMA, c.media_reference.OTIO_SCHEMA, c.media_reference.target_url, c.source_range.OTIO_SCHEMA, c.source_range.duration.value])).toEqual([
      ["Clip.1", "ExternalReference.1", "media/s01.mp4", "TimeRange.1", 15],
      ["Clip.1", "ExternalReference.1", "media/s02%20clip.mp4", "TimeRange.1", 18],
    ]);
    expect(v.children[1].markers[0].OTIO_SCHEMA).toBe("Marker.2");
    expect(a.children[0].source_range.duration.value).toBe(33);
    expect(buildOtio(model2)).toBe(text);
  });
});

describe("writeTimeline (tiny real clips)", () => {
  let root: string;
  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), "vs-timeline-"));
    root = join(tmp, "render");
    await mkdir(join(root, "scenes"), { recursive: true });
    const enc = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc=size=180x320:rate=15:duration=1", ...enc, join(root, "scenes", "s01.mp4")]);
    // s02 is 0.6 s but its slot is 1.2 s: the export conforms it (holds the last frame).
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "testsrc2=size=180x320:rate=15:duration=0.6", ...enc, join(root, "scenes", "s02.mp4")]);
    await runFfmpeg([
      "-y", "-f", "lavfi", "-i", "color=c=black:size=180x320:rate=15:duration=2.2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2.2:sample_rate=48000",
      ...enc, "-c:a", "aac", "-shortest", join(root, "master.mp4"),
    ]);
    await writeFile(join(root, "captions.srt"), "1\n00:00:00,000 --> 00:00:01,000\nHello & <world>\n");
  }, T);
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const run = (dir: string) =>
    writeTimeline({
      dir,
      formats: ["otio", "fcpxml"],
      title: "Tiny timeline",
      generator: { name: "video-studio", version: "0.0.0-test" },
      target: { width: 180, height: 320, fps: 15 },
      scenes: [
        { scene_id: "s01", clip: join(root, "scenes", "s01.mp4"), duration_ms: 1000 },
        { scene_id: "s02", clip: join(root, "scenes", "s02.mp4"), duration_ms: 1200, transition_in: { kind: "crossfade", ms: 400 } },
      ],
      mixSource: join(root, "master.mp4"),
      captionsSrt: join(root, "captions.srt"),
    });

  it(
    "writes media, both files and a README; every reference exists; frames sum to the reel; deterministic",
    async () => {
      const dir = join(tmp, "a", "timeline");
      const r = await run(dir);
      expect(r.status).toBe(TIMELINE_STATUS);
      expect(r.formats).toEqual(["fcpxml", "otio"]);
      expect(r.total_frames).toBe(33);
      expect(r.warnings.join("\n")).toMatch(/s02: clip has 9 frame\(s\), its slot 18; exported a conformed copy/);
      for (const p of [...r.media, r.fcpxml!, r.otio!, r.readme]) expect(existsSync(p)).toBe(true);

      const xml = await readFile(r.fcpxml!, "utf8");
      const doc = parseXml(xml);
      expect(doc.attrs.version).toBe("1.10");
      for (const rep of all(doc, "media-rep")) expect(existsSync(join(dir, decodeURIComponent(rep.attrs.src!)))).toBe(true);
      const spine = all(doc, "spine")[0]!.children.filter((c) => c.name === "asset-clip");
      let at = 0;
      for (const c of spine) {
        expect(framesOf(c.attrs.offset!, 15)).toBe(at);
        at += framesOf(c.attrs.duration!, 15);
      }
      expect(at).toBe(33);
      expect(framesOf(all(doc, "sequence")[0]!.attrs.duration!, 15)).toBe(33);

      const otio = JSON.parse(await readFile(r.otio!, "utf8"));
      const [v, a] = otio.tracks.children;
      for (const c of [...v.children, ...a.children]) expect(existsSync(join(dir, decodeURIComponent(c.media_reference.target_url)))).toBe(true);
      expect(v.children.reduce((n: number, c: { source_range: { duration: { value: number } } }) => n + c.source_range.duration.value, 0)).toBe(33);

      // Media: the conformed clip covers its slot; the mix is exactly the sequence length (2.2 s = 105600 samples).
      const s02 = await ffprobe(join(dir, "media", "s02.mp4"), { countFrames: true });
      expect(Math.round(s02.duration_s * 15)).toBe(18);
      const wav = await ffprobe(join(dir, "media", "audio.wav"));
      expect(wav.sample_rate).toBe(48000);
      expect(wav.channels).toBe(2);
      expect(wav.duration_s).toBeCloseTo(2.2, 3);
      expect(await readFile(join(dir, "media", "captions.srt"), "utf8")).toContain("Hello & <world>");
      expect(await readFile(r.readme, "utf8")).toMatch(/DaVinci Resolve[\s\S]*Final Cut Pro/);

      // Same input → same bytes (media included).
      const dir2 = join(tmp, "b", "timeline");
      await run(dir2);
      for (const name of ["project.fcpxml", "project.otio", "README.md", "media/s01.mp4", "media/s02.mp4", "media/audio.wav", "media/captions.srt"]) {
        expect((await readFile(join(dir2, name))).equals(await readFile(join(dir, name))), name).toBe(true);
      }
    },
    T,
  );
});

describe("export timeline on a real tiny render (ffmpeg renderer, silent voice)", () => {
  let dir: string;
  let env: Record<string, string | undefined>;
  const spec: VideoSpec = {
    schema_version: "1.0",
    id: "tiny-timeline",
    title: "Timeline & <cuts>",
    goal: "explain",
    audience: "editors",
    platform: "youtube_shorts",
    aspect_ratio: "9:16",
    target_duration_sec: 2,
    language: "en-US",
    grounding: "loose",
    voice: {},
    captions: { preset: "minimal", burn_in: false },
    scenes: [
      {
        id: "s01",
        duration_sec: 1,
        purpose: "hook",
        voiceover: "Cut here.",
        visual_strategy: "motion_graphic",
        deterministic: { kind: "typography", props: { lines: ["Cut here"] } },
        visual_requirements: { continuity_refs: [] },
        claim_refs: [],
      },
      {
        id: "s02",
        duration_sec: 1,
        purpose: "cta",
        voiceover: "Then fade.",
        visual_strategy: "motion_graphic",
        transition: "crossfade",
        deterministic: { kind: "cta", props: { headline: "Then fade", action: "Open the editor" } },
        visual_requirements: { continuity_refs: [] },
        claim_refs: [],
      },
    ],
  };
  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), "vs-timeline-render-"));
    env = { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: join(base, "data") };
    dir = join(base, "proj");
    await initProject(dir, { name: "tiny-timeline" });
    await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify(spec, null, 2));
    await mkdir(join(dir, "source"), { recursive: true });
    await writeFile(join(dir, "source", "provenance.json"), JSON.stringify({ sources: [] }));
    await renderProject(dir, {
      quality: "preview",
      voice: "silent",
      renderer: "ffmpeg",
      renderers: [createFfmpegRenderer({ encodePreset: "ultrafast" })],
      target: { shortSide: 180, fps: 15 },
      encodePreset: "ultrafast",
      env,
      voiceCacheDir: join(base, "voice-cache"),
    });
  }, 120_000);
  afterAll(async () => {
    await rm(join(dir, ".."), { recursive: true, force: true });
  });

  it(
    "exportProject({timeline}) writes dist/timeline/ matching the reel, lists it in the manifest, and states its import status",
    async () => {
      const r = await exportProject(dir, { timeline: ["fcpxml", "otio"] });
      const tl = r.timeline!;
      expect(tl.status).toBe(TIMELINE_STATUS);
      expect(tl.dir).toBe(join(dir, "dist", "timeline"));
      const reel = await ffprobe(join(dir, "dist", "clean-master.mp4"), { countFrames: true });
      expect(tl.total_frames).toBe(Math.round(reel.duration_s * 15));
      const doc = parseXml(await readFile(tl.fcpxml!, "utf8"));
      expect(doc.attrs.version).toBe("1.10");
      expect(all(doc, "project")[0]!.attrs.name).toBe("Timeline & <cuts>");
      for (const rep of all(doc, "media-rep")) expect(existsSync(join(tl.dir, decodeURIComponent(rep.attrs.src!)))).toBe(true);
      const spine = all(doc, "spine")[0]!.children.filter((c) => c.name === "asset-clip");
      expect(spine.map((c) => [c.attrs.name, framesOf(c.attrs.offset!, 15), framesOf(c.attrs.duration!, 15)])).toEqual([
        ["s01", 0, 15],
        ["s02", 15, 15],
      ]);
      expect(all(doc, "marker")[0]!.attrs.value).toMatch(/^transition: crossfade, 6 frame/);
      expect(all(doc, "note")[0]!.text).toContain("media/captions.srt");
      const otio = JSON.parse(await readFile(tl.otio!, "utf8"));
      expect(otio.metadata["video-studio"].status).toBe(TIMELINE_STATUS);
      const manifest = JSON.parse(await readFile(join(dir, "dist", "render-manifest.json"), "utf8"));
      expect(manifest.outputs.map((o: { path: string }) => o.path)).toEqual(expect.arrayContaining(["dist/timeline/project.fcpxml", "dist/timeline/project.otio"]));
      // Without timeline, a plain export leaves the result without one.
      expect((await exportProject(dir)).timeline).toBeUndefined();
    },
    120_000,
  );
});
