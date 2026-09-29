import { constants, existsSync, openSync, readSync, closeSync } from "node:fs";
import { access, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "@video-studio/media";
import type { AspectRatio, Brand, Style } from "@video-studio/schema";
import { type Script, languageScript, scriptFontFamilies } from "./script.js";
import { styleRef } from "./styles.js";
import type { MotionTokens, ProjectFontRef, RenderTarget, VisualTokens } from "./types.js";

/**
 * Visual tokens, font files and render targets shared by the deterministic renderers.
 * Font values are CSS-style fallback chains ("Inter, Helvetica, Arial, sans-serif") so the
 * HTML renderer can use them verbatim; the FFmpeg renderer resolves them to one font file.
 */

export const DEFAULT_TOKENS: Readonly<VisualTokens> = Object.freeze({
  font_heading: 'Inter, "Noto Sans", Helvetica, Arial, sans-serif',
  font_body: 'Inter, "Noto Sans", Helvetica, Arial, sans-serif',
  font_mono: '"JetBrains Mono", Menlo, "DejaVu Sans Mono", monospace',
  color_background: "#0B0F19",
  color_text: "#F5F7FA",
  color_primary: "#4F8CFF",
  color_secondary: "#22C55E",
});

const PALETTE_KEYS: Record<"color_background" | "color_text" | "color_primary" | "color_secondary", readonly string[]> = {
  color_background: ["background", "bg"],
  color_text: ["text", "foreground", "fg"],
  color_primary: ["primary", "accent"],
  color_secondary: ["secondary"],
};

/** Normalise `#rgb`, `#rrggbb` or `#rrggbbaa` to upper-case `#RRGGBB` (alpha dropped). */
export function normalizeHex(color: string): string {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(color.trim());
  if (!m) throw new Error(`invalid hex colour "${color}"`);
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  return `#${hex.slice(0, 6).toUpperCase()}`;
}

/** Brand font first, then the default chain (unless the brand already gives a chain). */
function fontChain(brandFont: string | undefined, fallback: string): string {
  if (!brandFont) return fallback;
  if (brandFont.includes(",")) return brandFont;
  const quoted = /\s/.test(brandFont) && !/^["']/.test(brandFont) ? `"${brandFont}"` : brandFont;
  return `${quoted}, ${fallback}`;
}

/** Insert brand fallback families (e.g. Noto Sans JP) before the chain's generic family, skipping duplicates. */
function withFallbacks(chain: string, extra: readonly string[]): string {
  if (extra.length === 0) return chain;
  const names = parseFontChain(chain);
  const add = extra.filter((f) => !names.includes(f)).map((f) => (/\s/.test(f) ? `"${f}"` : f));
  if (add.length === 0) return chain;
  const parts = chain.split(",").map((p) => p.trim());
  const at = parts.findIndex((p) => GENERIC.has(p.replace(/^["']|["']$/g, "")));
  parts.splice(at === -1 ? parts.length : at, 0, ...add);
  return parts.join(", ");
}

/** A style font before the default chain, without repeating a family the chain already has. */
function styleFontChain(font: string | undefined, fallback: string): string {
  if (!font) return fallback;
  if (font.includes(",")) return font;
  const rest = fallback
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.replace(/^["']|["']$/g, "").toLowerCase() !== font.toLowerCase());
  const quoted = /\s/.test(font) && !/^["']/.test(font) ? `"${font}"` : font;
  return [quoted, ...rest].join(", ");
}

/**
 * Default motion per personality, used when only brand.motion.personality is set (no style), or
 * when the brand's personality differs from the style's. Transitions are the default scene join.
 */
export const PERSONALITY_MOTION: Readonly<Record<MotionTokens["personality"], Omit<MotionTokens, "personality">>> = Object.freeze({
  calm: { easing: "ease_out", enter_ms: 600, exit_ms: 250, stagger_ms: 180, transition: "crossfade", transition_ms: 500 },
  precise: { easing: "snap", enter_ms: 160, exit_ms: 0, stagger_ms: 60, transition: "cut", transition_ms: 0 },
  friendly: { easing: "ease_in_out", enter_ms: 450, exit_ms: 200, stagger_ms: 120, transition: "crossfade", transition_ms: 350 },
  energetic: { easing: "spring", enter_ms: 350, exit_ms: 120, stagger_ms: 70, transition: "whip", transition_ms: 250 },
  playful: { easing: "spring", enter_ms: 500, exit_ms: 150, stagger_ms: 110, transition: "zoom", transition_ms: 300 },
});

/**
 * Resolve visual tokens. Precedence: DEFAULT_TOKENS < `defaults` < `style` < brand.yaml.
 * - Style: palette, fonts (placed before the default chain), weights, text case / heading scale /
 *   alignment, motion, and `style` = `<id>@<version>`.
 * - Brand: palette keys `background|bg`, `text|foreground|fg`, `primary|accent`, `secondary`;
 *   fonts; `visual.weights`; `motion.personality` (a personality other than the style's also
 *   brings that personality's easing and timings, keeping the style's transition kind) and
 *   `motion.transition_ms`. A brand personality without a style maps through PERSONALITY_MOTION.
 * `visual.font_fallbacks` are added to every chain before its generic family.
 * `logo_path` is the brand's logo path as written (project-relative); renderers resolve it.
 * Without a style and without brand weights or motion, the tokens are exactly the v1 tokens.
 */
export function resolveTokens(brand?: Brand, defaults: Partial<VisualTokens> = {}, style?: Style, opts: { language?: string } = {}): VisualTokens {
  const out = resolveTokensBase(brand, defaults, style);
  return opts.language ? withLanguage(out, opts.language) : out;
}

/**
 * Tokens for a spec language: when the language is written in a non-Latin script (ja, hi, ar, …)
 * the script's font families (Noto Sans JP / Devanagari / Arabic first) are added to every chain
 * before its generic family, and `language` is recorded. Latin-script languages (en, fr, …)
 * return the tokens unchanged, so English renders and their cache keys do not move.
 */
export function withLanguage(tokens: VisualTokens, language: string): VisualTokens {
  const script = languageScript(language);
  if (!script || script === "latin") return tokens;
  return {
    ...tokens,
    language,
    font_heading: withScriptFonts(tokens.font_heading, [script], language),
    font_body: withScriptFonts(tokens.font_body, [script], language),
    font_mono: withScriptFonts(tokens.font_mono, [script], language),
  };
}

/** Add the families covering `scripts` to a chain, before its generic family (skipping families already there). */
export function withScriptFonts(chain: string, scripts: readonly Script[], language?: string): string {
  return withFallbacks(chain, scripts.flatMap((s) => scriptFontFamilies(s, language)));
}

/**
 * A chain for drawing one line of `script` text with a single font file (FFmpeg drawtext has no
 * per-glyph fallback): the script's families first, then the original chain. Latin: unchanged.
 */
export function scriptFirstChain(chain: string, script: Script, language?: string): string {
  const fams = scriptFontFamilies(script, language);
  if (fams.length === 0) return chain;
  const rest = chain
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && !fams.some((f) => f.toLowerCase() === p.replace(/^["']|["']$/g, "").toLowerCase()));
  return [...fams.map((f) => (/\s/.test(f) ? `"${f}"` : f)), ...rest].join(", ");
}

function resolveTokensBase(brand?: Brand, defaults: Partial<VisualTokens> = {}, style?: Style): VisualTokens {
  const base: VisualTokens = { ...DEFAULT_TOKENS, ...defaults };
  if (style) {
    base.style = styleRef(style);
    const sp = style.palette ?? {};
    if (sp.background) base.color_background = sp.background;
    if (sp.text) base.color_text = sp.text;
    if (sp.primary) base.color_primary = sp.primary;
    if (sp.secondary) base.color_secondary = sp.secondary;
    base.font_heading = styleFontChain(style.fonts?.heading, base.font_heading);
    base.font_body = styleFontChain(style.fonts?.body, base.font_body);
    base.font_mono = styleFontChain(style.fonts?.mono, base.font_mono);
    if (style.weights?.heading !== undefined) base.weight_heading = style.weights.heading;
    if (style.weights?.body !== undefined) base.weight_body = style.weights.body;
    if (style.text?.case) base.text_case = style.text.case;
    if (style.text?.heading_scale !== undefined) base.heading_scale = style.text.heading_scale;
    if (style.text?.align) base.text_align = style.text.align;
    base.motion = { ...style.motion };
  }
  const visual = brand?.visual;
  const extra = visual?.font_fallbacks ?? [];
  const out: VisualTokens = {
    ...base,
    font_heading: withFallbacks(fontChain(visual?.fonts.heading, base.font_heading), extra),
    font_body: withFallbacks(fontChain(visual?.fonts.body, base.font_body), extra),
    font_mono: withFallbacks(fontChain(visual?.fonts.mono, base.font_mono), extra),
  };
  const palette = visual?.palette ?? {};
  for (const [token, keys] of Object.entries(PALETTE_KEYS) as [keyof typeof PALETTE_KEYS, readonly string[]][]) {
    const key = keys.find((k) => palette[k] !== undefined);
    out[token] = normalizeHex(key ? palette[key]! : out[token]);
  }
  if (visual?.weights?.heading !== undefined) out.weight_heading = visual.weights.heading;
  if (visual?.weights?.body !== undefined) out.weight_body = visual.weights.body;
  const bm = brand?.motion;
  if (bm?.personality && bm.personality !== out.motion?.personality) {
    const table = PERSONALITY_MOTION[bm.personality];
    out.motion = out.motion
      ? { ...out.motion, personality: bm.personality, easing: table.easing, enter_ms: table.enter_ms, exit_ms: table.exit_ms, stagger_ms: table.stagger_ms }
      : { personality: bm.personality, ...table };
  }
  if (bm?.transition_ms !== undefined && out.motion) out.motion = { ...out.motion, transition_ms: bm.transition_ms };
  const logo = visual?.logo ?? base.logo_path;
  if (logo) out.logo_path = logo;
  else delete out.logo_path;
  return out;
}

// ---------------------------------------------------------------------------------- fonts

/** One static font file shipped in `fonts/` (see fonts/README.md for sources and hashes). */
export interface BundledFont {
  family: string;
  weight: 400 | 700;
  /** Path relative to the fonts directory. */
  file: string;
  /** Script font (only needed for text in that script); absent: a core font every render uses. */
  script?: Script;
}

export const BUNDLED_FONTS: readonly BundledFont[] = Object.freeze([
  { family: "Inter", weight: 400, file: "Inter/Inter-Regular.ttf" },
  { family: "Inter", weight: 700, file: "Inter/Inter-Bold.ttf" },
  { family: "Noto Sans", weight: 400, file: "NotoSans/NotoSans-Regular.ttf" },
  { family: "Noto Sans", weight: 700, file: "NotoSans/NotoSans-Bold.ttf" },
  { family: "JetBrains Mono", weight: 400, file: "JetBrainsMono/JetBrainsMono-Regular.ttf" },
  { family: "JetBrains Mono", weight: 700, file: "JetBrainsMono/JetBrainsMono-Bold.ttf" },
  { family: "Noto Sans JP", weight: 400, file: "NotoSansJP/NotoSansJP-Regular.otf", script: "cjk" },
  { family: "Noto Sans JP", weight: 700, file: "NotoSansJP/NotoSansJP-Bold.otf", script: "cjk" },
  { family: "Noto Sans Devanagari", weight: 400, file: "NotoSansDevanagari/NotoSansDevanagari-Regular.ttf", script: "devanagari" },
  { family: "Noto Sans Devanagari", weight: 700, file: "NotoSansDevanagari/NotoSansDevanagari-Bold.ttf", script: "devanagari" },
  { family: "Noto Sans Arabic", weight: 400, file: "NotoSansArabic/NotoSansArabic-Regular.ttf", script: "arabic" },
  { family: "Noto Sans Arabic", weight: 700, file: "NotoSansArabic/NotoSansArabic-Bold.ttf", script: "arabic" },
]);

/** The bundled family for a script, if one is shipped (Noto Sans JP, Devanagari, Arabic). */
export function bundledScriptFamily(script: Script): string | undefined {
  return BUNDLED_FONTS.find((f) => f.script === script)?.family;
}

const FONTS_MARKER = "README.md";

/**
 * The bundled `fonts/` directory: `${CLAUDE_PLUGIN_ROOT}/fonts`, else the first `fonts/` with a
 * README.md found walking up from this module (the repo root in dev, the plugin root from
 * `dist/mcp.mjs`). Null when the fonts are not installed; callers then fall back to host fonts
 * and should report it (see `bundledFontsStatus`).
 */
export function findFontsDir(env: Record<string, string | undefined> = process.env, from?: string): string | null {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root && existsSync(join(root, "fonts", FONTS_MARKER))) return join(root, "fonts");
  let dir = from ?? dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "fonts");
    if (existsSync(join(candidate, FONTS_MARKER))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface BundledFontsStatus {
  dir: string | null;
  /** Core fonts, plus the script fonts of `scripts`, that are present. */
  present: string[];
  /** Core fonts, plus the script fonts of `scripts`, that are missing: these change how this render looks. */
  missing: string[];
  /** Every missing script font (informational: only matters for text in that script). */
  script_missing: string[];
}

/**
 * Which bundled font files are present in `dir` (null dir: none). Script fonts (Noto Sans JP,
 * Devanagari, Arabic) count in `present`/`missing` only for the `scripts` a render uses, so a
 * missing Japanese font only matters for videos with Japanese text.
 */
export function bundledFontsStatus(dir: string | null, opts: { scripts?: readonly Script[] } = {}): BundledFontsStatus {
  const present: string[] = [];
  const missing: string[] = [];
  const scriptMissing: string[] = [];
  const want = new Set(opts.scripts ?? []);
  for (const f of BUNDLED_FONTS) {
    const ok = Boolean(dir && existsSync(join(dir, f.file)));
    if (f.script && !ok) scriptMissing.push(f.file);
    if (f.script && !want.has(f.script)) continue;
    (ok ? present : missing).push(f.file);
  }
  return { dir, present, missing, script_missing: scriptMissing };
}

/** Nearest bundled weight: 600 and up map to Bold, anything lighter to Regular. */
function bundledWeight(weight: number | undefined): 400 | 700 {
  return (weight ?? 400) >= 600 ? 700 : 400;
}

/** Absolute path of the bundled file for `family` at (the nearest) `weight`, if bundled and present. */
export function bundledFontFile(family: string, weight: number | undefined, dir: string | null): string | null {
  if (!dir) return null;
  const want = family.trim().toLowerCase();
  const w = bundledWeight(weight);
  const hit = BUNDLED_FONTS.find((f) => f.family.toLowerCase() === want && f.weight === w);
  if (!hit) return null;
  const p = join(dir, hit.file);
  return existsSync(p) ? p : null;
}

/**
 * `@font-face` rules (file:// URLs) for the HTML renderer: first the project's own font files
 * (`<project>/fonts/`, from `opts.projectFonts` or the tokens' `project_fonts` with
 * `opts.projectDir`) under every chain name they answer to, at their real weight and style; then
 * every bundled family named in the chains (both weights) that no project font already covers.
 * Empty when there are neither, so callers can embed it unconditionally; the chains' other
 * families still apply through the browser.
 */
export function fontFaceCss(
  tokens: VisualTokens,
  opts: { fontsDir?: string | null; env?: Record<string, string | undefined>; projectFonts?: ProjectFontIndex | null; projectDir?: string } = {},
): string {
  const dir = opts.fontsDir === undefined ? findFontsDir(opts.env ?? process.env) : opts.fontsDir;
  const names = [...new Set([tokens.font_heading, tokens.font_body, tokens.font_mono].flatMap((c) => parseFontChain(c ?? "")))];
  const rules: string[] = [];
  const covered = new Set<string>();
  const project = opts.projectFonts !== undefined ? opts.projectFonts : opts.projectDir ? projectFontIndexFromTokens(tokens, opts.projectDir) : null;
  if (project) {
    for (const name of names) {
      if (GENERIC.has(name.toLowerCase()) || !CSS_FAMILY_NAME.test(name)) continue;
      const faces = projectFontFaces(project, name);
      if (!faces.length) continue;
      covered.add(fontKey(name));
      const seen = new Set<string>();
      for (const f of faces) {
        if (seen.has(f.path) || !existsSync(f.path)) continue;
        seen.add(f.path);
        rules.push(
          `@font-face { font-family: "${name}"; src: url("${pathToFileURL(f.path).href}") format("${/\.otf$/i.test(f.path) ? "opentype" : "truetype"}"); font-weight: ${f.weight}; font-style: ${f.italic ? "italic" : "normal"}; font-display: block; }`,
        );
      }
    }
  }
  if (dir) {
    const used = new Set(names.map((n) => n.toLowerCase()));
    for (const f of BUNDLED_FONTS) {
      if (!used.has(f.family.toLowerCase()) || covered.has(fontKey(f.family))) continue;
      const p = join(dir, f.file);
      if (!existsSync(p)) continue;
      const format = f.file.endsWith(".otf") ? "opentype" : "truetype";
      rules.push(
        `@font-face { font-family: "${f.family}"; src: url("${pathToFileURL(p).href}") format("${format}"); font-weight: ${f.weight}; font-style: normal; font-display: block; }`,
      );
    }
  }
  return rules.join("\n");
}

// ---------------------------------------------------------------------------------- project fonts

/** A TTF/OTF in the project's `fonts/` folder (see project-fonts.ts for the scan). */
export interface ProjectFont {
  /** Absolute path. */
  path: string;
  /** Project-relative posix path. */
  file: string;
  /** Internal family (nameID 16, else 1). */
  family: string;
  /** The family folder's name (`fonts/<alias>/…`), which brand_draft names after the CSS family. */
  alias: string;
  weight: number;
  italic: boolean;
  sha256: string;
  /** Licence file in the same folder (OFL.txt, LICENSE, …), project-relative. */
  license?: string;
}

export interface ProjectFontIndex {
  /** Absolute project root. */
  root: string;
  fonts: ProjectFont[];
}

/** Family names compared without case, spaces or punctuation ("Field Sans" = "FieldSans" = "field-sans"). */
export function fontKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Family names a @font-face rule may carry verbatim. */
const CSS_FAMILY_NAME = /^[\p{L}\p{N} ._-]+$/u;

/** Every project font answering to `name` (internal family or folder alias), non-generic names only. */
export function projectFontFaces(index: ProjectFontIndex | null | undefined, name: string): ProjectFont[] {
  if (!index || GENERIC.has(name.trim().toLowerCase())) return [];
  const k = fontKey(name);
  if (!k) return [];
  return index.fonts.filter((f) => fontKey(f.family) === k || fontKey(f.alias) === k);
}

/**
 * The project font for `name` at the nearest weight (upright preferred unless `italic`); ties go
 * to the heavier face for weights above 500, else the lighter. Null when no project font answers.
 */
export function matchProjectFont(index: ProjectFontIndex | null | undefined, name: string, weight?: number, italic = false): ProjectFont | null {
  const faces = projectFontFaces(index, name);
  if (!faces.length) return null;
  const want = weight ?? 400;
  const styled = faces.filter((f) => f.italic === italic);
  const pool = styled.length ? styled : faces;
  const score = (f: ProjectFont) => Math.abs(f.weight - want) * 2 + (f.weight === want ? 0 : want > 500 ? (f.weight > want ? 0 : 1) : f.weight < want ? 0 : 1);
  return [...pool].sort((a, b) => score(a) - score(b) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))[0] ?? null;
}

/**
 * The project fonts the tokens carry (`project_fonts`), as an index rooted at `projectDir`. Refs
 * with an absolute path or `..` are ignored, so tokens can never point outside the project.
 * Null when the tokens carry none.
 */
export function projectFontIndexFromTokens(tokens: Pick<VisualTokens, "project_fonts">, projectDir: string): ProjectFontIndex | null {
  const refs = tokens.project_fonts ?? [];
  if (!refs.length) return null;
  const fonts: ProjectFont[] = [];
  for (const r of refs) {
    if (!r.file || isAbsolute(r.file) || r.file.split(/[\\/]/).includes("..")) continue;
    fonts.push({ path: join(projectDir, r.file), file: r.file, family: r.family, alias: r.name, weight: r.weight, italic: r.italic, sha256: r.sha256 });
  }
  return fonts.length ? { root: projectDir, fonts } : null;
}

/**
 * Tokens with the project fonts their chains (and `extraFamilies`, e.g. a caption family) name:
 * one `project_fonts` ref per (name, file), sorted. The same object when no project font
 * answers, so renders without project fonts keep their cache keys.
 */
export function withProjectFonts(tokens: VisualTokens, index: ProjectFontIndex | null | undefined, extraFamilies: readonly string[] = []): VisualTokens {
  if (!index?.fonts.length) return tokens;
  const names = [...new Set([tokens.font_heading, tokens.font_body, tokens.font_mono].flatMap((c) => parseFontChain(c ?? "")).concat(extraFamilies.flatMap((f) => parseFontChain(f))))];
  const refs = new Map<string, ProjectFontRef>();
  for (const name of names) {
    for (const f of projectFontFaces(index, name)) {
      refs.set(`${name}\u0000${f.file}`, { name, family: f.family, weight: f.weight, italic: f.italic, file: f.file, sha256: f.sha256 });
    }
  }
  if (!refs.size) return tokens;
  const sorted = [...refs.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { ...tokens, project_fonts: sorted };
}

/** Split a CSS font-family list into names (quotes removed). */
export function parseFontChain(chain: string): string[] {
  return chain
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, "").trim())
    .filter(Boolean);
}

const GENERIC = new Set(["sans-serif", "serif", "monospace", "system-ui", "ui-monospace", "ui-sans-serif", "cursive", "fantasy"]);

export interface FontResolverDeps {
  platform?: NodeJS.Platform;
  /** Runs `fc-match` with the given args and returns stdout, or null if unavailable/failed. */
  fcMatch?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string | null>;
  exists?: (path: string) => Promise<boolean>;
  /** Bundled fonts directory; undefined: `findFontsDir(env)`, null: do not use bundled fonts. */
  fontsDir?: string | null;
  /** The project's own fonts (`<project>/fonts/`): tried first for each family, nearest weight. */
  projectFonts?: ProjectFontIndex | null;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const defaultFcMatch = async (args: string[], env: NodeJS.ProcessEnv): Promise<string | null> => {
  try {
    const bin = env.FC_MATCH_PATH || "fc-match";
    const { stdout } = await runProcess(bin, args, { captureStdout: true, timeoutMs: 15_000 });
    return stdout;
  } catch {
    return null;
  }
};

const MAC_FALLBACKS: Record<"sans" | "mono", string[]> = {
  sans: ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf"],
  mono: ["/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Monaco.ttf"],
};
const LINUX_FALLBACKS: Record<"sans" | "mono", string[]> = {
  sans: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  ],
  mono: [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
    "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
    "/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf",
  ],
};
const WIN_FALLBACKS: Record<"sans" | "mono", string[]> = {
  sans: ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf"],
  mono: ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf"],
};

const FONT_EXT = /\.(ttf|otf|ttc)$/i;
const MONO_HINT = /mono|menlo|consol|courier|code|monaco/i;

export class FontNotFoundError extends Error {
  constructor(readonly family: string) {
    super(`no font file found for "${family}"`);
    this.name = "FontNotFoundError";
  }
}

/**
 * Locate a TTF/OTF/TTC file for a CSS-style family chain. For each named family, a project font
 * (`deps.projectFonts`: internal or folder name, nearest weight) wins first, then a bundled file
 * (Inter, Noto Sans, JetBrains Mono in `fonts/`, nearest of Regular/Bold to `weight`);
 * otherwise the family is tried with
 * `fc-match -f '%{family}\n%{file}'` and accepted only when fontconfig returns that family
 * (fontconfig otherwise substitutes silently). Then platform fallbacks (macOS Helvetica /
 * Arial / Menlo, Linux DejaVu / Liberation, Windows Arial / Consolas), then fontconfig's
 * substitute for the first family. Throws FontNotFoundError if nothing is found.
 */
export async function resolveFontFile(family: string, env: NodeJS.ProcessEnv = process.env, deps: FontResolverDeps = {}, weight?: number): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const fontsDir = deps.fontsDir === undefined ? findFontsDir(env) : deps.fontsDir;
  const fcMatch = deps.fcMatch ?? defaultFcMatch;
  const exists = deps.exists ?? fileExists;
  const names = parseFontChain(family);
  if (names.length === 0) names.push("sans-serif");
  const mono = names.some((n) => MONO_HINT.test(n) || n === "monospace");
  let substitute: string | null = null;

  for (const name of names) {
    // A direct path is honoured as-is.
    if (FONT_EXT.test(name) && (await exists(name))) return name;
    const own = matchProjectFont(deps.projectFonts, name, weight);
    if (own && (await exists(own.path))) return own.path;
    const bundled = bundledFontFile(name, weight, fontsDir);
    if (bundled) return bundled;
    const out = await fcMatch(["-f", "%{family}\n%{file}", name], env);
    if (!out) continue;
    const [fams = "", file = ""] = out.trim().split("\n");
    if (!file || !FONT_EXT.test(file) || !(await exists(file))) continue;
    const got = fams.split(",").map((f) => f.trim().toLowerCase());
    if (GENERIC.has(name.toLowerCase()) || got.includes(name.toLowerCase())) return file;
    substitute ??= file;
  }

  const table = platform === "darwin" ? MAC_FALLBACKS : platform === "win32" ? WIN_FALLBACKS : LINUX_FALLBACKS;
  const byName = new Map<string, string>([
    ["helvetica", "/System/Library/Fonts/Helvetica.ttc"],
    ["arial", "/System/Library/Fonts/Supplemental/Arial.ttf"],
    ["menlo", "/System/Library/Fonts/Menlo.ttc"],
    ["dejavu sans mono", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"],
    ["dejavu sans", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"],
  ]);
  const named = names.map((n) => byName.get(n.toLowerCase())).filter((p): p is string => Boolean(p));
  for (const p of [...named, ...table[mono ? "mono" : "sans"]]) {
    if (await exists(p)) return p;
  }
  if (substitute) return substitute;
  throw new FontNotFoundError(family);
}

export type FontResolver = (family: string, weight?: number) => Promise<string>;

/** A memoising FontResolver bound to `env` (per exact weight when project fonts are given, else per bundled weight). */
export function createFontResolver(env: NodeJS.ProcessEnv = process.env, deps: FontResolverDeps = {}): FontResolver {
  const cache = new Map<string, Promise<string>>();
  return (family, weight) => {
    const key = `${family}\u0000${deps.projectFonts?.fonts.length ? (weight ?? 400) : bundledWeight(weight)}`;
    let p = cache.get(key);
    if (!p) {
      p = resolveFontFile(family, env, deps, weight);
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return p;
  };
}

/**
 * Put the project fonts in front of another resolver (one injected by a caller): the first chain
 * family a project font answers to wins, unless an earlier family is a bundled one (which the
 * base resolver would have used). Everything else goes to `base`.
 */
export function projectFirstResolver(base: FontResolver, index: ProjectFontIndex | null | undefined): FontResolver {
  if (!index?.fonts.length) return base;
  const bundled = new Set(BUNDLED_FONTS.map((f) => f.family.toLowerCase()));
  return async (family, weight) => {
    for (const name of parseFontChain(family)) {
      const own = matchProjectFont(index, name, weight);
      if (own && (await fileExists(own.path))) return own.path;
      if (bundled.has(name.toLowerCase())) break;
    }
    return base(family, weight);
  };
}

// ---------------------------------------------------------------------------------- font metrics and libass

export interface FontMetrics {
  unitsPerEm: number;
  /** OS/2 usWinAscent + usWinDescent, in font units. */
  winHeight: number;
  /** OS/2 usWinAscent (libass puts the baseline this far below the line top). */
  winAscent: number;
  hheaAscent: number;
  hheaDescent: number;
}

const metricsCache = new Map<string, FontMetrics | null>();

type TableReader = (pos: number, len: number) => Buffer;

/**
 * Open a TTF/OTF (first face of a TTC), read its table directory and hand `fn` a reader and the
 * tables' offsets and lengths. Null when the file cannot be read or `fn` throws.
 */
function withFontTables<T>(file: string, fn: (read: TableReader, tables: Record<string, { offset: number; length: number }>) => T | null): T | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const read: TableReader = (pos, len) => {
      const b = Buffer.alloc(len);
      readSync(fd!, b, 0, len, pos);
      return b;
    };
    let base = 0;
    // A collection (ttcf) lists its faces' offsets after a 12-byte header: use the first face.
    if (read(0, 4).toString("latin1") === "ttcf") base = read(12, 4).readUInt32BE(0);
    const hdr = read(base, 12);
    const n = hdr.readUInt16BE(4);
    if (n === 0 || n > 512) return null;
    const dir = read(base + 12, n * 16);
    const tables: Record<string, { offset: number; length: number }> = {};
    for (let i = 0; i < n; i++) tables[dir.toString("latin1", i * 16, i * 16 + 4)] = { offset: dir.readUInt32BE(i * 16 + 8), length: dir.readUInt32BE(i * 16 + 12) };
    return fn(read, tables);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Vertical metrics from a TTF/OTF (first face of a TTC), read from the `head`, `hhea` and `OS/2`
 * tables. Null when the file cannot be read or parsed. Memoised per path.
 */
export function readFontMetrics(file: string): FontMetrics | null {
  if (metricsCache.has(file)) return metricsCache.get(file)!;
  const out = withFontTables<FontMetrics>(file, (read, tables) => {
    if (!tables.head || !tables.hhea || !tables["OS/2"]) return null;
    const head = read(tables.head.offset, 54);
    const hhea = read(tables.hhea.offset, 8);
    const os2 = read(tables["OS/2"].offset, 78);
    const m: FontMetrics = {
      unitsPerEm: head.readUInt16BE(18),
      winHeight: os2.readUInt16BE(74) + os2.readUInt16BE(76),
      winAscent: os2.readUInt16BE(74),
      hheaAscent: hhea.readInt16BE(4),
      hheaDescent: hhea.readInt16BE(6),
    };
    return m.unitsPerEm > 0 && m.winHeight > 0 ? m : null;
  });
  metricsCache.set(file, out);
  return out;
}

/** A font file's own identity: what libass and fontconfig match on. */
export interface FontNames {
  /** Typographic family (name table nameID 16), else the family (nameID 1). */
  family: string;
  /** OS/2 usWeightClass (400 when the table is missing). */
  weight: number;
  /** OS/2 fsSelection ITALIC (or head.macStyle italic). */
  italic: boolean;
}

/** One name-table string: UTF-16BE for Unicode/Windows records, Latin-1 (close to Mac Roman) otherwise. */
function nameString(buf: Buffer, platform: number): string {
  if (platform === 0 || platform === 3) {
    let s = "";
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
    return s;
  }
  return buf.toString("latin1");
}

/**
 * Family name, weight and italic flag of a TTF/OTF (first face of a TTC) from its `name`, `OS/2`
 * and `head` tables. The family is nameID 16 (typographic family) when present, else nameID 1;
 * Windows English records win over other languages and Mac/Unicode records. Null when unreadable.
 */
export function readFontNames(file: string): FontNames | null {
  return withFontTables<FontNames>(file, (read, tables) => {
    const nt = tables.name;
    if (!nt || nt.length < 6 || nt.length > 1 << 20) return null;
    const name = read(nt.offset, nt.length);
    const count = name.readUInt16BE(2);
    const strings = name.readUInt16BE(4);
    const found: Array<{ id: number; rank: number; value: string }> = [];
    for (let i = 0; i < count && 6 + (i + 1) * 12 <= name.length; i++) {
      const r = 6 + i * 12;
      const platform = name.readUInt16BE(r);
      const lang = name.readUInt16BE(r + 4);
      const id = name.readUInt16BE(r + 6);
      if (id !== 1 && id !== 16) continue;
      const len = name.readUInt16BE(r + 8);
      const off = strings + name.readUInt16BE(r + 10);
      if (off + len > name.length) continue;
      const value = nameString(name.subarray(off, off + len), platform).replace(/\0/g, "").trim();
      if (!value) continue;
      const rank = platform === 3 ? (lang === 0x409 ? 0 : 1) : platform === 0 ? 2 : 3;
      found.push({ id, rank, value });
    }
    const pick = (id: number) => found.filter((f) => f.id === id).sort((a, b) => a.rank - b.rank)[0]?.value;
    const family = pick(16) ?? pick(1);
    if (!family) return null;
    let weight = 400;
    let italic = false;
    const os2 = tables["OS/2"];
    if (os2 && os2.length >= 64) {
      const b = read(os2.offset, 64);
      const w = b.readUInt16BE(4);
      if (w >= 1 && w <= 1000) weight = w;
      italic = (b.readUInt16BE(62) & 1) === 1;
    }
    if (!italic && tables.head) italic = (read(tables.head.offset, 46).readUInt16BE(44) & 2) === 2;
    return { family, weight, italic };
  });
}

/**
 * libass font size for a wanted em size: libass scales a font so that its OS/2 win height
 * (usWinAscent + usWinDescent) equals the ASS font size, while FFmpeg drawtext sizes the em.
 * Tall-metric fonts (Noto Sans Devanagari 1.906, Arabic 2.169) would otherwise come out small.
 */
export function assFontSize(emPx: number, metrics: FontMetrics | null): number {
  if (!metrics) return emPx;
  return Math.round(((emPx * metrics.winHeight) / metrics.unitsPerEm) * 100) / 100;
}

/**
 * libass only reads font files directly inside its `fontsdir` (not sub-directories), while
 * `fonts/` keeps one directory per family. Link the given font files (default: every bundled
 * font present) flat into `destDir` and return it, for `subtitles=…:fontsdir=` / `ass=…:fontsdir=`.
 * Symlinks, so nothing is copied; existing links are replaced. Two files with the same name (a
 * project copy of a bundled font) get distinct link names (`2-<name>`, …).
 */
export async function prepareLibassFontsDir(destDir: string, files?: readonly string[], fontsDir: string | null = findFontsDir()): Promise<string> {
  await mkdir(destDir, { recursive: true });
  const list = files ?? (fontsDir ? BUNDLED_FONTS.map((f) => join(fontsDir, f.file)).filter((p) => existsSync(p)) : []);
  const taken = new Map<string, string>();
  for (const src of list) {
    let name = basename(src);
    for (let n = 2; taken.has(name) && taken.get(name) !== src; n++) name = `${n}-${basename(src)}`;
    taken.set(name, src);
    const dest = join(destDir, name);
    try {
      if ((await readlink(dest)) === src) continue;
      await unlink(dest);
    } catch {
      // not a link yet
    }
    try {
      await symlink(src, dest);
    } catch {
      // an unrelated file of that name: leave it
    }
  }
  return destDir;
}

// ---------------------------------------------------------------------------------- targets

export const DEFAULT_FPS = 30;

/** Frame size for an aspect ratio, keeping the short side at `shortSide` (even dimensions). */
export function targetForAspect(aspect: AspectRatio, opts: { shortSide?: number; fps?: number } = {}): RenderTarget {
  const s = opts.shortSide ?? 1080;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const [aw, ah] = aspect.split(":").map(Number) as [number, number];
  const width = aw <= ah ? even(s) : even((s * aw) / ah);
  const height = aw <= ah ? even((s * ah) / aw) : even(s);
  return { width, height, fps: opts.fps ?? DEFAULT_FPS, aspect_ratio: aspect };
}

/** Transitions that blend two scenes during assembly (the outgoing picture must stay on screen). */
const BLENDING_TRANSITIONS: ReadonlySet<string> = new Set(["crossfade", "slide", "zoom", "whip"]);

/**
 * Exit fade length for a scene: the style's exit_ms, except when the style's transition blends
 * scenes: then the assembly's transition is the exit, and a fade to the background here would
 * leave it blending from an empty frame.
 */
export function exitFadeMs(motion: VisualTokens["motion"]): number {
  if (!motion) return 0;
  return BLENDING_TRANSITIONS.has(motion.transition) ? 0 : motion.exit_ms;
}
