import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { Brand } from "./brand.js";
import { ContentIR } from "./content-ir.js";
import { CreativeBrief } from "./creative-brief.js";
import { PlatformContract } from "./platform-contract.js";
import { Policy } from "./policy.js";
import { RenderManifest } from "./render-manifest.js";
import { ExperimentManifest, ExperimentPlan } from "./experiment.js";
import { DemoScript, FormatGrammar, ShortCandidates } from "./footage.js";
import { TranslationSheet } from "./localization.js";
import { Style } from "./style.js";
import { Template } from "./template.js";
import { VideoLock } from "./video-lock.js";
import { VideoSpec } from "./video-spec.js";

/** Schemas published as `schemas/<name>.schema.json`. */
export const EMITTED_SCHEMAS = {
  "content-ir": ContentIR,
  "creative-brief": CreativeBrief,
  "video-spec": VideoSpec,
  "render-manifest": RenderManifest,
  brand: Brand,
  policy: Policy,
  template: Template,
  "platform-contract": PlatformContract,
  "video-lock": VideoLock,
  style: Style,
  "experiment-plan": ExperimentPlan,
  "experiment-manifest": ExperimentManifest,
  "demo-script": DemoScript,
  "format-grammar": FormatGrammar,
  "short-candidates": ShortCandidates,
  "translation-sheet": TranslationSheet,
} as const satisfies Record<string, z.ZodType>;

export type EmittedSchemaName = keyof typeof EMITTED_SCHEMAS;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const LEADING_KEYS = ["$schema", "$id", "title", "description"];

/** Keys whose values are maps of user-chosen names rather than schema keywords. */
const NAME_MAPS = new Set(["properties", "$defs", "patternProperties", "dependentSchemas"]);

/**
 * Recursively sort object keys for stable, diffable output. Schema objects list
 * `$schema`, `$id`, `title`, `description` first; name maps are purely alphabetical.
 */
function sortKeys(value: Json, isNameMap = false): Json {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v));
  if (value === null || typeof value !== "object") return value;
  const rank = (k: string): number => (isNameMap ? -1 : LEADING_KEYS.indexOf(k));
  const keys = Object.keys(value).sort((a, b) => {
    const ia = rank(a);
    const ib = rank(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const out: { [k: string]: Json } = {};
  for (const k of keys) {
    const child = value[k] as Json;
    out[k] = isNameMap ? sortKeys(child) : sortKeys(child, NAME_MAPS.has(k));
  }
  return out;
}

/** Draft 2020-12 JSON Schema for one canonical object, with the root hoisted out of `$defs`. */
export function toJsonSchema(name: EmittedSchemaName): Record<string, unknown> {
  const raw = z.toJSONSchema(EMITTED_SCHEMAS[name], { target: "draft-2020-12" }) as Record<string, Json>;
  let schema: Record<string, Json> = raw;
  // A schema with a registry `id` is emitted as `{ $ref: "#/$defs/<id>", $defs: {...} }`; inline the root.
  const ref = raw["$ref"];
  const defs = raw["$defs"] as Record<string, Json> | undefined;
  if (typeof ref === "string" && ref.startsWith("#/$defs/") && defs) {
    const id = ref.slice("#/$defs/".length);
    const { [id]: root, ...rest } = defs;
    schema = { ...(root as Record<string, Json>), $schema: raw["$schema"] as Json };
    if (Object.keys(rest).length > 0) schema["$defs"] = rest;
  }
  schema["$id"] = `urn:video-studio:schema:${name}`;
  return sortKeys(schema) as Record<string, unknown>;
}

/** Serialized file contents: pretty-printed with a trailing newline. */
export function renderJsonSchema(name: EmittedSchemaName): string {
  return `${JSON.stringify(toJsonSchema(name), null, 2)}\n`;
}

/** Write every schema to `<outDir>/<name>.schema.json`. Returns written paths. */
export function emitSchemas(outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  return (Object.keys(EMITTED_SCHEMAS) as EmittedSchemaName[]).map((name) => {
    const file = join(outDir, `${name}.schema.json`);
    writeFileSync(file, renderJsonSchema(name));
    return file;
  });
}

/** Repo root, resolved from this file (works from `src/` and `dist/`). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const file of emitSchemas(join(REPO_ROOT, "schemas"))) console.log(`wrote ${file}`);
}
