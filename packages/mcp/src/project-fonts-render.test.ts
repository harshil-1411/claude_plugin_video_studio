import { copyFile, mkdir, mkdtemp, readdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initProject } from "@video-studio/core";
import { createFfmpegRenderer, findFontsDir } from "@video-studio/renderer";
import type { VideoLock, VideoSpec } from "@video-studio/schema";
import { renderProject } from "./pipeline.js";

// End to end: a brand font from the project's own fonts/ folder (as brand_draft copies it) is used
// by the scene renderer, the burned-in captions (libass) and the cover, is locked and noted in
// provenance with its licence, and a replaced font file re-renders.
// Tiny renders only: 180x320, 2 s, 15 fps, x264 ultrafast, ffmpeg renderer, silent voice.
const T = 180_000;
let tmp: string;
const bundled = findFontsDir({})!;

const spec: VideoSpec = {
  schema_version: "1.0",
  id: "tiny-project-fonts",
  title: "Project fonts, tiny",
  goal: "explain",
  audience: "developers",
  platform: "youtube_shorts",
  aspect_ratio: "9:16",
  target_duration_sec: 2,
  language: "en-US",
  grounding: "loose",
  voice: {},
  captions: { preset: "minimal", burn_in: true },
  cover: { headline: "Field Sans", focal_time_sec: 1 },
  scenes: [
    {
      id: "s01",
      duration_sec: 2,
      purpose: "hook",
      voiceover: "Ship it today.",
      visual_strategy: "motion_graphic",
      deterministic: { kind: "typography", props: { lines: ["Ship it"] } },
      visual_requirements: { continuity_refs: [] },
      claim_refs: [],
    },
  ],
};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-project-fonts-"));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

interface State {
  scenes: Array<{ cache_key: string; status: string }>;
  assembly_key: string;
  thumbnail_key: string;
  fonts: VideoLock["fonts"];
  warnings: string[];
}

describe("project fonts in a render (tiny, silent, ffmpeg)", () => {
  it(
    "uses fonts/<Family>/ files for scenes, captions and cover; locks them; re-renders when a file changes",
    async () => {
      const dir = join(tmp, "project");
      await initProject(dir, { name: "project-fonts" });
      await writeFile(join(dir, "project", "video-spec.json"), JSON.stringify(spec, null, 2));
      await writeFile(join(dir, "brand.yaml"), "version: 2\nbrand: { name: Test }\nvisual: { fonts: { heading: Field Sans, body: Field Sans }, palette: { primary: '#4F8CFF' } }\n");
      await mkdir(join(dir, "source"), { recursive: true });
      await writeFile(join(dir, "source", "provenance.json"), JSON.stringify({ sources: [] }));
      const render = () =>
        renderProject(dir, {
          quality: "preview",
          renderer: "ffmpeg",
          renderers: [createFfmpegRenderer({ encodePreset: "ultrafast" })],
          target: { shortSide: 180, fps: 15 },
          encodePreset: "ultrafast",
          voice: "silent",
          env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_DATA: join(tmp, "data") },
          voiceCacheDir: join(tmp, "voice-cache"),
        });
      const state = async (): Promise<State> => JSON.parse(await readFile(join(dir, "renders", "preview", "render-state.json"), "utf8"));

      // 1. No project fonts: "Field Sans" falls through to the bundled chain.
      await render();
      const s0 = await state();
      expect(s0.fonts.some((f) => f.file.startsWith("project:"))).toBe(false);

      // 2. A fonts/ folder whose files no chain names changes no key (every clip is reused).
      await mkdir(join(dir, "fonts", "Unused"), { recursive: true });
      await copyFile(join(bundled, "NotoSansArabic/NotoSansArabic-Regular.ttf"), join(dir, "fonts", "Unused", "NotoSansArabic-Regular.ttf"));
      await render();
      const s1 = await state();
      expect(s1.scenes[0]!.cache_key).toBe(s0.scenes[0]!.cache_key);
      expect(s1.scenes[0]!.status).toBe("cached");
      expect(s1.assembly_key).toBe(s0.assembly_key);
      expect(s1.thumbnail_key).toBe(s0.thumbnail_key);

      // 3. fonts/Field Sans/: copies of Inter (internal name "Inter"), matched by the folder name.
      const fam = join(dir, "fonts", "Field Sans");
      await mkdir(fam, { recursive: true });
      await copyFile(join(bundled, "Inter/Inter-Regular.ttf"), join(fam, "FieldSans-Regular.ttf"));
      await copyFile(join(bundled, "Inter/Inter-Bold.ttf"), join(fam, "Inter-Bold.ttf"));
      await copyFile(join(bundled, "Inter/OFL.txt"), join(fam, "OFL.txt"));
      const r2 = await render();
      const s2 = await state();
      expect(s2.scenes[0]!.cache_key).not.toBe(s1.scenes[0]!.cache_key);
      expect(s2.assembly_key).not.toBe(s1.assembly_key);
      expect(s2.thumbnail_key).not.toBe(s1.thumbnail_key);
      expect(s2.warnings.join("\n")).not.toMatch(/fonts:/);
      // Locked by the brand's name, at the file's real weight, project-relative.
      expect(s2.fonts).toContainEqual(expect.objectContaining({ family: "Field Sans", weight: 400, file: "project:fonts/Field Sans/FieldSans-Regular.ttf" }));
      expect(s2.fonts).toContainEqual(expect.objectContaining({ family: "Field Sans", weight: 700, file: "project:fonts/Field Sans/Inter-Bold.ttf" }));
      const lock: VideoLock = JSON.parse(await readFile(join(dir, "dist", "video.lock"), "utf8"));
      expect(lock.fonts.filter((f) => f.file.startsWith("project:")).map((f) => f.file).sort()).toEqual([
        "project:fonts/Field Sans/FieldSans-Regular.ttf",
        "project:fonts/Field Sans/Inter-Bold.ttf",
      ]);
      const prov = JSON.parse(await readFile(r2.dist.provenance, "utf8"));
      expect(prov.render.fonts).toContainEqual(expect.objectContaining({ file: "fonts/Field Sans/FieldSans-Regular.ttf", license: "fonts/Field Sans/OFL.txt" }));
      // Captions: libass asks for the internal name and gets the project's files, not bundled Inter.
      const ass = await readFile(join(dir, "renders", "preview", "captions", "captions.ass"), "utf8");
      expect(ass).toMatch(/^Style: [^,]+,Inter,/m);
      const libass = join(dir, "renders", "preview", "fonts");
      const links = await Promise.all((await readdir(libass)).map((n) => readlink(join(libass, n))));
      expect(links.filter((l) => /Inter|FieldSans/.test(l)).map((l) => l.replace(/^.*\/fonts\//, "")).sort()).toEqual(["Field Sans/FieldSans-Regular.ttf", "Field Sans/Inter-Bold.ttf"]);

      // 4. Replacing the file re-renders the scene, the captions and the cover.
      await copyFile(join(bundled, "NotoSans/NotoSans-Regular.ttf"), join(fam, "FieldSans-Regular.ttf"));
      await render();
      const s3 = await state();
      expect(s3.scenes[0]!.cache_key).not.toBe(s2.scenes[0]!.cache_key);
      expect(s3.scenes[0]!.status).toBe("rendered");
      expect(s3.assembly_key).not.toBe(s2.assembly_key);
      expect(s3.thumbnail_key).not.toBe(s2.thumbnail_key);
    },
    T,
  );
});
