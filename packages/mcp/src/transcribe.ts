import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { projectPaths, resolveDataDir, resolveInsideProject, writeJsonAtomic } from "@video-studio/core";
import { classifyText, deriveClaims, maxDataClass } from "@video-studio/ingestion";
import { type TimedSentence, type TimedWord, groupSentences, isEnglishOnlyModel, isVtt, parseCaptionFile, whisperLanguage, whisperTranscribeDetailed } from "@video-studio/media";
import { ContentIR, type EvidenceSpan, type IrAsset, formatIssues } from "@video-studio/schema";

/**
 * transcribe: local ASR (whisper.cpp) for a project's video/audio asset, or import of a user
 * SRT/VTT, written as a timed-word transcript and recorded on the asset's `media.transcript`.
 * Each sentence becomes an evidence span with a time locator (`video:talk.mp4#t=12.3-18.9`) so
 * specs can cite what was said. The whisper model is never downloaded without explicit consent
 * (`download_model: true`).
 */

export interface WhisperModelInfo {
  name: string;
  file: string;
  url: string;
  /** sha256 of the published file. */
  sha256: string;
  bytes: number;
  approx_mb: number;
  /** "en": English only; "multi": ~99 languages with detection. */
  languages: "en" | "multi";
  /** Detects speaker turns (tinydiarize, `-tdrz`). */
  speakers: boolean;
}

/** Models `transcribe` can download (with consent), keyed by the `model` option. */
export const WHISPER_MODELS = {
  "base.en": {
    name: "ggml-base.en",
    file: "ggml-base.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    bytes: 147_964_211,
    approx_mb: 148,
    languages: "en",
    speakers: false,
  },
  base: {
    name: "ggml-base",
    file: "ggml-base.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    bytes: 147_951_465,
    approx_mb: 148,
    languages: "multi",
    speakers: false,
  },
  "small.en-tdrz": {
    name: "ggml-small.en-tdrz",
    file: "ggml-small.en-tdrz.bin",
    url: "https://huggingface.co/akashmjn/tinydiarize-whisper.cpp/resolve/main/ggml-small.en-tdrz.bin",
    sha256: "ceac3ec06d1d98ef71aec665283564631055fd6129b79d8e1be4f9cc33cc54b4",
    bytes: 487_614_184,
    approx_mb: 488,
    languages: "en",
    speakers: true,
  },
} as const satisfies Record<string, WhisperModelInfo>;

export type WhisperModelName = keyof typeof WHISPER_MODELS;
export const WHISPER_MODEL_NAMES = Object.keys(WHISPER_MODELS) as [WhisperModelName, ...WhisperModelName[]];

/** The default (English) model; kept for compatibility. */
export const WHISPER_MODEL = WHISPER_MODELS["base.en"];

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface TranscribeOptions {
  /** Import this caption file instead of running ASR (project-relative .srt or .vtt). */
  captions_file?: string;
  /** Explicit consent to download the chosen whisper model into the plugin data dir. */
  download_model?: boolean;
  /** Spoken language: ISO 639-1 code (`es`, `hi`; `en-US` is reduced to `en`) or `auto` to detect. */
  language?: string;
  /** Whisper model (default: chosen from language/speakers, see {@link selectWhisperModel}). */
  model?: WhisperModelName;
  /** Detect speaker turns (English only, tinydiarize model `small.en-tdrz`). */
  speakers?: boolean;
  env?: Record<string, string | undefined>;
  /** Tests: injected fetch for the model download. */
  fetch?: FetchLike;
  /** Tests: expected sha256 of the downloaded model (default: the chosen model's published hash). */
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
  /** Spoken language: detected by whisper, or the one requested. */
  language?: string;
  /** Speaker labels present (speakers: true). */
  speakers?: boolean;
  /** Speaker turns detected (speakers: true). */
  speaker_turns?: number;
  warnings?: string[];
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
  /** Registry entry (absent for a VS_WHISPER_MODEL override). */
  info?: WhisperModelInfo;
}

const unexpanded = (v: string) => /^\$\{[^}]*\}$/.test(v);

/**
 * Where a model lives: `<plugin data>/models/<file>`. Without a name (the default model),
 * `VS_WHISPER_MODEL` overrides it; a named model is always the registry file.
 */
export function resolveWhisperModel(env: Record<string, string | undefined> = process.env, name?: WhisperModelName): ResolvedModel {
  const override = env.VS_WHISPER_MODEL?.trim();
  if (!name && override && !unexpanded(override)) return { path: resolve(override), exists: existsSync(override), from: "VS_WHISPER_MODEL" };
  const info: WhisperModelInfo = WHISPER_MODELS[name ?? "base.en"];
  const path = join(resolveDataDir(env).root, "models", info.file);
  return { path, exists: existsSync(path), from: "data_dir", info };
}

/** `en-US` → `en`, `AUTO` → `auto`; empty → undefined. */
export function normalizeLanguage(lang: string | undefined): string | undefined {
  const l = lang?.trim().toLowerCase();
  if (!l) return undefined;
  if (l === "auto") return "auto";
  const primary = l.split(/[-_]/)[0]!;
  if (!/^[a-z]{2,3}$/.test(primary)) throw new TranscribeError(`language must be an ISO 639-1 code like "es" or "hi", or "auto"; got "${lang}"`);
  return primary;
}

export interface ModelSelection {
  name: WhisperModelName;
  /** Language passed to whisper-cli (undefined: the model's default, `en` or `auto`). */
  language?: string;
  reason: string;
}

/**
 * Pick the model for a transcription:
 * - `model` given: that one (checked against `language` and `speakers`).
 * - `speakers`: small.en-tdrz (English only).
 * - `language` set and not `en` (or `auto`), or the spec's language is not English: base (multilingual).
 * - otherwise base.en when present, else base when present, else base.en (to download).
 */
export function selectWhisperModel(o: { model?: WhisperModelName; language?: string; speakers?: boolean; specLanguage?: string; has: (name: WhisperModelName) => boolean }): ModelSelection {
  const lang = normalizeLanguage(o.language);
  const spec = (() => {
    try {
      return normalizeLanguage(o.specLanguage);
    } catch {
      return undefined;
    }
  })();
  const nonEnglish = lang !== undefined && lang !== "en";
  if (o.model) {
    if (!(o.model in WHISPER_MODELS)) throw new TranscribeError(`unknown whisper model "${o.model}"`, `use one of: ${WHISPER_MODEL_NAMES.join(", ")}`);
    const info: WhisperModelInfo = WHISPER_MODELS[o.model];
    if (o.speakers && !info.speakers) throw new TranscribeError(`model ${o.model} cannot detect speaker turns`, `use model "small.en-tdrz" (or leave model out) with speakers: true`);
    if (nonEnglish && info.languages === "en") throw new TranscribeError(`model ${o.model} is English-only and cannot transcribe language "${lang}"`, `use model "base" (multilingual), or leave model out`);
    return { name: o.model, ...(lang ? { language: lang } : {}), reason: "requested" };
  }
  if (o.speakers) {
    if (nonEnglish) throw new TranscribeError("speaker turns work only for English (tinydiarize)", `leave speakers out for "${lang}" speech, or pass language: "en"`);
    return { name: "small.en-tdrz", language: "en", reason: "speaker turns (tinydiarize, English)" };
  }
  if (nonEnglish) return { name: "base", language: lang, reason: lang === "auto" ? "language detection needs the multilingual model" : `language "${lang}" needs the multilingual model` };
  if (!lang && spec && spec !== "en") return { name: "base", language: "auto", reason: `the video spec's language is "${spec}"` };
  if (o.has("base.en")) return { name: "base.en", ...(lang ? { language: lang } : {}), reason: "English (default)" };
  if (o.has("base")) return { name: "base", language: lang ?? "auto", reason: "multilingual model already downloaded" };
  return { name: "base.en", ...(lang ? { language: lang } : {}), reason: "English (default)" };
}

export interface WhisperPlan {
  selection: ModelSelection;
  model: ResolvedModel;
  /** The spec's language (project/video-spec.json), if any. */
  specLanguage?: string;
}

/** The spec's `language` (e.g. `es-ES`), or undefined when there is no readable spec. */
export async function readSpecLanguage(projectDir: string): Promise<string | undefined> {
  try {
    const spec = JSON.parse(await readFile(join(projectDir, "project", "video-spec.json"), "utf8")) as { language?: unknown };
    return typeof spec.language === "string" && spec.language.trim() ? spec.language.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Choose and locate the model for a transcription. `VS_WHISPER_MODEL` replaces the default
 * choice when neither `model` nor `speakers` is given (unless it is English-only and a
 * non-English language is needed).
 */
export async function planWhisperModel(
  projectDir: string,
  o: { model?: WhisperModelName; language?: string; speakers?: boolean },
  env: Record<string, string | undefined> = process.env,
): Promise<WhisperPlan> {
  const specLanguage = await readSpecLanguage(projectDir);
  const selection = selectWhisperModel({ ...o, ...(specLanguage ? { specLanguage } : {}), has: (n) => resolveWhisperModel(env, n).exists });
  const override = env.VS_WHISPER_MODEL?.trim();
  if (!o.model && !o.speakers && override && !unexpanded(override)) {
    const m = resolveWhisperModel(env);
    const englishOnly = isEnglishOnlyModel(m.path);
    const lang = normalizeLanguage(o.language);
    const wantsOther = (lang !== undefined && lang !== "en") || selection.reason.startsWith("the video spec");
    // An English-only override cannot serve a non-English request: fall through to the registry.
    if (!(englishOnly && wantsOther)) {
      const language = englishOnly ? lang : (lang ?? "auto");
      return { selection: { name: selection.name, ...(language ? { language } : {}), reason: "VS_WHISPER_MODEL" }, model: m, ...(specLanguage ? { specLanguage } : {}) };
    }
  }
  return { selection, model: resolveWhisperModel(env, selection.name), ...(specLanguage ? { specLanguage } : {}) };
}

/** The error shown when no model is present and the user has not agreed to a download. */
export function missingModelError(path: string, info: WhisperModelInfo = WHISPER_MODEL): TranscribeError {
  return new TranscribeError(
    `no whisper model at ${path}. Local transcription needs ${info.file} (~${info.approx_mb} MB) from ${info.url}.`,
    `ask the user whether to download it (about ${info.approx_mb} MB, stored in the plugin data folder), then call transcribe again with download_model: true; or set VS_WHISPER_MODEL to a ggml model they already have; or pass captions_file with a .srt/.vtt they supply.`,
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
  /** Words carry speaker labels (speaker-turn detection ran). */
  speakers?: boolean;
}

/**
 * Sentence text for evidence: with speaker labels, a sentence that starts a new speaker's turn
 * (and the first one) is prefixed `S2: `. Refs stay time-based, so they do not change.
 */
function speakerText(sentences: readonly TimedSentence[]): string[] {
  let prev: string | undefined;
  return sentences.map((s) => {
    const label = s.speaker !== undefined && s.speaker !== prev ? `${s.speaker}: ` : "";
    prev = s.speaker;
    return `${label}${s.text}`;
  });
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
  const texts = speakerText(sentences);
  const spans: EvidenceSpan[] = sentences.map((s, i) => {
    let ref = `${base}#t=${secs(s.start_ms)}-${secs(s.end_ms)}`;
    for (let n = 2; used.has(ref); n++) ref = `${base}#t=${secs(s.start_ms)}-${secs(s.end_ms)}-${n}`;
    used.add(ref);
    return { ref, source_id: source.id, text: texts[i]!, locator: { time_start_sec: s.start_ms / 1000, time_end_sec: s.end_ms / 1000 } };
  });
  ir.evidence.push(...spans);

  const text = texts.join(" ");
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
    transcript: { path: meta.path, source: meta.source, ...(meta.model ? { model: meta.model } : {}), ...(meta.language ? { language: meta.language } : {}), ...(meta.speakers !== undefined ? { speakers: meta.speakers } : {}), words: words.length },
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
  let speakerTurns: number | undefined;
  const warnings: string[] = [];
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
    const plan = await planWhisperModel(root, { ...(opts.model ? { model: opts.model } : {}), ...(opts.language ? { language: opts.language } : {}), ...(opts.speakers ? { speakers: true } : {}) }, env);
    let model = plan.model;
    const info = model.info ?? WHISPER_MODELS[plan.selection.name];
    if (!model.exists) {
      if (model.from === "VS_WHISPER_MODEL") throw new TranscribeError(`VS_WHISPER_MODEL points at ${model.path}, which does not exist`, "fix the path or unset VS_WHISPER_MODEL");
      if (opts.download_model !== true) throw missingModelError(model.path, info);
      downloaded = await downloadWhisperModel(model.path, {
        url: info.url,
        expectedSha256: opts.modelSha256 !== undefined ? opts.modelSha256 : info.sha256,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
      });
      model = { ...model, exists: true };
    }
    const mediaPath = join(root, asset.path);
    const speakers = opts.speakers === true;
    const language = plan.selection.language;
    const r = await whisperTranscribeDetailed(mediaPath, {
      model: model.path,
      ...(language ? { language } : {}),
      ...(speakers ? { speakers: true } : {}),
      ...(opts.whisperBin ? { bin: opts.whisperBin } : {}),
    });
    words = r.words;
    speakerTurns = r.speaker_turns;
    const englishOnly = isEnglishOnlyModel(model.path);
    const detected = englishOnly ? "en" : (r.language ?? (language && language !== "auto" ? language : undefined));
    meta = {
      source: "whisper",
      model: basename(model.path).replace(/\.bin$/i, ""),
      ...(detected ? { language: detected } : { language: whisperLanguage(model.path, language) }),
      speakers,
    };
    warnings.push(...languageWarnings({ specLanguage: plan.specLanguage, detected, englishOnly }));
    if (speakers && !speakerTurns) {
      warnings.push("no speaker turns were detected: tinydiarize is trained on conversation and finds turn changes in dialogue, not between separate monologues; all words are labelled S1");
    }
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
    ...(meta.language ? { language: meta.language } : {}),
    ...(meta.speakers ? { speakers: true, speaker_turns: speakerTurns ?? 0 } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(downloaded ? { model_downloaded: downloaded } : {}),
  };
}

/**
 * Warnings when the transcript's language and the video spec's disagree. English-only models
 * always report `en`, so a non-English spec with such a model is flagged as a likely mistranscription.
 */
export function languageWarnings(o: { specLanguage?: string | undefined; detected?: string | undefined; englishOnly: boolean }): string[] {
  let spec: string | undefined;
  try {
    spec = normalizeLanguage(o.specLanguage);
  } catch {
    return [];
  }
  if (!spec || spec === "auto") return [];
  if (o.englishOnly && spec !== "en") {
    return [`the video spec's language is "${o.specLanguage}" but an English-only model was used, so non-English speech is transcribed as (wrong) English; run transcribe again with model: "base" (multilingual) or language: "${spec}"`];
  }
  if (o.detected && o.detected !== "auto" && o.detected !== spec) {
    return [`whisper detected "${o.detected}" speech but the video spec's language is "${o.specLanguage}": check the spec's language, or pass language: "${spec}" to force it`];
  }
  return [];
}
