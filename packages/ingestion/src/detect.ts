import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
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
 * - a path (existing or path-like single token) → by extension, unknown
 *   extensions of existing files → `text`;
 * - anything else is inline content: `markdown` if it has ATX headings or
 *   code fences, else `text`.
 *
 * Throws for an existing directory that does not look like a repository.
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
    if (stat?.isFile()) return byExt ?? "text";
    // Path-like token that does not exist (yet): trust the extension.
    if (byExt && !/\s/.test(path)) return byExt;
  }
  if (/^ {0,3}#{1,6}\s+\S/m.test(input) || /^ {0,3}(```|~~~)/m.test(input)) return "markdown";
  return "text";
}
