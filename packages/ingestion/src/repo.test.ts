import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileConfig } from "repomix";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FAKE_AWS_SECRET, materializeSampleLib } from "../../../fixtures/repos/materialize-sample-lib.mjs";
import { buildContentIR } from "./builder.js";
import { REMOTE_REPO_ERROR, createRepoExtractor, repoDigest, repoExtractor, repoFileTier, scanFileForSecrets } from "./repo.js";


let tmp: string;
let repo: string;
let marker: string;
const prevMarker = process.env.VS_EXEC_MARKER;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-repo-"));
  repo = materializeSampleLib(tmp);
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (prevMarker === undefined) delete process.env.VS_EXEC_MARKER;
  else process.env.VS_EXEC_MARKER = prevMarker;
});
afterEach(async () => {
  if (marker) await rm(marker, { force: true });
});

function setMarker(name: string): string {
  marker = join(tmp, name);
  process.env.VS_EXEC_MARKER = marker;
  return marker;
}

describe("repoFileTier", () => {
  it("orders README, docs, changelog, examples, manifests, other docs, source", () => {
    expect(repoFileTier("README.md")).toBe(0);
    expect(repoFileTier("docs/guide/intro.md")).toBe(1);
    expect(repoFileTier("CHANGELOG.md")).toBe(2);
    expect(repoFileTier("examples/basic.js")).toBe(3);
    expect(repoFileTier("package.json")).toBe(4);
    expect(repoFileTier("packages/a/README.md")).toBe(5);
    expect(repoFileTier("src/lru.ts")).toBe(6);
    expect(repoFileTier("assets/logo.png")).toBeUndefined();
    expect(repoFileTier("bin/tool")).toBeUndefined();
  });
});

describe("repoExtractor", () => {
  it("extracts prioritized files with repo:path#L refs and never executes repo config files", async () => {
    const m = setMarker("MARKER-extract");
    const r = await repoExtractor.extract({ uri: repo, kind: "repo" });
    expect(existsSync(m)).toBe(false);
    expect(existsSync(join(repo, "EXECUTED_MARKER"))).toBe(false);
    expect(existsSync(join(repo, "POSTINSTALL_RAN"))).toBe(false);

    expect(r.source.title).toBe("sample-lib");
    expect(r.sections[0]!.heading).toBe("README.md › sample-lib");
    const headings = r.sections.map((s) => s.heading);
    expect(headings.indexOf("docs/getting-started.md › Getting started")).toBeLessThan(headings.indexOf("CHANGELOG.md › Changelog"));
    expect(headings.indexOf("package.json")).toBeLessThan(headings.indexOf("src/lru.js"));
    for (const e of r.evidence) expect(e.ref).toMatch(/^repo:[^\s#]+#L\d+(-L\d+)?$/);
    expect(r.evidence.find((e) => e.ref === "repo:src/lru.js#L1-L26")?.text).toContain("class LruCache");
    // .gitignore is respected (build/ is ignored).
    expect(headings.some((h) => h?.startsWith("build/"))).toBe(false);
  });

  it("excludes secret-bearing files, warns without the secret and flags the classification", async () => {
    const r = await repoExtractor.extract({ uri: repo, kind: "repo" });
    expect(r.sections.some((s) => s.heading?.startsWith("deploy/"))).toBe(false);
    const w = r.warnings.filter((x) => x.code === "secret_excluded");
    expect(w).toHaveLength(1);
    expect(w[0]!.message).toContain("deploy/secrets.env");
    expect(w[0]!.message).toContain("@secretlint/secretlint-rule-aws");
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(FAKE_AWS_SECRET);
    expect(r.classificationHints?.contains_secrets).toBe(true);

    const ir = buildContentIR([r], { now: "2026-09-25T00:00:00Z" });
    expect(ir.classification.contains_secrets).toBe(true);
    expect(ir.classification.data_class).toBe("restricted");
    expect(JSON.stringify(ir)).not.toContain(FAKE_AWS_SECRET);
  });

  it("positive control: repomix's own config loader WOULD execute the fixture config", async () => {
    // Proves the fixture is a live trap, so the negative assertions above are meaningful.
    const m = setMarker("MARKER-control");
    await loadFileConfig(repo, null, { skipGlobalConfig: true });
    expect(existsSync(m)).toBe(true);
  });

  it("enforces the total text budget in priority order", async () => {
    const small = createRepoExtractor({ maxTotalBytes: 1200 });
    const r = await small.extract({ uri: repo, kind: "repo" });
    expect(r.sections[0]!.heading).toBe("README.md › sample-lib");
    expect(r.sections.some((s) => s.heading === "src/lru.js")).toBe(false);
    expect(r.warnings.some((w) => w.code === "repo_truncated")).toBe(true);
  });

  it("truncates oversized files at a line boundary", async () => {
    const dir = join(tmp, "big");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "README.md"), `# Big\n\n${"word ".repeat(40)}\n`.repeat(40));
    const r = await createRepoExtractor({ maxFileBytes: 1000 }).extract({ uri: dir, kind: "repo" });
    expect(r.warnings.some((w) => w.code === "file_truncated")).toBe(true);
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("skips symlinks and binary files", async () => {
    const dir = join(tmp, "links");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# Links\n\nHello.\n");
    await writeFile(join(dir, "src", "blob.js"), Buffer.from([0x63, 0x00, 0x01, 0x02]));
    await writeFile(join(tmp, "outside-secret.md"), "# Outside\n\nShould never be read.\n");
    await symlink(join(tmp, "outside-secret.md"), join(dir, "docs.md"));
    const r = await repoExtractor.extract({ uri: dir, kind: "repo" });
    expect(r.sections.map((s) => s.heading)).toEqual(["README.md › Links"]);
    expect(r.warnings.some((w) => w.code === "binary_skipped")).toBe(true);
  });

  it("rejects remote repos unless fetchRepo is injected", async () => {
    await expect(repoExtractor.extract({ uri: "https://github.com/o/r", kind: "repo" })).rejects.toThrow(REMOTE_REPO_ERROR);
    const withFetch = createRepoExtractor({ fetchRepo: async () => repo });
    const r = await withFetch.extract({ uri: "https://github.com/o/r", kind: "repo" });
    expect(r.source.uri).toBe("https://github.com/o/r");
    expect(r.source.sha256).toBe(await repoDigest(repo));
  });

  it("digest changes when a collected file changes", async () => {
    const dir = join(tmp, "digest");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "README.md"), "# A\n");
    const a = await repoDigest(dir);
    await writeFile(join(dir, "README.md"), "# B\n");
    expect(await repoDigest(dir)).not.toBe(a);
  });
});

/** A token-shaped fake, built at runtime so repository secret scanners do not flag this test file. */
const FAKE_GITHUB_TOKEN = ["ghp", "Zx8Kq2Lm9Pw4Rt7Yv1Bn6Cd3Fg5Hj0Ks2Lq8"].join("_");

describe("scanFileForSecrets", () => {
  it("reports rule ids only", async () => {
    const f = await scanFileForSecrets("x.env", `token = ${FAKE_GITHUB_TOKEN}\n`);
    expect(f.map((x) => x.rule)).toContain("@secretlint/secretlint-rule-github");
    expect(JSON.stringify(f)).not.toContain("ghp_");
    expect(await scanFileForSecrets("a.md", "# Hello\n\nNothing to see.\n")).toEqual([]);
  });
});
