import { execFileSync } from "node:child_process";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "./server.js";

let dir: string;
let fakeBin: string;

/** Minimal yt-dlp stand-in: -J metadata, then the clip plus an English .vtt into the cwd. */
function writeFakeYtDlp(path: string, clip: string): void {
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs"), p = require("node:path");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("2026.09.01"); process.exit(0); }
if (argv.includes("-J")) {
  console.log(JSON.stringify({ _type: "video", id: "abc123XYZ00", title: "Caching talk", uploader: "Tester", duration: 1,
    webpage_url: "https://www.youtube.com/watch?v=abc123XYZ00", extractor_key: "Youtube", live_status: "not_live",
    requested_formats: [{ filesize: 1000 }], subtitles: { en: [{ ext: "vtt" }] }, automatic_captions: {}, requested_subtitles: { en: { ext: "vtt" } } }));
  process.exit(0);
}
fs.writeFileSync(p.join(process.cwd(), "media.en.vtt"), "WEBVTT\\n\\n00:00:00.000 --> 00:00:00.900\\nCaching makes renders fast.\\n");
fs.copyFileSync(${JSON.stringify(clip)}, p.join(process.cwd(), "media.mp4"));
`,
  );
  chmodSync(path, 0o755);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-ingest-subs-"));
  const clip = join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
  ]);
  await mkdir(join(dir, "bin"));
  fakeBin = join(dir, "bin", "yt-dlp");
  writeFakeYtDlp(fakeBin, clip);
}, 60_000);

afterAll(() => rm(dir, { recursive: true, force: true }));

describe("ingest tool: video URL subtitles become the transcript", () => {
  it("applies downloaded subtitles without whisper and drops the stale warning", async () => {
    const server = createServer({
      cwd: () => dir,
      env: { ...process.env, YT_DLP_PATH: fakeBin },
      ingestOptions: { cacheDir: join(dir, "cache"), noCache: true, lookup: async () => [{ address: "142.250.72.14", family: 4 }] },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const project = join(dir, "proj");
      const r = (await client.callTool({ name: "ingest", arguments: { project_dir: project, inputs: ["https://www.youtube.com/watch?v=abc123XYZ00"] } })) as CallToolResult;
      const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      expect(r.isError).toBeFalsy();
      expect(text).toMatch(/transcript for asset-\d+ from manual subtitles \(en\)/);
      const s = r.structuredContent as { transcripts: Array<{ asset: string; words: number }>; warnings: Array<{ code: string }> };
      expect(s.transcripts[0]!.words).toBeGreaterThan(0);
      expect(s.warnings.map((w) => w.code)).not.toContain("needs_transcript");
      const ir = JSON.parse(await readFile(join(project, "source", "content-ir.json"), "utf8"));
      const video = ir.assets.find((a: { kind: string }) => a.kind === "video");
      expect(video.media.transcript.source).toBe("vtt");
      expect(video.media.subtitles[0]).toMatchObject({ lang: "en", kind: "manual" });
    } finally {
      await client.close();
    }
  }, 120_000);
});
