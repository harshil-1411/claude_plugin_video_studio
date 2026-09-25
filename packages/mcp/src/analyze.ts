import type { FormatGrammar, ShortCandidates } from "@video-studio/schema";

/**
 * analyze: a reference video → its format grammar (structure only: shots, pacing, caption band,
 * speech share). shorts: a long recording's transcript × shots → scored standalone spans.
 *
 * STUB (coordinator): the footage agent implements these.
 */

export async function analyzeVideo(_path: string, _opts: { projectDir?: string } = {}): Promise<FormatGrammar & { report_md?: string }> {
  throw new Error("not implemented: analyzeVideo");
}

export function formatGrammar(_g: FormatGrammar): string {
  throw new Error("not implemented: formatGrammar");
}

export async function findShorts(_projectDir: string, _asset: string, _opts: { min_sec?: number; max_sec?: number; count?: number } = {}): Promise<ShortCandidates> {
  throw new Error("not implemented: findShorts");
}

export function formatShorts(_s: ShortCandidates): string {
  throw new Error("not implemented: formatShorts");
}
