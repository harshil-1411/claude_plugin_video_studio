import { createHash } from "node:crypto";
import {
  ContentIR,
  SCHEMA_VERSION,
  formatIssues,
  type Claim,
  type Classification,
  type ContentIR as ContentIRT,
  type Entity,
  type EvidenceSpan,
} from "@video-studio/schema";
import { classifyText, maxDataClass, mergeClassifications } from "./classify.js";
import { RefRegistry } from "./refs.js";
import type { ExtractedSource } from "./types.js";

export interface BuildOptions {
  /** Creation time; defaults to the current time. */
  now?: Date | string;
  /** IR id; defaults to `ir-<first 12 hex of sha256 over the source hashes>`. */
  id?: string;
  /** Per-source likeness flags (index-aligned with `parts`) or one flag for all. */
  imagesWithFaces?: boolean | readonly boolean[];
  /** Cap on derived claims (default 200). */
  maxClaims?: number;
}

export class ContentIRValidationError extends Error {
  constructor(readonly issues: Array<{ path: string; message: string }>) {
    super(`ContentIR is invalid:\n${issues.map((i) => `  - ${i.path || "(root)"}: ${i.message}`).join("\n")}`);
    this.name = "ContentIRValidationError";
  }
}

// ---------------------------------------------------------------------------
// Claims

const QUANT_PATTERNS: RegExp[] = [
  /\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:%|percent\b|pct\b|pp\b|bps\b)/i,
  /[$€£¥₹]\s?\d/,
  /\b\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:USD|EUR|GBP|dollars?|euros?|cents?)\b/i,
  /\b\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:ns|µs|us|ms|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|days?|weeks?|months?|years?|yrs?|quarters?)\b/i,
  /\b\d+(?:\.\d+)?\s?(?:x|×)(?!\w)/i,
  /\b\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:k|K|M|B|thousand|million|billion|trillion)\b/,
  /\b\d(?:[\d,]*\d)?(?:\.\d+)?\s?(?:KB|MB|GB|TB|kB|fps|Hz|kHz|MHz|GHz|tokens?|users?|customers?|requests?|queries|downloads?|stars?|times)\b/i,
  /\b(?:19|20)\d{2}\b/,
  // A standalone number of two or more digits (not part of an identifier or version).
  /(?<![\w.\-/#:])\d{2,}(?:[.,]\d+)?(?![\w.\-/:])/,
];

/** True when a sentence carries a number with a unit, percent, currency, time or magnitude. */
export function isQuantitative(sentence: string): boolean {
  return QUANT_PATTERNS.some((re) => re.test(sentence));
}

function isCodeSpan(text: string): boolean {
  return /^\s{0,3}(```|~~~)/.test(text);
}

/** Split an evidence excerpt into candidate sentences (list items and lines stay separate). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  const blocks = text.split(/\n(?=\s*(?:[-*+•]|\d{1,3}[.)]|>|\|)\s)|\n{2,}/);
  for (const block of blocks) {
    const clean = block
      .replace(/^\s*(?:[-*+•]|\d{1,3}[.)])\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_`]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!clean) continue;
    for (const s of clean.split(/(?<=[.!?])\s+(?=["“(\[]?[\p{Lu}\p{N}])/u)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

export function deriveClaims(evidence: readonly EvidenceSpan[], max: number): Claim[] {
  const claims: Claim[] = [];
  const byText = new Map<string, Claim>();
  for (const span of evidence) {
    if (isCodeSpan(span.text) || span.locator.selector === "front-matter") continue;
    for (const sentence of splitSentences(span.text)) {
      if (sentence.split(/\s+/).length < 3 || sentence.length > 500) continue;
      const withoutCode = sentence.replace(/`[^`]*`/g, "");
      if (!isQuantitative(withoutCode)) continue;
      const key = sentence.toLowerCase();
      const existing = byText.get(key);
      if (existing) {
        if (!existing.evidence_refs.includes(span.ref)) existing.evidence_refs.push(span.ref);
        continue;
      }
      if (claims.length >= max) return claims;
      const claim: Claim = { id: `claim-${claims.length + 1}`, text: sentence, kind: "quantitative", evidence_refs: [span.ref] };
      claims.push(claim);
      byText.set(key, claim);
    }
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Entities (minimal: product-like names from titles and headings)

const COMMON_ACRONYMS = new Set(["I", "A", "OK", "FAQ", "TL", "DR", "TLDR", "TODO", "NOTE", "AND", "OR", "THE", "FOR", "HOW", "WHY", "WHAT", "NEW"]);

function candidateNames(text: string): Array<{ name: string; kind: Entity["kind"] }> {
  const out: Array<{ name: string; kind: Entity["kind"] }> = [];
  for (const m of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*[\p{L}\p{N}+#]|[\p{L}]/gu)) {
    const w = m[0];
    // Internal capital (GitHub, ContentIR, iPhone, JavaScript) → product-like name.
    if (/^\p{L}+[\p{Ll}\p{N}]\p{Lu}[\p{L}\p{N}]*$/u.test(w) || /^\p{Ll}+\p{Lu}[\p{L}\p{N}]*$/u.test(w)) {
      out.push({ name: w, kind: "product" });
    } else if (/^\p{Lu}{2,6}\d*$/u.test(w) && !COMMON_ACRONYMS.has(w)) {
      out.push({ name: w, kind: "technology" });
    } else if (/^[\p{Lu}][\p{L}]*(?:\.js|\.ts|\.py|\.io|\.ai|\.dev)$/u.test(w)) {
      out.push({ name: w, kind: "technology" });
    }
  }
  return out;
}

function deriveEntities(
  sources: ContentIRT["sources"],
  sections: ContentIRT["sections"],
  evidence: readonly EvidenceSpan[],
): Entity[] {
  const entities = new Map<string, Entity>();
  const add = (name: string, kind: Entity["kind"], sourceId: string) => {
    const key = name.toLowerCase();
    let ent = entities.get(key);
    if (!ent) {
      ent = { id: `ent-${entities.size + 1}`, name, kind, evidence_refs: [] };
      entities.set(key, ent);
    }
    // Evidence: the first span of that source mentioning the name, else its first span.
    const inSource = evidence.filter((e) => e.source_id === sourceId);
    const ref = (inSource.find((e) => e.text.includes(name)) ?? inSource[0])?.ref;
    if (ref && !ent.evidence_refs!.includes(ref)) ent.evidence_refs!.push(ref);
  };
  for (const s of sources) {
    if (s.title) for (const c of candidateNames(s.title)) add(c.name, c.kind, s.id);
  }
  for (const sec of sections) {
    if (sec.heading) for (const c of candidateNames(sec.heading)) add(c.name, c.kind, sec.source_id);
  }
  return [...entities.values()].map((e) => (e.evidence_refs!.length ? e : { id: e.id, name: e.name, kind: e.kind }));
}

// ---------------------------------------------------------------------------

function toIso(now: Date | string | undefined): string {
  if (now === undefined) return new Date().toISOString();
  return typeof now === "string" ? now : now.toISOString();
}

/**
 * Merge extractor outputs into one validated ContentIR: assign ids, attach
 * source ids, make refs unique across the IR, derive quantitative claims and
 * minimal entities, and classify every source (max data_class wins).
 */
export function buildContentIR(parts: readonly ExtractedSource[], opts: BuildOptions = {}): ContentIRT {
  if (parts.length === 0) throw new Error("buildContentIR: at least one extracted source is required");
  const registry = new RefRegistry();
  const ir: ContentIRT = {
    schema_version: SCHEMA_VERSION,
    id:
      opts.id ??
      `ir-${createHash("sha256")
        .update(parts.map((p) => p.source.sha256).join("\n"))
        .digest("hex")
        .slice(0, 12)}`,
    created_at: toIso(opts.now),
    sources: [],
    sections: [],
    evidence: [],
    entities: [],
    claims: [],
    assets: [],
    classification: mergeClassifications([]),
    warnings: [],
  };
  const classifications: Classification[] = [];

  parts.forEach((part, idx) => {
    const sourceId = `src-${idx + 1}`;
    ir.sources.push({ id: sourceId, ...part.source });
    for (const sec of part.sections) ir.sections.push({ id: `sec-${ir.sections.length + 1}`, source_id: sourceId, ...sec });

    // Remap refs within this part so assets keep pointing at the right span.
    const remap = new Map<string, string>();
    for (const span of part.evidence) {
      const ref = registry.claim(span.ref);
      if (!remap.has(span.ref)) remap.set(span.ref, ref);
      ir.evidence.push({ ref, source_id: sourceId, text: span.text, locator: span.locator });
    }
    const firstAsset = ir.assets.length;
    const localIds = new Map<string, string>();
    part.assets.forEach((a, k) => {
      if (a.local_id) localIds.set(a.local_id, `asset-${firstAsset + k + 1}`);
    });
    for (const a of part.assets) {
      ir.assets.push({
        id: `asset-${ir.assets.length + 1}`,
        kind: a.kind,
        path: a.path,
        sha256: a.sha256,
        ...(a.source_ref ? { source_ref: remap.get(a.source_ref) ?? a.source_ref } : {}),
        ...(a.media
          ? {
              media: {
                ...a.media,
                ...(a.media.shots
                  ? {
                      shots: a.media.shots.map((s) => {
                        const { keyframe, ...rest } = s;
                        const id = keyframe ? localIds.get(keyframe) : undefined;
                        return id ? { ...rest, keyframe: id } : rest;
                      }),
                    }
                  : {}),
              },
            }
          : {}),
      });
    }
    for (const w of part.warnings) ir.warnings.push({ ...w, source_id: sourceId });

    const faces = Array.isArray(opts.imagesWithFaces) ? opts.imagesWithFaces[idx] : opts.imagesWithFaces;
    const texts = [
      ...(part.source.title ? [part.source.title] : []),
      ...part.sections.map((s) => `${s.heading ?? ""}\n${s.text}`),
      ...part.evidence.map((e) => e.text),
    ];
    const { classification } = classifyText(texts, { kind: part.source.kind, imagesWithFaces: faces === true });
    const hints = part.classificationHints;
    classifications.push({
      ...classification,
      contains_likeness: classification.contains_likeness || hints?.contains_likeness === true,
      contains_secrets: classification.contains_secrets || hints?.contains_secrets === true,
      contains_pii: classification.contains_pii || hints?.contains_pii === true,
      data_class: maxDataClass(
        classification.data_class,
        hints?.contains_secrets ? "restricted" : hints?.contains_pii ? "confidential" : classification.data_class,
      ),
      notes: [...classification.notes, ...(hints?.notes ?? [])].map((n) => `${sourceId}: ${n}`),
    });
  });

  ir.classification = mergeClassifications(classifications);
  ir.claims = deriveClaims(ir.evidence, opts.maxClaims ?? 200);
  ir.entities = deriveEntities(ir.sources, ir.sections, ir.evidence);

  const result = ContentIR.safeParse(ir);
  if (!result.success) throw new ContentIRValidationError(formatIssues(result.error));
  return result.data;
}
