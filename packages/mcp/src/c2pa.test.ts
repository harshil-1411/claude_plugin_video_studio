import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashFile } from "@video-studio/core";
import { runFfmpeg } from "@video-studio/media";
import { RenderManifest, type VideoSpec } from "@video-studio/schema";
import {
  DST_COMPOSITE_TRAINED,
  DST_DIGITAL_CREATION,
  DST_TRAINED,
  type C2paTool,
  c2paManifestDefinition,
  classifySource,
  findC2patool,
  readC2pa,
  signVideos,
} from "./c2pa.js";
import { ENGINE_VERSION, exportProject } from "./pipeline.js";

let tmp: string;
let tool: C2paTool | null;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-c2pa-"));
  tool = await findC2patool();
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A 0.5 s 64×112 H.264/AAC mp4. */
async function tinyMp4(path: string): Promise<void> {
  await runFfmpeg([
    "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=64x112:d=0.5:r=10",
    "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono",
    "-t", "0.5", "-shortest",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    path,
  ]);
}

describe("classifySource", () => {
  const local = { renderer: "hyperframes" };
  it("local motion graphics without synthetic voice: digitalCreation", () => {
    const c = classifySource({ voice_backend: "silent", voice_has_audio: false, scenes: [local, { renderer: "ffmpeg-drawtext" }, { renderer: "ffmpeg-footage" }] });
    expect(c).toMatchObject({ digital_source_type: DST_DIGITAL_CREATION, ai_generated: false });
  });
  it("system TTS over local graphics: composite with trained media (conservative)", () => {
    const c = classifySource({ voice_backend: "system", voice_has_audio: true, scenes: [local] });
    expect(c).toMatchObject({ digital_source_type: DST_COMPOSITE_TRAINED, ai_generated: true });
  });
  it("a generated scene among local ones: composite; placeholders are local", () => {
    expect(classifySource({ voice_backend: "silent", voice_has_audio: false, scenes: [local, { renderer: "runway" }] }).digital_source_type).toBe(DST_COMPOSITE_TRAINED);
    expect(classifySource({ voice_backend: "silent", voice_has_audio: false, scenes: [{ renderer: "provider-x", placeholder: true }] }).ai_generated).toBe(false);
  });
  it("every scene generated and a provider voice: trainedAlgorithmicMedia", () => {
    expect(classifySource({ voice_backend: "elevenlabs", voice_has_audio: true, scenes: [{ renderer: "veo" }] }).digital_source_type).toBe(DST_TRAINED);
  });
});

describe("c2paManifestDefinition", () => {
  it("has the created action and the CreativeWork title", () => {
    const d = c2paManifestDefinition({ title: "Hello", engineVersion: "9.9.9", digitalSourceType: DST_DIGITAL_CREATION }) as {
      claim_generator_info: Array<{ name: string; version: string }>;
      assertions: Array<{ label: string; data: Record<string, unknown> }>;
    };
    expect(d.claim_generator_info).toEqual([{ name: "video-studio", version: "9.9.9" }]);
    expect(d.assertions.map((a) => a.label)).toEqual(["c2pa.actions", "stds.schema-org.CreativeWork"]);
    expect(JSON.stringify(d.assertions[0])).toContain("c2pa.created");
    expect(d.assertions[1]!.data.name).toBe("Hello");
  });
});

describe("signVideos without c2patool", () => {
  it("warns and signs nothing", async () => {
    const f = join(tmp, "unsigned.mp4");
    await writeFile(f, "x");
    const r = await signVideos({ root: tmp, files: [f], title: "t", engineVersion: "0", facts: { voice_backend: "silent", voice_has_audio: false, scenes: [] }, env: { PATH: "" } });
    expect(r.record).toBeUndefined();
    expect(r.signed).toEqual([]);
    expect(r.warnings[0]).toMatch(/c2patool not found.*exported unsigned/);
    expect(await readFile(f, "utf8")).toBe("x");
  });
});

describe("signVideos with c2patool (skipped when it is not installed)", () => {
  it("signs a tiny mp4 in place and the manifest reads back", async (ctx) => {
    if (!tool) ctx.skip();
    const f = join(tmp, "tiny.mp4");
    await tinyMp4(f);
    const before = await hashFile(f);
    const bad = join(tmp, "not-video.mp4");
    await writeFile(bad, "not a video");
    const r = await signVideos({ root: tmp, files: [f, bad], title: "Tiny test", engineVersion: ENGINE_VERSION, facts: { voice_backend: "system", voice_has_audio: true, scenes: [{ renderer: "hyperframes" }] } });
    expect(r.signed).toEqual([f]);
    expect(r.warnings.some((w) => /could not sign not-video\.mp4/.test(w))).toBe(true);
    expect(r.record).toMatchObject({ certificate: "test", claim_generator: `video-studio/${ENGINE_VERSION}`, signed: ["tiny.mp4"], ai_generated: true, assertions: ["c2pa.actions", "stds.schema-org.CreativeWork"] });
    expect(r.record!.tool).toMatch(/^c2patool \d/);
    expect(await hashFile(f)).not.toBe(before);
    const store = (await readC2pa(tool!, f)) as { active_manifest: string; manifests: Record<string, { title: string; claim_generator_info: Array<{ name: string }>; assertions: Array<{ label: string; data: Record<string, unknown> }> }> };
    const m = store.manifests[store.active_manifest]!;
    expect(m.title).toBe("Tiny test");
    expect(m.claim_generator_info[0]!.name).toBe("video-studio");
    const actions = m.assertions.find((a) => a.label.startsWith("c2pa.actions"))!;
    expect(JSON.stringify(actions.data)).toContain(DST_COMPOSITE_TRAINED);
    expect(m.assertions.find((a) => a.label === "stds.schema-org.CreativeWork")!.data.name).toBe("Tiny test");
    expect(await readC2pa(tool!, bad)).toBeNull();
  }, 60_000);

  it("export {sign: true} signs reel, master and target videos; hashes and lock match the signed files", async (ctx) => {
    if (!tool) ctx.skip();
    const root = join(tmp, "project");
    const rdir = join(root, "renders", "preview");
    await mkdir(rdir, { recursive: true });
    await mkdir(join(root, "project"), { recursive: true });
    await tinyMp4(join(rdir, "master.mp4"));
    await copyFile(join(rdir, "master.mp4"), join(rdir, "reel.mp4"));
    await runFfmpeg(["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x112", "-frames:v", "1", join(rdir, "thumbnail.png")]);
    await writeFile(join(rdir, "voice.json"), "[]");
    const spec: VideoSpec = {
      schema_version: "1.0",
      id: "c2pa-test",
      title: "Signed video",
      goal: "explain",
      audience: "testers",
      platform: "youtube_shorts",
      aspect_ratio: "9:16",
      target_duration_sec: 0.5,
      language: "en-US",
      grounding: "loose",
      voice: {},
      captions: { preset: "minimal", burn_in: false },
      scenes: [
        {
          id: "s01",
          duration_sec: 0.5,
          purpose: "hook",
          voiceover: "",
          visual_strategy: "motion_graphic",
          deterministic: { kind: "typography", props: { lines: ["Hi"] } },
          visual_requirements: { continuity_refs: [] },
          claim_refs: [],
        },
      ],
    };
    await writeFile(join(root, "project", "video-spec.json"), JSON.stringify(spec));
    const at = "2026-09-25T00:00:00.000Z";
    const z = "0".repeat(64);
    const state = {
      version: 1,
      quality: "preview",
      started_at: at,
      finished_at: at,
      spec_sha256: z,
      target: { width: 64, height: 112, fps: 10, aspect_ratio: "9:16" },
      duration_ms: 500,
      burn_in: false,
      caption_preset: "minimal",
      scenes: [
        {
          scene_id: "s01",
          status: "rendered",
          renderer: "ffmpeg-drawtext",
          renderer_version: "0.2.0",
          cache_key: z,
          clip: "renders/preview/master.mp4",
          clip_sha256: z,
          duration_ms: 500,
          placeholder: false,
          warnings: [],
          started_at: at,
          finished_at: at,
          claim_refs: [],
          visual_strategy: "motion_graphic",
        },
      ],
      voice: { requested: "silent", backend: "silent", reason: "test", timing_source: "none", has_audio: false, tracks_path: "renders/preview/voice.json", request_hash: z },
      renderer: { preference: "ffmpeg", used: ["ffmpeg-drawtext"], reasons: [] },
      captions: {},
      master: "renders/preview/master.mp4",
      reel: "renders/preview/reel.mp4",
      thumbnail: "renders/preview/thumbnail.png",
      assembly_key: z,
      timing_adjustments: [],
      warnings: [],
      tool_versions: { node: process.versions.node, "video-studio-engine": ENGINE_VERSION },
      voice_mode: "narrated",
      fonts: [],
    };
    await writeFile(join(rdir, "render-state.json"), JSON.stringify(state));
    await writeFile(join(root, "renders", "latest.json"), JSON.stringify({ quality: "preview" }));

    const r = await exportProject(root, { sign: true, now: () => new Date(at) });
    expect(r.dist.c2pa).toMatchObject({ certificate: "test", ai_generated: false });
    expect(r.dist.c2pa!.signed).toEqual(expect.arrayContaining(["dist/reel.mp4", "dist/clean-master.mp4", "dist/youtube-shorts/video.mp4"]));
    const manifest = RenderManifest.parse(JSON.parse(await readFile(r.dist.render_manifest, "utf8")));
    expect(manifest.c2pa?.signed.length).toBe(3);
    const videos = manifest.outputs.filter((o) => o.kind === "final" || o.kind === "clean_master");
    expect(videos.length).toBe(3);
    for (const o of videos) {
      expect(o.c2pa).toBe(true);
      expect(o.sha256).toBe(await hashFile(join(root, o.path)));
      expect(await readC2pa(tool!, join(root, o.path))).not.toBeNull();
    }
    const lock = await readFile(r.dist.lock, "utf8");
    for (const o of videos) expect(lock).toContain(o.sha256);
    const prov = JSON.parse(await readFile(r.dist.provenance, "utf8")) as { render: { c2pa?: { digital_source_type: string } } };
    expect(prov.render.c2pa?.digital_source_type).toBe(DST_DIGITAL_CREATION);

    // Without sign, a re-export is unsigned again (dist/ is regenerated from renders/).
    const u = await exportProject(root, { now: () => new Date(at) });
    expect(u.dist.c2pa).toBeUndefined();
    expect(await readC2pa(tool!, u.dist.reel)).toBeNull();

    // Missing tool: export succeeds unsigned with a warning.
    const m = await exportProject(root, { sign: true, now: () => new Date(at), c2pa: { env: { PATH: "" } } });
    expect(m.dist.c2pa).toBeUndefined();
    expect(m.dist.warnings?.[0]).toMatch(/c2patool not found/);
    const mm = RenderManifest.parse(JSON.parse(await readFile(m.dist.render_manifest, "utf8")));
    expect(mm.warnings?.some((w) => /c2patool not found/.test(w))).toBe(true);
  }, 120_000);
});
