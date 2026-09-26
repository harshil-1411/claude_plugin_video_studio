import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectPaths } from "@video-studio/core";
import { ContentIR, type EvidenceSpan, type Section } from "@video-studio/schema";

/**
 * source_summary / source_section: read the ContentIR without loading all of it into Claude's
 * context. A repo's source/content-ir.json can be over 1 MB (hundreds of sections and evidence
 * spans); planning needs an outline (what is there, which refs cite what, the top claims) and
 * then the full text of the few sections the script will actually use.
 */

export interface SourceSummaryOptions {
  /** Claims listed (default 30; they keep ContentIR order). */
  maxClaims?: number;
  /** Evidence refs listed per section (default 2). */
  maxEvidencePerSection?: number;
  /** Sections listed (default 100); the rest are counted, and `source_id` narrows the list. */
  maxSections?: number;
  /** Entities listed (default 25, most-cited first). */
  maxEntities?: number;
  /** Only this source's sections, claims and entities. */
  source_id?: string;
}

export interface SourceSummary {
  ir_id: string;
  counts: { sources: number; sections: number; evidence: number; entities: number; claims: number; assets: number; warnings: number };
  sources: Array<{ id: string; kind: string; title?: string; uri: string; sections: number; evidence: number; chars: number }>;
  /** Section outline in source order: `chars` of text, `evidence` spans inside it, the first `refs`. */
  /** `source_id` is left out when the IR has a single source. */
  sections: Array<{ id: string; source_id?: string; heading?: string; chars: number; evidence: number; refs: string[] }>;
  sections_omitted?: number;
  /** Claims with text cut to 200 chars; cite `id` or one of `refs` in claim_refs. */
  claims: Array<{ id: string; kind: string; text: string; refs: string[] }>;
  claims_omitted?: number;
  entities: Array<{ name: string; kind: string; refs: number }>;
  assets: Array<{
    id: string;
    kind: string;
    path: string;
    duration_sec?: number;
    width?: number;
    height?: number;
    has_audio?: boolean;
    transcript: boolean;
    transcript_words?: number;
    shots?: number;
    source_ref?: string;
  }>;
  classification: ContentIR["classification"];
  warnings: Array<{ code: string; message: string; source_id?: string }>;
  /** How to read more: which follow-up tool returns what in full. */
  detail: string;
}

export interface SourceSectionResult {
  id: string;
  source_id: string;
  heading?: string;
  /** Full text (or the requested window of it; see `offset`/`truncated`). */
  text: string;
  chars: number;
  offset?: number;
  /** Set when text was cut at `max_chars`: call again with `offset` = offset + text.length. */
  truncated?: boolean;
  /** Evidence spans inside this section: ref, locator and the first 120 chars (the full text is in `text`). */
  evidence: Array<{ ref: string; locator: EvidenceSpan["locator"]; preview: string }>;
  /** Claims citing this section's evidence. */
  claims: Array<{ id: string; kind: string; text: string; refs: string[] }>;
  /** Set when `id` was an evidence ref: the ref that led here. */
  matched_ref?: string;
  prev?: string;
  next?: string;
}

const CLAIM_CHARS = 200;

function cut(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Load and validate <project>/source/content-ir.json. */
export async function loadContentIr(projectDir: string): Promise<ContentIR> {
  const path = join(projectPaths(projectDir).source, "content-ir.json");
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error(`no source/content-ir.json in ${projectDir}: ingest the sources first`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`source/content-ir.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  const parsed = ContentIR.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`source/content-ir.json is not a valid ContentIR (${issues})`);
  }
  return parsed.data;
}

/** Lowercase words only: evidence keeps the source's markup (`*`, `>`, links, escapes), sections are plain text. */
function words(s: string): string {
  return ` ${s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/**
 * Assign each evidence span to the section of its source that contains it. Spans follow source
 * order, so matching uses a moving cursor (a repeated short span lands in the section where it
 * appears next, not the first one). A span matches a section whose heading + text contains its
 * words; failing that, the section sharing at least 60% of its distinct words; failing that
 * (speaker notes, markup the section text dropped), the section the previous span landed in.
 * Spans before any match are left out.
 */
export function evidenceBySection(ir: Pick<ContentIR, "sections" | "evidence">): Map<string, EvidenceSpan[]> {
  const out = new Map<string, EvidenceSpan[]>();
  const bySource = new Map<string, Section[]>();
  for (const s of ir.sections) {
    out.set(s.id, []);
    bySource.set(s.source_id, [...(bySource.get(s.source_id) ?? []), s]);
  }
  const cursor = new Map<string, number>();
  const norm = new Map<string, { text: string; set: Set<string> }>();
  const of = (s: Section) => {
    let t = norm.get(s.id);
    if (!t) {
      const text = words(`${s.heading ?? ""} ${s.text}`);
      norm.set(s.id, (t = { text, set: new Set(text.split(" ").filter(Boolean)) }));
    }
    return t;
  };
  for (const e of ir.evidence) {
    const secs = bySource.get(e.source_id);
    if (!secs?.length) continue;
    const needle = words(e.text);
    if (!needle.trim()) continue;
    const start = cursor.get(e.source_id) ?? 0;
    const order = secs.map((_, k) => (start + k) % secs.length);
    let hit = order.find((i) => of(secs[i]!).text.includes(needle)) ?? -1;
    if (hit < 0) {
      const toks = [...new Set(needle.split(" ").filter((w) => w.length > 2))];
      let best = 0;
      if (toks.length >= 3) {
        for (const i of order) {
          const set = of(secs[i]!).set;
          const share = toks.filter((w) => set.has(w)).length / toks.length;
          if (share > best) [best, hit] = [share, i];
        }
      }
      if (best < 0.6) hit = cursor.has(e.source_id) ? start : -1;
    }
    if (hit < 0) continue;
    cursor.set(e.source_id, hit);
    out.get(secs[hit]!.id)!.push(e);
  }
  return out;
}

export function summarizeIr(ir: ContentIR, opts: SourceSummaryOptions = {}): SourceSummary {
  const maxClaims = opts.maxClaims ?? 30;
  const maxRefs = opts.maxEvidencePerSection ?? 2;
  const maxSections = opts.maxSections ?? 100;
  const single = ir.sources.length === 1;
  const maxEntities = opts.maxEntities ?? 25;
  const only = opts.source_id;
  if (only && !ir.sources.some((s) => s.id === only)) {
    throw new Error(`no source "${only}" (sources: ${ir.sources.map((s) => s.id).join(", ")})`);
  }
  const bySec = evidenceBySection(ir);
  const refSource = new Map(ir.evidence.map((e) => [e.ref, e.source_id]));
  const inScope = (sourceId: string | undefined) => !only || sourceId === only;

  const sources = ir.sources.map((s) => {
    const secs = ir.sections.filter((x) => x.source_id === s.id);
    return {
      id: s.id,
      kind: s.kind,
      ...(s.title ? { title: s.title } : {}),
      uri: s.uri,
      sections: secs.length,
      evidence: ir.evidence.filter((e) => e.source_id === s.id).length,
      chars: secs.reduce((n, x) => n + x.text.length, 0),
    };
  });

  const allSections = ir.sections.filter((s) => inScope(s.source_id));
  const sections = allSections.slice(0, maxSections).map((s) => {
    const ev = bySec.get(s.id) ?? [];
    return {
      id: s.id,
      ...(single ? {} : { source_id: s.source_id }),
      ...(s.heading ? { heading: cut(s.heading, 120) } : {}),
      chars: s.text.length,
      evidence: ev.length,
      refs: ev.slice(0, maxRefs).map((e) => e.ref),
    };
  });

  const allClaims = ir.claims.filter((c) => !only || c.evidence_refs.some((r) => refSource.get(r) === only));
  const claims = allClaims.slice(0, maxClaims).map((c) => ({ id: c.id, kind: c.kind, text: cut(c.text, CLAIM_CHARS), refs: c.evidence_refs.slice(0, 3) }));

  const entities = ir.entities
    .filter((e) => !only || (e.evidence_refs ?? []).some((r) => refSource.get(r) === only))
    .map((e) => ({ name: e.name, kind: e.kind, refs: e.evidence_refs?.length ?? 0 }))
    .sort((a, b) => b.refs - a.refs)
    .slice(0, maxEntities);

  const assets = ir.assets.map((a) => ({
    id: a.id,
    kind: a.kind,
    path: a.path,
    ...(a.media ? { duration_sec: a.media.duration_sec } : {}),
    ...(a.media?.width ? { width: a.media.width, height: a.media.height } : {}),
    ...(a.media ? { has_audio: a.media.has_audio } : {}),
    transcript: Boolean(a.media?.transcript),
    ...(a.media?.transcript ? { transcript_words: a.media.transcript.words } : {}),
    ...(a.media?.shots ? { shots: a.media.shots.length } : {}),
    ...(a.source_ref ? { source_ref: a.source_ref } : {}),
  }));

  const omittedSections = allSections.length - sections.length;
  const omittedClaims = allClaims.length - claims.length;
  const detail = [
    "source_section {project_dir, id} returns one section's full text with every evidence ref inside it and the claims citing them (id may also be an evidence ref).",
    omittedSections ? `${omittedSections} more section(s): pass source_id or a larger max_sections to list them.` : "",
    omittedClaims ? `${omittedClaims} more claim(s): pass a larger max_claims.` : "",
    "Cite evidence refs or claim ids exactly as listed in claim_refs.",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    ir_id: ir.id,
    counts: {
      sources: ir.sources.length,
      sections: ir.sections.length,
      evidence: ir.evidence.length,
      entities: ir.entities.length,
      claims: ir.claims.length,
      assets: ir.assets.length,
      warnings: ir.warnings.length,
    },
    sources,
    sections,
    ...(omittedSections ? { sections_omitted: omittedSections } : {}),
    claims,
    ...(omittedClaims ? { claims_omitted: omittedClaims } : {}),
    entities,
    assets,
    classification: ir.classification,
    warnings: ir.warnings.slice(0, 20).map((w) => ({ code: w.code, message: cut(w.message, 300), ...(w.source_id ? { source_id: w.source_id } : {}) })),
    detail,
  };
}

/** Compact outline of <project>/source/content-ir.json (see {@link SourceSummary}). */
export async function summarizeSource(projectDir: string, opts: SourceSummaryOptions = {}): Promise<SourceSummary> {
  return summarizeIr(await loadContentIr(projectDir), opts);
}

export interface SourceSectionOptions {
  /** Longest text returned (default 20,000 chars); page with `offset`. */
  max_chars?: number;
  offset?: number;
}

export function irSection(ir: ContentIR, id: string, opts: SourceSectionOptions = {}): SourceSectionResult {
  const bySec = evidenceBySection(ir);
  let sec = ir.sections.find((s) => s.id === id);
  let matched: string | undefined;
  if (!sec) {
    const ev = ir.evidence.find((e) => e.ref === id);
    if (ev) {
      matched = ev.ref;
      sec = ir.sections.find((s) => (bySec.get(s.id) ?? []).includes(ev));
      if (!sec) throw new Error(`evidence ref "${id}" is not inside any section; its text: ${cut(ev.text, 300)}`);
    }
  }
  if (!sec) {
    const near = ir.sections.slice(0, 10).map((s) => s.id).join(", ");
    throw new Error(`no section or evidence ref "${id}" in the ContentIR (sections start ${near}${ir.sections.length > 10 ? ", …" : ""}; see source_summary)`);
  }
  const max = Math.max(500, opts.max_chars ?? 20_000);
  const offset = Math.max(0, Math.min(opts.offset ?? 0, sec.text.length));
  const text = sec.text.slice(offset, offset + max);
  const ev = bySec.get(sec.id) ?? [];
  const refs = new Set(ev.map((e) => e.ref));
  const claims = ir.claims
    .filter((c) => c.evidence_refs.some((r) => refs.has(r)))
    .map((c) => ({ id: c.id, kind: c.kind, text: c.text, refs: c.evidence_refs }));
  const siblings = ir.sections.filter((s) => s.source_id === sec.source_id);
  const i = siblings.indexOf(sec);
  return {
    id: sec.id,
    source_id: sec.source_id,
    ...(sec.heading ? { heading: sec.heading } : {}),
    text,
    chars: sec.text.length,
    ...(offset ? { offset } : {}),
    ...(offset + text.length < sec.text.length ? { truncated: true } : {}),
    evidence: ev.map((e) => ({ ref: e.ref, locator: e.locator, preview: cut(e.text, 120) })),
    claims,
    ...(matched ? { matched_ref: matched } : {}),
    ...(i > 0 ? { prev: siblings[i - 1]!.id } : {}),
    ...(i >= 0 && i < siblings.length - 1 ? { next: siblings[i + 1]!.id } : {}),
  };
}

/** One section of <project>/source/content-ir.json in full (id: a section id or an evidence ref). */
export async function sourceSection(projectDir: string, sectionId: string, opts: SourceSectionOptions = {}): Promise<SourceSectionResult> {
  return irSection(await loadContentIr(projectDir), sectionId, opts);
}

export function formatSourceSummary(s: SourceSummary): string {
  const c = s.counts;
  const cls = s.classification;
  return [
    `ContentIR ${s.ir_id}: ${c.sources} source(s), ${c.sections} section(s), ${c.evidence} evidence span(s), ${c.claims} claim(s), ${c.entities} entit${c.entities === 1 ? "y" : "ies"}, ${c.assets} asset(s)`,
    `classification: ${cls.data_class}${cls.contains_secrets ? ", secrets (redacted)" : ""}${cls.contains_pii ? ", PII" : ""}${cls.contains_likeness ? ", likeness" : ""}`,
    ...s.sources.map((x) => `${x.id} ${x.kind}${x.title ? ` "${x.title}"` : ""}: ${x.sections} section(s), ${x.chars} chars`),
    s.detail,
  ].join("\n");
}

export function formatSourceSection(r: SourceSectionResult): string {
  return `section ${r.id}${r.heading ? ` "${r.heading}"` : ""} (${r.source_id}, ${r.chars} chars, ${r.evidence.length} evidence ref(s), ${r.claims.length} claim(s))${r.truncated ? `; text cut: call again with offset ${(r.offset ?? 0) + r.text.length}` : ""}`;
}
