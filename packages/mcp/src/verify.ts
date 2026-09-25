import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { projectPaths, writeFileAtomic, writeJsonAtomic } from "@video-studio/core";
import { ContentIR, CreativeBrief, type Grounding, type ScenePurpose, VideoSpec, parseYamlOrJson, validateVideoSpecSemantics } from "@video-studio/schema";
import { projectSpecPaths } from "./spec-validate.js";

/**
 * verify: claim-coverage report for a planned project. Which ContentIR claims each scene cites,
 * which claims no scene covers, and which scenes make statements without grounding, reusing
 * validateVideoSpecSemantics. Read-only apart from qa/verify.{json,md}. Every finding carries an
 * actionable `fix` that the verify skill applies to the spec.
 *
 * A scene "covers" a claim when its claim_refs name the claim id or one of the claim's evidence
 * refs; it "cites" an evidence span when it names the span's ref or a claim backed by it. Key
 * claims are the claims a brief key message restates (word overlap), since the brief says what
 * the video must get across.
 */

/** Scene purposes that make no statement of fact and so need no claim_refs. */
const UNGROUNDED_OK: ReadonlySet<ScenePurpose> = new Set(["cta", "end_card"]);

export type VerifySeverity = "error" | "warning";

export interface VerifyFinding {
  id: "semantic" | "ungrounded_scene" | "uncovered_key_claim" | "no_content_ir" | "invalid_content_ir" | "invalid_spec";
  severity: VerifySeverity;
  /** Dotted path into the spec, when the finding points at a field. */
  path?: string;
  scene_id?: string;
  claim_id?: string;
  message: string;
  fix: string;
}

export interface ClaimCoverage {
  id: string;
  text: string;
  kind: "quantitative" | "qualitative";
  evidence_refs: string[];
  /** Restated by a brief key message. */
  key: boolean;
  /** Scenes whose claim_refs cover it, in spec order. */
  scenes: string[];
}

export interface EvidenceCoverage {
  ref: string;
  text: string;
  scenes: string[];
}

export interface SceneGrounding {
  scene_id: string;
  purpose: ScenePurpose;
  claim_refs: string[];
  /** ContentIR claims this scene covers. */
  claims: string[];
  /** claim_refs that match no evidence ref or claim id (empty without a ContentIR). */
  unknown_refs: string[];
  /** Has text (voiceover or on-screen) but no claim_refs, and is not a cta/end card. */
  ungrounded: boolean;
}

export interface VerifyResult {
  status: "pass" | "warn" | "fail";
  grounding: Grounding | null;
  content_ir: string | null;
  counts: { errors: number; warnings: number; claims: number; claims_covered: number; key_claims: number; evidence: number; evidence_cited: number };
  claims: ClaimCoverage[];
  evidence: EvidenceCoverage[];
  scenes: SceneGrounding[];
  uncovered_claims: string[];
  ungrounded_scenes: string[];
  findings: VerifyFinding[];
  report_json: string;
  report_md: string;
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function loadBrief(projectDir: string): Promise<CreativeBrief | undefined> {
  for (const name of ["creative-brief.yaml", "creative-brief.yml", "creative-brief.json"]) {
    const text = await readIfExists(join(projectDir, "project", name));
    if (text === null) continue;
    const parsed = parseYamlOrJson(CreativeBrief, text);
    return parsed.ok ? parsed.data : undefined;
  }
  return undefined;
}

const contentWords = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

/** A key message restates a claim when it shares at least half of the claim's content words (and at least 2). */
function restates(message: string, claim: string): boolean {
  const c = contentWords(claim);
  if (c.size === 0) return false;
  const m = contentWords(message);
  const shared = [...c].filter((w) => m.has(w)).length;
  return shared >= Math.min(c.size, Math.max(2, Math.ceil(c.size / 2)));
}

export async function verifyProject(projectDir: string): Promise<VerifyResult> {
  const paths = projectPaths(projectDir);
  const { spec: specPath, contentIr: irPath } = projectSpecPaths(paths.root);
  const reportJson = join(paths.qa, "verify.json");
  const reportMd = join(paths.qa, "verify.md");
  const findings: VerifyFinding[] = [];
  const result: VerifyResult = {
    status: "pass",
    grounding: null,
    content_ir: null,
    counts: { errors: 0, warnings: 0, claims: 0, claims_covered: 0, key_claims: 0, evidence: 0, evidence_cited: 0 },
    claims: [],
    evidence: [],
    scenes: [],
    uncovered_claims: [],
    ungrounded_scenes: [],
    findings,
    report_json: reportJson,
    report_md: reportMd,
  };

  const specText = await readIfExists(specPath);
  if (specText === null) throw new Error(`no spec at ${specPath}; plan the video first (the plan skill writes project/video-spec.json)`);
  const parsed = parseYamlOrJson(VideoSpec, specText);
  if (!parsed.ok) {
    for (const e of parsed.errors) {
      findings.push({ id: "invalid_spec", severity: "error", path: e.path, message: e.message, fix: "fix the spec so it matches the VideoSpec schema (run spec_validate for details), then verify again" });
    }
    return finish(result);
  }
  const spec = parsed.data;
  result.grounding = spec.grounding;

  let ir: ContentIR | undefined;
  const irText = await readIfExists(irPath);
  if (irText !== null) {
    const irParsed = parseYamlOrJson(ContentIR, irText);
    if (irParsed.ok) {
      ir = irParsed.data;
      result.content_ir = "source/content-ir.json";
    } else {
      findings.push({
        id: "invalid_content_ir",
        severity: spec.grounding === "strict" ? "error" : "warning",
        message: `source/content-ir.json is invalid (${irParsed.errors.slice(0, 2).map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}), so claim_refs cannot be checked`,
        fix: "re-run ingest on the project's sources to regenerate source/content-ir.json",
      });
    }
  } else {
    findings.push({
      id: "no_content_ir",
      severity: spec.grounding === "strict" ? "error" : "warning",
      message: `no source/content-ir.json, so claim_refs cannot be checked${spec.grounding === "strict" ? " (grounding is strict)" : ""}`,
      fix: "run ingest on the sources this video is based on, then point each scene's claim_refs at the evidence refs it produces",
    });
  }

  // Semantic validation (claim refs resolve, quantitative statements under grounding, structure).
  const semantic = validateVideoSpecSemantics(spec, ir);
  for (const e of semantic.errors) findings.push({ id: "semantic", severity: "error", path: e.path, ...sceneAt(spec, e.path), message: e.message, fix: e.fix });
  for (const w of semantic.warnings) findings.push({ id: "semantic", severity: "warning", path: w.path, ...sceneAt(spec, w.path), message: w.message, fix: w.fix });
  const semanticRefPaths = new Set([...semantic.errors, ...semantic.warnings].map((i) => i.path));

  // Coverage.
  const claimIds = new Set(ir?.claims.map((c) => c.id) ?? []);
  const evidenceRefs = new Set(ir?.evidence.map((e) => e.ref) ?? []);
  const claimsByEvidence = new Map<string, string[]>();
  for (const c of ir?.claims ?? []) for (const r of c.evidence_refs) claimsByEvidence.set(r, [...(claimsByEvidence.get(r) ?? []), c.id]);
  const evidenceOfClaim = new Map(ir?.claims.map((c) => [c.id, c.evidence_refs]) ?? []);
  const claimScenes = new Map<string, string[]>();
  const evidenceScenes = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, sid: string) => {
    const list = m.get(k) ?? [];
    if (!list.includes(sid)) list.push(sid);
    m.set(k, list);
  };

  spec.scenes.forEach((s, i) => {
    const covered = new Set<string>();
    for (const ref of s.claim_refs) {
      if (claimIds.has(ref)) {
        covered.add(ref);
        for (const e of evidenceOfClaim.get(ref) ?? []) push(evidenceScenes, e, s.id);
      }
      if (evidenceRefs.has(ref)) {
        push(evidenceScenes, ref, s.id);
        for (const c of claimsByEvidence.get(ref) ?? []) covered.add(c);
      }
    }
    for (const c of covered) push(claimScenes, c, s.id);
    const hasText = !!(s.voiceover.trim() || s.on_screen_text?.trim());
    const ungrounded = s.claim_refs.length === 0 && hasText && !UNGROUNDED_OK.has(s.purpose);
    result.scenes.push({
      scene_id: s.id,
      purpose: s.purpose,
      claim_refs: s.claim_refs,
      claims: [...covered].sort(),
      unknown_refs: ir ? s.claim_refs.filter((r) => !claimIds.has(r) && !evidenceRefs.has(r)) : [],
      ungrounded,
    });
    if (!ungrounded) return;
    result.ungrounded_scenes.push(s.id);
    // The semantic check already reports scenes that state numbers without claim_refs.
    const path = `scenes.${i}.claim_refs`;
    if (spec.grounding === "off" || semanticRefPaths.has(path)) return;
    // A hook often frames rather than asserts, so an uncited hook is only a warning.
    findings.push({
      id: "ungrounded_scene",
      severity: spec.grounding === "strict" && s.purpose !== "hook" ? "error" : "warning",
      path,
      scene_id: s.id,
      message: `scene ${s.id} (${s.purpose}) makes statements but cites no evidence (grounding: ${spec.grounding})`,
      fix: ir?.evidence.length
        ? `add the evidence ref(s) that support "${snippet(s.voiceover || s.on_screen_text || "")}" to claim_refs (e.g. ${nearestEvidence(s.voiceover || s.on_screen_text || "", ir).map((r) => `"${r}"`).join(", ")}), or reword the scene to what the sources say`
        : "ingest a source that supports this scene and add its evidence ref to claim_refs, or reword the scene",
    });
  });

  const keyMessages = (await loadBrief(paths.root))?.key_messages ?? [];
  for (const c of ir?.claims ?? []) {
    const key = keyMessages.some((m) => restates(m, c.text));
    const scenes = claimScenes.get(c.id) ?? [];
    result.claims.push({ id: c.id, text: c.text, kind: c.kind, evidence_refs: c.evidence_refs, key, scenes });
    if (scenes.length) continue;
    result.uncovered_claims.push(c.id);
    if (key) {
      findings.push({
        id: "uncovered_key_claim",
        severity: "warning",
        claim_id: c.id,
        message: `key claim ${c.id} ("${snippet(c.text)}") is restated in the brief's key messages but no scene cites it`,
        fix: `add "${c.id}" (or one of its evidence refs ${c.evidence_refs.map((r) => `"${r}"`).join(", ") || "(none)"}) to the claim_refs of the scene that says it, or add a scene for it, or drop the key message from the brief`,
      });
    }
  }
  for (const e of ir?.evidence ?? []) result.evidence.push({ ref: e.ref, text: e.text, scenes: evidenceScenes.get(e.ref) ?? [] });

  return finish(result);
}

/** Scene id for a `scenes.<i>...` path. */
function sceneAt(spec: VideoSpec, path: string): { scene_id?: string } {
  const m = /^scenes\.(\d+)/.exec(path);
  const s = m ? spec.scenes[Number(m[1])] : undefined;
  return s ? { scene_id: s.id } : {};
}

function snippet(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Up to 2 evidence refs whose text shares the most content words with `text`. */
function nearestEvidence(text: string, ir: ContentIR): string[] {
  const words = contentWords(text);
  return ir.evidence
    .map((e) => ({ ref: e.ref, score: [...contentWords(e.text)].filter((w) => words.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.ref);
}

async function finish(r: VerifyResult): Promise<VerifyResult> {
  const errors = r.findings.filter((f) => f.severity === "error").length;
  const warnings = r.findings.length - errors;
  r.status = errors ? "fail" : warnings ? "warn" : "pass";
  r.counts = {
    errors,
    warnings,
    claims: r.claims.length,
    claims_covered: r.claims.filter((c) => c.scenes.length).length,
    key_claims: r.claims.filter((c) => c.key).length,
    evidence: r.evidence.length,
    evidence_cited: r.evidence.filter((e) => e.scenes.length).length,
  };
  const { report_json: _j, report_md: _m, ...core } = r;
  await writeJsonAtomic(r.report_json, core);
  await writeFileAtomic(r.report_md, formatMarkdown(r));
  return r;
}

function formatMarkdown(r: VerifyResult): string {
  const lines = [
    `# Claim coverage: ${r.status}`,
    "",
    `Grounding: ${r.grounding ?? "unknown"}. ContentIR: ${r.content_ir ?? "none"}. ${r.counts.errors} error(s), ${r.counts.warnings} warning(s).`,
    `Claims covered: ${r.counts.claims_covered}/${r.counts.claims} (key: ${r.counts.key_claims}). Evidence spans cited: ${r.counts.evidence_cited}/${r.counts.evidence}.`,
    "",
  ];
  if (r.findings.length) {
    lines.push("## Findings", "");
    for (const f of r.findings) lines.push(`- **${f.severity}** \`${f.id}\`${f.scene_id ? ` ${f.scene_id}` : ""}${f.claim_id ? ` ${f.claim_id}` : ""}: ${f.message}`, `  - fix: ${f.fix}`);
    lines.push("");
  }
  if (r.scenes.length) {
    lines.push("## Scenes", "", "| Scene | Purpose | claim_refs | Claims | Note |", "|---|---|---|---|---|");
    for (const s of r.scenes) {
      const note = [s.ungrounded ? "ungrounded" : "", s.unknown_refs.length ? `unknown: ${s.unknown_refs.join(", ")}` : ""].filter(Boolean).join("; ");
      lines.push(`| ${s.scene_id} | ${s.purpose} | ${s.claim_refs.map((x) => `\`${x}\``).join(", ") || "none"} | ${s.claims.join(", ") || "-"} | ${note || "-"} |`);
    }
    lines.push("");
  }
  if (r.claims.length) {
    lines.push("## Claims", "", "| Claim | Key | Scenes | Text |", "|---|---|---|---|");
    for (const c of r.claims) lines.push(`| ${c.id} | ${c.key ? "yes" : ""} | ${c.scenes.join(", ") || "**uncovered**"} | ${snippet(c.text, 80).replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  if (r.evidence.length) {
    lines.push("## Evidence", "", "| Ref | Scenes | Text |", "|---|---|---|");
    for (const e of r.evidence) lines.push(`| \`${e.ref}\` | ${e.scenes.join(", ") || "-"} | ${snippet(e.text, 80).replace(/\|/g, "\\|")} |`);
    lines.push("");
  }
  return lines.join("\n");
}

/** One-screen summary for the tool result. */
export function formatVerify(r: VerifyResult): string {
  return [
    `verify ${r.status}: ${r.counts.errors} error(s), ${r.counts.warnings} warning(s); claims covered ${r.counts.claims_covered}/${r.counts.claims}, evidence cited ${r.counts.evidence_cited}/${r.counts.evidence} (grounding ${r.grounding ?? "unknown"}); report ${r.report_md}`,
    ...(r.uncovered_claims.length ? [`uncovered claims: ${r.uncovered_claims.join(", ")}`] : []),
    ...(r.ungrounded_scenes.length ? [`scenes without claim_refs: ${r.ungrounded_scenes.join(", ")}`] : []),
    ...r.findings.map((f) => `- ${f.severity === "error" ? "error" : "warning"} ${f.id}${f.scene_id ? ` ${f.scene_id}` : ""}${f.claim_id ? ` ${f.claim_id}` : ""}: ${f.message} (fix: ${f.fix})`),
  ].join("\n");
}
