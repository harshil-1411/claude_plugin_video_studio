import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { runProcess } from "@video-studio/media";
import type { AspectRatio, Brand } from "@video-studio/schema";
import type { RenderTarget, VisualTokens } from "./types.js";

/**
 * Visual tokens, font files and render targets shared by the deterministic renderers.
 * Font values are CSS-style fallback chains ("Inter, Helvetica, Arial, sans-serif") so the
 * HTML renderer can use them verbatim; the FFmpeg renderer resolves them to one font file.
 */

export const DEFAULT_TOKENS: Readonly<VisualTokens> = Object.freeze({
  font_heading: "Inter, Helvetica, Arial, sans-serif",
  font_body: "Inter, Helvetica, Arial, sans-serif",
  font_mono: 'Menlo, "DejaVu Sans Mono", monospace',
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

/**
 * Resolve visual tokens: brand.yaml values where given (palette keys `background|bg`,
 * `text|foreground|fg`, `primary|accent`, `secondary`), else `defaults`, else DEFAULT_TOKENS.
 * `logo_path` is the brand's logo path as written (project-relative); renderers resolve it.
 */
export function resolveTokens(brand?: Brand, defaults: Partial<VisualTokens> = {}): VisualTokens {
  const base: VisualTokens = { ...DEFAULT_TOKENS, ...defaults };
  const visual = brand?.visual;
  const out: VisualTokens = {
    ...base,
    font_heading: fontChain(visual?.fonts.heading, base.font_heading),
    font_body: fontChain(visual?.fonts.body, base.font_body),
    font_mono: fontChain(visual?.fonts.mono, base.font_mono),
  };
  const palette = visual?.palette ?? {};
  for (const [token, keys] of Object.entries(PALETTE_KEYS) as [keyof typeof PALETTE_KEYS, readonly string[]][]) {
    const key = keys.find((k) => palette[k] !== undefined);
    out[token] = normalizeHex(key ? palette[key]! : out[token]);
  }
  const logo = visual?.logo ?? base.logo_path;
  if (logo) out.logo_path = logo;
  else delete out.logo_path;
  return out;
}

// ---------------------------------------------------------------------------------- fonts

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
 * Locate a TTF/OTF/TTC file for a CSS-style family chain. Each named family is tried with
 * `fc-match -f '%{family}\n%{file}'` and accepted only when fontconfig returns that family
 * (fontconfig otherwise substitutes silently). Then platform fallbacks (macOS Helvetica /
 * Arial / Menlo, Linux DejaVu / Liberation, Windows Arial / Consolas), then fontconfig's
 * substitute for the first family. Throws FontNotFoundError if nothing is found.
 */
export async function resolveFontFile(family: string, env: NodeJS.ProcessEnv = process.env, deps: FontResolverDeps = {}): Promise<string> {
  const platform = deps.platform ?? process.platform;
  const fcMatch = deps.fcMatch ?? defaultFcMatch;
  const exists = deps.exists ?? fileExists;
  const names = parseFontChain(family);
  if (names.length === 0) names.push("sans-serif");
  const mono = names.some((n) => MONO_HINT.test(n) || n === "monospace");
  let substitute: string | null = null;

  for (const name of names) {
    // A direct path is honoured as-is.
    if (FONT_EXT.test(name) && (await exists(name))) return name;
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

export type FontResolver = (family: string) => Promise<string>;

/** A memoising FontResolver bound to `env`. */
export function createFontResolver(env: NodeJS.ProcessEnv = process.env, deps: FontResolverDeps = {}): FontResolver {
  const cache = new Map<string, Promise<string>>();
  return (family) => {
    let p = cache.get(family);
    if (!p) {
      p = resolveFontFile(family, env, deps);
      p.catch(() => cache.delete(family));
      cache.set(family, p);
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
