import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "@video-studio/ingestion";
import type { VideoSpec } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type LintFinding, checkFootageQuality } from "./lint.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-lint-fq-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const spec = (footage: Record<string, unknown>, audio?: { mode: string }) =>
  ({ scenes: [{ id: "s01", duration_sec: 1, footage: { asset: "v1", in_sec: 0, ...footage }, ...(audio ? { audio } : {}) }] }) as unknown as VideoSpec;
const ir = (quality: Record<string, unknown>) => ({ assets: [{ id: "v1", media: { quality: { notes: [], ...quality } } }] });
const run = (s: VideoSpec, i: ReturnType<typeof ir> | undefined) => {
  const out: LintFinding[] = [];
  checkFootageQuality(s, i, out);
  return out;
};

describe("lint footage_quality", () => {
  it("warns on dark/bright pictures unless the scene cuts away", () => {
    const dark = run(spec({}), ir({ exposure: "dark", luma_mean: 30 }));
    expect(dark).toHaveLength(1);
    expect(dark[0]).toMatchObject({ id: "footage_quality", severity: "warning", scene_id: "s01" });
    expect(dark[0]!.message).toMatch(/underexposed/);
    expect(dark[0]!.fix).toMatch(/another clip|better-exposed span/);
    expect(run(spec({}), ir({ exposure: "bright" }))[0]!.message).toMatch(/overexposed/);
    expect(run(spec({ cutaway: true }), ir({ exposure: "dark" }))).toEqual([]);
    expect(run(spec({}), ir({ exposure: "ok" }))).toEqual([]);
    expect(run(spec({}), undefined)).toEqual([]);
  });

  it("warns on clipped or noisy sound only when the scene plays it", () => {
    const clipped = run(spec({}), ir({ clipped_audio: true }));
    expect(clipped[0]!.message).toMatch(/clips/);
    expect(clipped[0]!.fix).toMatch(/replace or re-record/);
    expect(run(spec({}, { mode: "mix" }), ir({ clipped_audio: true }))).toHaveLength(1);
    expect(run(spec({}, { mode: "music" }), ir({ clipped_audio: true }))).toEqual([]);
    expect(run(spec({}, { mode: "mute" }), ir({ clipped_audio: true }))).toEqual([]);
    expect(run(spec({}), ir({ snr_db: 3, notes: ["noisy or unclear audio (estimated SNR 3 dB)"] }))[0]!.message).toMatch(/noisy/);
    expect(run(spec({}), ir({ snr_db: 40 }))).toEqual([]);
  });

  it("flags a dark clip ingested for real", async () => {
    const clip = join(dir, "dark.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=160x90:d=1:r=15,eq=brightness=-0.6", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip]);
    const { ir: content } = await ingest([clip], { projectDir: join(dir, "p"), noCache: true });
    const asset = content.assets.find((a) => a.kind === "video")!;
    const out: LintFinding[] = [];
    checkFootageQuality({ scenes: [{ id: "s01", duration_sec: 1, footage: { asset: asset.id, in_sec: 0 } }] } as unknown as VideoSpec, content, out);
    expect(out.map((f) => f.id)).toEqual(["footage_quality"]);
  }, 60_000);
});
