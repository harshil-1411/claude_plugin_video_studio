import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalJson, projectPaths, sha256Hex } from "@video-studio/core";
import { SCHEMA_VERSION, type TranslationEntry, TranslationSheet, VideoSpec, parseYamlOrJson, voiceMode } from "@video-studio/schema";
import { projectSpecPaths, validateSpecFile } from "./spec-validate.js";
import { estimateSpeechSec as voiceSpeechSec } from "@video-studio/voice";

/**
 * localize: make a language version of a planned project.
 *
 * Step 1 (no `apply`): copies the project (source, input, assets, brand.yaml, project) into
 * `<project>/localized/<language>/` (or `out_dir`) with spec.language set, and writes
 * project/translation.json listing every viewer-facing string with notes (budgets, what not to
 * translate). Re-running step 1 keeps the targets of entries whose path and source are unchanged.
 *
 * Step 2 (`apply`): refuses when the source spec changed since the sheet was made; builds the
 * localized spec from the source spec and the sheet (an empty target keeps the source), re-derives
 * `emphasis`, renames diagram edges with their nodes, re-times narrated scenes for the language's
 * speaking speed (and on-screen-only scenes for its reading speed), and validates. The localized
 * spec is always rebuilt from the source spec + sheet, so edit the sheet, not the localized spec.
 */

export interface LocalizeOptions {
  apply?: boolean;
  /** Default: <project>/localized/<language>. */
  out_dir?: string;
}

export interface LocalizeResult {
  language: string;
  out_dir: string;
  sheet_path: string;
  entries: number;
  translated: number;
  applied: boolean;
  notes: string[];
  valid?: boolean;
  errors?: string[];
  sheet?: TranslationSheet;
}

// ------------------------------------------------------------------------------------ language rates

/**
 * Speaking and reading speed per language. Scripts written without spaces between words (CJK,
 * Thai, …) are measured in characters, others in words.
 *
 * NOTE: a local table until @video-studio/voice exports script-aware speech estimates; swap
 * `languageRate` for those when they land so localize and the voice backends agree.
 */
export interface LanguageRate {
  unit: "words" | "chars";
  /** Comfortable narration speed (TTS at a natural pace). */
  speak_per_sec: number;
  /** On-screen reading speed without narration. */
  read_per_sec: number;
}

const CHAR_SCRIPTS: Record<string, LanguageRate> = {
  ja: { unit: "chars", speak_per_sec: 7, read_per_sec: 8 },
  zh: { unit: "chars", speak_per_sec: 4.5, read_per_sec: 6 },
  yue: { unit: "chars", speak_per_sec: 4.5, read_per_sec: 6 },
  ko: { unit: "chars", speak_per_sec: 5.5, read_per_sec: 7 },
  th: { unit: "chars", speak_per_sec: 10, read_per_sec: 12 },
  lo: { unit: "chars", speak_per_sec: 10, read_per_sec: 12 },
  km: { unit: "chars", speak_per_sec: 9, read_per_sec: 11 },
  my: { unit: "chars", speak_per_sec: 9, read_per_sec: 11 },
};
const WORD_RATES: Record<string, number> = {
  en: 2.5,
  de: 2.2,
  nl: 2.3,
  fr: 2.6,
  es: 2.7,
  it: 2.6,
  pt: 2.5,
  ru: 2.2,
  pl: 2.2,
  uk: 2.2,
  tr: 2.1,
  fi: 1.9,
  hi: 2.4,
  bn: 2.3,
  ar: 2.1,
  he: 2.2,
  fa: 2.3,
  id: 2.3,
  vi: 3.0,
};

export function languageRate(language: string): LanguageRate {
  const primary = language.split("-")[0]!.toLowerCase();
  const chars = CHAR_SCRIPTS[primary];
  if (chars) return chars;
  const wps = WORD_RATES[primary] ?? 2.4;
  return { unit: "words", speak_per_sec: wps, read_per_sec: 3 };
}

/** Length of `text` in the language's unit: words, or letters/digits for character scripts. */
export function countUnits(text: string, language: string): number {
  if (languageRate(language).unit === "chars") return (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return text.trim() ? text.trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

/**
 * Seconds to speak `text`: the voice package's per-script rates (the same the render plan uses),
 * plus sentence pauses. `language` only matters when the text's script is ambiguous.
 */
export function estimateSpeechSec(text: string, language: string): number {
  if (!countUnits(text, language)) return 0;
  const sentences = (text.match(/[.!?…。！？]+/g) ?? []).length;
  return voiceSpeechSec(text) + Math.max(0, sentences - 1) * 0.25;
}

const unitLabel = (language: string, n: number) => `${n} ${languageRate(language).unit === "chars" ? "characters" : n === 1 ? "word" : "words"}`;

// ------------------------------------------------------------------------------------ extraction

const HAS_LETTER = /\p{L}/u;
const URL_LIKE = /^(?:https?:\/\/|www\.)\S+$|^[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/i;
const COMMAND_LIKE = /^(?:\$\s|>\s)|^(?:npm|npx|pnpm|yarn|pip|pipx|brew|git|cargo|go|docker|kubectl|curl|wget|make|node|python3?|uv|deno|bun)\s/;
const CODE_HINT = /`|=>|\(\)|::|\{\s*\}|<\/?[a-z][^>]*>|[a-z]+_[a-z]+\(|--[a-z]/i;

/** True when a string is something a viewer reads and a translator should see. */
export function isTranslatable(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t || !HAS_LETTER.test(t)) return false;
  if (URL_LIKE.test(t) || COMMAND_LIKE.test(t)) return false;
  return true;
}

function codeNote(text: string): string | undefined {
  return CODE_HINT.test(text) ? "contains code or a command: keep those parts exactly as written" : undefined;
}

const joinNotes = (...n: Array<string | undefined>) => n.filter(Boolean).join("; ") || undefined;

/** The source language's length of a string and the budget for its translation. */
function lengthBudget(text: string, from: string, to: string, slack = 1.2): string {
  const fromChars = languageRate(from).unit === "chars";
  const toChars = languageRate(to).unit === "chars";
  const src = countUnits(text, from);
  let max: number;
  if (fromChars === toChars) max = Math.ceil(src * slack);
  else if (toChars) max = Math.ceil(src * 2 * slack); // ~2 CJK characters per English word
  else max = Math.ceil((src / 2) * slack);
  return `keep it about as short as the source: at most ${unitLabel(to, Math.max(1, max))}`;
}

interface Collector {
  entries: TranslationEntry[];
  from: string;
  to: string;
}

function add(c: Collector, path: string, kind: TranslationEntry["kind"], source: unknown, ...notes: Array<string | undefined>) {
  if (!isTranslatable(source)) return;
  const note = joinNotes(codeNote(source), ...notes);
  c.entries.push({ path, kind, source, ...(note ? { note } : {}) });
}

const EMPHASIS_NOTE = (em: string) =>
  `"${em}" is emphasised: mark the word(s) of your translation that carry it with *asterisks* (e.g. "… *Wörter*"); unmarked, apply keeps "${em}" if it appears, else picks the longest word`;

function collectProps(c: Collector, base: string, kind: string, props: Record<string, unknown>) {
  const p = (k: string) => `${base}.${k}`;
  const short = (t: unknown) => (typeof t === "string" ? lengthBudget(t, c.from, c.to) : undefined);
  const NAME = "a proper name: keep it unless it has an established form in the target language";
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const unitNote = "unit: translate words, keep symbols";
  const unitOk = (u: unknown) => typeof u === "string" && /\p{L}{3,}/u.test(u);
  switch (kind) {
    case "typography": {
      const em = typeof props.emphasis === "string" ? props.emphasis.trim() : "";
      arr(props.lines).forEach((l, j) => {
        const has = em && typeof l === "string" && l.toLowerCase().includes(em.toLowerCase());
        add(c, p(`lines.${j}`), "props", l, short(l), has ? EMPHASIS_NOTE(em) : undefined);
      });
      break;
    }
    case "kinetic_text": {
      const em = typeof props.emphasis === "string" ? props.emphasis.trim() : "";
      add(c, p("text"), "props", props.text, short(props.text), "shown word by word: short words and phrases", em ? EMPHASIS_NOTE(em) : undefined);
      break;
    }
    case "diagram":
      arr(props.nodes).forEach((n, j) => add(c, p(`nodes.${j}`), "props", n, "diagram node label (edges follow it automatically); 1–3 words"));
      break;
    case "comparison":
    case "split_screen":
      for (const side of ["left", "right"]) {
        add(c, p(`${side}.label`), "props", obj(props[side]).label, "panel label: 1–2 words");
        add(c, p(`${side}.text`), "props", obj(props[side]).text, short(obj(props[side]).text));
      }
      add(c, p("verdict"), "props", props.verdict, short(props.verdict));
      break;
    case "cta":
      add(c, p("headline"), "props", props.headline, short(props.headline));
      add(c, p("action"), "props", props.action, "call to action: an imperative verb phrase", short(props.action));
      break;
    case "end_card":
      add(c, p("title"), "props", props.title, "often a product name: keep names");
      add(c, p("subtitle"), "props", props.subtitle, short(props.subtitle));
      break;
    case "chart":
      add(c, p("label"), "props", props.label, short(props.label));
      if (unitOk(props.unit)) add(c, p("unit"), "props", props.unit, unitNote);
      arr(props.series).forEach((s, j) => add(c, p(`series.${j}.label`), "props", obj(s).label, "chart axis/bar label: 1–2 words"));
      break;
    case "stat":
      add(c, p("label"), "props", props.label, short(props.label));
      add(c, p("context"), "props", props.context, short(props.context));
      if (unitOk(props.unit)) add(c, p("unit"), "props", props.unit, unitNote);
      break;
    case "screenshot":
      arr(props.callouts).forEach((co, j) =>
        typeof co === "string" ? add(c, p(`callouts.${j}`), "props", co, short(co), "callout on a screenshot: UI names shown in the image stay as they appear") : add(c, p(`callouts.${j}.text`), "props", obj(co).text, short(obj(co).text), "callout on a screenshot: UI names shown in the image stay as they appear"),
      );
      break;
    case "quote":
      add(c, p("text"), "props", props.text, "a quotation: translate faithfully, never paraphrase into new claims", short(props.text));
      add(c, p("attribution"), "props", props.attribution, NAME);
      add(c, p("source"), "props", props.source, "the work quoted: keep titles as published");
      break;
    case "timeline":
      arr(props.events).forEach((e, j) => {
        add(c, p(`events.${j}.label`), "props", obj(e).label, "timeline label: 1–3 words");
        add(c, p(`events.${j}.text`), "props", obj(e).text, short(obj(e).text));
      });
      break;
    case "lower_third":
      add(c, p("name"), "props", props.name, NAME);
      add(c, p("title"), "props", props.title, "job title or role");
      add(c, p("headline"), "props", props.headline, short(props.headline));
      break;
    case "map":
      add(c, p("title"), "props", props.title, short(props.title));
      arr(props.points).forEach((pt, j) => add(c, p(`points.${j}.label`), "props", obj(pt).label, "map pin label: 1–2 words"));
      break;
    default:
      // code: never translated.
      break;
  }
}

/** Every viewer-facing string of `spec`, with translator notes for `to`. */
export function extractEntries(spec: VideoSpec, to: string): TranslationEntry[] {
  const from = spec.language;
  const c: Collector = { entries: [], from, to };
  const narrated = voiceMode(spec) === "narrated";
  const rate = languageRate(to);
  add(c, "title", "title", spec.title, "video title (also the default post title)", lengthBudget(spec.title ?? "", from, to));
  spec.scenes.forEach((s, i) => {
    const base = `scenes.${i}`;
    if (narrated && s.voiceover.trim()) {
      const max = Math.max(1, Math.floor(Math.max(0.5, s.duration_sec - 0.3) * rate.speak_per_sec));
      add(
        c,
        `${base}.voiceover`,
        "voiceover",
        s.voiceover,
        `spoken in ${s.duration_sec}s (${s.purpose}): aim for at most ${unitLabel(to, max)} (~${rate.speak_per_sec} ${rate.unit}/s); longer lines lengthen the scene at apply`,
        "same claims as the source, no new facts, numbers and names unchanged",
      );
    } else if (s.voiceover.trim()) {
      add(c, `${base}.voiceover`, "voiceover", s.voiceover, `voice.mode is ${voiceMode(spec)}: not spoken, used for captions/notes`);
    }
    if (s.on_screen_text?.trim()) {
      const max = Math.max(1, Math.floor(Math.max(0.5, s.duration_sec - 0.5) * rate.read_per_sec));
      add(c, `${base}.on_screen_text`, "on_screen_text", s.on_screen_text, `on screen for ${s.duration_sec}s: at most ${unitLabel(to, max)}`, lengthBudget(s.on_screen_text, from, to));
    }
    if (s.deterministic) collectProps(c, `${base}.deterministic.props`, s.deterministic.kind, s.deterministic.props);
    (s.sfx ?? []).forEach((fx, j) => add(c, `${base}.sfx.${j}.caption`, "on_screen_text", fx.caption, "sound-event caption: keep the [brackets], 1–3 words"));
  });
  if (spec.cover) add(c, "cover.headline", "cover", spec.cover.headline, "cover headline: large text on the thumbnail", lengthBudget(spec.cover.headline, from, to, 1.1));
  for (const [t, pub] of Object.entries(spec.publish ?? {})) {
    add(c, `publish.${t}.post_caption`, "post", pub.post_caption, `post text for ${t}: keep its length limit (see dist/${t}/post.json limits) and the call to action`);
    (pub.hashtags ?? []).forEach((h, j) => add(c, `publish.${t}.hashtags.${j}`, "post", h, "hashtag: # then letters, digits or _ only, no spaces; use the tag people search for in the language, or keep it"));
  }
  return c.entries;
}

// ------------------------------------------------------------------------------------ JSON paths

function getAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const k of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function setAt(root: unknown, path: string, value: unknown): boolean {
  const keys = path.split(".");
  let cur: unknown = root;
  for (const k of keys.slice(0, -1)) {
    if (cur === null || typeof cur !== "object") return false;
    cur = (cur as Record<string, unknown>)[k];
  }
  if (cur === null || typeof cur !== "object") return false;
  (cur as Record<string, unknown>)[keys[keys.length - 1]!] = value;
  return true;
}

// ------------------------------------------------------------------------------------ emphasis

const stripEdges = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** `*word*` marks → {text without marks, marked words}. */
export function takeEmphasisMarks(text: string): { text: string; marked: string[] } {
  const marked: string[] = [];
  const clean = text.replace(/\*([^*\n]+)\*/g, (_, w: string) => {
    marked.push(w.trim());
    return w;
  });
  return { text: clean, marked };
}

/**
 * The emphasis for translated `lines`: a marked word, else the source emphasis if it still
 * appears (names, numbers, acronyms), else the longest word of the line that held it (word
 * scripts only). Null: drop the emphasis.
 */
export function deriveEmphasis(opts: { lines: string[]; marked: string[]; sourceEmphasis: string; lineIndex: number; language: string }): { emphasis: string | null; how: string } {
  const all = opts.lines.join(" ").toLowerCase();
  const m = opts.marked.find((w) => w && all.includes(w.toLowerCase()));
  if (m) return { emphasis: m, how: "marked in the translation" };
  if (opts.sourceEmphasis && all.includes(opts.sourceEmphasis.toLowerCase())) return { emphasis: opts.sourceEmphasis, how: "kept (appears in the translation)" };
  if (languageRate(opts.language).unit === "chars") return { emphasis: null, how: "dropped (no word boundaries to pick from; mark it with *asterisks* in the sheet)" };
  const line = opts.lines[opts.lineIndex] ?? opts.lines.join(" ");
  const words = line.split(/\s+/).map(stripEdges).filter((w) => Array.from(w).length >= 3);
  if (!words.length) return { emphasis: null, how: "dropped (no suitable word)" };
  const best = words.reduce((a, b) => (Array.from(b).length > Array.from(a).length ? b : a));
  return { emphasis: best, how: "longest word of the line (mark another with *asterisks* in the sheet to change it)" };
}

// ------------------------------------------------------------------------------------ main

const SHEET = "translation.json";
const round1 = (n: number) => Math.round(n * 10) / 10;

async function readSourceSpec(root: string): Promise<VideoSpec> {
  const text = await readFile(projectSpecPaths(root).spec, "utf8").catch(() => {
    throw new Error(`no project/video-spec.json in ${root}; plan the project first`);
  });
  const parsed = parseYamlOrJson(VideoSpec, text);
  if (!parsed.ok) throw new Error(`project/video-spec.json is invalid; run spec_validate first (${parsed.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join("; ")})`);
  return parsed.data;
}

async function readSheet(path: string): Promise<TranslationSheet | undefined> {
  if (!existsSync(path)) return undefined;
  const parsed = parseYamlOrJson(TranslationSheet, await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(`${path} is not a valid TranslationSheet: ${parsed.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join("; ")}`);
  return parsed.data;
}

function localizedId(spec: VideoSpec, language: string): string {
  return `${spec.id ?? "video"}-${language.toLowerCase()}`.replace(/[^A-Za-z0-9_.@:-]/g, "-");
}

/** The source spec with the language set for `language` (text unchanged). */
function baseLocalizedSpec(src: VideoSpec, language: string, notes: string[]): VideoSpec {
  const spec = structuredClone(src);
  spec.language = language;
  spec.id = localizedId(src, language);
  if (spec.voice.voice_id) {
    notes.push(`voice.voice_id "${spec.voice.voice_id}" removed: it speaks ${src.language}; the voice backend picks a ${language} voice (set one explicitly if you prefer)`);
    delete spec.voice.voice_id;
  }
  return spec;
}

export async function localizeProject(projectDir: string, language: string, opts: LocalizeOptions = {}): Promise<LocalizeResult> {
  const root = projectPaths(projectDir).root;
  const out = resolve(opts.out_dir ?? join(root, "localized", language));
  if (out === root) throw new Error("out_dir must differ from the source project (localize never modifies the source)");
  const src = await readSourceSpec(root);
  if (src.language.toLowerCase() === language.toLowerCase()) throw new Error(`the project is already in ${src.language}; choose another language`);
  const srcSha = sha256Hex(canonicalJson(src));
  const sheetPath = join(out, "project", SHEET);
  const notes: string[] = [];
  return opts.apply ? applySheet(root, out, sheetPath, src, srcSha, language, notes) : prepare(root, out, sheetPath, src, srcSha, language, notes);
}

async function prepare(root: string, out: string, sheetPath: string, src: VideoSpec, srcSha: string, language: string, notes: string[]): Promise<LocalizeResult> {
  let previous: TranslationSheet | undefined;
  if (existsSync(out) && (await readdir(out)).length > 0) {
    previous = await readSheet(sheetPath).catch(() => undefined);
    if (!previous || previous.target_language.toLowerCase() !== language.toLowerCase()) {
      throw new Error(`out_dir ${out} is not empty and holds no ${language} translation sheet; choose a new folder`);
    }
  }
  await mkdir(out, { recursive: true });
  for (const part of ["source", "input", "assets", "brand.yaml", "project"]) {
    const from = join(root, part);
    if (!existsSync(from)) continue;
    // assets/voice holds the source language's synthesized narration: never carry it over.
    await rm(join(out, part), { recursive: true, force: true });
    await cp(from, join(out, part), { recursive: true, filter: (p) => !p.startsWith(join(root, "assets", "voice")) });
  }
  const spec = baseLocalizedSpec(src, language, notes);
  await writeFile(projectSpecPaths(out).spec, `${JSON.stringify(spec, null, 2)}\n`);

  const entries = extractEntries(src, language);
  let kept = 0;
  if (previous) {
    const prior = new Map(previous.entries.map((e) => [`${e.path}\u0000${e.source}`, e.target]));
    for (const e of entries) {
      const t = prior.get(`${e.path}\u0000${e.source}`);
      if (t) {
        e.target = t;
        kept++;
      }
    }
    if (kept) notes.push(`kept ${kept} translation(s) from the previous sheet (same path and source text)`);
  }
  const sheet: TranslationSheet = { schema_version: SCHEMA_VERSION, source_language: src.language, target_language: language, source_spec_sha256: srcSha, entries };
  await writeFile(sheetPath, `${JSON.stringify(sheet, null, 2)}\n`);
  const rate = languageRate(language);
  notes.push(
    `fill each entry's "target" in project/translation.json (meaning, not word for word; the same claims; within each note's budget), then run localize with apply: true`,
    `${language} is measured in ${rate.unit}: about ${rate.speak_per_sec} ${rate.unit}/s spoken, ${rate.read_per_sec} ${rate.unit}/s read`,
  );
  return { language, out_dir: out, sheet_path: sheetPath, entries: entries.length, translated: kept, applied: false, notes, sheet };
}

async function applySheet(root: string, out: string, sheetPath: string, src: VideoSpec, srcSha: string, language: string, notes: string[]): Promise<LocalizeResult> {
  const sheet = await readSheet(sheetPath);
  if (!sheet) throw new Error(`no translation sheet at ${sheetPath}; run localize without apply first`);
  if (sheet.target_language.toLowerCase() !== language.toLowerCase()) throw new Error(`${sheetPath} is for ${sheet.target_language}, not ${language}`);
  if (sheet.source_spec_sha256 !== srcSha) {
    throw new Error(
      "the source project/video-spec.json changed since the sheet was made; run localize without apply again (translations whose source text is unchanged are kept), translate the new entries, then apply",
    );
  }
  const spec = baseLocalizedSpec(src, language, notes);
  const untranslated = new Map<string, number>();
  let translated = 0;
  // Diagram node renames per scene: edges follow their nodes.
  const nodeRenames = new Map<number, Map<string, string>>();
  // Emphasis marks per scene props (typography lines / kinetic text).
  const marks = new Map<string, string[]>();

  for (const e of sheet.entries) {
    const target = e.target?.trim();
    if (!target) {
      untranslated.set(e.kind, (untranslated.get(e.kind) ?? 0) + 1);
      continue;
    }
    const current = getAt(src, e.path);
    if (current !== e.source) {
      notes.push(`${e.path}: the sheet's source no longer matches the spec; skipped`);
      continue;
    }
    let value = target;
    // Units keep the source's separator (" hours" → " घंटे"), except in scripts written without spaces.
    if (e.path.endsWith(".unit") && /^\s/.test(e.source) && !/^\s/.test(value) && languageRate(sheet.target_language).unit !== "chars") value = ` ${value}`;
    const em = /^scenes\.(\d+)\.deterministic\.props\.(lines\.\d+|text)$/.exec(e.path);
    if (em) {
      const t = takeEmphasisMarks(target);
      value = t.text;
      if (t.marked.length) marks.set(em[1]!, [...(marks.get(em[1]!) ?? []), ...t.marked]);
    } else if (/\.sfx\.\d+\.caption$/.test(e.path)) {
      value = /^\[.*\]$/.test(value) ? value : `[${value.replace(/^\[|\]$/g, "")}]`;
    } else if (/^publish\.[^.]+\.hashtags\.\d+$/.test(e.path)) {
      if (!/^#[\p{L}\p{N}_]+$/u.test(value)) {
        notes.push(`${e.path}: "${value}" is not a hashtag (# then letters, digits or _); kept ${e.source}`);
        continue;
      }
    }
    const node = /^scenes\.(\d+)\.deterministic\.props\.nodes\.\d+$/.exec(e.path);
    if (node) {
      const m = nodeRenames.get(Number(node[1])) ?? new Map<string, string>();
      m.set(e.source, value);
      nodeRenames.set(Number(node[1]), m);
    }
    if (!setAt(spec, e.path, value)) {
      notes.push(`${e.path}: not found in the spec; skipped`);
      continue;
    }
    translated++;
  }
  for (const [kind, n] of untranslated) notes.push(`${n} ${kind} entr${n === 1 ? "y has" : "ies have"} no target and keep${n === 1 ? "s" : ""} the ${src.language} text`);

  spec.scenes.forEach((s, i) => {
    const d = s.deterministic;
    if (!d) return;
    const props = d.props as Record<string, unknown>;
    // diagram edges follow renamed nodes
    const ren = nodeRenames.get(i);
    if (d.kind === "diagram" && ren && Array.isArray(props.edges)) {
      props.edges = (props.edges as unknown[]).map((edge) => (Array.isArray(edge) ? edge.map((n) => (typeof n === "string" ? (ren.get(n) ?? n) : n)) : edge));
    }
    // emphasis must be a word of the translated text
    if ((d.kind === "typography" || d.kind === "kinetic_text") && typeof props.emphasis === "string" && props.emphasis.trim()) {
      const srcProps = src.scenes[i]!.deterministic!.props as Record<string, unknown>;
      const srcLines = d.kind === "typography" ? ((srcProps.lines as unknown[]) ?? []).map(String) : [String(srcProps.text ?? "")];
      const lines = d.kind === "typography" ? ((props.lines as unknown[]) ?? []).map(String) : [String(props.text ?? "")];
      const changed = lines.some((l, k) => l !== srcLines[k]);
      if (!changed) return;
      const srcEm = props.emphasis.trim();
      const lineIndex = Math.max(0, srcLines.findIndex((l) => l.toLowerCase().includes(srcEm.toLowerCase())));
      const r = deriveEmphasis({ lines, marked: marks.get(String(i)) ?? [], sourceEmphasis: srcEm, lineIndex, language });
      if (r.emphasis) {
        if (r.emphasis !== srcEm) notes.push(`${s.id}: emphasis "${srcEm}" → "${r.emphasis}" (${r.how})`);
        props.emphasis = r.emphasis;
      } else {
        delete props.emphasis;
        notes.push(`${s.id}: emphasis "${srcEm}" ${r.how}`);
      }
    } else if ((d.kind === "typography" || d.kind === "kinetic_text") && marks.has(String(i))) {
      props.emphasis = marks.get(String(i))![0]!;
    }
  });

  retime(src, spec, language, notes);

  const { spec: specPath, contentIr } = projectSpecPaths(out);
  await mkdir(join(out, "project"), { recursive: true });
  await writeFile(specPath, `${JSON.stringify(spec, null, 2)}\n`);
  const validation = await validateSpecFile(specPath, existsSync(contentIr) ? contentIr : null);
  for (const w of validation.warnings) notes.push(`spec warning ${w.path}: ${w.message}`);
  return {
    language,
    out_dir: out,
    sheet_path: sheetPath,
    entries: sheet.entries.length,
    translated,
    applied: true,
    notes,
    valid: validation.ok,
    errors: validation.errors.map((e) => `${e.path}: ${e.message} (fix: ${e.fix})`),
  };
}

/** Lead-in and tail around narration inside a scene. */
const SPEECH_PAD_SEC = 0.4;
/** Settle time before on-screen text is read. */
const READ_SETTLE_SEC = 0.5;
const DURATION_TOLERANCE = 0.1;

/**
 * Lengthen scenes whose translated narration (or, without narration, on-screen text) needs more
 * time in `language`; scenes never shrink (their visuals were paced for the source). Keeps the
 * cover's focal frame at the same relative point of its scene. When the total leaves ±10% of
 * target_duration_sec, the target follows the new total (reported).
 */
function retime(src: VideoSpec, spec: VideoSpec, language: string, notes: string[]) {
  const narrated = voiceMode(spec) === "narrated";
  const rate = languageRate(language);
  const changed: string[] = [];
  spec.scenes.forEach((s) => {
    let need = 0;
    if (narrated && s.voiceover.trim()) need = estimateSpeechSec(s.voiceover, language) + SPEECH_PAD_SEC;
    else if (!narrated && s.on_screen_text?.trim()) need = countUnits(s.on_screen_text, language) / rate.read_per_sec + READ_SETTLE_SEC;
    need = Math.min(30, round1(need));
    if (need > s.duration_sec + 0.05) {
      changed.push(`${s.id} ${s.duration_sec}s → ${need}s`);
      s.duration_sec = need;
    }
  });
  if (changed.length) notes.push(`re-timed for ${language} ${narrated ? "speech" : "reading"} speed: ${changed.join(", ")}`);
  if (spec.cover) {
    let acc = 0;
    let newAcc = 0;
    for (const [i, s] of src.scenes.entries()) {
      const d = s.duration_sec;
      const nd = spec.scenes[i]!.duration_sec;
      if (spec.cover.focal_time_sec < acc + d || i === src.scenes.length - 1) {
        const f = Math.min(1, Math.max(0, (spec.cover.focal_time_sec - acc) / d));
        const t = round1(newAcc + f * nd);
        if (t !== spec.cover.focal_time_sec) notes.push(`cover.focal_time_sec ${spec.cover.focal_time_sec} → ${t} (same point of ${s.id})`);
        spec.cover.focal_time_sec = t;
        break;
      }
      acc += d;
      newAcc += nd;
    }
  }
  const total = round1(spec.scenes.reduce((a, s) => a + s.duration_sec, 0));
  if (Math.abs(total - spec.target_duration_sec) > spec.target_duration_sec * DURATION_TOLERANCE) {
    notes.push(
      `target_duration_sec ${spec.target_duration_sec}s → ${Math.round(total)}s: the ${language} version runs ${total}s, outside ±10%; shorten the longest translations to get closer to ${spec.target_duration_sec}s, and check the targets' duration limits`,
    );
    spec.target_duration_sec = Math.round(total);
  } else if (changed.length) {
    notes.push(`total ${total}s, within ±10% of the ${spec.target_duration_sec}s target`);
  }
}

export function formatLocalize(r: LocalizeResult): string {
  const head = r.applied
    ? `applied ${r.translated}/${r.entries} translation(s) into ${r.out_dir} (${r.language}); spec ${r.valid ? "valid" : `has ${r.errors?.length ?? 0} error(s)`}`
    : `wrote ${r.entries} string(s) to translate to ${r.sheet_path} (${r.language})${r.translated ? `; ${r.translated} already translated` : ""}`;
  return [head, ...(r.errors ?? []).map((e) => `- error ${e}`), ...r.notes.map((n) => `note: ${n}`)].join("\n");
}
