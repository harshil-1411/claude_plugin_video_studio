import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { projectPaths, readJson, resolveDataDir, writeJsonAtomic } from "@video-studio/core";
import { type Brand, Policy, type VideoSpec, parseYamlOrJson } from "@video-studio/schema";
import {
  type BackendChoice,
  type BackendSet,
  type PaidBackendGate,
  type SynthesisPlan,
  isPaidBackend,
  planSynthesis,
} from "@video-studio/voice";
import { findConsent } from "./consent.js";

/**
 * policy.yaml: loading, merging and the parts the engine enforces today.
 *
 * Sources, lowest to highest precedence:
 *   1. user default: `<plugin data dir>/policy.yaml` (`${CLAUDE_PLUGIN_DATA}`)
 *   2. project:      `<project>/policy.yaml` or `<project>/project/policy.yaml` (not both)
 * Objects merge key by key (project wins); arrays and scalars are replaced.
 *
 * Enforced: `providers.allow`/`providers.deny` for paid voice backends (ElevenLabs) and the
 * `spend` limits on paid voice (see {@link resolveVoicePolicy}). Everything else is recorded but
 * advisory until the provider phase.
 */

type Env = Record<string, string | undefined>;

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface PolicySource {
  scope: "user" | "project";
  path: string;
}

export interface LoadedPolicy {
  /** The effective (merged) policy, or null when no policy file exists. */
  policy: Policy | null;
  /** Files it came from, lowest precedence first. */
  sources: PolicySource[];
}

/** What render-state and provenance record about the policy a render ran under. */
export interface PolicySummary {
  sources: PolicySource[];
  /** The effective policy (null: none; defaults apply: paid providers off unless requested). */
  effective: Policy | null;
  enforced: string[];
}

export const ENFORCED_POLICY_FIELDS = [
  "providers.allow/deny (paid voice backends)",
  "spend.project_limit_usd, spend.scene_limit_usd, spend.approval_above_usd (paid voice)",
] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge: objects key by key, `over` wins; arrays and scalars are replaced. */
export function mergePolicy(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(out[k]) ? mergePolicy(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

async function readPolicyFile(path: string): Promise<Policy> {
  const r = parseYamlOrJson(Policy, await readFile(path, "utf8"));
  if (!r.ok) {
    throw new PolicyError(
      `invalid policy file ${path}: ${r.errors
        .slice(0, 8)
        .map((e) => `${e.path || "(root)"}: ${e.message}`)
        .join("; ")}. Fix it (schema_get policy; it needs version: 1) or remove it.`,
    );
  }
  return r.data;
}

/** The user-level default policy file (whether or not it exists). */
export function userPolicyPath(env: Env = process.env): string {
  return join(resolveDataDir(env).root, "policy.yaml");
}

/** Load the effective policy for a project (or only the user default without a project). Throws PolicyError on an invalid file. */
export async function loadPolicy(projectDir: string | undefined, env: Env = process.env): Promise<LoadedPolicy> {
  const sources: PolicySource[] = [];
  let merged: Record<string, unknown> | null = null;
  let userPath: string | undefined;
  try {
    userPath = userPolicyPath(env);
  } catch {
    userPath = undefined; // data dir misconfigured: doctor reports it separately
  }
  if (userPath && existsSync(userPath)) {
    merged = { ...(await readPolicyFile(userPath)) };
    sources.push({ scope: "user", path: userPath });
  }
  if (projectDir) {
    const root = projectPaths(projectDir).root;
    const found = [join(root, "policy.yaml"), join(root, "project", "policy.yaml")].filter((p) => existsSync(p));
    if (found.length > 1) throw new PolicyError(`two project policy files (${found.join(" and ")}); keep one`);
    if (found[0]) {
      const p = await readPolicyFile(found[0]);
      merged = merged ? mergePolicy(merged, p) : { ...p };
      sources.push({ scope: "project", path: found[0] });
    }
  }
  if (!merged) return { policy: null, sources };
  const r = Policy.safeParse(merged);
  if (!r.success) throw new PolicyError(`merged policy is invalid: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return { policy: r.data, sources };
}

/**
 * For render-state and provenance: paths are project-relative (the project policy) or
 * `${CLAUDE_PLUGIN_DATA}/policy.yaml` (the user default), never absolute paths of this machine.
 */
export function summarizePolicy(lp: LoadedPolicy, projectDir?: string): PolicySummary {
  const root = projectDir ? projectPaths(projectDir).root : undefined;
  const sources = lp.sources.map((s) => ({
    scope: s.scope,
    path: s.scope === "user" ? "${CLAUDE_PLUGIN_DATA}/policy.yaml" : root ? relative(root, s.path).split(sep).join("/") : s.path,
  }));
  return { sources, effective: lp.policy, enforced: [...ENFORCED_POLICY_FIELDS] };
}

/** One line for doctor and tool output. */
export function describePolicy(lp: LoadedPolicy): string {
  if (!lp.policy) return "no policy.yaml (defaults: paid providers are used only when requested explicitly; no spend limits)";
  const p = lp.policy;
  const parts = [
    p.providers?.allow ? `allow [${p.providers.allow.join(", ")}]` : "allow: none",
    ...(p.providers?.deny?.length ? [`deny [${p.providers.deny.join(", ")}]`] : []),
    ...(p.spend?.project_limit_usd !== undefined ? [`project limit $${p.spend.project_limit_usd}`] : []),
    ...(p.spend?.scene_limit_usd !== undefined ? [`scene limit $${p.spend.scene_limit_usd}`] : []),
    ...(p.spend?.approval_above_usd !== undefined ? [`approval above $${p.spend.approval_above_usd}`] : []),
  ];
  return `${parts.join("; ")} (from ${lp.sources.map((s) => `${s.scope} ${s.path}`).join(" + ")})`;
}

// ------------------------------------------------------------------------------------ provider globs

/** `*` matches any run of characters, `?` one; case-insensitive; the whole id must match. */
export function globMatch(glob: string, id: string): boolean {
  const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\/]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return re.test(id);
}

export interface ProviderRule {
  /** true: an allow glob matches; false: a deny glob matches (deny wins); undefined: neither. */
  allowed: boolean | undefined;
  glob?: string;
}

export function providerRule(policy: Policy | null, id: string): ProviderRule {
  const deny = policy?.providers?.deny?.find((g) => globMatch(g, id));
  if (deny) return { allowed: false, glob: deny };
  const allow = policy?.providers?.allow?.find((g) => globMatch(g, id));
  if (allow) return { allowed: true, glob: allow };
  return { allowed: undefined };
}

const DISPLAY: Record<string, string> = { elevenlabs: "ElevenLabs" };
const display = (id: string) => DISPLAY[id] ?? id;

// ------------------------------------------------------------------------------------ paid voice

export interface PaidVoiceDecision {
  backend: string;
  /** allowed: may synthesize; needs_consent: only with a recorded paid_voice consent for `subject`; refused: never. */
  status: "allowed" | "needs_consent" | "refused";
  reason: string;
  plan: SynthesisPlan;
  /** Consent subject for this exact synthesis (backend + the uncached scenes' cache keys). */
  subject: string;
  /** Estimated paid-voice spend already recorded for this project. */
  spent_usd: number;
  /** A matching consent was found in project/consent.json. */
  consented?: boolean;
}

export interface VoicePolicy {
  loaded: LoadedPolicy;
  /** Gate for selectBackend: provider allow/deny plus the spend decision. */
  gate: PaidBackendGate;
  /** The spend decision for each paid backend that is available and permitted by the provider rules. */
  decisions: Record<string, PaidVoiceDecision>;
}

export interface SpendEntry {
  at: string;
  provider: string;
  chars: number;
  estimated_usd: number | null;
  scenes: string[];
  subject: string;
}

export const SPEND_FILE = "spend.json";

export async function readSpend(projectDir: string): Promise<SpendEntry[]> {
  const f = join(projectPaths(projectDir).project, SPEND_FILE);
  const data = await readJson<{ entries?: SpendEntry[] }>(f).catch(() => undefined);
  return Array.isArray(data?.entries) ? data.entries : [];
}

/** Append an estimated paid-provider charge to `<project>/project/spend.json`. */
export async function recordSpend(projectDir: string, entry: SpendEntry): Promise<void> {
  const entries = await readSpend(projectDir);
  entries.push(entry);
  await writeJsonAtomic(join(projectPaths(projectDir).project, SPEND_FILE), { version: 1, entries });
}

export function paidVoiceSubject(plan: SynthesisPlan): string {
  return `${plan.backend}:${plan.uncached_digest}`;
}

/** Why a paid backend is not permitted by the provider rules, or null when it is. */
export function paidProviderRefusal(policy: Policy | null, id: string, explicit: boolean, spec: Pick<VideoSpec, "voice">): string | null {
  const rule = providerRule(policy, id);
  if (rule.allowed === false) return `${display(id)} is denied by policy (providers.deny: ${rule.glob})`;
  if (explicit || rule.allowed || spec.voice.provider_preference?.some((p) => p.toLowerCase() === id)) return null;
  return `${display(id)} key present but not allowed by policy; add providers.allow: [${id}] to policy.yaml or set voice.provider_preference: [${id}] in the spec (or request voice: ${id})`;
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** Spend limits for one planned paid synthesis. Pure, apart from the recorded consent passed in. */
export function decideSpend(policy: Policy | null, plan: SynthesisPlan, spent_usd: number): Omit<PaidVoiceDecision, "consented"> {
  const subject = paidVoiceSubject(plan);
  const base = { backend: plan.backend, plan, subject, spent_usd };
  const spend = policy?.spend;
  const name = display(plan.backend);
  if (plan.chars_uncached === 0) return { ...base, status: "allowed", reason: `every ${name} scene is cached (no charge)` };
  const est = plan.estimated_usd;
  const what = `${plan.chars_uncached} characters${est !== null ? ` (~${usd(est)} at ${usd(plan.usd_per_1k_chars!)}/1k)` : " (no price estimate)"}`;
  const limited = spend && (spend.project_limit_usd !== undefined || spend.scene_limit_usd !== undefined || spend.approval_above_usd !== undefined);
  if (est !== null && spend?.project_limit_usd !== undefined && spent_usd + est > spend.project_limit_usd) {
    return { ...base, status: "refused", reason: `refusing ${name}: ${what} would bring this project's estimated spend to ${usd(spent_usd + est)}, above spend.project_limit_usd ${usd(spend.project_limit_usd)}` };
  }
  if (est !== null && spend?.scene_limit_usd !== undefined && plan.usd_per_1k_chars !== null) {
    const over = plan.scenes.filter((s) => !s.cached && (s.chars / 1000) * plan.usd_per_1k_chars! > spend.scene_limit_usd!);
    if (over.length) return { ...base, status: "refused", reason: `refusing ${name}: scene(s) ${over.map((s) => s.scene_id).join(", ")} exceed spend.scene_limit_usd ${usd(spend.scene_limit_usd)}` };
  }
  if (est === null && limited) return { ...base, status: "needs_consent", reason: `${name} for ${what}: no price estimate to check the spend limits against, so the user must approve` };
  if (est !== null && spend?.approval_above_usd !== undefined && est > spend.approval_above_usd) {
    return { ...base, status: "needs_consent", reason: `${name} for ${what} is above spend.approval_above_usd ${usd(spend.approval_above_usd)}, so the user must approve` };
  }
  return { ...base, status: "allowed", reason: `${name} for ${what} within policy` };
}

export interface ResolveVoicePolicyOptions {
  root: string;
  spec: VideoSpec;
  brand?: Pick<Brand, "language"> | null;
  voiceChoice: BackendChoice;
  env: Env;
  backends: BackendSet;
  cacheDir?: string;
  /** Pre-loaded policy (default: loadPolicy(root, env)). */
  loaded?: LoadedPolicy;
}

/**
 * The paid-voice rules for one render. For each paid backend that is available and permitted by
 * providers.allow/deny (or named by the request or the spec), plan the synthesis, apply the spend
 * limits and look up a recorded consent. The returned gate refuses anything not allowed, so
 * `auto` falls through to the system voice and an explicit request fails with the reason.
 */
export async function resolveVoicePolicy(o: ResolveVoicePolicyOptions): Promise<VoicePolicy> {
  const loaded = o.loaded ?? (await loadPolicy(o.root, o.env));
  const policy = loaded.policy;
  const decisions: Record<string, PaidVoiceDecision> = {};
  const candidates = o.voiceChoice === "auto" ? (["elevenlabs"] as const) : o.voiceChoice === "elevenlabs" ? (["elevenlabs"] as const) : [];
  for (const id of candidates) {
    const backend = o.backends[id];
    if (!isPaidBackend(backend)) continue;
    const a = await Promise.resolve(backend.available(o.env)).catch(() => ({ ok: false }));
    if (!a.ok) continue;
    if (paidProviderRefusal(policy, backend.id, o.voiceChoice === id, o.spec)) continue;
    const plan = await planSynthesis(o.spec, { backend, env: o.env, brand: o.brand ?? null, ...(o.cacheDir ? { cacheDir: o.cacheDir } : {}) });
    const spent = (await readSpend(o.root)).reduce((n, e) => n + (e.estimated_usd ?? 0), 0);
    const d: PaidVoiceDecision = decideSpend(policy, plan, spent);
    if (d.status === "needs_consent") {
      const c = await findConsent(o.root, "paid_voice", d.subject);
      if (c) {
        d.status = "allowed";
        d.consented = true;
        d.reason += `; approved by the user (${c.via}, ${c.granted_at})`;
      }
    }
    decisions[backend.id] = d;
  }
  const gate: PaidBackendGate = (id, explicit) => {
    const refused = paidProviderRefusal(policy, id, explicit, o.spec);
    if (refused) return refused;
    const d = decisions[id];
    if (!d) return null;
    if (d.status === "refused") return `${d.reason} (policy.yaml)`;
    if (d.status === "needs_consent") return `${d.reason}; no approval recorded (render_submit asks the user, or pass approve_paid_voice: true after they agree)`;
    return null;
  };
  return { loaded, gate, decisions };
}
