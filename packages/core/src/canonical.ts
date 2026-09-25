import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** Thrown when a value cannot be represented in canonical JSON. */
export class CanonicalJsonError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${message} at ${path || "<root>"}`);
    this.name = "CanonicalJsonError";
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encode(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number (${value})`, path);
      return JSON.stringify(value); // -0 serializes as 0
    case "undefined":
      throw new CanonicalJsonError("undefined is not allowed", path);
    case "function":
      throw new CanonicalJsonError("functions are not allowed", path);
    case "bigint":
      throw new CanonicalJsonError("bigint is not allowed", path);
    case "symbol":
      throw new CanonicalJsonError("symbols are not allowed", path);
  }
  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalJsonError("circular reference", path);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        // Holes in sparse arrays are undefined and therefore rejected.
        parts.push(encode(obj[i], `${path}[${i}]`, seen));
      }
      return `[${parts.join(",")}]`;
    }
    if (!isPlainObject(obj)) {
      const name = (obj as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
      throw new CanonicalJsonError(`non-plain object (${name}) is not allowed`, path);
    }
    const record = obj as Record<string, unknown>;
    // Default sort compares UTF-16 code units: deterministic and locale-independent.
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${encode(record[k], path ? `${path}.${k}` : k, seen)}`,
    );
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace.
 * Rejects undefined, functions, bigint, symbols, NaN/Infinity, non-plain objects
 * (Date, Map, class instances...) and cycles, so equal inputs always hash equally.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "", new Set());
}

/** Hex sha256 of a string (UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Streaming hex sha256 of a file's contents. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export interface CacheKeyInput {
  /** Kind of derived artifact, e.g. "ingest.url", "tts.elevenlabs". */
  kind: string;
  /** Digest of the input content (usually sha256 hex). */
  inputDigest: string;
  /** Version of the code producing the artifact; bump to invalidate. */
  extractorVersion: string;
  /** Options affecting the output. Must be canonical-JSON serializable. */
  options?: unknown;
  /** Version of the IR schema the output conforms to. */
  irSchemaVersion: string | number;
}

/** sha256 over the canonical JSON of the cache-key fields. */
export function cacheKey(input: CacheKeyInput): string {
  return sha256Hex(
    canonicalJson({
      kind: input.kind,
      inputDigest: input.inputDigest,
      extractorVersion: input.extractorVersion,
      options: input.options ?? null,
      irSchemaVersion: input.irSchemaVersion,
    }),
  );
}
