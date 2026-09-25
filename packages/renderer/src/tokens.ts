import { constants, existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "@video-studio/media";
import type { AspectRatio, Brand, Style } from "@video-studio/schema";
import type { MotionTokens, RenderTarget, VisualTokens } from "./types.js";

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
export function resolveTokens(brand?: Brand, defaults: Partial<VisualTokens> = {}, style?: Style): VisualTokens {
  const base: VisualTokens = { ...DEFAULT_TOKENS, ...defaults };
  if (style) {
    base.style = `${style.id}@${style.version}`;
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
}

export const BUNDLED_FONTS: readonly BundledFont[] = Object.freeze([
  { family: "Inter", weight: 400, file: "Inter/Inter-Regular.ttf" },
  { family: "Inter", weight: 700, file: "Inter/Inter-Bold.ttf" },
  { family: "Noto Sans", weight: 400, file: "NotoSans/NotoSans-Regular.ttf" },
  { family: "Noto Sans", weight: 700, file: "NotoSans/NotoSans-Bold.ttf" },
  { family: "JetBrains Mono", weight: 400, file: "JetBrainsMono/JetBrainsMono-Regular.ttf" },
  { family: "JetBrains Mono", weight: 700, file: "JetBrainsMono/JetBrainsMono-Bold.ttf" },
]);

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

/** Which bundled font files are present in `dir` (null dir: none). */
export function bundledFontsStatus(dir: string | null): { dir: string | null; present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const f of BUNDLED_FONTS) (dir && existsSync(join(dir, f.file)) ? present : missing).push(f.file);
  return { dir, present, missing };
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
 * `@font-face` rules (file:// URLs) for every bundled family named in the tokens' chains, both
 * weights, for the HTML renderer. Empty when the fonts directory is missing, so callers can
 * embed it unconditionally; the chains' other families still apply through the browser.
 */
export function fontFaceCss(tokens: VisualTokens, opts: { fontsDir?: string | null; env?: Record<string, string | undefined> } = {}): string {
  const dir = opts.fontsDir === undefined ? findFontsDir(opts.env ?? process.env) : opts.fontsDir;
  if (!dir) return "";
  const used = new Set([tokens.font_heading, tokens.font_body, tokens.font_mono].flatMap((c) => parseFontChain(c ?? "")).map((n) => n.toLowerCase()));
  const rules: string[] = [];
  for (const f of BUNDLED_FONTS) {
    if (!used.has(f.family.toLowerCase())) continue;
    const p = join(dir, f.file);
    if (!existsSync(p)) continue;
    rules.push(
      `@font-face { font-family: "${f.family}"; src: url("${pathToFileURL(p).href}") format("truetype"); font-weight: ${f.weight}; font-style: normal; font-display: block; }`,
    );
  }
  return rules.join("\n");
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
 * Locate a TTF/OTF/TTC file for a CSS-style family chain. For each named family, a bundled file
 * (Inter, Noto Sans, JetBrains Mono in `fonts/`, nearest of Regular/Bold to `weight`) wins first;
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

/** A memoising FontResolver bound to `env`. */
export function createFontResolver(env: NodeJS.ProcessEnv = process.env, deps: FontResolverDeps = {}): FontResolver {
  const cache = new Map<string, Promise<string>>();
  return (family, weight) => {
    const key = `${family}\u0000${bundledWeight(weight)}`;
    let p = cache.get(key);
    if (!p) {
      p = resolveFontFile(family, env, deps, weight);
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return p;
  };
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
