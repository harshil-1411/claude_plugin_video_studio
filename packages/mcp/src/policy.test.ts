import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initProject } from "@video-studio/core";
import type { VideoSpec } from "@video-studio/schema";
import { type VoiceBackend, createSilentBackend, tokenize } from "@video-studio/voice";
import { recordConsent } from "./consent.js";
import { checkPolicy } from "./doctor.js";
import { createRenderRun, stageVoice } from "./pipeline-stages.js";
import { PolicyError, decideSpend, globMatch, loadPolicy, readSpend, recordSpend, resolveVoicePolicy } from "./policy.js";

const exampleSpec = JSON.parse(await readFile(resolve(import.meta.dirname, "../../schema/examples/explain-vector-db.video-spec.json"), "utf8")) as VideoSpec;
const spec: VideoSpec = { ...exampleSpec, voice: { ...exampleSpec.voice, align: false } };

let tmp: string;
let n = 0;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-policy-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function project(policy?: string, where: "root" | "project" = "project"): Promise<string> {
  const dir = join(tmp, `p${++n}`);
  await initProject(dir, { name: "p" });
  if (policy) await writeFile(where === "root" ? join(dir, "policy.yaml") : join(dir, "project", "policy.yaml"), policy);
  return dir;
}

/** A fake voice backend that writes a small file and reports provider timings (no alignment). */
function fake(id: string, extra: Partial<VoiceBackend> = {}): VoiceBackend & { calls: string[] } {
  const calls: string[] = [];
  return {
    id,
    calls,
    available: () => ({ ok: true, reason: `${id} ready` }),
    cacheOptions: () => ({ fake: id }),
    async synthesize(input, ctx) {
      calls.push(input.scene_id);
      const out = join(ctx.outDir, `${input.scene_id}.wav`);
      await writeFile(out, `RIFF-${id}-${input.text}`);
      const words = tokenize(input.text);
      return { scene_id: input.scene_id, audio_path: out, duration_ms: 1000, words: words.map((w, i) => ({ word: w, start_ms: i * 10, end_ms: i * 10 + 10 })), timing_source: "provider", provider: id };
    },
    ...extra,
  };
}

const paidEleven = () => fake("elevenlabs", { paid: true, usdPer1kChars: () => 0.1 });

async function voice(dir: string, o: { voice?: "auto" | "elevenlabs" | "system"; eleven?: VoiceBackend; spec?: VideoSpec } = {}) {
  const eleven = o.eleven ?? paidEleven();
  const system = fake("system");
  const run = createRenderRun(dir, {
    voice: o.voice ?? "auto",
    env: { CLAUDE_PLUGIN_DATA: join(tmp, "data") },
    voiceCacheDir: join(dir, ".voice-cache"),
    voiceBackends: { elevenlabs: eleven, system, silent: createSilentBackend() },
  });
  const vs = await stageVoice(run, o.spec ?? spec, undefined);
  return { vs, eleven, system };
}

describe("loadPolicy", () => {
  it("returns no policy when no file exists, and reads project/policy.yaml or <project>/policy.yaml", async () => {
    const env = { CLAUDE_PLUGIN_DATA: join(tmp, "nodata") };
    expect(await loadPolicy(await project(), env)).toEqual({ policy: null, sources: [] });
    const a = await loadPolicy(await project("version: 1\nproviders: {allow: [elevenlabs]}\n"), env);
    expect(a.policy?.providers?.allow).toEqual(["elevenlabs"]);
    expect(a.sources[0]!.scope).toBe("project");
    const b = await loadPolicy(await project("version: 1\nspend: {project_limit_usd: 5}\n", "root"), env);
    expect(b.policy?.spend?.project_limit_usd).toBe(5);
  });

  it("merges the user default under the project policy (project wins, arrays replaced)", async () => {
    const data = join(tmp, "userdata");
    await mkdir(data, { recursive: true });
    await writeFile(join(data, "policy.yaml"), "version: 1\nproviders: {allow: [elevenlabs, runway]}\nspend: {project_limit_usd: 10, approval_above_usd: 1}\n");
    const lp = await loadPolicy(await project("version: 1\nproviders: {allow: [runway]}\nspend: {approval_above_usd: 2}\n"), { CLAUDE_PLUGIN_DATA: data });
    expect(lp.sources.map((s) => s.scope)).toEqual(["user", "project"]);
    expect(lp.policy?.providers?.allow).toEqual(["runway"]);
    expect(lp.policy?.spend).toEqual({ project_limit_usd: 10, approval_above_usd: 2 });
    // user default only (doctor without a project)
    expect((await loadPolicy(undefined, { CLAUDE_PLUGIN_DATA: data })).policy?.spend?.approval_above_usd).toBe(1);
  });

  it("rejects an invalid file and two project policy files with a clear error", async () => {
    const env = { CLAUDE_PLUGIN_DATA: join(tmp, "nodata") };
    const bad = await project("version: 1\nspend: {project_limit_usd: -1}\nbogus: true\n");
    await expect(loadPolicy(bad, env)).rejects.toBeInstanceOf(PolicyError);
    await expect(loadPolicy(bad, env)).rejects.toThrow(/invalid policy file .*policy\.yaml: .*(spend|bogus)/);
    const both = await project("version: 1\n");
    await writeFile(join(both, "policy.yaml"), "version: 1\n");
    await expect(loadPolicy(both, env)).rejects.toThrow(/two project policy files/);
    const c = await checkPolicy(env, bad);
    expect(c.status).toBe("fail");
  });

  it("doctor's policy check explains why a configured ElevenLabs key is not used", async () => {
    const c = await checkPolicy({ CLAUDE_PLUGIN_DATA: join(tmp, "nodata"), ELEVENLABS_API_KEY: "k" }, await project());
    expect(c.status).toBe("ok");
    expect(c.detail).toMatch(/no policy\.yaml.*ELEVENLABS_API_KEY is set but voice auto will not use it/);
  });
});

describe("globMatch", () => {
  it("matches ids and globs case-insensitively", () => {
    expect(globMatch("elevenlabs", "ElevenLabs")).toBe(true);
    expect(globMatch("eleven*", "elevenlabs")).toBe(true);
    expect(globMatch("fal/*", "fal/kling")).toBe(true);
    expect(globMatch("*-experimental", "elevenlabs")).toBe(false);
    expect(globMatch("eleven", "elevenlabs")).toBe(false);
  });
});

describe("decideSpend", () => {
  const plan = (chars: number, rate: number | null) => ({
    backend: "elevenlabs",
    paid: true,
    scenes: [{ scene_id: "s1", chars, cached: false, cache_key: "k" }],
    chars_total: chars,
    chars_uncached: chars,
    usd_per_1k_chars: rate,
    estimated_usd: rate === null ? null : (chars / 1000) * rate,
    uncached_digest: "d",
  });
  it("refuses above the project and scene limits, asks above the approval threshold or without an estimate", () => {
    expect(decideSpend({ version: 1, spend: { project_limit_usd: 1 } }, plan(5000, 0.1), 0.6).status).toBe("refused");
    expect(decideSpend({ version: 1, spend: { scene_limit_usd: 0.1 } }, plan(2000, 0.1), 0).status).toBe("refused");
    expect(decideSpend({ version: 1, spend: { approval_above_usd: 0.1 } }, plan(2000, 0.1), 0).status).toBe("needs_consent");
    expect(decideSpend({ version: 1, spend: { approval_above_usd: 1 } }, plan(2000, 0.1), 0).status).toBe("allowed");
    expect(decideSpend({ version: 1, spend: { project_limit_usd: 100 } }, plan(2000, null), 0).status).toBe("needs_consent");
    expect(decideSpend({ version: 1 }, plan(2000, null), 0).status).toBe("allowed");
    expect(decideSpend(null, { ...plan(2000, 0.1), chars_uncached: 0 }, 99).status).toBe("allowed");
  });
});

describe("stageVoice under policy", () => {
  it("auto does not use a configured paid voice without a policy, and says why", async () => {
    const dir = await project();
    const { vs, eleven } = await voice(dir);
    expect(vs.voice.backend).toBe("system");
    expect(eleven.calls).toEqual([]);
    expect(vs.reason).toMatch(/ElevenLabs key present but not allowed by policy; add providers\.allow: \[elevenlabs\] to policy\.yaml or set voice\.provider_preference/);
    expect(vs.policy).toMatchObject({ sources: [], effective: null });
  });

  it("auto uses it when providers.allow matches, records the estimated spend and the policy source", async () => {
    const dir = await project("version: 1\nproviders: {allow: ['eleven*']}\n");
    const { vs, eleven } = await voice(dir);
    expect(vs.voice.backend).toBe("elevenlabs");
    expect(eleven.calls.length).toBe(spec.scenes.length);
    expect(vs.policy.sources).toEqual([{ scope: "project", path: "project/policy.yaml" }]);
    expect(vs.paid_voice?.estimated_usd).toBeGreaterThan(0);
    const spent = await readSpend(dir);
    expect(spent).toHaveLength(1);
    expect(spent[0]!.chars).toBe(vs.paid_voice!.chars);
    // A re-render is served from the cache: no charge, no new spend entry.
    const again = await voice(dir);
    expect(again.eleven.calls).toEqual([]);
    expect(await readSpend(dir)).toHaveLength(1);
  });

  it("the spec's voice.provider_preference or an explicit request also allow it; providers.deny wins", async () => {
    const pref = await voice(await project(), { spec: { ...spec, voice: { ...spec.voice, provider_preference: ["elevenlabs"] } } });
    expect(pref.vs.voice.backend).toBe("elevenlabs");
    const explicit = await voice(await project(), { voice: "elevenlabs" });
    expect(explicit.vs.voice.backend).toBe("elevenlabs");
    const denied = await project("version: 1\nproviders: {deny: [elevenlabs]}\n");
    await expect(voice(denied, { voice: "elevenlabs" })).rejects.toThrow(/denied by policy \(providers\.deny: elevenlabs\)/);
    const auto = await voice(denied, { spec: { ...spec, voice: { ...spec.voice, provider_preference: ["elevenlabs"] } } });
    expect(auto.vs.voice.backend).toBe("system");
  });

  it("above approval_above_usd it needs a recorded consent for exactly this synthesis", async () => {
    const dir = await project("version: 1\nproviders: {allow: [elevenlabs]}\nspend: {approval_above_usd: 0}\n");
    const first = await voice(dir);
    expect(first.vs.voice.backend).toBe("system");
    expect(first.vs.reason).toMatch(/above spend\.approval_above_usd \$0\.0000, so the user must approve; no approval recorded/);
    await expect(voice(dir, { voice: "elevenlabs" })).rejects.toThrow(/no approval recorded/);

    const backends = { elevenlabs: paidEleven(), system: fake("system"), silent: createSilentBackend() };
    const vp = await resolveVoicePolicy({ root: dir, spec, voiceChoice: "auto", env: { CLAUDE_PLUGIN_DATA: join(tmp, "data") }, backends, cacheDir: join(dir, ".voice-cache") });
    await recordConsent(dir, { action: "paid_voice", subject: vp.decisions.elevenlabs!.subject, via: "elicitation", detail: "test" });
    const second = await voice(dir);
    expect(second.vs.voice.backend).toBe("elevenlabs");
    expect(second.vs.reason).toMatch(/approved by the user \(elicitation/);
  });

  it("refuses above spend.project_limit_usd, counting the spend already recorded", async () => {
    const dir = await project("version: 1\nproviders: {allow: [elevenlabs]}\nspend: {project_limit_usd: 1}\n");
    await recordSpend(dir, { at: "2026-09-26T00:00:00Z", provider: "elevenlabs", chars: 9990, estimated_usd: 0.999, scenes: ["x"], subject: "old" });
    const { vs, eleven } = await voice(dir);
    expect(eleven.calls).toEqual([]);
    expect(vs.voice.backend).toBe("system");
    expect(vs.reason).toMatch(/refusing ElevenLabs: .* above spend\.project_limit_usd \$1\.00/);
  });

  it("a paid backend without a price estimate needs approval once spend limits are set", async () => {
    const dir = await project("version: 1\nproviders: {allow: [elevenlabs]}\nspend: {project_limit_usd: 50}\n");
    const { vs } = await voice(dir, { eleven: fake("elevenlabs") /* paid by id, no price */ });
    expect(vs.voice.backend).toBe("system");
    expect(vs.reason).toMatch(/no price estimate/);
  });
});
