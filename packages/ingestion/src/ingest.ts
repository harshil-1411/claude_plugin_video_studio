import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ContentStore,
  cacheKey,
  hashFile,
  resolveDataDir,
  sha256Hex,
  writeFileAtomic,
  writeJsonAtomic,
} from "@video-studio/core";
import {
  SCHEMA_VERSION,
  type Classification,
  type ContentIR,
  type IrWarning,
  type SourceKind,
} from "@video-studio/schema";
import { buildContentIR } from "./builder.js";
import { detectKind } from "./detect.js";
import { type ExtractorRegistry, createExtractors } from "./extractors.js";
import { displayPath } from "./refs.js";
import type { FetchRepo } from "./repo.js";
import type { ExtractInput, ExtractedSource, Extractor } from "./types.js";
import type { FetchImpl } from "./url.js";

/** One ingest input: a path, URL or inline text, optionally with an explicit kind. */
export interface IngestInput {
  uri: string;
  kind?: SourceKind;
  /** Inline content (kind text/markdown); `uri` is then only a label. */
  content?: string;
}

export interface IngestOptions {
  /** Project folder; writes `source/content-ir.json` and `source/provenance.json`. */
  projectDir: string;
  /** Fixed creation/fetch time (tests, reproducible builds). */
  now?: Date | string;
  /** Extraction cache root. Defaults to `<data dir>/cache` (CLAUDE_PLUGIN_DATA…). */
  cacheDir?: string;
  /** Skip the cache entirely (no reads, no writes). */
  noCache?: boolean;
  /** Base for relative input paths (default process.cwd()). */
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchImpl;
  fetchRepo?: FetchRepo;
  /** Replace or extend extractors (tests). */
  extractors?: ExtractorRegistry;
}

export interface SourceProvenance {
  source_id: string;
  uri: string;
  kind: SourceKind;
  sha256: string;
  title?: string;
  extractor_version: string;
  fetched_at: string;
  cache_hit: boolean;
  cache_key: string;
}

export interface Provenance {
  schema_version: 1;
  ir_id: string;
  ir_schema_version: string;
  created_at: string;
  sources: SourceProvenance[];
  failures: Array<{ uri: string; kind?: SourceKind; error: string }>;
}

export interface IngestSummary {
  ir_path: string;
  provenance_path: string;
  ir_id: string;
  sources: Array<{
    id: string;
    kind: SourceKind;
    uri: string;
    title?: string;
    sections: number;
    evidence: number;
    cache_hit: boolean;
  }>;
  sections: number;
  evidence: number;
  claims: number;
  entities: number;
  assets: number;
  warnings: IrWarning[];
  classification: Classification;
}

export interface IngestResult {
  summary: IngestSummary;
  ir: ContentIR;
  provenance: Provenance;
}

export class IngestError extends Error {
  constructor(
    message: string,
    readonly failures: Provenance["failures"],
  ) {
    super(message);
    this.name = "IngestError";
  }
}

const INLINE_KINDS = new Set<SourceKind>(["text", "markdown"]);

function isExistingFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Normalize a raw input into an ExtractInput (absolute paths, inline content detected). */
export function resolveIngestInput(raw: string | IngestInput, cwd: string): ExtractInput {
  const item: IngestInput = typeof raw === "string" ? { uri: raw } : raw;
  if (item.content !== undefined) {
    const kind = item.kind ?? detectKind(item.content);
    if (!INLINE_KINDS.has(kind)) throw new Error(`inline content must be text or markdown, got kind "${kind}"`);
    return { uri: item.uri || item.content, kind, content: item.content };
  }
  let uri = item.uri;
  if (/^file:\/\//i.test(uri)) uri = fileURLToPath(uri);
  const isUrl = /^https?:\/\//i.test(uri.trim()) && !/\s/.test(uri.trim());
  const singleToken = !/[\n\r]/.test(uri) && uri.length < 4096;
  const candidatePath = !isUrl && singleToken ? resolve(cwd, uri.trim()) : undefined;
  const pathExists = candidatePath !== undefined && existsSync(candidatePath);
  const kind = item.kind ?? detectKind(pathExists ? candidatePath : uri);

  if (kind === "url" || (kind === "repo" && isUrl)) return { uri: uri.trim(), kind };
  if (INLINE_KINDS.has(kind) && !(candidatePath && isExistingFile(candidatePath))) {
    return { uri, kind, content: uri }; // inline text
  }
  if (!candidatePath || !pathExists) throw new Error(`input not found: ${uri}`);
  return { uri: candidatePath, kind };
}

// ---------------------------------------------------------------------------
// Cache: `<cacheDir>/ingest/<ab>/<key>.json` → pointer to an ExtractedSource
// JSON blob in the content store `<cacheDir>/cas`. Extracted assets (images)
// are stored in the same CAS so a hit can restore them into a new project.

interface CacheIndexEntry {
  sha256: string;
  kind: SourceKind;
  extractor_version: string;
  fetched_at: string;
}

class ExtractionCache {
  private readonly store: ContentStore;
  constructor(private readonly root: string) {
    this.store = new ContentStore(join(root, "cas"));
  }

  private indexPath(key: string): string {
    return join(this.root, "ingest", key.slice(0, 2), `${key}.json`);
  }

  async get(key: string, projectDir: string): Promise<{ part: ExtractedSource; entry: CacheIndexEntry } | undefined> {
    try {
      const entry = JSON.parse(await readFile(this.indexPath(key), "utf8")) as CacheIndexEntry;
      const blob = await this.store.get(entry.sha256);
      if (!blob) return undefined;
      const part = JSON.parse(await readFile(blob.path, "utf8")) as ExtractedSource;
      if (!part?.source || !Array.isArray(part.sections) || !Array.isArray(part.evidence)) return undefined;
      for (const a of part.assets ?? []) {
        const dest = join(projectDir, a.path);
        if (existsSync(dest)) continue;
        if (!(await this.store.has(a.sha256))) return undefined;
        await this.store.materialize(a.sha256, dest);
      }
      return { part, entry };
    } catch {
      return undefined;
    }
  }

  async put(key: string, part: ExtractedSource, projectDir: string, extractorVersion: string, fetchedAt: string): Promise<void> {
    try {
      for (const a of part.assets) await this.store.put(join(projectDir, a.path));
      const blob = await this.store.put(new TextEncoder().encode(JSON.stringify(part)));
      const entry: CacheIndexEntry = {
        sha256: blob.sha256,
        kind: part.source.kind,
        extractor_version: extractorVersion,
        fetched_at: fetchedAt,
      };
      await writeFileAtomic(this.indexPath(key), JSON.stringify(entry));
    } catch {
      /* the cache is best-effort; ingest never fails because of it */
    }
  }
}

async function inputDigest(extractor: Extractor, input: ExtractInput): Promise<string> {
  if (input.content !== undefined) return sha256Hex(input.content);
  if (extractor.inputDigest) return extractor.inputDigest(input);
  return hashFile(input.uri);
}

function toIso(now: Date | string | undefined): string {
  if (now === undefined) return new Date().toISOString();
  return typeof now === "string" ? now : now.toISOString();
}

/**
 * Ingest inputs into `<projectDir>/source/content-ir.json`:
 * detect kind → (cache | extractor) → buildContentIR → atomic writes of the IR
 * and `source/provenance.json`. Inputs that fail are reported as
 * `ingest_failed` warnings; if every input fails an {@link IngestError} is thrown.
 */
export async function ingest(inputs: ReadonlyArray<string | IngestInput>, options: IngestOptions): Promise<IngestResult> {
  if (inputs.length === 0) throw new Error("ingest: at least one input is required");
  const projectDir = resolve(options.projectDir);
  const cwd = options.cwd ?? process.cwd();
  const now = toIso(options.now);
  const registry: ExtractorRegistry = {
    ...createExtractors({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.fetchRepo ? { fetchRepo: options.fetchRepo } : {}),
    }),
    ...options.extractors,
  };
  const cache = options.noCache
    ? undefined
    : new ExtractionCache(options.cacheDir ?? resolveDataDir(options.env ?? process.env).cache);

  const parts: ExtractedSource[] = [];
  const provenance: Array<Omit<SourceProvenance, "source_id">> = [];
  const failures: Provenance["failures"] = [];

  for (const raw of inputs) {
    const label = typeof raw === "string" ? raw : raw.uri || "(inline)";
    let kind: SourceKind | undefined = typeof raw === "string" ? undefined : raw.kind;
    try {
      const input: ExtractInput = { ...resolveIngestInput(raw, cwd), projectDir };
      kind = input.kind;
      const extractor = registry[input.kind];
      if (!extractor) throw new Error(`no extractor for kind "${input.kind}" yet`);
      const digest = await inputDigest(extractor, input);
      const inline = input.content !== undefined;
      const key = cacheKey({
        kind: `ingest.${input.kind}`,
        inputDigest: digest,
        extractorVersion: extractor.version,
        // Things besides the bytes that change the output: where the input
        // lives (Source.uri) and the project-relative path used in refs.
        options: inline ? null : { uri: input.uri, ref_base: displayPath(input.uri, projectDir) },
        irSchemaVersion: SCHEMA_VERSION,
      });

      const hit = cache ? await cache.get(key, projectDir) : undefined;
      let part: ExtractedSource;
      let fetchedAt = now;
      if (hit) {
        part = hit.part;
        fetchedAt = hit.entry.fetched_at;
      } else {
        part = await extractor.extract(input);
        await cache?.put(key, part, projectDir, extractor.version, now);
      }
      parts.push(part);
      provenance.push({
        uri: part.source.uri,
        kind: part.source.kind,
        sha256: part.source.sha256,
        ...(part.source.title ? { title: part.source.title } : {}),
        extractor_version: extractor.version,
        fetched_at: fetchedAt,
        cache_hit: hit !== undefined,
        cache_key: key,
      });
    } catch (err) {
      failures.push({ uri: inline(label), ...(kind ? { kind } : {}), error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (parts.length === 0) {
    throw new IngestError(
      `nothing was ingested:\n${failures.map((f) => `  - ${f.uri}: ${f.error}`).join("\n")}`,
      failures,
    );
  }

  const ir = buildContentIR(parts, { now });
  for (const f of failures) {
    ir.warnings.push({ code: "ingest_failed", message: `${f.uri}: ${f.error}` });
  }

  const irPath = join(projectDir, "source", "content-ir.json");
  const provPath = join(projectDir, "source", "provenance.json");
  const prov: Provenance = {
    schema_version: 1,
    ir_id: ir.id,
    ir_schema_version: SCHEMA_VERSION,
    created_at: now,
    sources: provenance.map((p, i) => ({ source_id: ir.sources[i]!.id, ...p })),
    failures,
  };
  await writeJsonAtomic(irPath, ir);
  await writeJsonAtomic(provPath, prov);

  const summary: IngestSummary = {
    ir_path: irPath,
    provenance_path: provPath,
    ir_id: ir.id,
    sources: ir.sources.map((s, i) => ({
      id: s.id,
      kind: s.kind,
      uri: s.uri,
      ...(s.title ? { title: s.title } : {}),
      sections: ir.sections.filter((x) => x.source_id === s.id).length,
      evidence: ir.evidence.filter((x) => x.source_id === s.id).length,
      cache_hit: prov.sources[i]!.cache_hit,
    })),
    sections: ir.sections.length,
    evidence: ir.evidence.length,
    claims: ir.claims.length,
    entities: ir.entities.length,
    assets: ir.assets.length,
    warnings: ir.warnings,
    classification: ir.classification,
  };
  return { summary, ir, provenance: prov };
}

/** Short label for an input in messages: long inline text is abbreviated. */
function inline(label: string): string {
  const oneLine = label.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

/** Human-readable multi-line summary (MCP tool text output). */
export function formatIngestSummary(s: IngestSummary): string {
  const lines = [
    `ContentIR ${s.ir_id} written to ${s.ir_path}`,
    `${s.sources.length} source(s), ${s.sections} sections, ${s.evidence} evidence spans, ${s.claims} claims, ${s.entities} entities, ${s.assets} assets`,
  ];
  for (const src of s.sources) {
    lines.push(
      `  ${src.id} [${src.kind}] ${src.title ? `"${src.title}" ` : ""}${inline(src.uri)} — ${src.sections} sections, ${src.evidence} spans${src.cache_hit ? " (cached)" : ""}`,
    );
  }
  const c = s.classification;
  lines.push(
    `classification: data_class=${c.data_class}, secrets=${c.contains_secrets}, pii=${c.contains_pii}, likeness=${c.contains_likeness}`,
  );
  for (const n of c.notes) lines.push(`  note: ${n}`);
  if (s.warnings.length) {
    lines.push(`warnings (${s.warnings.length}):`);
    for (const w of s.warnings) lines.push(`  ${w.code}${w.source_id ? ` (${w.source_id})` : ""}: ${w.message}`);
  }
  return lines.join("\n");
}
