import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SourceKind } from "@video-studio/schema";

const EXTENSION_KINDS: Record<string, SourceKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".pptx": "pptx",
  ".md": "markdown",
  ".markdown": "markdown",
  ".mdown": "markdown",
  ".mkd": "markdown",
  ".mdx": "markdown",
  ".txt": "text",
  // A saved web page: extracted like a URL (defuddle/Readability, scripts never run), from disk.
  ".html": "url",
  ".htm": "url",
  ".text": "text",
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".mkv": "video",
  ".m4v": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".m4a": "audio",
  ".aac": "audio",
  ".flac": "audio",
  ".ogg": "audio",
};

/** One line naming every supported input, for error messages. */
export const SUPPORTED_INPUTS =
  "Supported: Markdown (.md .markdown .mdx), plain text (.txt, or another text file such as .json .yaml .csv or source code), " +
  "PDF (.pdf), Word (.docx), PowerPoint (.pptx), a saved web page (.html .htm), video (.mp4 .mov .webm .mkv .m4v), " +
  "audio (.mp3 .wav .m4a .aac .flac .ogg), a repository folder, a folder of clips, an http(s) URL, or inline text.";

/**
 * Extensions of files that are plain text and ingested as kind `text` (after a binary sniff).
 * Files with any other unknown extension are refused rather than guessed at.
 */
const TEXT_EXTENSIONS = new Set([
  ".json", ".jsonl", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".csv", ".tsv", ".log", ".rst", ".adoc",
  ".asciidoc", ".org", ".tex", ".xml", ".srt", ".vtt", ".diff", ".patch",
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts",
  ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".scala", ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".sql", ".graphql", ".proto", ".css", ".scss", ".less", ".vue", ".svelte", ".lua", ".r", ".jl", ".dart", ".ex",
  ".exs", ".erl", ".hs", ".ml", ".clj", ".el", ".vim", ".dockerfile", ".gradle", ".cmake", ".mk",
]);

/** Image files: not a source type yet (the extractors pull images out of PDFs, decks and pages themselves). */
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif", ".svg", ".ico"]);

/** Expand a leading `~` / `~/` to the user's home directory (other `~user` forms are left alone). */
export function expandHome(p: string, home: string = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith(`~${sep}`)) return join(home, p.slice(2));
  return p;
}

/**
 * True when an input looks like a file path rather than inline text, so that a missing file is
 * an error instead of being ingested as its own literal text. A single token (no whitespace,
 * not an http(s) URL) is path-like when it has at least one of
 * - a path separator (`docs/missing.md`, `a\b`), or a leading `~`, `./`, `../` or `file://`;
 * - a file extension: a dot followed by 1–10 characters starting with a letter at the end
 *   (`notes.txt`, `report.PDF`; not `3.14` or `e.g.`).
 * A single line WITH spaces is path-like only when it is an explicit path with an extension:
 * it starts with `/`, `~/`, `./` or `../` (`/Users/me/My Notes.md`). Anything else with
 * whitespace, and anything with a newline (sentences, markdown, pasted content), is inline text.
 * Consequence: a single dotted or slashed word such as `Node.js` or `and/or` is treated as a
 * path; pass it inside a sentence (or as `{uri, content}`) to ingest it as text.
 */
export function isPathLike(input: string): boolean {
  const t = input.trim();
  if (t.length === 0 || t.length >= 4096 || /[\n\r]/.test(t)) return false;
  if (/^https?:\/\//i.test(t)) return false;
  const ext = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;
  if (/\s/.test(t)) return /^(?:\/|~\/|\.{1,2}\/)/.test(t) && ext.test(t);
  if (/^file:\/\//i.test(t)) return true;
  if (/[/\\]/.test(t) || t.startsWith("~")) return true;
  return ext.test(t);
}

/**
 * Why `path` (absolute) is a credential location, or undefined. Ingest refuses these whatever
 * the caller asks, before checking that the file exists: anything under a `.ssh`, `.aws`,
 * `.gnupg`, `.config/gcloud` or `Library/Keychains` folder, and files named `.env` / `.env.*`,
 * `*.pem`, `*.key`, `id_rsa*` / `id_dsa*` / `id_ecdsa*` / `id_ed25519*`, `.netrc` / `_netrc`
 * or `.npmrc` (by name alone: an .npmrc often holds a registry token).
 */
export function credentialReason(path: string): string | undefined {
  const parts = path.split(/[/\\]+/).filter(Boolean);
  const lower = parts.map((x) => x.toLowerCase());
  for (const dir of [".ssh", ".aws", ".gnupg"]) if (lower.slice(0, -1).includes(dir) || lower.at(-1) === dir) return `it is in a ${dir} folder`;
  for (let i = 0; i + 1 < lower.length; i++) {
    if (lower[i] === ".config" && lower[i + 1] === "gcloud") return "it is in .config/gcloud";
    if (lower[i] === "library" && lower[i + 1] === "keychains") return "it is in Library/Keychains";
  }
  const name = (lower.at(-1) ?? "").toLowerCase();
  if (name === ".env" || name.startsWith(".env.")) return "it is a .env file";
  if (/\.(?:pem|key)$/.test(name)) return "it is a key file";
  if (/^id_(?:rsa|dsa|ecdsa|ed25519)/.test(name)) return "it is an SSH key";
  if (name === ".netrc" || name === "_netrc" || name === ".npmrc") return `it is a ${name} file`;
  return undefined;
}

/** Throws "refusing to ingest a credential file" when {@link credentialReason} matches. */
export function assertNotCredential(path: string, label: string = path): void {
  const reason = credentialReason(path);
  if (reason) throw new Error(`refusing to ingest a credential file: ${label} (${reason}); credentials never go into a ContentIR`);
}

/**
 * Why the first bytes of a file say it is not text (a NUL byte, or not valid UTF-8), or
 * undefined for text. Reads at most `bytes` bytes; a multi-byte character cut at the end of the
 * sample is not an error.
 */
export function binaryReason(path: string, bytes = 8192): string | undefined {
  const buf = Buffer.alloc(bytes);
  const fd = openSync(path, "r");
  let n: number;
  try {
    n = readSync(fd, buf, 0, bytes, 0);
  } finally {
    closeSync(fd);
  }
  const head = buf.subarray(0, n);
  if (head.includes(0)) return "it contains NUL bytes";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head, { stream: true });
  } catch {
    return "it is not valid UTF-8 text";
  }
  return undefined;
}

/** Throws a clear error when a file that should be text is binary. */
export function assertTextFile(path: string): void {
  const why = binaryReason(path);
  if (why) throw new Error(`not a text file: ${basename(path)} (${why}). ${SUPPORTED_INPUTS}`);
}

/**
 * Kind of an existing file whose extension is not a known source type: `text` for text
 * extensions and extension-less files that pass the binary sniff; otherwise an error naming
 * the supported types (images get their own message: they are not a source type yet).
 */
function unknownFileKind(path: string): SourceKind {
  const ext = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`images are not a supported source type yet: ${basename(path)}. ${SUPPORTED_INPUTS}`);
  }
  if (ext && !TEXT_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported file type "${ext}": ${basename(path)}. ${SUPPORTED_INPUTS}`);
  }
  assertTextFile(path);
  return "text";
}

/** `https://github.com/<owner>/<repo>` optionally followed by `.git`, `/`, `/tree/<ref>…`. */
const GITHUB_REPO = /^https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?(?:\/(?:tree\/[^?#]*)?)?(?:[?#].*)?$/i;

/** True when `dir` looks like a code repository (has .git, package.json or a README at its root). */
export function isRepoDir(dir: string): boolean {
  if (existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"))) return true;
  try {
    return readdirSync(dir).some((f) => /^readme(?:\.[\w]+)?$/i.test(f));
  } catch {
    return false;
  }
}

/**
 * A folder of clips (not a repository): its top-level video and audio files, sorted by name,
 * or null when `dir` is not such a folder. Lets users ingest "a folder of my clips".
 */
export function mediaFolderFiles(dir: string): string[] | null {
  try {
    if (!statSync(dir).isDirectory() || isRepoDir(dir)) return null;
    const files = readdirSync(dir)
      .filter((f) => !f.startsWith("."))
      .filter((f) => {
        const k = EXTENSION_KINDS[extname(f).toLowerCase()];
        return k === "video" || k === "audio";
      })
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
      .map((f) => join(dir, f));
    return files.length ? files : null;
  } catch {
    return null;
  }
}

/**
 * Guess the SourceKind of an ingest input:
 * - `http(s)://` → `repo` for github.com/<owner>/<repo>, else `url`;
 * - an existing directory with .git / package.json / README → `repo`;
 * - an existing file → by extension; other text extensions (.json, .yaml, source code…) and
 *   extension-less files that pass a NUL-byte / UTF-8 sniff → `text`; images, archives,
 *   executables and other unknown or binary files throw with the list of supported types;
 * - a path-like single token that does not exist → by extension (a guess only:
 *   {@link resolveIngestInput} refuses missing paths);
 * - anything else is inline content: `markdown` if it has ATX headings or
 *   code fences, else `text`.
 *
 * Throws for an existing directory that does not look like a repository, and for existing
 * files of an unsupported type (see above).
 */
export function detectKind(input: string): SourceKind {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed) && !/\s/.test(trimmed)) {
    return GITHUB_REPO.test(trimmed) ? "repo" : "url";
  }
  const isSingleToken = trimmed.length > 0 && trimmed.length < 4096 && !/[\n\r]/.test(trimmed);
  if (isSingleToken) {
    let path = trimmed;
    if (/^file:\/\//i.test(path)) {
      try {
        path = fileURLToPath(path);
      } catch {
        /* keep as-is */
      }
    }
    let stat: ReturnType<typeof statSync> | undefined;
    try {
      stat = existsSync(path) ? statSync(path) : undefined;
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) {
      if (isRepoDir(path)) return "repo";
      throw new Error(`"${path}" is a directory without .git, package.json or README; it is not a recognizable repository`);
    }
    const byExt = EXTENSION_KINDS[extname(path).toLowerCase()];
    if (stat?.isFile()) return byExt ?? unknownFileKind(path);
    // Path-like token that does not exist (yet): trust the extension.
    if (byExt && !/\s/.test(path)) return byExt;
  }
  if (/^ {0,3}#{1,6}\s+\S/m.test(input) || /^ {0,3}(```|~~~)/m.test(input)) return "markdown";
  return "text";
}
