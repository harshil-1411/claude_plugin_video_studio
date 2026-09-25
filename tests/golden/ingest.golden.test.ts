/**
 * Phase 1 exit criterion: every golden fixture ingests into a ContentIR that
 * is valid under both the zod schema and the emitted JSON Schema (ajv), and
 * matches its reviewed snapshot in `__golden__/<case>.content-ir.json`.
 *
 * Update snapshots after an intentional extractor change with
 *   npx vitest run tests/golden -u
 * and review the diff (bump the extractor's `version` so caches invalidate).
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type IngestInput, type IngestResult, ingest } from "../../packages/ingestion/src/index.js";
import { ContentIR } from "../../packages/schema/src/index.js";
import { FAKE_AWS_SECRET, SAMPLE_LIB, materializeSampleLib } from "../../fixtures/repos/materialize-sample-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const GOLDEN = join(REPO_ROOT, "fixtures/golden");

interface GoldenCase {
  name: string;
  inline?: string;
  path?: string;
  url?: string;
  html?: string;
  expectWarning?: string;
}
const manifest = JSON.parse(readFileSync(join(GOLDEN, "cases.json"), "utf8")) as { now: string; cases: GoldenCase[] };

const ajv = new Ajv2020.default({ strict: true, allErrors: true, validateFormats: false });
const validateJsonSchema = ajv.compile(JSON.parse(readFileSync(join(REPO_ROOT, "schemas/content-ir.schema.json"), "utf8")));

let fetchCalls = 0;
const routes = new Map<string, string>();
for (const c of manifest.cases) if (c.url && c.html) routes.set(c.url, readFileSync(join(GOLDEN, c.html), "utf8"));
const fakeFetch = async (url: string): Promise<Response> => {
  fetchCalls++;
  const body = routes.get(url);
  if (body === undefined) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
};

function toInput(c: GoldenCase): string | IngestInput {
  if (c.inline) return readFileSync(join(GOLDEN, c.inline), "utf8");
  if (c.url) return c.url;
  const path = join(GOLDEN, c.path!);
  // The repo fixture is materialized with its fake secret at test time.
  return path === SAMPLE_LIB ? sampleLib : path;
}

let tmp: string;
let cacheDir: string;
let sampleLib: string;
const prevMarker = process.env.VS_EXEC_MARKER;
const marker = () => join(tmp, "EXEC_MARKER");
const first = new Map<string, IngestResult>();

/** Replace machine-specific absolute paths so snapshots are portable. */
function normalize(value: unknown, projectDir: string): string {
  const pairs: Array<[string, string]> = [
    [realpathSync(sampleLib), SAMPLE_LIB],
    [sampleLib, SAMPLE_LIB],
    [realpathSync(projectDir), "<project>"],
    [projectDir, "<project>"],
    [realpathSync(REPO_ROOT), "<repo>"],
    [REPO_ROOT, "<repo>"],
  ];
  let text = JSON.stringify(value, null, 2);
  for (const [from, to] of pairs) text = text.split(from).join(to);
  return `${text}\n`;
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-golden-"));
  cacheDir = join(tmp, "cache");
  sampleLib = materializeSampleLib(tmp);
  process.env.VS_EXEC_MARKER = marker();
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (prevMarker === undefined) delete process.env.VS_EXEC_MARKER;
  else process.env.VS_EXEC_MARKER = prevMarker;
});

describe("golden ingest fixtures", () => {
  it("has 10 cases", () => {
    expect(manifest.cases).toHaveLength(10);
  });

  for (const c of manifest.cases) {
    it(`${c.name}: valid ContentIR matching the golden snapshot`, async () => {
      const projectDir = await mkdtemp(join(tmp, `${c.name}-`));
      const res = await ingest([toInput(c)], { projectDir, now: manifest.now, cacheDir, fetch: fakeFetch, cwd: REPO_ROOT });
      first.set(c.name, res);

      const onDisk = JSON.parse(await readFile(join(projectDir, "source/content-ir.json"), "utf8"));
      expect(onDisk).toEqual(res.ir);
      const zod = ContentIR.safeParse(onDisk);
      expect(zod.success, JSON.stringify(zod.error?.issues)).toBe(true);
      expect(validateJsonSchema(onDisk), JSON.stringify(validateJsonSchema.errors)).toBe(true);

      const prov = JSON.parse(await readFile(join(projectDir, "source/provenance.json"), "utf8"));
      expect(prov.sources).toHaveLength(1);
      expect(prov.sources[0]).toMatchObject({ source_id: "src-1", kind: onDisk.sources[0].kind, cache_hit: false, fetched_at: manifest.now });
      expect(prov.failures).toEqual([]);

      if (c.expectWarning !== "thin_content") expect(res.ir.evidence.length).toBeGreaterThan(0);
      if (c.expectWarning) expect(res.ir.warnings.map((w) => w.code)).toContain(c.expectWarning);
      for (const a of res.ir.assets) expect(existsSync(join(projectDir, a.path))).toBe(true);

      await expect(normalize(onDisk, projectDir)).toMatchFileSnapshot(`./__golden__/${c.name}.content-ir.json`);
    });
  }

  it("never executed code from the fixture repo", () => {
    expect(existsSync(marker())).toBe(false);
    expect(existsSync(join(sampleLib, "EXECUTED_MARKER"))).toBe(false);
    const repo = first.get("repo-sample-lib")!;
    expect(repo.ir.classification.contains_secrets).toBe(true);
    expect(JSON.stringify(repo.ir)).not.toContain(FAKE_AWS_SECRET);
  });

  it("re-ingest hits the cache and reproduces the same IR (assets restored into a new project)", async () => {
    expect(first.size).toBe(manifest.cases.length);
    const projectDir = await mkdtemp(join(tmp, "rerun-"));
    const fetchesBefore = fetchCalls;
    const res = await ingest(manifest.cases.map(toInput), { projectDir, now: "2030-01-01T00:00:00.000Z", cacheDir, fetch: fakeFetch, cwd: REPO_ROOT });
    expect(res.provenance.sources.map((s) => s.cache_hit)).toEqual(manifest.cases.map(() => true));
    // Cached entries keep their original fetch time.
    expect(new Set(res.provenance.sources.map((s) => s.fetched_at))).toEqual(new Set([manifest.now]));
    // URL inputs are re-fetched once each to hash the body (the cache key), never twice.
    expect(fetchCalls - fetchesBefore).toBe(manifest.cases.filter((c) => c.url).length);
    manifest.cases.forEach((c, i) => {
      const prev = first.get(c.name)!.ir;
      const sid = `src-${i + 1}`;
      expect(res.ir.sources[i]).toEqual({ ...prev.sources[0], id: sid });
      expect(res.ir.sections.filter((s) => s.source_id === sid).map((s) => s.text)).toEqual(prev.sections.map((s) => s.text));
    });
    for (const a of res.ir.assets) expect(existsSync(join(projectDir, a.path))).toBe(true);
    expect(ContentIR.safeParse(res.ir).success).toBe(true);
  });
});
