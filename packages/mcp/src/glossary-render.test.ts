import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initProject } from "@video-studio/core";
import { createFfmpegRenderer } from "@video-studio/renderer";
import type { VideoSpec } from "@video-studio/schema";
import { renderProject } from "./pipeline.js";

// End to end: the brand glossary corrects the caption words of a render (HANDOFF open issue 15).
// Tiny render only: 180x320, 2 s, 15 fps, x264 ultrafast, ffmpeg renderer, silent voice.
const T = 120_000;
let tmp: string;

const spec: VideoSpec = {
  schema_version: "1.0",
  id: "tiny-glossary",
  title: "Glossary, tiny",
  goal: "explain",
  audience: "developers",
  platform: "youtube_shorts",
  aspect_ratio: "9:16",
  target_duration_sec: 2,
  language: "en-US",
  grounding: "loose",
  voice: {},
  captions: { preset: "minimal", burn_in: true },
  scenes: [
    {
      id: "s01",
      duration_sec: 2,
      purpose: "hook",
      // How speech recognition hears the name; the glossary spells it.
      voiceover: "Deploy it with cooper netties today.",
      visual_strategy: "motion_graphic",
      deterministic: { kind: "typography", props: { lines: ["Ship it"] } },
      visual_requirements: { continuity_refs: [] },
      claim_refs: [],
    },
  ],
};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-glossary-render-"));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

describe("brand glossary in a render (tiny, silent, ffmpeg)", () => {
  it(
    "writes the glossary's spelling into the SRT, VTT and transcript",
    async () => {
      const dir = join(tmp, "project");
      await initProject(dir, { name: "glossary" });
      await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify(spec, null, 2));
      await writeFile(join(dir, "brand.yaml"), "version: 2\nbrand: { name: Test }\nlanguage: { locale: en-US, glossary: [{ term: Kubernetes, variants: [cooper netties] }] }\n");
      await mkdir(join(dir, "source"), { recursive: true });
      await writeFile(join(dir, "source", "provenance.json"), JSON.stringify({ sources: [] }));
      const r = await renderProject(dir, {
        quality: "preview",
        renderer: "ffmpeg",
        renderers: [createFfmpegRenderer({ encodePreset: "ultrafast" })],
        target: { shortSide: 180, fps: 15 },
        encodePreset: "ultrafast",
        voice: "silent",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: join(tmp, "data") },
        voiceCacheDir: join(tmp, "voice-cache"),
      });
      const srt = await readFile(r.dist.captions_srt!, "utf8");
      expect(srt).toMatch(/\bKubernetes\b/);
      expect(srt).not.toMatch(/cooper|netties/i);
      expect(await readFile(r.dist.captions_vtt!, "utf8")).toMatch(/\bKubernetes\b/);
      expect(await readFile(r.dist.transcript!, "utf8")).toMatch(/Deploy it with Kubernetes today/);
    },
    T,
  );
});
