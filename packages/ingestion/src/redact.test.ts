import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingest } from "./ingest.js";
import { mapOffset, redactPart } from "./redact.js";
import type { ExtractedSource } from "./types.js";

// Fake credentials built at runtime so the repo itself holds no scanner-bait literals.
const AWS_ID = ["AKIA", "QWERTYUIOPASDF12"].join("");
const AWS_SECRET = ["Zq8d3Kf9Lm2Nx7Pw", "4Rt6Vy1Bc5Hj0Gs3Ua9Ek2Wo"].join("");
const KEY_BODY = [
  "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
  "VTLw7onLRnrq0/IzW7yWR7QkrmBL7jTKEn5u+qKhbwKfBstIs+bMY2Zkp18gnTxK",
].join("\n");
const PEM = `-----BEGIN RSA ${"PRIVATE"} KEY-----\n${KEY_BODY}\n-----END RSA ${"PRIVATE"} KEY-----`;

const TEXT = `Deploy notes

Our deploy script uses the access key ${AWS_ID} for the staging bucket.
aws_secret_access_key = ${AWS_SECRET}

The signing key is below.

${PEM}

Everything else about the rollout is ordinary prose that must stay untouched.
`;

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-redact-"));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await filesUnder(p)));
    else out.push(p);
  }
  return out;
}

describe("secret redaction (S3)", () => {
  it("redacts an AWS key and a PEM block from a .txt, in content-ir.json and in the ingest cache", async () => {
    const file = join(tmp, "notes.txt");
    await writeFile(file, TEXT);
    const cacheDir = join(tmp, "cache");
    const projectDir = join(tmp, "proj");
    const { ir, summary } = await ingest([file], { projectDir, cacheDir, cwd: tmp, now: "2026-09-26T00:00:00.000Z" });

    const onDisk = await readFile(join(projectDir, "source", "content-ir.json"), "utf8");
    for (const secret of [AWS_ID, AWS_SECRET, KEY_BODY.split("\n")[0]!, KEY_BODY.split("\n")[1]!, "BEGIN RSA PRIVATE KEY"]) {
      expect(onDisk).not.toContain(secret);
      for (const f of await filesUnder(cacheDir)) expect(await readFile(f, "utf8")).not.toContain(secret);
    }
    expect(onDisk).toContain("[REDACTED:aws_access_key_id]");
    expect(onDisk).toMatch(/\[REDACTED:(private_key|secretlint-privatekey)\]/);
    expect(onDisk).toMatch(/\[REDACTED:secretlint-aws\]|\[REDACTED:high_entropy_assignment\]/);
    expect(onDisk).toContain("Everything else about the rollout is ordinary prose that must stay untouched.");

    const redacted = ir.warnings.filter((w) => w.code === "secret_redacted");
    expect(redacted.length).toBeGreaterThanOrEqual(2);
    expect(redacted.every((w) => w.source_id === "src-1")).toBe(true);
    expect(redacted.map((w) => w.message).join("\n")).toMatch(/rule aws_access_key_id/);
    expect(summary.classification).toMatchObject({ contains_secrets: true, data_class: "restricted" });
    expect(ir.classification.notes.some((n) => n.startsWith("src-1: secret redacted: aws_access_key_id"))).toBe(true);
    // Excerpts still locate their span in the original file (offsets are untouched there).
    for (const e of ir.evidence) expect(e.locator.char_end! >= e.locator.char_start!).toBe(true);

    // A cache hit serves the redacted part, with the same warnings and classification.
    const again = await ingest([file], { projectDir: join(tmp, "proj2"), cacheDir, cwd: tmp });
    expect(again.provenance.sources[0]!.cache_hit).toBe(true);
    expect(JSON.stringify(again.ir)).not.toContain(AWS_ID);
    expect(again.ir.warnings.filter((w) => w.code === "secret_redacted")).toEqual(redacted);
    expect(again.ir.classification.contains_secrets).toBe(true);
  });

  it("redacts inline text inputs as well", async () => {
    const { ir } = await ingest([{ uri: "inline", kind: "text", content: TEXT }], { projectDir: join(tmp, "inline"), noCache: true });
    expect(JSON.stringify(ir)).not.toContain(AWS_ID);
    expect(ir.classification.contains_secrets).toBe(true);
  });

  it("leaves ordinary text untouched", async () => {
    const plain = "Vector databases index embeddings.\n\nApproximate search trades a little recall for a lot of speed.\n";
    const file = join(tmp, "plain.txt");
    await writeFile(file, plain);
    const { ir } = await ingest([file], { projectDir: join(tmp, "plain"), noCache: true, cwd: tmp });
    expect(ir.warnings.filter((w) => w.code === "secret_redacted")).toEqual([]);
    expect(ir.classification.contains_secrets).toBe(false);
    expect(ir.evidence.map((e) => e.text).join("\n\n")).toBe(plain.trim());
    const part: ExtractedSource = {
      source: { kind: "text", uri: "x", sha256: "0".repeat(64) },
      sections: [{ text: plain }],
      evidence: [],
      assets: [],
      warnings: [],
    };
    expect(await redactPart(part)).toBe(part);
  });

  it("keeps section-relative evidence offsets consistent (DOCX-style locators)", async () => {
    const sec = `Intro words. Key ${AWS_ID} here. Tail words.`;
    const ev = `Key ${AWS_ID} here.`;
    const cs = sec.indexOf(ev);
    const part: ExtractedSource = {
      source: { kind: "docx", uri: "d.docx", sha256: "0".repeat(64), title: `Title ${AWS_ID}` },
      sections: [{ heading: "H", text: sec }],
      evidence: [
        { ref: "docx:d.docx#para-1", text: ev, locator: { selector: "#para-1", char_start: cs, char_end: cs + ev.length } },
        { ref: "docx:d.docx#para-2", text: "Tail words.", locator: { selector: "#para-2", char_start: sec.indexOf("Tail"), char_end: sec.length } },
      ],
      assets: [],
      warnings: [],
    };
    const out = await redactPart(part);
    expect(out.source.title).toBe("Title [REDACTED:aws_access_key_id]");
    const text = out.sections[0]!.text;
    expect(text).toBe("Intro words. Key [REDACTED:aws_access_key_id] here. Tail words.");
    for (const e of out.evidence) expect(text.slice(e.locator.char_start, e.locator.char_end)).toBe(e.text);
    expect(out.evidence[0]!.text).toBe("Key [REDACTED:aws_access_key_id] here.");
    expect(out.classificationHints).toMatchObject({ contains_secrets: true });
    expect(JSON.stringify(out.warnings)).not.toContain(AWS_ID);
    // Idempotent: redacting again changes nothing.
    expect(await redactPart(out)).toBe(out);
  });

  it("mapOffset shifts offsets after a replacement and snaps inside one", () => {
    const edits = [{ start: 4, end: 10, len: 3 }];
    expect(mapOffset(edits, 2, "start")).toBe(2);
    expect(mapOffset(edits, 4, "start")).toBe(4);
    expect(mapOffset(edits, 6, "start")).toBe(4);
    expect(mapOffset(edits, 6, "end")).toBe(7);
    expect(mapOffset(edits, 10, "end")).toBe(7);
    expect(mapOffset(edits, 12, "end")).toBe(9);
  });
});
