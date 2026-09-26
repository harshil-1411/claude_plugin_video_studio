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
  type IrAsset,
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

/** An extracted asset as an IR asset: refs remapped to the IR's refs, keyframe handles to asset ids. */
function toIrAsset(a: ExtractedSource["assets"][number], id: string, remap: ReadonlyMap<string, string>, localIds: ReadonlyMap<string, string>): IrAsset {
  return {
    id,
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
                    const kid = keyframe ? localIds.get(keyframe) : undefined;
                    return kid ? { ...rest, keyframe: kid } : rest;
                  }),
                }
              : {}),
          },
        }
      : {}),
  };
}

/** Classification of one extracted source; notes are prefixed with its source id. */
function classifyPart(part: ExtractedSource, sourceId: string, imagesWithFaces: boolean): Classification {
  const texts = [
    ...(part.source.title ? [part.source.title] : []),
    ...part.sections.map((s) => `${s.heading ?? ""}\n${s.text}`),
    ...part.evidence.map((e) => e.text),
  ];
  const { classification } = classifyText(texts, { kind: part.source.kind, imagesWithFaces });
  const hints = part.classificationHints;
  return {
    ...classification,
    contains_likeness: classification.contains_likeness || hints?.contains_likeness === true,
    contains_secrets: classification.contains_secrets || hints?.contains_secrets === true,
    contains_pii: classification.contains_pii || hints?.contains_pii === true,
    data_class: maxDataClass(
      classification.data_class,
      hints?.contains_secrets ? "restricted" : hints?.contains_pii ? "confidential" : classification.data_class,
    ),
    notes: [...classification.notes, ...(hints?.notes ?? [])].map((n) => `${sourceId}: ${n}`),
  };
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
    for (const a of part.assets) ir.assets.push(toIrAsset(a, `asset-${ir.assets.length + 1}`, remap, localIds));
    for (const w of part.warnings) ir.warnings.push({ ...w, source_id: sourceId });

    const faces = Array.isArray(opts.imagesWithFaces) ? opts.imagesWithFaces[idx] : opts.imagesWithFaces;
    classifications.push(classifyPart(part, sourceId, faces === true));
  });

  ir.classification = mergeClassifications(classifications);
  ir.claims = deriveClaims(ir.evidence, opts.maxClaims ?? 200);
  ir.entities = deriveEntities(ir.sources, ir.sections, ir.evidence);

  const result = ContentIR.safeParse(ir);
  if (!result.success) throw new ContentIRValidationError(formatIssues(result.error));
  return result.data;
}

// ---------------------------------------------------------------------------
// Merge into an existing ContentIR (re-ingest, adding sources)

export interface MergeOptions {
  /** Per-part likeness flags (index-aligned with `parts`) or one flag for all. */
  imagesWithFaces?: boolean | readonly boolean[];
  /** Cap on claims derived from the newly added evidence (default 200). */
  maxClaims?: number;
}

export interface MergeResult {
  ir: ContentIRT;
  /** Per part (index-aligned): the source id it landed on and whether it was added or refreshed in place. */
  placed: Array<{ source_id: string; status: "added" | "updated" }>;
}

/** Heading `transcribe` gives the transcript section it adds (packages/mcp/src/transcribe.ts `transcriptHeading`). */
const TRANSCRIPT_HEADING = /^Transcript \(.+\)$/;
/** Sources ingest created (`src-N`). Sources added by other tools (`demo-<id>`, `<asset>-src`) are never matched or replaced. */
const INGEST_SOURCE_ID = /^src-\d+$/;

function nextNumber(ids: Iterable<string>, prefix: string): number {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

const refBase = (ref: string): string => ref.split("#")[0]!;

/**
 * Merge freshly extracted sources into an existing, valid ContentIR instead of replacing it,
 * so that earlier sources, transcripts, demo recordings and the refs a VideoSpec cites survive.
 *
 * - The IR `id` and `created_at` stay as they are.
 * - Existing sources, sections, evidence, claims, entities, assets and warnings are kept with
 *   their ids and refs unchanged.
 * - A part matches an existing ingest source (`src-N`) when its sha256 is the same (identical
 *   bytes, possibly from another path) or its uri and kind are the same (an updated file). It is
 *   refreshed IN PLACE: same source id; its ingest-produced sections, evidence, assets and
 *   warnings are replaced. Evidence refs are location-based (`markdown:README.md#L3-L7`,
 *   `pdf:x.pdf#p3`, …) and deterministic, so spans whose location did not change keep their ref;
 *   section ids are reused by heading, asset ids by sha256, and the source file's own asset
 *   (a video or audio file) keeps its id even when its bytes changed.
 * - What `transcribe` added to a refreshed media source (timed evidence, the `Transcript (…)`
 *   section, `media.transcript` on the asset) is kept when the bytes are unchanged, and dropped
 *   with a `transcript_dropped` warning when the file changed (the timings no longer apply).
 * - Anything else is new: `src-`, `sec-`, `asset-`, `claim-` and `ent-` numbers continue after
 *   the highest existing one, so a retired id is never reused for different content.
 * - Claims: an existing claim keeps its id while one of its spans still contains its sentence
 *   (refs into refreshed spans are re-checked); claims from new evidence are appended, or add
 *   their ref to an existing claim with the same sentence. Entities are re-derived and keep the
 *   id of an existing entity with the same name.
 * - Classification only ever escalates: the existing label is merged with the new parts'
 *   (a refreshed source's old `src-N:` notes are replaced).
 */
export function mergeContentIR(existing: ContentIRT, parts: readonly ExtractedSource[], opts: MergeOptions = {}): MergeResult {
  if (parts.length === 0) throw new Error("mergeContentIR: at least one extracted source is required");
  const ir: ContentIRT = structuredClone(existing);
  let nextSrc = nextNumber(ir.sources.map((s) => s.id), "src");
  let nextSec = nextNumber(ir.sections.map((s) => s.id), "sec");
  let nextAsset = nextNumber(ir.assets.map((a) => a.id), "asset");
  let nextClaim = nextNumber(ir.claims.map((c) => c.id), "claim");
  let nextEnt = nextNumber(ir.entities.map((e) => e.id), "ent");

  const placed: MergeResult["placed"] = [];
  const classifications: Classification[] = [];
  const dropNotePrefixes: string[] = [];
  let added: EvidenceSpan[] = [];

  parts.forEach((part, idx) => {
    const match = ir.sources.find(
      (s) =>
        INGEST_SOURCE_ID.test(s.id) &&
        (s.sha256 === part.source.sha256 || (s.uri === part.source.uri && s.kind === part.source.kind)),
    );
    let sourceId: string;
    let matchSha: string | undefined;
    const reuseSections = new Map<string, string[]>();
    const reuseAssets = new Map<string, IrAsset>();
    if (match) {
      sourceId = match.id;
      matchSha = match.sha256;
      const sameBytes = match.sha256 === part.source.sha256;
      const isTranscriptSection = (heading: string | undefined) => heading !== undefined && TRANSCRIPT_HEADING.test(heading);
      const isTimed = (e: EvidenceSpan) => e.locator.time_start_sec !== undefined;
      const hadTranscript =
        ir.sections.some((s) => s.source_id === sourceId && isTranscriptSection(s.heading)) ||
        ir.evidence.some((e) => e.source_id === sourceId && isTimed(e));

      const oldSections = ir.sections.filter((s) => s.source_id === sourceId && !(sameBytes && isTranscriptSection(s.heading)));
      for (const s of oldSections) {
        const key = s.heading ?? "";
        reuseSections.set(key, [...(reuseSections.get(key) ?? []), s.id]);
      }
      ir.sections = ir.sections.filter((s) => !oldSections.includes(s));

      const oldEvidence = ir.evidence.filter((e) => e.source_id === sourceId && !(sameBytes && isTimed(e)));
      ir.evidence = ir.evidence.filter((e) => !oldEvidence.includes(e));

      // Assets the source produced: the file itself (same sha256) and anything whose source_ref
      // points into the same file (keyframes, extracted images).
      const ownedBases = new Set(oldEvidence.map((e) => refBase(e.ref)));
      for (const a of ir.assets) if (a.sha256 === match.sha256 && a.source_ref) ownedBases.add(refBase(a.source_ref));
      const oldAssets = ir.assets.filter((a) => a.sha256 === match.sha256 || (a.source_ref !== undefined && ownedBases.has(refBase(a.source_ref))));
      for (const a of oldAssets) if (!reuseAssets.has(a.sha256)) reuseAssets.set(a.sha256, a);
      ir.assets = ir.assets.filter((a) => !oldAssets.includes(a));

      ir.warnings = ir.warnings.filter((w) => w.source_id !== sourceId);
      dropNotePrefixes.push(`${sourceId}: `);
      if (!sameBytes && hadTranscript) {
        dropNotePrefixes.push(`${sourceId} (speech): `);
        ir.warnings.push({
          code: "transcript_dropped",
          source_id: sourceId,
          message: `${part.source.title ?? part.source.uri} changed since it was transcribed; its transcript was dropped: run transcribe again`,
        });
      }
      ir.sources = ir.sources.map((s) => (s.id === sourceId ? { id: sourceId, ...part.source } : s));
      placed.push({ source_id: sourceId, status: "updated" });
    } else {
      sourceId = `src-${nextSrc++}`;
      ir.sources.push({ id: sourceId, ...part.source });
      placed.push({ source_id: sourceId, status: "added" });
    }

    for (const sec of part.sections) {
      const id = reuseSections.get(sec.heading ?? "")?.shift() ?? `sec-${nextSec++}`;
      ir.sections.push({ id, source_id: sourceId, ...sec });
    }

    const registry = new RefRegistry();
    for (const e of ir.evidence) registry.claim(e.ref);
    const remap = new Map<string, string>();
    for (const span of part.evidence) {
      const ref = registry.claim(span.ref);
      if (!remap.has(span.ref)) remap.set(span.ref, ref);
      const ev: EvidenceSpan = { ref, source_id: sourceId, text: span.text, locator: span.locator };
      ir.evidence.push(ev);
      added.push(ev);
    }

    const ids = part.assets.map((a) => {
      const old = reuseAssets.get(a.sha256);
      if (old && old.kind === a.kind) {
        reuseAssets.delete(a.sha256);
        return { id: old.id, old };
      }
      // The source file itself changed (a re-cut video): keep the asset id footage scenes cite.
      const prevFile = matchSha !== undefined && a.sha256 === part.source.sha256 ? reuseAssets.get(matchSha) : undefined;
      if (prevFile && prevFile.kind === a.kind) {
        reuseAssets.delete(matchSha!);
        return { id: prevFile.id, old: undefined };
      }
      return { id: `asset-${nextAsset++}`, old: undefined };
    });
    const localIds = new Map<string, string>();
    part.assets.forEach((a, k) => {
      if (a.local_id) localIds.set(a.local_id, ids[k]!.id);
    });
    part.assets.forEach((a, k) => {
      const asset = toIrAsset(a, ids[k]!.id, remap, localIds);
      // Same bytes → the transcript and footage notes recorded on the old asset still apply
      // (a re-cut file keeps its id but loses both: they describe the old picture and sound).
      const transcript = ids[k]!.old?.media?.transcript;
      if (transcript && asset.media) asset.media = { ...asset.media, transcript };
      const notes = ids[k]!.old?.media?.notes?.filter((n) => n.asset_sha256 === asset.sha256);
      if (notes?.length && asset.media) asset.media = { ...asset.media, notes };
      ir.assets.push(asset);
    });

    for (const w of part.warnings) ir.warnings.push({ ...w, source_id: sourceId });
    const faces = Array.isArray(opts.imagesWithFaces) ? opts.imagesWithFaces[idx] : opts.imagesWithFaces;
    classifications.push(classifyPart(part, sourceId, faces === true));
  });

  ir.classification = mergeClassifications([
    { ...ir.classification, notes: ir.classification.notes.filter((n) => !dropNotePrefixes.some((p) => n.startsWith(p))) },
    ...classifications,
  ]);

  // Claims: keep ids stable; re-check refs that point at refreshed spans.
  const live = new Set(ir.evidence);
  added = added.filter((e) => live.has(e)); // a later duplicate input in the same call refreshed it again
  const addedRefs = new Set(added.map((e) => e.ref));
  const spans = new Map(ir.evidence.map((e) => [e.ref, e]));
  const still = (ref: string, text: string): boolean => {
    const span = spans.get(ref);
    if (!span) return false;
    if (!addedRefs.has(ref)) return true;
    return splitSentences(span.text).some((s) => s.toLowerCase() === text.toLowerCase());
  };
  ir.claims = ir.claims
    .map((c) => ({ ...c, evidence_refs: c.evidence_refs.filter((r) => still(r, c.text)) }))
    .filter((c) => c.evidence_refs.length > 0);
  const byText = new Map(ir.claims.map((c) => [c.text.toLowerCase(), c]));
  let budget = opts.maxClaims ?? 200;
  for (const c of deriveClaims(added, Number.MAX_SAFE_INTEGER)) {
    const known = byText.get(c.text.toLowerCase());
    if (known) {
      for (const r of c.evidence_refs) if (!known.evidence_refs.includes(r)) known.evidence_refs.push(r);
      continue;
    }
    if (budget-- <= 0) break;
    const claim: Claim = { ...c, id: `claim-${nextClaim++}` };
    ir.claims.push(claim);
    byText.set(claim.text.toLowerCase(), claim);
  }

  // Entities: re-derived over the merged IR, ids stable by name.
  const oldEnt = new Map(ir.entities.map((e) => [e.name.toLowerCase(), e.id]));
  ir.entities = deriveEntities(ir.sources, ir.sections, ir.evidence).map((e) => ({ ...e, id: oldEnt.get(e.name.toLowerCase()) ?? `ent-${nextEnt++}` }));

  const result = ContentIR.safeParse(ir);
  if (!result.success) throw new ContentIRValidationError(formatIssues(result.error));
  return { ir: result.data, placed };
}
