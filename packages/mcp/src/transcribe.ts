import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { projectPaths, resolveDataDir, resolveInsideProject, writeJsonAtomic } from "@video-studio/core";
import { classifyText, deriveClaims, maxDataClass } from "@video-studio/ingestion";
import { type TimedWord, groupSentences, isVtt, parseCaptionFile, whisperLanguage, whisperTranscribe } from "@video-studio/media";
import { ContentIR, type EvidenceSpan, type IrAsset, formatIssues } from "@video-studio/schema";

/**
 * transcribe: local ASR (whisper.cpp) for a project's video/audio asset, or import of a user
 * SRT/VTT, written as a timed-word transcript and recorded on the asset's `media.transcript`.
 * Each sentence becomes an evidence span with a time locator (`video:talk.mp4#t=12.3-18.9`) so
 * specs can cite what was said. The whisper model is never downloaded without explicit consent
 * (`download_model: true`).
 */

export const WHISPER_MODEL = {
  name: "ggml-base.en",
  file: "ggml-base.en.bin",
  url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  /** sha256 of the published file (147,964,211 bytes). */
  sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
  approx_mb: 148,
} as const;

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface TranscribeOptions {
  /** Import this caption file instead of running ASR (project-relative .srt or .vtt). */
  captions_file?: string;
  /** Explicit consent to download the whisper model (~150 MB) into the plugin data dir. */
  download_model?: boolean;
  env?: Record<string, string | undefined>;
  /** Tests: injected fetch for the model download. */
  fetch?: FetchLike;
  /** Tests: expected sha256 of the downloaded model (default: the published base.en hash). */
  modelSha256?: string;
  /** whisper-cli binary (default: on PATH). */
  whisperBin?: string;
}

export interface TranscribeResult {
  asset: string;
  source: "whisper" | "srt" | "vtt";
  words: number;
  path: string;
  text: string;
  sentences: number;
  evidence_refs: string[];
  model?: string;
  model_downloaded?: { path: string; sha256: string; bytes: number };
}

export class TranscribeError extends Error {
  constructor(
    message: string,
    readonly fix?: string,
  ) {
    super(fix ? `${message}\nFix: ${fix}` : message);
    this.name = "TranscribeError";
  }
}

// ---------------------------------------------------------------------------------- model

export interface ResolvedModel {
  path: string;
  exists: boolean;
  from: "VS_WHISPER_MODEL" | "data_dir";
}

/** `VS_WHISPER_MODEL`, else `<plugin data>/models/ggml-base.en.bin`. */
export function resolveWhisperModel(env: Record<string, string | undefined> = process.env): ResolvedModel {
  const override = env.VS_WHISPER_MODEL?.trim();
  if (override && !/^\$\{[^}]*\}$/.test(override)) return { path: resolve(override), exists: existsSync(override), from: "VS_WHISPER_MODEL" };
  const path = join(resolveDataDir(env).root, "models", WHISPER_MODEL.file);
  return { path, exists: existsSync(path), from: "data_dir" };
}

/** The error shown when no model is present and the user has not agreed to a download. */
export function missingModelError(path: string): TranscribeError {
  return new TranscribeError(
    `no whisper model at ${path}. Local transcription needs ${WHISPER_MODEL.file} (~${WHISPER_MODEL.approx_mb} MB) from ${WHISPER_MODEL.url}.`,
    `ask the user whether to download it (about ${WHISPER_MODEL.approx_mb} MB, stored in the plugin data folder), then call transcribe again with download_model: true; or set VS_WHISPER_MODEL to a ggml model they already have; or pass captions_file with a .srt/.vtt they supply.`,
  );
}

/**
 * Download the model: fetch → `<dest>.part-*` while hashing → verify sha256 → rename, and record
 * `{url, sha256, bytes, downloaded_at}` in `<dest>.json`. Only called after explicit consent.
 */
export async function downloadWhisperModel(
  dest: string,
  opts: { fetch?: FetchLike; expectedSha256?: string | null; url?: string; signal?: AbortSignal } = {},
): Promise<{ path: string; sha256: string; bytes: number }> {
  const url = opts.url ?? WHISPER_MODEL.url;
  const doFetch = opts.fetch ?? (globalThis.fetch as FetchLike);
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  try {
    const res = await doFetch(url, opts.signal ? { signal: opts.signal } : undefined);
    if (!res.ok || !res.body) throw new TranscribeError(`model download failed: HTTP ${res.status} from ${url}`, "check the network connection, or set VS_WHISPER_MODEL to a model file you already have");
    const hash = createHash("sha256");
    let bytes = 0;
    const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
    });
    await pipeline(body, createWriteStream(tmp));
    const sha256 = hash.digest("hex");
    const expected = opts.expectedSha256 === undefined ? WHISPER_MODEL.sha256 : opts.expectedSha256;
    if (expected && sha256 !== expected) {
      throw new TranscribeError(`model download is corrupt or changed: sha256 ${sha256}, expected ${expected}`, "retry the download; if it keeps failing, download the model yourself and set VS_WHISPER_MODEL");
    }
    await rename(tmp, dest);
    await writeJsonAtomic(`${dest}.json`, { url, sha256, bytes, downloaded_at: new Date().toISOString() });
    return { path: dest, sha256, bytes };
  } finally {
    await rm(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------------- IR

export interface LoadedIr {
  path: string;
  ir: ContentIR;
}

export async function loadContentIr(projectDir: string): Promise<LoadedIr> {
  const path = join(projectDir, "source", "content-ir.json");
  if (!existsSync(path)) throw new TranscribeError(`no source/content-ir.json in ${projectDir}`, "ingest the video or audio file first");
  const r = ContentIR.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!r.success) throw new TranscribeError(`source/content-ir.json is invalid: ${formatIssues(r.error).map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  return { path, ir: r.data };
}

/** The video/audio asset `id`, with a helpful error listing the media assets. */
export function findMediaAsset(ir: ContentIR, id: string): IrAsset {
  const media = ir.assets.filter((a) => a.kind === "video" || a.kind === "audio");
  const asset = ir.assets.find((a) => a.id === id);
  if (!asset || asset.kind === "image") {
    const list = media.map((a) => `${a.id} (${a.kind} ${basename(a.path)})`).join(", ");
    throw new TranscribeError(`"${id}" is not a video or audio asset of this project`, list ? `use one of: ${list}` : "ingest a video or audio file first");
  }
  return asset;
}

/** `video:talk.mp4` from the asset's source_ref (or its file name). */
export function mediaRefBase(asset: IrAsset): string {
  const base = asset.source_ref?.split("#")[0];
  return base && /^(?:video|audio):\S+$/.test(base) ? base : `${asset.kind}:${encodeURIComponent(basename(asset.path))}`;
}

const secs = (ms: number) => (ms / 1000).toFixed(1);
export const transcriptHeading = (assetId: string) => `Transcript (${assetId})`;

export interface TranscriptMeta {
  path: string;
  source: "whisper" | "srt" | "vtt";
  model?: string;
  language?: string;
}

/**
 * Record a transcript in the IR (pure; returns a new, validated IR): the asset's
 * `media.transcript`, a section with the full text, one evidence span per sentence (replacing
 * a previous transcript of the same asset), quantitative claims from what was said, and PII or
 * secrets found in the speech OR-ed into the classification.
 */
export function applyTranscript(input: ContentIR, assetId: string, words: readonly TimedWord[], meta: TranscriptMeta): { ir: ContentIR; refs: string[]; text: string; sentences: number } {
  const ir = structuredClone(input);
  const asset = findMediaAsset(ir, assetId);
  const source =
    ir.sources.find((s) => s.sha256 === asset.sha256 && (s.kind === "video" || s.kind === "audio")) ??
    ir.sources.find((s) => s.sha256 === asset.sha256);
  if (!source) throw new TranscribeError(`no source in the ContentIR matches asset ${asset.id}`, "re-ingest the media file");
  const base = mediaRefBase(asset);
  const heading = transcriptHeading(asset.id);

  // Replace an earlier transcript of this asset.
  const isOld = (e: EvidenceSpan) => e.source_id === source.id && e.ref.startsWith(`${base}#t=`) && e.locator.time_start_sec !== undefined;
  const oldRefs = new Set(ir.evidence.filter(isOld).map((e) => e.ref));
  ir.evidence = ir.evidence.filter((e) => !isOld(e));
  ir.sections = ir.sections.filter((s) => !(s.source_id === source.id && s.heading === heading));
  ir.claims = ir.claims.filter((c) => !c.evidence_refs.some((r) => oldRefs.has(r)));

  const used = new Set(ir.evidence.map((e) => e.ref));
  const sentences = groupSentences(words);
  const spans: EvidenceSpan[] = sentences.map((s) => {
    let ref = `${base}#t=${secs(s.start_ms)}-${secs(s.end_ms)}`;
    for (let n = 2; used.has(ref); n++) ref = `${base}#t=${secs(s.start_ms)}-${secs(s.end_ms)}-${n}`;
    used.add(ref);
    return { ref, source_id: source.id, text: s.text, locator: { time_start_sec: s.start_ms / 1000, time_end_sec: s.end_ms / 1000 } };
  });
  ir.evidence.push(...spans);

  const text = sentences.map((s) => s.text).join(" ");
  const usedSec = new Set(ir.sections.map((s) => s.id));
  let n = ir.sections.length + 1;
  while (usedSec.has(`sec-${n}`)) n++;
  ir.sections.push({ id: `sec-${n}`, source_id: source.id, heading, text });

  // Quantitative claims from what was said, numbered after the existing ones.
  const known = new Set(ir.claims.map((c) => c.text.toLowerCase()));
  const usedClaim = new Set(ir.claims.map((c) => c.id));
  let k = ir.claims.length + 1;
  for (const c of deriveClaims(spans, 100)) {
    if (known.has(c.text.toLowerCase())) continue;
    while (usedClaim.has(`claim-${k}`)) k++;
    usedClaim.add(`claim-${k}`);
    ir.claims.push({ ...c, id: `claim-${k}` });
  }

  const { classification: c } = classifyText(spans.map((s) => s.text), { kind: source.kind });
  ir.classification = {
    contains_secrets: ir.classification.contains_secrets || c.contains_secrets,
    contains_pii: ir.classification.contains_pii || c.contains_pii,
    contains_likeness: ir.classification.contains_likeness,
    data_class: maxDataClass(ir.classification.data_class, c.data_class),
    notes: [...new Set([...ir.classification.notes, ...c.notes.map((x) => `${source.id} (speech): ${x}`)])],
  };

  const target = ir.assets.find((a) => a.id === asset.id)!;
  target.media = {
    ...(target.media ?? { duration_sec: words.length ? words[words.length - 1]!.end_ms / 1000 : 0, has_video: target.kind === "video", has_audio: true }),
    transcript: { path: meta.path, source: meta.source, ...(meta.model ? { model: meta.model } : {}), ...(meta.language ? { language: meta.language } : {}), words: words.length },
  };

  const r = ContentIR.safeParse(ir);
  if (!r.success) throw new TranscribeError(`transcript would make the ContentIR invalid: ${formatIssues(r.error).map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  return { ir: r.data, refs: spans.map((s) => s.ref), text, sentences: sentences.length };
}

/** Read `source/transcripts/<asset>.json` (timed words) for an asset. */
export async function loadTranscriptWords(projectDir: string, asset: IrAsset): Promise<TimedWord[]> {
  const t = asset.media?.transcript;
  if (!t) throw new TranscribeError(`asset ${asset.id} has no transcript`, `run transcribe for ${asset.id} first`);
  const data = JSON.parse(await readFile(join(projectDir, t.path), "utf8")) as unknown;
  const words = Array.isArray(data) ? data : (data as { words?: unknown }).words;
  if (!Array.isArray(words)) throw new TranscribeError(`${t.path} is not a timed-word list`, `run transcribe for ${asset.id} again`);
  return words as TimedWord[];
}

// ---------------------------------------------------------------------------------- tool

const MAX_TEXT = 20_000;

export async function transcribeAsset(projectDir: string, assetId: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  const root = resolve(projectDir);
  const env = opts.env ?? process.env;
  const { path: irPath, ir } = await loadContentIr(root);
  const asset = findMediaAsset(ir, assetId);

  let words: TimedWord[];
  let meta: Omit<TranscriptMeta, "path">;
  let downloaded: TranscribeResult["model_downloaded"];
  if (opts.captions_file) {
    // Inside the project only (symlinks resolved): a caption path never reads files from elsewhere.
    let file: string;
    try {
      file = await resolveInsideProject(projectPaths(root), opts.captions_file);
    } catch {
      throw new TranscribeError(`captions_file must be a path inside the project: ${opts.captions_file}`, "copy the .srt/.vtt into the project folder and pass its project-relative path");
    }
    const ext = extname(file).toLowerCase();
    if (ext !== ".srt" && ext !== ".vtt") throw new TranscribeError(`captions_file must be a .srt or .vtt file, got ${basename(file)}`);
    if (!existsSync(file)) throw new TranscribeError(`captions file not found: ${file}`, "pass a path relative to the project folder");
    const st = await stat(file);
    if (st.size > 20 * 1024 * 1024) throw new TranscribeError(`captions file is too large (${st.size} bytes)`);
    const text = await readFile(file, "utf8");
    words = parseCaptionFile(text);
    if (words.length === 0) throw new TranscribeError(`no cues found in ${basename(file)}`, "check that it is a valid SRT or WebVTT file");
    meta = { source: isVtt(text) || ext === ".vtt" ? "vtt" : "srt" };
  } else {
    if (asset.media && !asset.media.has_audio) throw new TranscribeError(`asset ${asset.id} has no audio track to transcribe`, "pass captions_file with a .srt/.vtt instead");
    let model = resolveWhisperModel(env);
    if (!model.exists) {
      if (model.from === "VS_WHISPER_MODEL") throw new TranscribeError(`VS_WHISPER_MODEL points at ${model.path}, which does not exist`, "fix the path or unset VS_WHISPER_MODEL");
      if (opts.download_model !== true) throw missingModelError(model.path);
      downloaded = await downloadWhisperModel(model.path, {
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.modelSha256 !== undefined ? { expectedSha256: opts.modelSha256 } : {}),
      });
      model = { ...model, exists: true };
    }
    const mediaPath = join(root, asset.path);
    words = await whisperTranscribe(mediaPath, { model: model.path, ...(opts.whisperBin ? { bin: opts.whisperBin } : {}) });
    meta = { source: "whisper", model: basename(model.path).replace(/\.bin$/i, ""), language: whisperLanguage(model.path) };
  }

  const rel = `source/transcripts/${asset.id}.json`;
  const abs = join(root, rel);
  const relCheck = relative(root, abs);
  if (relCheck.startsWith("..") || isAbsolute(relCheck)) throw new TranscribeError("transcript path escaped the project");
  await writeJsonAtomic(abs, words);
  const applied = applyTranscript(ir, asset.id, words, { path: rel, ...meta });
  await writeJsonAtomic(irPath, applied.ir);

  return {
    asset: asset.id,
    source: meta.source,
    words: words.length,
    path: rel,
    text: applied.text.length > MAX_TEXT ? `${applied.text.slice(0, MAX_TEXT)}…` : applied.text,
    sentences: applied.sentences,
    evidence_refs: applied.refs,
    ...(meta.model ? { model: meta.model } : {}),
    ...(downloaded ? { model_downloaded: downloaded } : {}),
  };
}
