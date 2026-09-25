import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ContentIR, VideoSpec } from "@video-studio/schema";
import { formatVerify, verifyProject } from "./verify.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const schemaExamples = join(repo, "packages", "schema", "examples");
let tmp: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-verify-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** The schema's explain-vector-db example as a project; `edit` changes the spec/IR/brief first. */
async function schemaProject(name: string, edit: (x: { spec: VideoSpec; ir: ContentIR; brief: Record<string, unknown> }) => void = () => {}): Promise<string> {
  const root = join(tmp, name);
  await mkdir(join(root, "project"), { recursive: true });
  await mkdir(join(root, "source"), { recursive: true });
  const spec = JSON.parse(await readFile(join(schemaExamples, "explain-vector-db.video-spec.json"), "utf8")) as VideoSpec;
  const ir = JSON.parse(await readFile(join(schemaExamples, "explain-vector-db.content-ir.json"), "utf8")) as ContentIR;
  const brief = JSON.parse(await readFile(join(schemaExamples, "explain-vector-db.creative-brief.json"), "utf8")) as Record<string, unknown>;
  edit({ spec, ir, brief });
  await writeFile(join(root, "project", "video-spec.json"), JSON.stringify(spec, null, 2));
  await writeFile(join(root, "source", "content-ir.json"), JSON.stringify(ir, null, 2));
  await writeFile(join(root, "project", "creative-brief.json"), JSON.stringify(brief, null, 2));
  return root;
}

describe("verifyProject", () => {
  it("examples/text-to-motion-graphic: every scene cites evidence, so it passes", async () => {
    const root = join(tmp, "ttmg");
    await cp(join(repo, "examples", "text-to-motion-graphic", "project"), join(root, "project"), { recursive: true });
    await cp(join(repo, "examples", "text-to-motion-graphic", "source"), join(root, "source"), { recursive: true });
    const r = await verifyProject(root);
    expect(r.findings).toEqual([]);
    expect(r.status).toBe("pass");
    expect(r.grounding).toBe("strict");
    expect(r.content_ir).toBe("source/content-ir.json");
    expect(r.ungrounded_scenes).toEqual([]);
    expect(r.counts.evidence_cited).toBeGreaterThan(0);
    expect(r.evidence.find((e) => e.ref === "markdown:input/vector-databases.md#L3")?.scenes).toEqual(["s01", "s02"]);

    const json = JSON.parse(await readFile(join(root, "qa", "verify.json"), "utf8"));
    expect(json.status).toBe("pass");
    expect(json.report_json).toBeUndefined();
    const md = await readFile(join(root, "qa", "verify.md"), "utf8");
    expect(md).toMatch(/^# Claim coverage: pass/);
    expect(md).toContain("| s01 | hook |");
    expect(formatVerify(r)).toMatch(/^verify pass: 0 error\(s\), 0 warning\(s\)/);
  });

  it("maps claims to scenes through their evidence; an uncited hook is a warning even under strict", async () => {
    const r = await verifyProject(await schemaProject("schema"));
    expect(r.claims).toEqual([expect.objectContaining({ id: "c1", scenes: ["s04"], key: false })]);
    expect(r.scenes.find((s) => s.scene_id === "s04")?.claims).toEqual(["c1"]);
    expect(r.ungrounded_scenes).toEqual(["s01"]); // s06 is the cta: exempt
    expect(r.findings.map((f) => [f.severity, f.id, f.scene_id])).toEqual([["warning", "ungrounded_scene", "s01"]]);
    expect(r.findings[0]!.fix).toMatch(/claim_refs/);
    expect(r.status).toBe("warn");
  });

  it("strict: an uncited point scene fails; loose warns; off lists it without a finding", async () => {
    const drop = (grounding: VideoSpec["grounding"]) => (x: { spec: VideoSpec }) => {
      x.spec.grounding = grounding;
      x.spec.scenes[2]!.claim_refs = [];
    };
    const strict = await verifyProject(await schemaProject("strict", drop("strict")));
    expect(strict.status).toBe("fail");
    const f = strict.findings.find((x) => x.scene_id === "s03")!;
    expect(f).toMatchObject({ id: "ungrounded_scene", severity: "error", path: "scenes.2.claim_refs" });
    expect(f.fix).toContain("url:https://example.com/vector-db-guide#embeddings"); // nearest evidence suggested

    const loose = await verifyProject(await schemaProject("loose", drop("loose")));
    expect(loose.status).toBe("warn");
    expect(loose.findings.find((x) => x.scene_id === "s03")?.severity).toBe("warning");

    const off = await verifyProject(await schemaProject("off", drop("off")));
    expect(off.ungrounded_scenes).toContain("s03");
    expect(off.findings.filter((x) => x.id === "ungrounded_scene")).toEqual([]);
  });

  it("reports unknown claim refs (semantic errors) and uncovered key claims", async () => {
    const root = await schemaProject("key", ({ spec, ir, brief }) => {
      spec.scenes[1]!.claim_refs = ["url:https://example.com/vector-db-guide#keyword-limit"];
      ir.claims.push({ id: "c2", text: "Embedding models map similar meanings to nearby vectors", kind: "qualitative", evidence_refs: [] });
      brief.key_messages = ["Embedding models place similar meanings near each other as vectors"];
    });
    const r = await verifyProject(root);
    expect(r.status).toBe("fail");
    const sem = r.findings.find((f) => f.id === "semantic" && f.severity === "error")!;
    expect(sem).toMatchObject({ scene_id: "s02", path: "scenes.1.claim_refs.0" });
    expect(sem.fix).toContain("#keyword-limits");
    expect(r.scenes.find((s) => s.scene_id === "s02")?.unknown_refs).toEqual(["url:https://example.com/vector-db-guide#keyword-limit"]);
    expect(r.claims.find((c) => c.id === "c2")).toMatchObject({ key: true, scenes: [] });
    expect(r.uncovered_claims).toEqual(["c2"]);
    const key = r.findings.find((f) => f.id === "uncovered_key_claim")!;
    expect(key).toMatchObject({ severity: "warning", claim_id: "c2" });
    expect(key.fix).toMatch(/claim_refs/);
    expect(await readFile(join(root, "qa", "verify.md"), "utf8")).toContain("**uncovered**");
  });

  it("without a ContentIR: an error under strict (examples/readme-plan), a warning otherwise", async () => {
    const root = join(tmp, "readme-plan");
    await cp(join(repo, "examples", "readme-plan", "project"), join(root, "project"), { recursive: true });
    const r = await verifyProject(root);
    expect(r.status).toBe("fail");
    expect(r.content_ir).toBeNull();
    expect(r.findings[0]).toMatchObject({ id: "no_content_ir", severity: "error" });
    expect(r.findings[0]!.fix).toMatch(/ingest/);

    const specPath = join(root, "project", "video-spec.json");
    const spec = JSON.parse(await readFile(specPath, "utf8")) as VideoSpec;
    spec.grounding = "loose";
    await writeFile(specPath, JSON.stringify(spec));
    const loose = await verifyProject(root);
    expect(loose.findings.find((f) => f.id === "no_content_ir")?.severity).toBe("warning");
    expect(loose.status).not.toBe("fail");
  });

  it("throws when there is no spec, and reports a spec that fails the schema", async () => {
    await expect(verifyProject(join(tmp, "nothing"))).rejects.toThrow(/plan the video first/);
    const root = join(tmp, "badspec");
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "video-spec.json"), JSON.stringify({ schema_version: "1.0" }));
    const r = await verifyProject(root);
    expect(r.status).toBe("fail");
    expect(r.findings.every((f) => f.id === "invalid_spec" && f.fix.length > 0)).toBe(true);
  });
});
