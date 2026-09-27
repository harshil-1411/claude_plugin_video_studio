import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CompiledPrompt, compile, findProviderSpecsDir, loadProviderSpecs } from "@video-studio/prompts";
import { type ProviderFamily, ProviderFamily as ProviderFamilySchema, type ProviderSpec, type Scene, VideoSpec, hasCredential, parseYamlOrJson } from "@video-studio/schema";
import { projectSpecPaths } from "./spec-validate.js";

/**
 * prompt_pack: compile every shot card of a project into each provider family's prompt syntax and
 * write a prompt package under <project>/prompts/. Offline and free: no provider is called, nothing
 * is generated, no credential value is read (only whether one is set). Paid generation is Phase 7.
 */

export const PROMPT_PACK_BANNER = "Prompt package (no generation, no spend)";

export interface PromptPackOptions {
  /** Families to compile for; default all. */
  families?: readonly ProviderFamily[];
  /** Limit to these scene ids. */
  scenes?: readonly string[];
  /** Only used to report whether each credential is set (never its value). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Default: the bundled provider-specs/. */
  providerSpecsDir?: string | null;
}

export interface PackCredential {
  via: string;
  env: string;
  /** Whether the env var holds a value; the value itself is never read into the pack. */
  set: boolean;
}

export interface PackSceneEntry {
  scene_id: string;
  model?: string;
  mode: string;
  md: string;
  json: string;
  warnings: number;
}

export interface PackFamily {
  family: ProviderFamily;
  name: string;
  verified: boolean;
  verified_on: string;
  credentials: PackCredential[];
  scenes: PackSceneEntry[];
}

export interface PromptPackResult {
  ok: true;
  kind: "prompt_package";
  generated: false;
  spend_usd: 0;
  project_dir: string;
  dir: string;
  readme: string;
  families: PackFamily[];
  scenes: string[];
  warnings: number;
}

function shotScenes(scenes: readonly Scene[], only?: readonly string[]): Scene[] {
  const withShot = scenes.filter((s) => s.shot && (s.visual_strategy === "generated_video" || s.visual_strategy === "avatar"));
  if (only?.length) {
    const known = new Set(withShot.map((s) => s.id));
    const unknown = only.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`no shot card on scene(s) ${unknown.join(", ")}; scenes with a shot: ${[...known].join(", ") || "(none)"}`);
    return withShot.filter((s) => only.includes(s.id));
  }
  return withShot;
}

function credentialsFor(ps: ProviderSpec, env: Readonly<Record<string, string | undefined>>): PackCredential[] {
  return ps.access.map((a) => ({ via: a.via, env: a.env, set: hasCredential(env, a.env) }));
}

function sceneMarkdown(scene: Scene, ps: ProviderSpec, c: CompiledPrompt): string {
  const lines = [
    `# ${scene.id} · ${ps.name}`,
    "",
    `${PROMPT_PACK_BANNER}. Nothing was generated or sent anywhere; this is text to review and paste.`,
    "",
    `- model: \`${c.model ?? "(none)"}\``,
    `- mode: ${c.mode}`,
    `- shot purpose: ${scene.shot!.purpose}`,
    `- provider spec: ${c.verified ? `verified ${c.verified_on}` : `**unverified** (read ${c.verified_on}; re-check the live docs first)`}`,
    "",
    "## Prompt",
    "",
    "```text",
    c.text,
    "```",
    "",
    "## Parameters",
    "",
    "Provider-neutral; the Phase 7 adapter maps them to the API's field names.",
    "",
    "```json",
    JSON.stringify(c.params, null, 2),
    "```",
    "",
  ];
  if (c.warnings.length) {
    lines.push("## Warnings", "", ...c.warnings.map((w) => `- [${w.code}] ${w.path}: ${w.message}${w.fix ? ` → ${w.fix}` : ""}`), "");
  }
  if (c.fixes.length) lines.push("## Applied by the compiler", "", ...c.fixes.map((f) => `- ${f}`), "");
  lines.push("## Notes", "", ...c.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

function readme(result: Omit<PromptPackResult, "readme">, specs: ProviderSpec[]): string {
  const lines = [
    `# ${PROMPT_PACK_BANNER}`,
    "",
    "Compiled from the shot cards in `project/video-spec.json` by `prompt_pack`. No provider was",
    "called, nothing was generated and nothing was spent. Paid generation is Phase 7 and runs only",
    "through the engine's policy, spend and consent gates.",
    "",
    "Every provider spec is a dated hypothesis (`verified: false`): re-check the provider's live",
    "docs before you generate, and see `provider-specs/` for the sources.",
    "",
    "## Consistency plan",
    "",
    "1. Approve an identity keyframe (the hero, product or place) before any clip.",
    "2. Generate the riskiest shot first and inspect it before the batch.",
    "3. Chain shots: export each approved shot's last frame to `prompts/frames/<scene>-last.png`;",
    "   a shot with `first_frame_from` starts from it (its params point there).",
    "4. Composite logos, prices, UI and copy in the edit, never in the generated pixels.",
    "",
    "## Packs",
    "",
    "| family | scene | model | mode | warnings | files |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const f of result.families) {
    for (const s of f.scenes) lines.push(`| ${f.family} | ${s.scene_id} | \`${s.model ?? "-"}\` | ${s.mode} | ${s.warnings} | [md](${f.family}/${s.scene_id}.md) · [json](${f.family}/${s.scene_id}.json) |`);
  }
  lines.push("", "## Credentials (placeholders until Phase 7)", "", "Only whether each is set is recorded, never its value.", "");
  for (const f of result.families) {
    const spec = specs.find((s) => s.id === f.family)!;
    lines.push(`- **${spec.name}** (${f.verified ? `verified ${f.verified_on}` : "unverified"}): ${f.credentials.map((c) => `${c.env} via ${c.via}: ${c.set ? "set" : "not set"}`).join("; ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export async function promptPack(projectDir: string, opts: PromptPackOptions = {}): Promise<PromptPackResult> {
  const specPath = projectSpecPaths(projectDir).spec;
  if (!existsSync(specPath)) throw new Error(`no ${specPath}; write the spec first (plan / spec_scaffold)`);
  const parsed = parseYamlOrJson(VideoSpec, await readFile(specPath, "utf8"));
  if (!parsed.ok) throw new Error(`invalid video spec (run spec_validate): ${parsed.message}`);
  const spec = parsed.data;
  const scenes = shotScenes(spec.scenes, opts.scenes);
  if (!scenes.length) throw new Error('no scene has a shot card: add `shot` to generated_video or avatar scenes (see the prompt-pack skill)');

  const dir = opts.providerSpecsDir === undefined ? findProviderSpecsDir() : opts.providerSpecsDir;
  if (!dir) throw new Error("provider-specs/ not found (reinstall the plugin)");
  const families = opts.families?.length ? [...new Set(opts.families)] : [...ProviderFamilySchema.options];
  const all = await loadProviderSpecs(dir);
  const specs = families.map((f) => {
    const ps = all.find((s) => s.id === f);
    if (!ps) throw new Error(`no provider spec for "${f}" in ${dir}`);
    return ps;
  });

  const env = opts.env ?? {};
  const outDir = join(projectDir, "prompts");
  const packFamilies: PackFamily[] = [];
  let warnings = 0;
  for (const ps of specs) {
    const famDir = join(outDir, ps.id);
    await mkdir(famDir, { recursive: true });
    const entries: PackSceneEntry[] = [];
    for (const scene of scenes) {
      const c = compile(scene.shot!, scene, spec, ps);
      const md = `prompts/${ps.id}/${scene.id}.md`;
      const json = `prompts/${ps.id}/${scene.id}.json`;
      await writeFile(join(projectDir, md), sceneMarkdown(scene, ps, c));
      await writeFile(join(projectDir, json), `${JSON.stringify({ kind: "prompt_package", generated: false, scene_id: scene.id, ...c }, null, 2)}\n`);
      entries.push({ scene_id: scene.id, ...(c.model ? { model: c.model } : {}), mode: c.mode, md, json, warnings: c.warnings.length });
      warnings += c.warnings.length;
    }
    packFamilies.push({ family: ps.id, name: ps.name, verified: ps.verified, verified_on: ps.verified_on, credentials: credentialsFor(ps, env), scenes: entries });
  }
  const base = { ok: true as const, kind: "prompt_package" as const, generated: false as const, spend_usd: 0 as const, project_dir: projectDir, dir: outDir, families: packFamilies, scenes: scenes.map((s) => s.id), warnings };
  const readmePath = join(outDir, "README.md");
  await writeFile(readmePath, readme(base, specs));
  return { ...base, readme: readmePath };
}

export function formatPromptPack(r: PromptPackResult): string {
  const lines = [
    `${PROMPT_PACK_BANNER}: ${r.scenes.length} shot(s) × ${r.families.length} famil${r.families.length === 1 ? "y" : "ies"} → ${r.dir}`,
    `index: ${r.readme}`,
  ];
  for (const f of r.families) {
    const creds = f.credentials.map((c) => `${c.env} ${c.set ? "set" : "not set"}`).join(", ");
    const w = f.scenes.reduce((n, s) => n + s.warnings, 0);
    lines.push(`${f.family}: ${f.scenes.length} prompt(s), ${w} warning(s), ${f.verified ? "verified" : "unverified spec"}; credentials (Phase 7): ${creds}`);
  }
  lines.push("Nothing was generated or spent. Review the warnings in each .md; paid generation is Phase 7 (policy, spend and consent gated).");
  return lines.join("\n");
}
