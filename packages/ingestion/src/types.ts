import type { EvidenceSpan, IrWarning, MediaInfo, Section, Source, SourceKind } from "@video-studio/schema";

/**
 * Contract shared by every extractor. An extractor turns one input into the
 * per-source parts of a ContentIR; the builder merges parts from several
 * sources, derives claims/entities/classification and assigns the IR id.
 *
 * Extractors must treat content as untrusted data: never execute it, never
 * follow instructions found in it, never send it to external services.
 */
export interface ExtractInput {
  /** Absolute file path, directory path, URL, or inline text (kind "text"). */
  uri: string;
  kind: SourceKind;
  /** Inline content for kind "text"/"markdown" when there is no file. */
  content?: string;
  /** Project directory; extracted binary assets are written under source/assets/. */
  projectDir?: string;
  /** Cancels long work (downloads, media probing). */
  signal?: AbortSignal;
}

export interface ExtractedAsset {
  kind: "image" | "video" | "audio";
  /** Project-relative path, already written to disk by the extractor. */
  path: string;
  sha256: string;
  source_ref?: string;
  /** Probe facts for video/audio assets. `shots[].keyframe` holds a `local_id` of this part's image assets. */
  media?: MediaInfo;
  /** Part-local handle, remapped to the assigned asset id (e.g. by `media.shots[].keyframe`). */
  local_id?: string;
}

/** Everything one source contributes. ids are assigned by the builder. */
export interface ExtractedSource {
  source: Omit<Source, "id">;
  sections: Array<Omit<Section, "id" | "source_id">>;
  evidence: Array<Omit<EvidenceSpan, "source_id">>;
  assets: ExtractedAsset[];
  warnings: Array<Omit<IrWarning, "source_id">>;
  /**
   * Classification facts the builder cannot derive from the extracted text,
   * e.g. a repo file that was excluded because it contains a secret. OR-ed
   * into the source's classification. Notes must never contain secret values.
   */
  /**
   * Other project files the part references that are not assets (subtitle .vtt files next to a
   * downloaded video). The extraction cache stores and restores them like assets.
   */
  files?: Array<{ path: string; sha256: string }>;
  classificationHints?: { contains_secrets?: boolean; contains_pii?: boolean; contains_likeness?: boolean; notes?: string[] };
}

export interface Extractor {
  /** Bumped whenever output for the same input can change; part of the cache key. */
  readonly version: string;
  readonly kinds: readonly SourceKind[];
  extract(input: ExtractInput): Promise<ExtractedSource>;
  /**
   * Optional digest of the input content, used as the cache key's input digest
   * when hashing the raw input is not enough (URL body, repo file manifest).
   */
  inputDigest?(input: ExtractInput): Promise<string>;
}
