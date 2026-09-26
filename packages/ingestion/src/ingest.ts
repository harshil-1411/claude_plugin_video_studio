import { existsSync, realpathSync, statSync } from "node:fs";
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
  ContentIR as ContentIRSchema,
  SCHEMA_VERSION,
  formatIssues,
  type Classification,
  type ContentIR,
  type IrWarning,
  type Source,
  type SourceKind,
} from "@video-studio/schema";
import { buildContentIR, mergeContentIR } from "./builder.js";
import { assertNotCredential, assertTextFile, detectKind, expandHome, isPathLike, mediaFolderFiles } from "./detect.js";
import { type ExtractorRegistry, createExtractors } from "./extractors.js";
import { displayPath } from "./refs.js";
import type { FetchRepo } from "./repo.js";
import type { ExtractInput, ExtractedSource, Extractor } from "./types.js";
import { type FetchImpl, UrlFetchError } from "./url.js";
import { type LookupFn, allowPrivateUrls } from "./net-guard.js";
import { redactPart } from "./redact.js";

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
  /**
   * Environment (default process.env). `VS_ALLOW_PRIVATE_URLS=1` here, set by the USER, lets URL
   * ingest fetch loopback/private/link-local hosts; it is never a tool argument.
   */
  env?: Record<string, string | undefined>;
  fetch?: FetchImpl;
  /** Host resolver for the URL SSRF guard (tests inject one); default DNS. */
  lookup?: LookupFn;
  fetchRepo?: FetchRepo;
  /** Replace or extend extractors (tests). */
  extractors?: ExtractorRegistry;
  /**
   * Start fresh: write a ContentIR (and provenance) holding only this call's inputs, discarding
   * what an earlier ingest, transcribe or demo put in `source/content-ir.json`. By default
   * (false) ingest MERGES into an existing ContentIR; see {@link ingest}.
   */
  replace?: boolean;
  /** Preferred subtitle language for video URLs (default en; English is always requested too). */
  subtitleLanguage?: string;
  /** Cancels downloads and media probing. */
  signal?: AbortSignal;
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
  /** Video URL sources: URL, final URL, bytes, platform metadata (the downloaded file's sha256 is `sha256`). */
  remote?: Source["remote"];
}

export interface Provenance {
  schema_version: 1;
  ir_id: string;
  ir_schema_version: string;
  created_at: string;
  /** Time of the last merge into this ContentIR (absent until the first merge). */
  updated_at?: string;
  sources: SourceProvenance[];
  failures: Array<{ uri: string; kind?: SourceKind; error: string }>;
}

export interface IngestSummary {
  ir_path: string;
  provenance_path: string;
  ir_id: string;
  /**
   * `created`: no ContentIR existed; `merged`: this call's sources were added to (or refreshed
   * in) an existing one; `replaced`: `replace: true` discarded an existing one.
   */
  mode: "created" | "merged" | "replaced";
  /** The sources ingested by THIS call (counts below are for the whole ContentIR). */
  sources: Array<{
    id: string;
    kind: SourceKind;
    uri: string;
    title?: string;
    sections: number;
    evidence: number;
    cache_hit: boolean;
    /** `added` as a new source, or `updated` in place (same id) because it was ingested before. */
    status: "added" | "updated";
  }>;
  /** Sources in the whole ContentIR (earlier ones included). */
  total_sources: number;
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

/**
 * Normalize a raw input into an ExtractInput (absolute paths, inline content detected).
 *
 * Refuses, with a clear error:
 * - credential locations ({@link credentialReason}: `~/.ssh`, `~/.aws`, `.env`, `*.pem`, …),
 *   whatever kind the caller asks for, checked on the path as given and on its real path;
 * - a path-like input ({@link isPathLike}: `notes.txt`, `docs/missing.md`, `~/file.pdf`) that
 *   does not exist: `file not found: notes.txt (resolved to /abs/notes.txt)`. It is never
 *   ingested as its own literal text. Real inline text (sentences, markdown) still is;
 * - images, archives, executables and other binary or unknown files (see {@link detectKind}),
 *   and text/markdown files that fail the NUL-byte / UTF-8 sniff.
 * A leading `~/` is expanded to the home directory.
 */
export function resolveIngestInput(raw: string | IngestInput, cwd: string): ExtractInput {
  const item: IngestInput = typeof raw === "string" ? { uri: raw } : raw;
  if (item.content !== undefined) {
    const kind = item.kind ?? detectKind(item.content);
    if (!INLINE_KINDS.has(kind)) throw new Error(`inline content must be text or markdown, got kind "${kind}"`);
    return { uri: item.uri || item.content, kind, content: item.content };
  }
  let uri = item.uri;
  if (/^file:\/\//i.test(uri)) uri = fileURLToPath(uri);
  const trimmed = uri.trim();
  const isUrl = /^https?:\/\//i.test(trimmed) && !/\s/.test(trimmed);
  if (isUrl) {
    const kind = item.kind ?? detectKind(trimmed);
    if (kind === "url" || kind === "repo" || kind === "video_url") return { uri: trimmed, kind };
    throw new Error(`a ${kind} input must be a local file, got a URL: ${trimmed}`);
  }
  const singleLine = !/[\n\r]/.test(uri) && uri.length < 4096;
  const candidatePath = singleLine ? resolve(cwd, expandHome(trimmed)) : undefined;
  if (candidatePath) assertNotCredential(candidatePath, trimmed);
  const pathExists = candidatePath !== undefined && existsSync(candidatePath);
  if (!pathExists) {
    if (candidatePath && isPathLike(trimmed)) throw new Error(`file not found: ${trimmed} (resolved to ${candidatePath})`);
    const kind = item.kind ?? detectKind(uri);
    if (INLINE_KINDS.has(kind)) return { uri, kind, content: uri }; // inline text
    throw new Error(`file not found: ${trimmed}${candidatePath ? ` (resolved to ${candidatePath})` : ""}`);
  }
  try {
    assertNotCredential(realpathSync(candidatePath), trimmed); // a symlink into ~/.ssh
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("refusing")) throw err;
  }
  const kind = item.kind ?? detectKind(candidatePath);
  if (kind === "video_url") throw new Error(`a video_url input must be an http(s) URL, got a local path: ${trimmed} (ingest the file directly)`);
  if (INLINE_KINDS.has(kind) && isExistingFile(candidatePath)) assertTextFile(candidatePath);
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
      for (const a of [...(part.assets ?? []), ...(part.files ?? [])]) {
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
      for (const a of [...part.assets, ...(part.files ?? [])]) await this.store.put(join(projectDir, a.path));
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

/** The existing ContentIR at `irPath`, undefined when there is none; throws when it is invalid. */
async function loadExistingIr(irPath: string): Promise<ContentIR | undefined> {
  if (!existsSync(irPath)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(await readFile(irPath, "utf8"));
  } catch (err) {
    throw new Error(`source/content-ir.json exists but is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it, or ingest with replace: true to start over`);
  }
  const r = ContentIRSchema.safeParse(data);
  if (!r.success) {
    const issues = formatIssues(r.error).slice(0, 3).map((i) => `${i.path || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`source/content-ir.json exists but is not a valid ContentIR (${issues}); fix it, or ingest with replace: true to start over`);
  }
  return r.data;
}

/** The existing provenance when it belongs to `irId`; anything else is ignored (it is rebuilt). */
async function loadExistingProvenance(path: string, irId: string): Promise<Provenance | undefined> {
  try {
    const p = JSON.parse(await readFile(path, "utf8")) as Provenance;
    return p && p.ir_id === irId && Array.isArray(p.sources) && Array.isArray(p.failures) ? p : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ingest inputs into `<projectDir>/source/content-ir.json`:
 * detect kind → (cache | extractor) → build or merge the ContentIR → atomic writes of the IR
 * and `source/provenance.json`. Inputs that fail are reported as `ingest_failed` warnings; if
 * every input fails an {@link IngestError} is thrown and nothing is written.
 *
 * Re-ingest MERGES (the plan skill ingests again when the user adds sources): when a valid
 * ContentIR already exists, earlier sources, evidence, claims, assets and whatever transcribe /
 * demo / tighten added are kept with their ids and refs, new sources are appended, and a source
 * ingested before (same sha256, or same uri and kind) is refreshed in place under its id
 * ({@link mergeContentIR}). The IR id stays the same; provenance entries are appended (a
 * refreshed source's entry is replaced) and failures accumulate. An existing but invalid
 * ContentIR is an error rather than being overwritten. `replace: true` restores the old
 * behaviour: a fresh ContentIR with only this call's inputs. With no existing ContentIR the
 * output is exactly {@link buildContentIR}'s.
 */
export async function ingest(inputs: ReadonlyArray<string | IngestInput>, options: IngestOptions): Promise<IngestResult> {
  if (inputs.length === 0) throw new Error("ingest: at least one input is required");
  const projectDir = resolve(options.projectDir);
  const cwd = options.cwd ?? process.cwd();
  const irPath = join(projectDir, "source", "content-ir.json");
  const provPath = join(projectDir, "source", "provenance.json");
  // Fail before extracting anything when the existing IR cannot be merged into.
  const existing = options.replace ? undefined : await loadExistingIr(irPath);
  const replacing = options.replace === true && existsSync(irPath);
  // A folder of clips (not a repository) stands for its video and audio files.
  inputs = inputs.flatMap((raw): Array<string | IngestInput> => (typeof raw === "string" ? (mediaFolderFiles(resolve(cwd, expandHome(raw.trim()))) ?? [raw]) : [raw]));
  const now = toIso(options.now);
  const allowPrivate = allowPrivateUrls(options.env ?? process.env);
  const urlOptions = {
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(allowPrivate ? { allowPrivateAddresses: true } : {}),
  };
  const registry: ExtractorRegistry = {
    ...createExtractors({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.fetchRepo ? { fetchRepo: options.fetchRepo } : {}),
      ...(Object.keys(urlOptions).length ? { url: urlOptions } : {}),
      videoUrl: {
        env: options.env ?? process.env,
        ...(options.lookup ? { lookup: options.lookup } : {}),
        ...(allowPrivate ? { allowPrivateAddresses: true } : {}),
        ...(options.subtitleLanguage ? { subtitleLanguage: options.subtitleLanguage } : {}),
      },
    }),
    ...options.extractors,
  };
  const cache = options.noCache
    ? undefined
    : new ExtractionCache(options.cacheDir ?? resolveDataDir(options.env ?? process.env).cache);

  /** Cache lookup or extraction of one resolved input (secrets redacted before anything is persisted). */
  const extractOne = async (input: ExtractInput) => {
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
    const cached = cache ? await cache.get(key, projectDir) : undefined;
    let part: ExtractedSource;
    let fetchedAt = now;
    if (cached) {
      // Entries written before redaction existed may hold secrets: redact them too (a no-op
      // for entries that are already redacted).
      part = await redactPart(cached.part);
      fetchedAt = cached.entry.fetched_at;
      if (part !== cached.part) await cache?.put(key, part, projectDir, extractor.version, fetchedAt);
    } else {
      part = await redactPart(await extractor.extract(input));
      await cache?.put(key, part, projectDir, extractor.version, now);
    }
    return { part, extractor, key, hit: cached !== undefined, fetchedAt };
  };

  const parts: ExtractedSource[] = [];
  const provenance: Array<Omit<SourceProvenance, "source_id">> = [];
  const failures: Provenance["failures"] = [];

  for (const raw of inputs) {
    const label = typeof raw === "string" ? raw : raw.uri || "(inline)";
    let kind: SourceKind | undefined = typeof raw === "string" ? undefined : raw.kind;
    try {
      const resolved: ExtractInput = { ...resolveIngestInput(raw, cwd), projectDir, ...(options.signal ? { signal: options.signal } : {}) };
      kind = resolved.kind;
      let one: Awaited<ReturnType<typeof extractOne>>;
      try {
        one = await extractOne(resolved);
      } catch (err) {
        // A URL that serves video/audio (no telltale extension) is a video URL: download it.
        const explicit = typeof raw !== "string" && raw.kind !== undefined;
        if (!explicit && resolved.kind === "url" && err instanceof UrlFetchError && err.code === "unsupported_content_type" && /^(?:video|audio)\//.test(err.mediaType ?? "")) {
          kind = "video_url";
          one = await extractOne({ ...resolved, kind: "video_url" });
        } else throw err;
      }
      const { part, extractor, key, hit, fetchedAt } = one;
      parts.push(part);
      provenance.push({
        uri: part.source.uri,
        kind: part.source.kind,
        sha256: part.source.sha256,
        ...(part.source.title ? { title: part.source.title } : {}),
        extractor_version: extractor.version,
        fetched_at: fetchedAt,
        cache_hit: hit,
        cache_key: key,
        ...(part.source.remote ? { remote: part.source.remote } : {}),
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

  let ir: ContentIR;
  let placed: Array<{ source_id: string; status: "added" | "updated" }>;
  if (existing) {
    ({ ir, placed } = mergeContentIR(existing, parts));
    // A retried input's earlier failure is stale: this call reports it afresh if it fails again.
    const retried = new Set(inputs.map((raw) => inline(typeof raw === "string" ? raw : raw.uri || "(inline)")));
    ir.warnings = ir.warnings.filter((w) => !(w.code === "ingest_failed" && [...retried].some((l) => w.message.startsWith(`${l}: `))));
  } else {
    ir = buildContentIR(parts, { now });
    placed = ir.sources.map((s) => ({ source_id: s.id, status: "added" as const }));
  }
  for (const f of failures) {
    ir.warnings.push({ code: "ingest_failed", message: `${f.uri}: ${f.error}` });
  }

  const fresh: SourceProvenance[] = provenance.map((p, i) => ({ source_id: placed[i]!.source_id, ...p }));
  const previous = existing ? await loadExistingProvenance(provPath, existing.id) : undefined;
  const touched = new Set(fresh.map((p) => p.source_id));
  const prov: Provenance = existing
    ? {
        schema_version: 1,
        ir_id: ir.id,
        ir_schema_version: SCHEMA_VERSION,
        created_at: previous?.created_at ?? existing.created_at,
        updated_at: now,
        sources: lastPerSource([
          ...(previous?.sources ?? []).filter((p) => !touched.has(p.source_id) && ir.sources.some((s) => s.id === p.source_id)),
          ...fresh,
        ]),
        failures: [...(previous?.failures ?? []), ...failures],
      }
    : {
        schema_version: 1,
        ir_id: ir.id,
        ir_schema_version: SCHEMA_VERSION,
        created_at: now,
        sources: fresh,
        failures,
      };
  await writeJsonAtomic(irPath, ir);
  await writeJsonAtomic(provPath, prov);

  const summary: IngestSummary = {
    ir_path: irPath,
    provenance_path: provPath,
    ir_id: ir.id,
    mode: existing ? "merged" : replacing ? "replaced" : "created",
    sources: fresh.map((p, i) => {
      const s = ir.sources.find((x) => x.id === p.source_id)!;
      return {
        id: s.id,
        kind: s.kind,
        uri: s.uri,
        ...(s.title ? { title: s.title } : {}),
        sections: ir.sections.filter((x) => x.source_id === s.id).length,
        evidence: ir.evidence.filter((x) => x.source_id === s.id).length,
        cache_hit: p.cache_hit,
        status: placed[i]!.status,
      };
    }),
    total_sources: ir.sources.length,
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

/** One provenance entry per source id: the last one wins (a file given twice in one call). */
function lastPerSource(list: readonly SourceProvenance[]): SourceProvenance[] {
  const by = new Map<string, SourceProvenance>();
  for (const p of list) {
    by.delete(p.source_id);
    by.set(p.source_id, p);
  }
  return [...by.values()];
}

/** Short label for an input in messages: long inline text is abbreviated. */
function inline(label: string): string {
  const oneLine = label.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine;
}

/** Human-readable multi-line summary (MCP tool text output). */
export function formatIngestSummary(s: IngestSummary): string {
  const lines = [
    `ContentIR ${s.ir_id} ${s.mode === "merged" ? "updated (merged into the existing one)" : s.mode === "replaced" ? "replaced (earlier sources discarded)" : "written"} to ${s.ir_path}`,
    `${s.sources.length} source(s) ingested now, ${s.total_sources} in total; ${s.sections} sections, ${s.evidence} evidence spans, ${s.claims} claims, ${s.entities} entities, ${s.assets} assets`,
  ];
  for (const src of s.sources) {
    lines.push(
      `  ${src.id}${src.status === "updated" ? " (updated in place)" : ""} [${src.kind}] ${src.title ? `"${src.title}" ` : ""}${inline(src.uri)} — ${src.sections} sections, ${src.evidence} spans${src.cache_hit ? " (cached)" : ""}`,
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
