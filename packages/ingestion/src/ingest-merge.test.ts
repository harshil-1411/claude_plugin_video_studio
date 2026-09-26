import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentIR } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingest } from "./ingest.js";

const NOW = "2026-09-25T12:00:00.000Z";
const LATER = "2026-09-26T08:00:00.000Z";

const A1 = "# Alpha\n\nThe cache cut latency by 40% in 2026.\n\nIt also cut costs by 12% per month.\n";
// Same first paragraph (same lines), second claim reworded, a new section appended.
const A2 = "# Alpha\n\nThe cache cut latency by 40% in 2026.\n\nIt was cheap to run.\n\n## Rollout\n\nWe rolled it out to 300 customers in 3 weeks.\n";
const B = "# Beta\n\nThe index serves 5000 queries per second.\n";

let tmp: string;
let a: string;
let b: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-merge-"));
  a = join(tmp, "alpha.md");
  b = join(tmp, "beta.md");
  await writeFile(a, A1);
  await writeFile(b, B);
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

const readIr = async (p: string) => ContentIR.parse(JSON.parse(await readFile(join(p, "source/content-ir.json"), "utf8")));
const readProv = async (p: string) => JSON.parse(await readFile(join(p, "source/provenance.json"), "utf8"));
const opts = (projectDir: string, now = NOW) => ({ projectDir, now, noCache: true, cwd: tmp });

describe("re-ingest merges into the existing ContentIR", () => {
  const project = () => join(tmp, "merge");

  it("keeps A (ids and refs unchanged) when B is added", async () => {
    await writeFile(a, A1);
    const first = await ingest([a], opts(project()));
    expect(first.summary.mode).toBe("created");
    const second = await ingest([b], opts(project(), LATER));
    const ir = second.ir;
    expect(second.summary.mode).toBe("merged");
    expect(second.summary.sources).toEqual([expect.objectContaining({ id: "src-2", status: "added", uri: b })]);
    expect(second.summary.total_sources).toBe(2);
    expect(ir.id).toBe(first.ir.id);
    expect(ir.created_at).toBe(first.ir.created_at);
    expect(ir.sources.map((s) => s.id)).toEqual(["src-1", "src-2"]);
    // Everything A had is still there, byte for byte.
    expect(ir.sources[0]).toEqual(first.ir.sources[0]);
    expect(ir.sections.filter((s) => s.source_id === "src-1")).toEqual(first.ir.sections);
    expect(ir.evidence.filter((e) => e.source_id === "src-1")).toEqual(first.ir.evidence);
    for (const c of first.ir.claims) expect(ir.claims).toContainEqual(c);
    for (const e of first.ir.entities) expect(ir.entities.find((x) => x.name === e.name)?.id).toBe(e.id);
    // B is new, numbered after A.
    expect(ir.evidence.some((e) => e.source_id === "src-2" && e.text.includes("5000 queries"))).toBe(true);
    const bClaim = ir.claims.find((c) => c.text.includes("5000 queries"))!;
    expect(Number(bClaim.id.slice(6))).toBeGreaterThan(first.ir.claims.length);
    expect(new Set(ir.sections.map((s) => s.id)).size).toBe(ir.sections.length);
    // Provenance appends.
    const prov = await readProv(project());
    expect(prov.sources.map((s: { source_id: string }) => s.source_id)).toEqual(["src-1", "src-2"]);
    expect(prov).toMatchObject({ ir_id: first.ir.id, created_at: NOW, updated_at: LATER });
    expect(await readIr(project())).toEqual(ir);
  });

  it("refreshes a changed A in place: same source id, unchanged spans keep their refs and claim ids", async () => {
    const before = await readIr(project());
    await writeFile(a, A2);
    const { ir, summary } = await ingest([a], opts(project(), LATER));
    expect(summary.sources).toEqual([expect.objectContaining({ id: "src-1", status: "updated" })]);
    expect(ir.sources.map((s) => s.id)).toEqual(["src-1", "src-2"]);
    expect(ir.sources[0]!.sha256).not.toBe(before.sources[0]!.sha256);
    // The unchanged paragraph: same ref, same claim id.
    const oldLatency = before.evidence.find((e) => e.text.includes("40%"))!;
    expect(ir.evidence.find((e) => e.ref === oldLatency.ref)?.text).toBe(oldLatency.text);
    const latencyClaim = before.claims.find((c) => c.text.includes("40%"))!;
    expect(ir.claims.find((c) => c.id === latencyClaim.id)?.text).toBe(latencyClaim.text);
    // The reworded paragraph's claim is gone; the new one is added with a fresh id.
    const costClaim = before.claims.find((c) => c.text.includes("12%"))!;
    expect(ir.claims.find((c) => c.id === costClaim.id)).toBeUndefined();
    expect(ir.claims.some((c) => c.text.includes("12%"))).toBe(false);
    const rollout = ir.claims.find((c) => c.text.includes("300 customers"))!;
    const maxBefore = Math.max(...before.claims.map((c) => Number(c.id.slice(6))));
    expect(Number(rollout.id.slice(6))).toBeGreaterThan(maxBefore);
    expect(ir.evidence.filter((e) => e.source_id === "src-1").some((e) => e.text.includes("cheap to run"))).toBe(true);
    // The first section keeps its id; B is untouched.
    const alphaSec = before.sections.find((s) => s.source_id === "src-1" && s.heading === "Alpha")!;
    expect(ir.sections.find((s) => s.heading === "Alpha")?.id).toBe(alphaSec.id);
    expect(ir.evidence.filter((e) => e.source_id === "src-2")).toEqual(before.evidence.filter((e) => e.source_id === "src-2"));
    // Every claim ref resolves.
    const refs = new Set(ir.evidence.map((e) => e.ref));
    for (const c of ir.claims) for (const r of c.evidence_refs) expect(refs.has(r)).toBe(true);
    expect((await readProv(project())).sources.map((s: { source_id: string }) => s.source_id)).toEqual(["src-2", "src-1"]);
  });

  it("re-ingesting identical bytes changes nothing but provenance", async () => {
    const before = await readIr(project());
    const { ir, summary } = await ingest([a], opts(project(), LATER));
    expect(summary.sources[0]).toMatchObject({ id: "src-1", status: "updated" });
    expect(ir).toEqual(before);
  });

  it("replace: true starts fresh with only the new input", async () => {
    const { ir, summary } = await ingest([b], { ...opts(project(), LATER), replace: true });
    expect(summary.mode).toBe("replaced");
    expect(ir.sources).toHaveLength(1);
    expect(ir.sources[0]).toMatchObject({ id: "src-1", uri: b });
    expect((await readProv(project())).sources).toHaveLength(1);
  });

  it("refuses to overwrite an existing ContentIR that is not valid", async () => {
    const p = join(tmp, "broken");
    await ingest([a], opts(p));
    await writeFile(join(p, "source/content-ir.json"), '{"schema_version":"1.0"}');
    await expect(ingest([b], opts(p))).rejects.toThrow(/not a valid ContentIR .*replace: true/);
    expect(await readFile(join(p, "source/content-ir.json"), "utf8")).toBe('{"schema_version":"1.0"}');
    await expect(ingest([b], { ...opts(p), replace: true })).resolves.toBeTruthy();
  });

  it("clears an earlier failure once the input is retried", async () => {
    const p = join(tmp, "retry");
    const late = join(tmp, "late.md");
    await expect(ingest([a, late], opts(p))).resolves.toMatchObject({ summary: { warnings: [expect.objectContaining({ code: "ingest_failed" })] } });
    await writeFile(late, "# Late\n\nArrived later.\n");
    const { ir } = await ingest([late], opts(p));
    expect(ir.warnings.filter((w) => w.code === "ingest_failed")).toEqual([]);
    expect(ir.sources).toHaveLength(2);
  });
});

describe("merge keeps what transcribe and demo added", () => {
  let audio: string;
  beforeAll(() => {
    audio = join(tmp, "talk.m4a");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-c:a", "aac", audio]);
  }, 60_000);

  it("transcript evidence, sections, claims, media.transcript and demo sources survive later ingests", async () => {
    const p = join(tmp, "media");
    await writeFile(a, A1);
    const first = await ingest([audio, a], opts(p));
    const ir = structuredClone(first.ir);
    const audioSrc = ir.sources.find((s) => s.kind === "audio")!;
    const asset = ir.assets.find((x) => x.kind === "audio")!;
    // What transcribe (packages/mcp/src/transcribe.ts applyTranscript) writes.
    ir.evidence.push({ ref: "audio:talk.m4a#t=0.0-1.0", source_id: audioSrc.id, text: "Revenue grew 25% in 2025.", locator: { time_start_sec: 0, time_end_sec: 1 } });
    ir.sections.push({ id: "sec-50", source_id: audioSrc.id, heading: `Transcript (${asset.id})`, text: "Revenue grew 25% in 2025." });
    ir.claims.push({ id: "claim-50", text: "Revenue grew 25% in 2025.", kind: "quantitative", evidence_refs: ["audio:talk.m4a#t=0.0-1.0"] });
    asset.media = { ...asset.media!, transcript: { path: `source/transcripts/${asset.id}.json`, source: "srt", words: 5 } };
    ir.classification.notes.push(`${audioSrc.id} (speech): note`);
    // What demo (packages/mcp/src/demo.ts recordInIr) writes.
    ir.sources.push({ id: "demo-app", kind: "video", uri: "http://localhost:3000", sha256: "a".repeat(64), title: "Demo recording" });
    ir.sections.push({ id: "demo-app-steps", source_id: "demo-app", heading: "Demo steps", text: "1. open" });
    ir.evidence.push({ ref: "video:demo-app.mp4#step-1", source_id: "demo-app", text: "open (at 0.0 s)", locator: { time_start_sec: 0, time_end_sec: 1 } });
    ir.assets.push({ id: "asset-demo", kind: "video", path: "source/assets/demo-app.mp4", sha256: "a".repeat(64), source_ref: "video:demo-app.mp4" });
    await writeFile(join(p, "source/content-ir.json"), JSON.stringify(ContentIR.parse(ir)));

    const added = (await ingest([b], opts(p))).ir;
    for (const e of ir.evidence) expect(added.evidence).toContainEqual(e);
    for (const s of ir.sections) expect(added.sections).toContainEqual(s);
    expect(added.claims).toContainEqual(ir.claims.find((c) => c.id === "claim-50"));
    expect(added.assets).toEqual(expect.arrayContaining(ir.assets));
    expect(added.sources).toEqual(expect.arrayContaining(ir.sources));
    expect(added.classification.notes).toContain(`${audioSrc.id} (speech): note`);

    // Re-ingesting the same media file refreshes it in place and keeps its transcript.
    const again = (await ingest([audio], opts(p))).ir;
    expect(again.sources.find((s) => s.id === audioSrc.id)).toEqual(audioSrc);
    expect(again.sources.filter((s) => s.kind === "audio")).toHaveLength(1);
    expect(again.assets.find((x) => x.id === asset.id)?.media?.transcript).toEqual(asset.media.transcript);
    expect(again.evidence.find((e) => e.ref === "audio:talk.m4a#t=0.0-1.0")).toBeTruthy();
    expect(again.sections.find((s) => s.id === "sec-50")).toBeTruthy();
    expect(again.claims.find((c) => c.id === "claim-50")).toBeTruthy();
    expect(again.sources.find((s) => s.id === "demo-app")).toBeTruthy();
    expect(again.assets.find((x) => x.id === "asset-demo")).toBeTruthy();
    expect(again.assets.filter((x) => x.kind === "audio")).toHaveLength(1);

    // A changed media file drops the stale transcript, with a warning.
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=1", "-c:a", "aac", audio]);
    const changed = (await ingest([audio], opts(p))).ir;
    expect(changed.sources.find((s) => s.id === audioSrc.id)!.sha256).not.toBe(audioSrc.sha256);
    expect(changed.evidence.find((e) => e.ref === "audio:talk.m4a#t=0.0-1.0")).toBeUndefined();
    expect(changed.claims.find((c) => c.id === "claim-50")).toBeUndefined();
    expect(changed.warnings).toContainEqual(expect.objectContaining({ code: "transcript_dropped", source_id: audioSrc.id }));
    expect(changed.assets.filter((x) => x.kind === "audio")).toHaveLength(1);
    const changedAsset = changed.assets.find((x) => x.kind === "audio")!;
    expect(changedAsset.id).toBe(asset.id); // footage scenes keep resolving
    expect(changedAsset.sha256).not.toBe(asset.sha256);
    expect(changedAsset.media?.transcript).toBeUndefined();
    expect(changed.evidence.find((e) => e.ref === "video:demo-app.mp4#step-1")).toBeTruthy();
  }, 60_000);
});
