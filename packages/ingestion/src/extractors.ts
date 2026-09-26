import type { SourceKind } from "@video-studio/schema";
import { docxExtractor } from "./docx.js";
import { markdownExtractor } from "./markdown.js";
import { mediaExtractor } from "./media.js";
import { pdfExtractor } from "./pdf.js";
import { pptxExtractor } from "./pptx.js";
import { type FetchRepo, createRepoExtractor, repoExtractor } from "./repo.js";
import { textExtractor } from "./text.js";
import { type FetchImpl, type UrlExtractorOptions, createUrlExtractor, urlExtractor } from "./url.js";
import type { Extractor } from "./types.js";
import { type VideoUrlOptions, createVideoUrlExtractor, videoUrlExtractor } from "./video-url.js";

export type ExtractorRegistry = Partial<Record<SourceKind, Extractor>>;

/** Default registry, keyed by SourceKind. */
export const extractors = {
  text: textExtractor,
  markdown: markdownExtractor,
  url: urlExtractor,
  pdf: pdfExtractor,
  docx: docxExtractor,
  pptx: pptxExtractor,
  repo: repoExtractor,
  video: mediaExtractor,
  audio: mediaExtractor,
  video_url: videoUrlExtractor,
} as const satisfies ExtractorRegistry;

export interface ExtractorRegistryOptions {
  /** fetch used by the URL extractor (tests inject a fixture-backed fetch). */
  fetch?: FetchImpl;
  url?: Omit<UrlExtractorOptions, "fetch">;
  /** Materializes remote repos; without it only local directories are accepted. */
  fetchRepo?: FetchRepo;
  /** Options of the video URL extractor (env for yt-dlp, SSRF lookup/override, subtitle language). */
  videoUrl?: VideoUrlOptions;
}

/** Registry with injectable transports; returns the defaults when nothing is overridden. */
export function createExtractors(options: ExtractorRegistryOptions = {}): ExtractorRegistry {
  return {
    ...extractors,
    ...(options.fetch || options.url ? { url: createUrlExtractor({ ...options.url, ...(options.fetch ? { fetch: options.fetch } : {}) }) } : {}),
    ...(options.fetchRepo ? { repo: createRepoExtractor({ fetchRepo: options.fetchRepo }) } : {}),
    ...(options.videoUrl || options.fetch ? { video_url: createVideoUrlExtractor({ ...options.videoUrl, ...(options.fetch ? { fetch: options.fetch } : {}) }) } : {}),
  };
}
