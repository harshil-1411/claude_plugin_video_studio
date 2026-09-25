import { z } from "zod";
import { FilePath, Id, PlatformTargetId, SchemaVersion, Sha256 } from "./common.js";
import { SceneId } from "./video-spec.js";

/**
 * dist/video.lock: everything a render depended on, so two renders can be compared and a
 * render can be reproduced. Deterministic: no timestamps, arrays sorted by their key, so the
 * same inputs give a byte-identical lock.
 */
export const VideoLock = z
  .strictObject({
    schema_version: SchemaVersion,
    project_id: Id,
    quality: z.enum(["preview", "final"]),
    spec_sha256: Sha256.describe("Canonical-JSON hash of the VideoSpec that was rendered."),
    content_ir_sha256: Sha256.optional(),
    engine: z
      .record(z.string(), z.string())
      .describe("Engine component versions, e.g. {engine: \"0.1.0\", assembly: \"2\", cover: \"2\", target_package: \"1\"}."),
    tools: z.record(z.string(), z.string()).describe("External tool and renderer versions (ffmpeg, ffmpeg-drawtext, hyperframes, voice backend)."),
    voice: z.strictObject({ backend: Id, voice_id: z.string().optional(), request_hash: Sha256 }),
    fonts: z
      .array(z.strictObject({ family: z.string(), weight: z.int().positive(), file: FilePath, sha256: Sha256 }))
      .describe("Font files the render used, sorted by family then weight."),
    targets: z
      .array(z.strictObject({ id: PlatformTargetId, contract_version: z.int().positive(), verified: z.iso.date() }))
      .describe("Platform contracts the packages were compiled against, sorted by id."),
    scenes: z
      .array(
        z.strictObject({
          scene_id: SceneId,
          renderer: Id,
          renderer_version: z.string(),
          cache_key: Sha256,
          clip_sha256: Sha256,
        }),
      )
      .describe("Scene clips in spec order."),
    assets: z.array(z.strictObject({ path: FilePath, sha256: Sha256 })).describe("Project inputs the render read (sources, brand, assets), sorted by path."),
    outputs: z
      .array(z.strictObject({ path: FilePath, sha256: Sha256, target: PlatformTargetId.optional() }))
      .describe("dist/ files, sorted by path; excludes video.lock and render-manifest.json (which carries timestamps)."),
  })
  .meta({
    id: "VideoLock",
    title: "VideoLock",
    description: "dist/video.lock: versions, contract versions and hashes of everything a render depended on.",
  });

/**
 * What kind of change a lock diff found:
 * - creative: the video's content changed (spec hash, scene cache keys/clips).
 * - renderer: engine, tool, renderer, voice backend or font versions changed.
 * - spec: a platform contract (platform-specs/<id>.yaml) changed version or verified date, or targets changed.
 * - asset: a project input's hash changed, or one was added/removed.
 * - metadata: only outputs changed without a cause above (e.g. post copy), or the quality/project id.
 */
export const LockChangeClass = z.enum(["creative", "renderer", "spec", "asset", "metadata"]);

export const LockChange = z.strictObject({
  class: LockChangeClass,
  /** Dotted path into the lock, e.g. `tools.ffmpeg` or `scenes.s02.clip_sha256`. */
  path: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  message: z.string(),
});

export type VideoLock = z.infer<typeof VideoLock>;
export type LockChangeClass = z.infer<typeof LockChangeClass>;
export type LockChange = z.infer<typeof LockChange>;
