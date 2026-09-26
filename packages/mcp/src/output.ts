import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Tool results that are cheap for Claude's context.
 *
 * Every tool returns ONE text block: a short human summary, then the data as compact JSON (no
 * pretty-printing; null/undefined and empty arrays/objects dropped; long arrays and strings cut
 * with a "…N more" marker that says where the full list lives; optional project-relative paths).
 * `structuredContent` keeps the full, untrimmed object for clients that read it programmatically.
 *
 * Why the text still carries the data: MCP clients differ in what they show the model. Some show
 * only the text blocks, some only `structuredContent`, some both. Carrying a compact copy in the
 * text means the model always sees the data, and a client that forwards both pays for one compact
 * copy plus the object instead of a pretty copy plus the object (the old `jsonResult`).
 */

export interface CompactOptions {
  /** Longest array kept in full; longer ones keep the first `maxArray` items plus a marker (default 20). */
  maxArray?: number;
  /** Per-property overrides of `maxArray`, keyed by property name (e.g. `{ tiles: 60 }`). */
  maxArrayFor?: Record<string, number>;
  /** Longest string kept in full (default 1000 chars). */
  maxString?: number;
  /** Where a truncated array can be read in full, keyed by property name (e.g. `{ findings: "qa/lint.json" }`). */
  hints?: Record<string, string>;
  /** Fallback hint for truncated arrays without a per-key hint (default: "structuredContent"). */
  hint?: string;
  /** Absolute directory: strings under it become relative (`<dir>/a/b` → `a/b`); the text says so. */
  relativeTo?: string;
  /** Decimal places kept for non-integer numbers (default 3). */
  precision?: number;
  /** Drop empty arrays and objects as well as null/undefined (default true). */
  dropEmpty?: boolean;
  /** Property names left out of the text entirely (still in structuredContent). */
  omit?: readonly string[];
}

const DEFAULTS = { maxArray: 20, maxString: 1000, precision: 3, dropEmpty: true };

/** Prune a value for the text copy (see {@link CompactOptions}). Returns undefined for a dropped value. */
export function compactValue(value: unknown, opts: CompactOptions = {}, key?: string): unknown {
  const o = { ...DEFAULTS, ...opts };
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    let s = value;
    if (o.relativeTo) s = relativize(s, o.relativeTo);
    return s.length > o.maxString ? `${s.slice(0, o.maxString)}…(+${s.length - o.maxString} chars)` : s;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) || !Number.isFinite(value)) return value;
    const f = 10 ** o.precision;
    return Math.round(value * f) / f;
  }
  if (typeof value !== "object") return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  if (Array.isArray(value)) {
    const limit = (key !== undefined ? o.maxArrayFor?.[key] : undefined) ?? o.maxArray;
    const kept = value.slice(0, limit).map((v) => compactValue(v, opts)).filter((v) => v !== undefined);
    if (value.length > limit) {
      const where = (key !== undefined ? o.hints?.[key] : undefined) ?? o.hint ?? "structuredContent";
      kept.push(`…${value.length - limit} more (full list: ${where})`);
    }
    return o.dropEmpty && !kept.length ? undefined : kept;
  }
  if (value instanceof Date) return value.toISOString();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (o.omit?.includes(k)) continue;
    const c = compactValue(v, opts, k);
    if (c !== undefined) out[k] = c;
  }
  return o.dropEmpty && !Object.keys(out).length ? undefined : out;
}

function relativize(s: string, dir: string): string {
  const base = dir.replace(/[\\/]+$/, "");
  if (s === base) return ".";
  if (s.startsWith(`${base}/`) || s.startsWith(`${base}\\`)) return s.slice(base.length + 1);
  return s;
}

/** Compact, single-line JSON of `data` after {@link compactValue} ("" when nothing is left). */
export function compactJson(data: unknown, opts: CompactOptions = {}): string {
  const v = compactValue(data, opts);
  return v === undefined ? "" : JSON.stringify(v);
}

/**
 * The standard tool result: `summary`, then (when there is data) a newline and the compact JSON,
 * in one text block; `structuredContent` is the full object. With `relativeTo`, a
 * `(paths relative to <dir>)` line precedes the JSON.
 */
export function toolResult(summary: string, data?: Record<string, unknown>, opts: CompactOptions & { isError?: boolean } = {}): CallToolResult {
  const { isError, ...compact } = opts;
  const json = data ? compactJson(data, compact) : "";
  const note = json && compact.relativeTo ? `\n(paths relative to ${compact.relativeTo.replace(/[\\/]+$/, "")})` : "";
  return {
    content: [{ type: "text", text: summary + note + (json ? `\n${json}` : "") }],
    ...(data ? { structuredContent: data } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

/** Bytes of a tool result as a client would send it to the model (text blocks, plus structuredContent when `withStructured`). */
export function resultBytes(r: CallToolResult, withStructured = false): number {
  const text = r.content.reduce((n, c) => n + (c.type === "text" ? Buffer.byteLength(c.text) : 0), 0);
  return text + (withStructured && r.structuredContent ? Buffer.byteLength(JSON.stringify(r.structuredContent)) : 0);
}
