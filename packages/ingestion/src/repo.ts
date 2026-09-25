import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, extname, join, posix, resolve } from "node:path";
import { lintSource } from "@secretlint/core";
import { creator as secretlintPresetRecommend } from "@secretlint/secretlint-rule-preset-recommend";
import { searchFiles } from "repomix";
import type { EvidenceSpan, Section } from "@video-studio/schema";
import { classifyText } from "./classify.js";
import { markdownToParts, parseMarkdown } from "./markdown.js";
import { repoRef } from "./refs.js";
import type { ExtractInput, ExtractedSource, Extractor } from "./types.js";

/**
 * Repository extractor (kind "repo").
 *
 * Security model — the repository is untrusted data:
 * - Files are only ever *read*. Nothing from the repo is executed, imported,
 *   installed or evaluated: no package scripts, no git hooks, no config files.
 * - repomix is used only for its file search (`searchFiles`), which honours
 *   .gitignore / .ignore / .repomixignore and repomix's default ignore list.
 *   We pass an explicit in-memory config and never call repomix's config
 *   loader (`loadFileConfig`, which evaluates `repomix.config.{js,ts,…}` from
 *   the target directory via jiti) nor its CLI/pack pipeline.
 * - secretlint runs through `@secretlint/core` with the recommend preset
 *   passed as an in-memory rule, so no `.secretlintrc*` from the repo is
 *   loaded and no rule/formatter package is resolved at runtime.
 * - Symlinks are skipped; paths are confined to the repo root.
 */

export const REPO_EXTRACTOR_VERSION = "repo-1";
export const REPO_MAX_TOTAL_BYTES = 400 * 1024;
export const REPO_MAX_FILE_BYTES = 64 * 1024;
/** Files above this size are digested by size+mtime instead of content. */
const DIGEST_FULL_HASH_LIMIT = 1024 * 1024;
const MAX_CANDIDATES = 20_000;
const CHUNK_MAX_LINES = 40;

export type FetchRepo = (url: string) => Promise<string>;

export interface RepoExtractorOptions {
  /**
   * Materialize a remote repository (e.g. `https://github.com/o/r`) as a local
   * directory and return its path. Without it, remote repos are rejected: the
   * user must clone locally first. Implementations must not run repo code
   * (plain `git clone --depth 1 --no-recurse-submodules` without hooks is fine).
   */
  fetchRepo?: FetchRepo;
  maxTotalBytes?: number;
  maxFileBytes?: number;
}

export const REMOTE_REPO_ERROR =
  "remote repositories are not fetched automatically: clone the repo locally first (e.g. `git clone --depth 1 <url>`) and ingest the local directory";

// ---------------------------------------------------------------------------
// File selection

const MANIFESTS = new Set([
  "package.json", "pyproject.toml", "setup.cfg", "setup.py", "cargo.toml", "go.mod", "composer.json",
  "gemfile", "pom.xml", "build.gradle", "build.gradle.kts", "deno.json", "mix.exs", "pubspec.yaml",
]);
const LOCKFILES = [
  "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/bun.lockb", "**/Cargo.lock",
  "**/poetry.lock", "**/composer.lock", "**/Gemfile.lock", "**/go.sum", "**/*.min.js", "**/*.map",
];
const DOC_EXT = new Set([".md", ".markdown", ".mdx", ".rst", ".txt", ".adoc"]);
const MARKDOWN_EXT = new Set([".md", ".markdown", ".mdx"]);
const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".kts", ".scala", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".lua", ".sh", ".bash",
  ".zsh", ".ps1", ".r", ".jl", ".ex", ".exs", ".erl", ".hs", ".ml", ".clj", ".dart", ".vue", ".svelte",
  ".sql", ".graphql", ".proto", ".css", ".scss", ".html", ".json", ".jsonc", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".conf", ".env", ".xml", ".gradle", ".tf", ".nix", ".zig",
]);
const TEXT_BASENAMES = new Set(["dockerfile", "makefile", "license", "licence", "notice", "contributing", "authors"]);

/** Priority tier of a repo-relative path; undefined means "not collected". */
export function repoFileTier(relPath: string): number | undefined {
  const p = relPath.toLowerCase();
  const base = posix.basename(p);
  const ext = posix.extname(p);
  const depth = p.split("/").length - 1;
  const isDoc = DOC_EXT.has(ext) || ext === "";
  if (depth === 0 && /^readme(\.|$)/.test(base)) return 0;
  if (/^docs?\//.test(p) && DOC_EXT.has(ext)) return 1;
  if (depth === 0 && /^(changelog|changes|history|releases)(\.|$)/.test(base) && isDoc) return 2;
  if (/^examples?\//.test(p) && (DOC_EXT.has(ext) || SOURCE_EXT.has(ext))) return 3;
  if (MANIFESTS.has(base)) return depth === 0 ? 4 : 6;
  if (DOC_EXT.has(ext) && ext !== "") return 5;
  if (SOURCE_EXT.has(ext) || TEXT_BASENAMES.has(base)) return 6;
  return undefined;
}

// Note: repomix's logger writes debug/info to console.log; searchFiles only
// logs at debug/trace level, and the MCP entry point routes console.log to
// stderr, so it cannot corrupt the stdio transport.

/**
 * repomix's `searchFiles` takes a fully merged config. We build it here instead
 * of calling `loadFileConfig`, so a `repomix.config.*` in the repo is never read,
 * let alone evaluated. Only the fields `searchFiles` reads are meaningful.
 */
function searchConfig(root: string): Parameters<typeof searchFiles>[1] {
  return {
    cwd: root,
    include: [],
    ignore: { useGitignore: true, useDotIgnore: true, useDefaultPatterns: true, customPatterns: LOCKFILES },
    output: { includeEmptyDirectories: false, filePath: undefined },
  } as unknown as Parameters<typeof searchFiles>[1];
}

interface Candidate {
  path: string;
  tier: number;
}

/** Repo-relative POSIX paths of collectable files, in priority order. */
export async function listRepoFiles(root: string): Promise<Candidate[]> {
  const { filePaths } = await searchFiles(root, searchConfig(root), undefined, true);
  const out: Candidate[] = [];
  for (const raw of filePaths) {
    const path = raw.split("\\").join("/");
    const tier = repoFileTier(path);
    if (tier !== undefined) out.push({ path, tier });
    if (out.length >= MAX_CANDIDATES) break;
  }
  const depth = (p: string) => p.split("/").length;
  return out.sort((a, b) => a.tier - b.tier || depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Read at most `limit + 1` bytes of a regular, non-symlink file inside `root`. */
async function readCapped(root: string, rel: string, limit: number): Promise<{ bytes: Buffer; size: number } | undefined> {
  const abs = join(root, rel);
  const st = await lstat(abs).catch(() => undefined);
  if (!st || !st.isFile()) return undefined; // symlinks, sockets, vanished files
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(Math.min(st.size, limit + 1));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return { bytes: buf.subarray(0, bytesRead), size: st.size };
  } finally {
    await fh.close();
  }
}

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/**
 * Stable digest of a repo's collectable files: sha256 over `path\0sha256\n`
 * lines (size+mtime for files over 1 MB). Used as Source.sha256 and cache key.
 */
export async function repoDigest(dir: string): Promise<string> {
  const root = await realpath(resolve(dir));
  const files = await listRepoFiles(root);
  const sorted = files.map((f) => f.path).sort();
  const h = createHash("sha256");
  for (const rel of sorted) {
    const st = await lstat(join(root, rel)).catch(() => undefined);
    if (!st?.isFile()) continue;
    let d: string;
    if (st.size > DIGEST_FULL_HASH_LIMIT) d = `size:${st.size}:mtime:${Math.floor(st.mtimeMs)}`;
    else {
      const r = await readCapped(root, rel, DIGEST_FULL_HASH_LIMIT);
      d = createHash("sha256").update(r?.bytes ?? Buffer.alloc(0)).digest("hex");
    }
    h.update(`${rel}\0${d}\n`);
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Secret scanning

export interface SecretFinding {
  rule: string;
  line?: number;
}

const SECRETLINT_CONFIG = {
  rules: [{ id: "@secretlint/secretlint-rule-preset-recommend", rule: secretlintPresetRecommend }],
} as unknown as Parameters<typeof lintSource>[0]["options"]["config"];

/**
 * Secret findings for one file: secretlint (recommend preset) plus the
 * heuristic secret patterns from classify.ts. Only rule ids and line numbers
 * are returned, never the matched value.
 */
export async function scanFileForSecrets(relPath: string, content: string): Promise<SecretFinding[]> {
  const out: SecretFinding[] = [];
  const result = await lintSource({
    source: { filePath: relPath, content, ext: extname(relPath), contentType: "text" },
    options: { config: SECRETLINT_CONFIG, maskSecrets: true, noPhysicFilePath: true },
  });
  for (const m of result.messages) {
    out.push({ rule: m.ruleId, ...(m.loc?.start?.line ? { line: m.loc.start.line } : {}) });
  }
  for (const f of classifyText(content).findings) {
    if (f.category === "secret") out.push({ rule: `classify:${f.type}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parts

type PartialSection = Omit<Section, "id" | "source_id">;
type PartialSpan = Omit<EvidenceSpan, "source_id">;

/** Split a non-markdown file into blank-line-separated chunks of at most 40 lines. */
function codeChunks(text: string): Array<{ start: number; end: number }> {
  const lines = text.split("\n");
  const blocks: Array<{ start: number; end: number }> = [];
  let cur: { start: number; end: number } | undefined;
  lines.forEach((l, i) => {
    if (l.trim() === "") {
      cur = undefined;
      return;
    }
    if (!cur) blocks.push((cur = { start: i, end: i }));
    else cur.end = i;
  });
  const out: Array<{ start: number; end: number }> = [];
  let chunk: { start: number; end: number } | undefined;
  for (const b of blocks) {
    if (chunk && b.end - chunk.start < CHUNK_MAX_LINES) {
      chunk.end = b.end; // merge small neighbouring blocks (keeps the blank lines between them)
      continue;
    }
    for (let s = b.start; s <= b.end; s += CHUNK_MAX_LINES) {
      out.push((chunk = { start: s, end: Math.min(b.end, s + CHUNK_MAX_LINES - 1) }));
    }
  }
  return out;
}

function fileParts(relPath: string, text: string): { sections: PartialSection[]; evidence: PartialSpan[] } {
  if (MARKDOWN_EXT.has(posix.extname(relPath).toLowerCase())) {
    const parsed = parseMarkdown(text);
    const { sections, evidence } = markdownToParts(parsed, (b) => repoRef(relPath, b.lineStart, b.lineEnd));
    return {
      sections: sections.map((s) => ({ ...s, heading: s.heading ? `${relPath} › ${s.heading}` : relPath })),
      evidence,
    };
  }
  const lines = text.split("\n");
  const evidence: PartialSpan[] = codeChunks(text).map(({ start, end }) => ({
    ref: repoRef(relPath, start + 1, end + 1),
    text: lines.slice(start, end + 1).join("\n"),
    locator: { line_start: start + 1, line_end: end + 1 },
  }));
  const body = text.trim();
  return { sections: body ? [{ heading: relPath, text: body }] : [], evidence };
}

function decode(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** Truncate at the last newline within `limit` bytes. */
function truncateText(bytes: Buffer, limit: number): Buffer {
  const cut = bytes.subarray(0, limit);
  const nl = cut.lastIndexOf(10);
  return nl > 0 ? cut.subarray(0, nl) : cut;
}

function repoTitle(root: string, files: Map<string, string>): string {
  const pkg = files.get("package.json");
  if (pkg) {
    try {
      const name = (JSON.parse(pkg) as { name?: unknown }).name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      /* not JSON */
    }
  }
  for (const [p, text] of files) {
    if (/^readme\.(md|markdown|mdx)$/i.test(p)) {
      const t = parseMarkdown(text).title;
      if (t) return t;
    }
  }
  return basename(root);
}

const isRemote = (uri: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(uri) && !/^file:\/\//i.test(uri);

export function createRepoExtractor(options: RepoExtractorOptions = {}): Extractor {
  const maxTotal = options.maxTotalBytes ?? REPO_MAX_TOTAL_BYTES;
  const maxFile = options.maxFileBytes ?? REPO_MAX_FILE_BYTES;

  async function localRoot(uri: string): Promise<string> {
    if (isRemote(uri)) {
      if (!options.fetchRepo) throw new Error(`${uri}: ${REMOTE_REPO_ERROR}`);
      return realpath(resolve(await options.fetchRepo(uri)));
    }
    const path = /^file:\/\//i.test(uri) ? new URL(uri).pathname : uri;
    return realpath(resolve(path));
  }

  return {
    version: REPO_EXTRACTOR_VERSION,
    kinds: ["repo"],
    async inputDigest(input: ExtractInput): Promise<string> {
      return repoDigest(await localRoot(input.uri));
    },
    async extract(input: ExtractInput): Promise<ExtractedSource> {
      const root = await localRoot(input.uri);
      const candidates = await listRepoFiles(root);
      const sha256 = await repoDigest(root);

      const sections: PartialSection[] = [];
      const evidence: PartialSpan[] = [];
      const warnings: ExtractedSource["warnings"] = [];
      const secretNotes: string[] = [];
      const included = new Map<string, string>();
      let total = 0;
      let omitted = 0;
      let skippedBinary = 0;

      for (const { path } of candidates) {
        if (total >= maxTotal) {
          omitted++;
          continue;
        }
        const read = await readCapped(root, path, maxFile);
        if (!read) continue;
        if (looksBinary(read.bytes)) {
          skippedBinary++;
          continue;
        }
        let bytes = read.bytes;
        if (read.size > maxFile) {
          bytes = truncateText(bytes, maxFile);
          warnings.push({
            code: "file_truncated",
            message: `${path} is ${read.size} bytes; only the first ${bytes.length} bytes were extracted (per-file limit ${maxFile})`,
          });
        }
        if (total + bytes.length > maxTotal) {
          omitted++;
          total = maxTotal; // budget exhausted: keep priority order, do not back-fill with smaller files
          continue;
        }
        const text = decode(bytes);
        const findings = await scanFileForSecrets(path, text);
        if (findings.length > 0) {
          const rules = [...new Set(findings.map((f) => f.rule))].sort();
          warnings.push({
            code: "secret_excluded",
            message: `${path} was excluded from the content because it appears to contain a secret (rules: ${rules.join(", ")})`,
          });
          secretNotes.push(`secret-bearing file excluded: ${path} (${rules.join(", ")})`);
          continue;
        }
        total += bytes.length;
        included.set(path, text);
        const parts = fileParts(path, text);
        sections.push(...parts.sections);
        evidence.push(...parts.evidence);
      }

      if (omitted > 0) {
        warnings.push({
          code: "repo_truncated",
          message: `${omitted} lower-priority file(s) were not extracted: the repo text budget of ${maxTotal} bytes was reached`,
        });
      }
      if (skippedBinary > 0) {
        warnings.push({ code: "binary_skipped", message: `${skippedBinary} binary file(s) were skipped` });
      }
      if (evidence.length === 0) warnings.push({ code: "empty_source", message: "No readable text files were found in the repository." });

      return {
        source: { kind: "repo", uri: input.uri, sha256, title: repoTitle(root, included) },
        sections,
        evidence,
        assets: [],
        warnings,
        ...(secretNotes.length ? { classificationHints: { contains_secrets: true, notes: secretNotes } } : {}),
      };
    },
  };
}

/** Default repo extractor: local directories only. */
export const repoExtractor: Extractor = createRepoExtractor();
