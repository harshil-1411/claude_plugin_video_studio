import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DoctorDeps } from "./doctor.js";
import { SCHEMA_NAMES, findSchemasDir, resolveInputPath } from "./paths.js";
import { createServer } from "./server.js";
import { validateSpecFile } from "./spec-validate.js";

const here = dirname(fileURLToPath(import.meta.url));
const examples = resolve(here, "../../schema/examples");
const SPEC = join(examples, "explain-vector-db.video-spec.json");
const IR = join(examples, "explain-vector-db.content-ir.json");

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-mcp-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const fakeDoctorDeps = (): DoctorDeps => ({
  env: { PATH: "/bin", CLAUDE_PLUGIN_DATA: "/data/vs", ELEVENLABS_API_KEY: "el-secret-xyz" },
  platform: "linux",
  nodeVersion: "24.15.0",
  home: "/home/u",
  isExecutable: async () => false,
  exec: async () => null,
  loadSqlite: async () => null,
  probeWritable: async () => null,
});

async function connect() {
  const server = createServer({
    doctorDeps: fakeDoctorDeps,
    cwd: () => tmp,
    ingestOptions: { cacheDir: join(tmp, "ingest-cache"), now: "2026-09-25T12:00:00.000Z" },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: () => client.close() };
}

const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("spec_validate", () => {
  it("accepts the example spec and cross-checks the example ContentIR", async () => {
    const r = await validateSpecFile(SPEC, IR);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.content_ir_path).toBe(IR);
  });

  it("reports schema and semantic errors with paths", async () => {
    const spec = JSON.parse(await readFile(SPEC, "utf8"));
    spec.scenes[1].id = spec.scenes[0].id; // duplicate id (semantic)
    spec.scenes[0].duration_sec = 20; // duration sum outside tolerance (semantic)
    const bad = join(tmp, "bad-semantic.json");
    await writeFile(bad, JSON.stringify(spec));
    const r = await validateSpecFile(bad, null);
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["scenes", "scenes.1.id"]));
    expect(r.errors.every((e) => e.stage === "semantic")).toBe(true);

    delete spec.audience;
    spec.aspect_ratio = "5:5";
    const badSchema = join(tmp, "bad-schema.json");
    await writeFile(badSchema, JSON.stringify(spec));
    const s = await validateSpecFile(badSchema, null);
    expect(s.ok).toBe(false);
    expect(s.errors.some((e) => e.stage === "schema" && e.path === "audience")).toBe(true);
    expect(s.errors.some((e) => e.path === "aspect_ratio")).toBe(true);
  });

  it("reports syntax errors", async () => {
    const f = join(tmp, "syntax.json");
    await writeFile(f, "{ not json: [");
    const r = await validateSpecFile(f, null);
    expect(r.ok).toBe(false);
    expect(r.errors[0]?.stage).toBe("syntax");
  });
});

describe("paths", () => {
  it("resolves relative input against cwd and rejects bad input", () => {
    expect(resolveInputPath("a/b", "/base")).toBe("/base/a/b");
    expect(resolveInputPath("/abs/x", "/base")).toBe("/abs/x");
    expect(() => resolveInputPath("", "/base")).toThrow();
    expect(() => resolveInputPath("a\0b", "/base")).toThrow();
  });

  it("finds bundled schemas for every name", async () => {
    const dir = findSchemasDir({});
    expect(dir).not.toBeNull();
    for (const name of SCHEMA_NAMES) {
      const json = JSON.parse(await readFile(join(dir!, `${name}.schema.json`), "utf8"));
      expect(json.$id).toBe(`urn:video-studio:schema:${name}`);
    }
  });
});

describe("MCP server (in-memory)", () => {
  it("lists the tools", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "adapt",
      "analyze",
      "brief_validate",
      "compare",
      "demo",
      "diff",
      "doctor",
      "export",
      "ingest",
      "job_status",
      "lint",
      "localize",
      "project_init",
      "qa_run",
      "render_cancel",
      "render_submit",
      "review",
      "schema_get",
      "shorts",
      "spec_scaffold",
      "spec_validate",
      "storyboard_render",
      "template_get",
      "template_list",
      "test",
      "tighten",
      "transcribe",
      "variants",
      "verify",
    ]);
    await close();
  });

  it("doctor returns structured checks without secret values", async () => {
    const { client, close } = await connect();
    const r = (await client.callTool({ name: "doctor", arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as { overall: string; provider_keys: Record<string, boolean>; checks: { id: string }[] };
    expect(sc.overall).toBe("fail"); // no ffmpeg in the fake env
    expect(sc.provider_keys.ELEVENLABS_API_KEY).toBe(true);
    expect(sc.checks.map((c) => c.id)).toContain("ffmpeg_libass");
    expect(text(r)).toContain("[FAIL] ffmpeg");
    expect(JSON.stringify(r)).not.toContain("el-secret-xyz");
    await close();
  });

  it("project_init then spec_validate on a project dir", async () => {
    const { client, close } = await connect();
    const init = (await client.callTool({ name: "project_init", arguments: { dir: "proj", name: "Demo" } })) as CallToolResult;
    expect(init.isError).toBeFalsy();
    const root = join(tmp, "proj");
    expect(JSON.parse(await readFile(join(root, "project", "project.json"), "utf8")).name).toBe("Demo");

    const again = (await client.callTool({ name: "project_init", arguments: { dir: root, name: "Demo" } })) as CallToolResult;
    expect(again.isError).toBe(true);
    expect(text(again)).toMatch(/already exists/);

    const missing = (await client.callTool({ name: "spec_validate", arguments: { project_dir: root } })) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/spec file not found/);

    await mkdir(join(root, "source"), { recursive: true });
    await writeFile(join(root, "project", "video-spec.json"), await readFile(SPEC));
    await writeFile(join(root, "source", "content-ir.json"), await readFile(IR));
    const ok = (await client.callTool({ name: "spec_validate", arguments: { project_dir: root } })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    expect((ok.structuredContent as { ok: boolean }).ok).toBe(true);
    expect(text(ok)).toContain("VALID");

    const both = (await client.callTool({ name: "spec_validate", arguments: { project_dir: root, spec_path: SPEC } })) as CallToolResult;
    expect(both.isError).toBe(true);
    await close();
  });

  it("lint reports platform findings with fixes and writes qa/lint.json", async () => {
    const { client, close } = await connect();
    const root = join(tmp, "lint-proj");
    await mkdir(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "video-spec.json"), await readFile(join(here, "__fixtures__", "lint", "tiktok-low-captions", "project", "video-spec.json")));
    const r = (await client.callTool({ name: "lint", arguments: { project_dir: root } })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    expect(text(r)).toMatch(/^lint fail: 1 error/);
    const data = r.structuredContent as { status: string; findings: { id: string; fix: string }[] };
    expect(data.status).toBe("fail");
    expect(data.findings.find((f) => f.id === "caption_mask")!.fix).toMatch(/remove captions\.position/);
    expect(JSON.parse(await readFile(join(root, "qa", "lint.json"), "utf8")).status).toBe("fail");
    const missing = (await client.callTool({ name: "lint", arguments: { project_dir: join(tmp, "nope") } })) as CallToolResult;
    expect(missing.isError).toBe(true);
    await close();
  });

  it("schema_get returns schema text and rejects unknown names", async () => {
    const { client, close } = await connect();
    const r = (await client.callTool({ name: "schema_get", arguments: { name: "video-spec" } })) as CallToolResult;
    expect(JSON.parse(text(r)).$id).toBe("urn:video-studio:schema:video-spec");
    const bad = (await client.callTool({ name: "schema_get", arguments: { name: "nope" } })) as CallToolResult;
    expect(bad.isError).toBe(true);
    await close();
  });
});

describe("ingest tool", () => {
  it("creates the project, writes content-ir.json and returns a summary with structuredContent", async () => {
    const { client, close } = await connect();
    const r = (await client.callTool({
      name: "ingest",
      arguments: {
        project_dir: "ingest-proj",
        inputs: ["# Launch notes\n\nThe new index cut p95 latency by 40% in 2026.", join(here, "../../../fixtures/golden/article.md")],
      },
    })) as CallToolResult;
    expect(r.isError).toBeFalsy();
    const sc = r.structuredContent as Record<string, any>;
    expect(sc.project_created).toBe(true);
    expect(sc.sources.map((s: { kind: string }) => s.kind)).toEqual(["markdown", "markdown"]);
    expect(sc.claims).toBeGreaterThan(0);
    expect(sc.classification.contains_secrets).toBe(false);
    expect(text(r)).toContain("untrusted data");
    const ir = JSON.parse(await readFile(join(tmp, "ingest-proj/source/content-ir.json"), "utf8"));
    expect(ir.id).toBe(sc.ir_id);
    await readFile(join(tmp, "ingest-proj/project/project.json"), "utf8");

    // Second call reuses the existing project and hits the cache.
    const again = (await client.callTool({ name: "ingest", arguments: { project_dir: join(tmp, "ingest-proj"), inputs: [join(here, "../../../fixtures/golden/article.md")] } })) as CallToolResult;
    const sc2 = again.structuredContent as Record<string, any>;
    expect(sc2.project_created).toBe(false);
    expect(sc2.sources[0].cache_hit).toBe(true);
    await close();
  });

  it("returns isError when nothing can be ingested", async () => {
    const { client, close } = await connect();
    const r = (await client.callTool({ name: "ingest", arguments: { project_dir: "ingest-bad", inputs: ["https://github.com/o/r"] } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("clone the repo locally first");
    const empty = (await client.callTool({ name: "ingest", arguments: { project_dir: "ingest-bad", inputs: [] } })) as CallToolResult;
    expect(empty.isError).toBe(true);
    await close();
  });
});
