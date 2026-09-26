import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentIR } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectKind, isDirectMediaUrl, videoPlatform } from "./detect.js";
import { IngestError, type Provenance, ingest } from "./ingest.js";
import type { LookupFn } from "./net-guard.js";
import {
  YT_DLP_FORMAT,
  YT_DLP_SAFETY_ARGS,
  createVideoUrlExtractor,
  rankSubtitles,
  subLangs,
  ytDlpDownloadArgs,
  ytDlpMetadataArgs,
} from "./video-url.js";

const PUBLIC_DNS: LookupFn = async () => [{ address: "142.250.72.14", family: 4 }];

let dir: string;
let clip: string;
let fakeBin: string;
let argvLog: string;

const VTT_MANUAL = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello from the manual subtitles.\n";
const VTT_AUTO = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhello from the automatic captions\n";

/**
 * A fake yt-dlp following the real argv contract for the flags the engine uses:
 * `--version`; `-J` prints one JSON object (a playlist for a `list=` URL without --no-playlist);
 * otherwise downloads into the cwd per `-o media.%(ext)s`, writes `media.<lang>.vtt` for the
 * requested subtitles and honours `--max-filesize` (skips with the real message, exit 0).
 * Scenario words in the URL: `huge` (3 GB estimate), `noest` (no size estimate), `auto`
 * (automatic captions only), `nosubs`. Every argv is appended to a log as JSON.
 */
function writeFakeYtDlp(path: string, log: string, fixture: string): void {
  const src = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), env: Object.keys(process.env) }) + "\\n");
if (argv.includes("--version")) { console.log("2026.09.01"); process.exit(0); }
const url = argv[argv.indexOf("--") + 1];
if (!url) { console.error("ERROR: no URL"); process.exit(2); }
const noPlaylist = argv.includes("--no-playlist");
const scenario = url;
const manual = scenario.includes("auto") || scenario.includes("nosubs") ? {} : { en: [{ ext: "vtt" }] };
const automatic = scenario.includes("nosubs") ? {} : { en: [{ ext: "vtt" }], "en-orig": [{ ext: "vtt" }] };
const sized = !scenario.includes("noest");
const requested = scenario.includes("nosubs") ? null : scenario.includes("auto") ? { en: { ext: "vtt" }, "en-orig": { ext: "vtt" } } : { en: { ext: "vtt" } };
if (argv.includes("-J")) {
  if (url.includes("list=") && !noPlaylist) { console.log(JSON.stringify({ _type: "playlist", entries: [{ id: "a" }, { id: "b" }] })); process.exit(0); }
  const size = scenario.includes("huge") ? 3e9 : fs.statSync(${JSON.stringify(fixture)}).size;
  console.log(JSON.stringify({
    _type: "video", id: "abc123XYZ00", title: "Fake talk\\u0007 about caching", uploader: "Tester", duration: 1.0,
    webpage_url: "https://www.youtube.com/watch?v=abc123XYZ00", extractor_key: "Youtube",
    license: "Creative Commons Attribution license (reuse allowed)", live_status: "not_live",
    requested_formats: sized ? [{ filesize_approx: size - 100 }, { filesize: 100 }] : [{}, {}],
    subtitles: manual, automatic_captions: automatic, requested_subtitles: requested, _version: { version: "2026.09.01" },
  }));
  process.exit(0);
}
const max = Number(argv[argv.indexOf("--max-filesize") + 1]);
const out = argv[argv.indexOf("-o") + 1];
const size = fs.statSync(${JSON.stringify(fixture)}).size;
if (Number.isFinite(max) && size > max) { console.log("[download] File is larger than max-filesize (" + size + " bytes > " + max + " bytes). Aborting."); process.exit(0); }
if (requested) for (const lang of Object.keys(requested)) {
  const auto = !(lang in manual);
  fs.writeFileSync(path.join(process.cwd(), "media." + lang + ".vtt"), auto ? ${JSON.stringify(VTT_AUTO)} : ${JSON.stringify(VTT_MANUAL)});
}
fs.copyFileSync(${JSON.stringify(fixture)}, path.join(process.cwd(), out.replace("%(ext)s", "mp4")));
console.log("[Merger] Merging formats into \\"media.mp4\\"");
`;
  writeFileSync(path, src);
  chmodSync(path, 0o755);
}

function readArgvLog(): Array<{ argv: string[]; cwd: string; env: string[] }> {
  return existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "vs-video-url-"));
  clip = join(dir, "clip.mp4");
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc=size=160x120:rate=15:duration=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
  ]);
  fakeBin = join(dir, "bin", "yt-dlp");
  argvLog = join(dir, "argv.log");
  await mkdir(join(dir, "bin"));
  writeFakeYtDlp(fakeBin, argvLog, clip);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ytEnv = () => ({ PATH: process.env.PATH, YT_DLP_PATH: fakeBin, ELEVENLABS_API_KEY: "sk-should-not-leak" });

describe("video URL detection", () => {
  it("recognizes YouTube, Vimeo and Loom video pages", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/shorts/abcdefghijk",
      "https://www.youtube.com/live/abcdefghijk",
      "https://www.youtube.com/embed/abcdefghijk",
      "https://www.youtube-nocookie.com/embed/abcdefghijk",
      "https://www.youtube.com/playlist?list=PL123",
    ]) {
      expect(videoPlatform(u), u).toBe("youtube");
      expect(detectKind(u), u).toBe("video_url");
    }
    for (const u of ["https://vimeo.com/76979871", "https://player.vimeo.com/video/76979871", "https://vimeo.com/channels/staffpicks/76979871"]) {
      expect(videoPlatform(u), u).toBe("vimeo");
      expect(detectKind(u)).toBe("video_url");
    }
    for (const u of ["https://www.loom.com/share/0281766fa2d04bb788eaf19e65135184", "https://loom.com/embed/0281766fa2d04bb788eaf19e65135184"]) {
      expect(videoPlatform(u), u).toBe("loom");
    }
  });

  it("keeps other pages on those sites as web pages", () => {
    for (const u of [
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/feed/trending",
      "https://www.youtube.com/watch",
      "https://vimeo.com/pricing",
      "https://www.loom.com/pricing",
      "https://notyoutube.com/watch?v=abc",
      "https://example.com/video",
    ]) {
      expect(videoPlatform(u), u).toBeUndefined();
      expect(detectKind(u), u).toBe("url");
    }
  });

  it("recognizes direct media URLs by extension (query strings allowed)", () => {
    for (const u of [
      "https://cdn.example.com/talk.mp4",
      "https://cdn.example.com/a/b/Talk%20Final.MOV?sig=abc",
      "http://example.com/x.webm",
      "https://example.com/pod/ep1.mp3",
      "https://example.com/a.m4a#t=10",
      "https://example.com/a.wav",
      "https://example.com/a.mkv",
      "https://example.com/a.m4v",
    ]) {
      expect(isDirectMediaUrl(u), u).toBe(true);
      expect(detectKind(u), u).toBe("video_url");
    }
    for (const u of ["https://example.com/a.html", "https://example.com/mp4", "https://example.com/a.mp4.html", "https://github.com/acme/widgetron/blob/main/demo.mp4"]) {
      expect(isDirectMediaUrl(u) && !u.includes("github"), u).toBe(false);
    }
    expect(detectKind("https://github.com/acme/widgetron")).toBe("repo");
  });
});

describe("yt-dlp argv", () => {
  it("carries the safety flags, capped format, size cap and subtitle preference", () => {
    const meta = ytDlpMetadataArgs("https://youtu.be/abcdefghijk");
    const dl = ytDlpDownloadArgs("https://youtu.be/abcdefghijk", { maxBytes: 1234 });
    for (const args of [meta, dl]) {
      for (const f of ["--ignore-config", "--no-playlist", "--restrict-filenames", "--no-exec", "--no-cookies", "--no-cookies-from-browser", "--no-batch-file"]) expect(args).toContain(f);
      expect(args[args.indexOf("--use-extractors") + 1]).toBe("default,-generic");
      expect(args[args.indexOf("-f") + 1]).toBe(YT_DLP_FORMAT);
      expect(args[args.indexOf("--sub-format") + 1]).toBe("vtt");
      expect(args).toContain("--write-subs");
      expect(args).toContain("--write-auto-subs");
      // The URL comes last, after `--`, so it can never be read as an option.
      expect(args.slice(-2)).toEqual(["--", "https://youtu.be/abcdefghijk"]);
    }
    expect(meta).toContain("-J");
    expect(dl[dl.indexOf("--max-filesize") + 1]).toBe("1234");
    expect(dl[dl.indexOf("--merge-output-format") + 1]).toBe("mp4");
    expect(dl[dl.indexOf("-o") + 1]).toBe("media.%(ext)s");
    expect(YT_DLP_FORMAT).toBe("bv*[height<=1080]+ba/b[height<=1080]");
    expect(subLangs("hi")).toBe("hi.*,en.*,-live_chat");
    expect(subLangs("en")).toBe("en.*,-live_chat");
    expect(YT_DLP_SAFETY_ARGS).not.toContain("--cookies");
  });

  it("ranks manual subtitles before automatic ones, exact language first", () => {
    const ranked = rankSubtitles([
      { lang: "en-orig", kind: "auto" as const },
      { lang: "en-US", kind: "manual" as const },
      { lang: "en", kind: "auto" as const },
      { lang: "en", kind: "manual" as const },
    ]);
    expect(ranked.map((s) => `${s.kind}:${s.lang}`)).toEqual(["manual:en", "manual:en-US", "auto:en", "auto:en-orig"]);
  });
});

describe("ingest a platform URL through yt-dlp (fake)", () => {
  it("downloads, ingests like a local video, keeps subtitles and records provenance", async () => {
    const projectDir = join(dir, "yt1");
    const url = "https://www.youtube.com/watch?v=abc123XYZ00";
    const { ir, provenance, summary } = await ingest([url], { projectDir, noCache: true, env: ytEnv(), lookup: PUBLIC_DNS });
    expect(ContentIR.safeParse(ir).success).toBe(true);
    const src = ir.sources[0]!;
    expect(src.kind).toBe("video");
    expect(src.uri).toBe(url);
    expect(src.title).toBe("Fake talk about caching");
    expect(src.remote).toMatchObject({
      url,
      via: "yt-dlp",
      webpage_url: "https://www.youtube.com/watch?v=abc123XYZ00",
      extractor: "Youtube",
      video_id: "abc123XYZ00",
      uploader: "Tester",
      duration_sec: 1,
      license: "Creative Commons Attribution license (reuse allowed)",
      downloader_version: "2026.09.01",
    });
    expect(src.remote!.bytes).toBe(statSync(clip).size);
    const video = ir.assets.find((a) => a.kind === "video")!;
    expect(video.path).toBe(`source/assets/${video.sha256}.mp4`);
    expect(video.source_ref).toBe(`video:${url}`);
    expect(video.media?.has_audio).toBe(true);
    expect(video.media?.subtitles).toEqual([{ path: `source/assets/${video.sha256}.en.vtt`, lang: "en", kind: "manual" }]);
    expect(readFileSync(join(projectDir, video.media!.subtitles![0]!.path), "utf8")).toBe(VTT_MANUAL);
    expect(ir.sections[0]!.text).toContain("Import them with transcribe captions_file");
    expect(summary.warnings.find((w) => w.code === "needs_transcript")?.message).toContain(`captions_file source/assets/${video.sha256}.en.vtt`);
    expect(ir.classification.notes.join("\n")).toMatch(/rights: downloaded from www\.youtube\.com \(license: Creative Commons.*use only videos you have the right to use/);
    const p = provenance.sources[0]!;
    expect(p.remote?.via).toBe("yt-dlp");
    expect(p.sha256).toBe(video.sha256);
    const onDisk = JSON.parse(readFileSync(join(projectDir, "source", "provenance.json"), "utf8")) as Provenance;
    expect(onDisk.sources[0]!.remote?.url).toBe(url);
    // The staging folder is gone; nothing but assets remain.
    expect(existsSync(join(projectDir, "source", ".downloads"))).toBe(false);

    const runs = readArgvLog().filter((r) => r.argv.includes(url));
    expect(runs).toHaveLength(2);
    for (const r of runs) {
      for (const f of ["--ignore-config", "--no-playlist", "--no-exec", "--no-cookies", "--restrict-filenames"]) expect(r.argv).toContain(f);
      expect(r.cwd).toContain(join("yt1", "source", ".downloads", "dl-"));
      // Only allowlisted environment reaches yt-dlp: no API keys.
      expect(r.env).not.toContain("ELEVENLABS_API_KEY");
      expect(r.env).not.toContain("YT_DLP_PATH");
    }
  }, 60_000);

  it("records automatic captions as auto, best first", async () => {
    const { ir } = await ingest(["https://youtu.be/autocaps123"], { projectDir: join(dir, "yt-auto"), noCache: true, env: ytEnv(), lookup: PUBLIC_DNS });
    const subs = ir.assets.find((a) => a.kind === "video")!.media!.subtitles!;
    expect(subs.map((s) => `${s.kind}:${s.lang}`)).toEqual(["auto:en", "auto:en-orig"]);
  }, 60_000);

  it("treats a watch URL inside a playlist as that single video; refuses a bare playlist", async () => {
    const url = "https://www.youtube.com/watch?v=abc123XYZ00&list=PLxyz&index=3";
    const { ir } = await ingest([url], { projectDir: join(dir, "yt-list"), noCache: true, env: ytEnv(), lookup: PUBLIC_DNS });
    expect(ir.sources).toHaveLength(1);
    expect(ir.sources[0]!.kind).toBe("video");
    const err = await ingest(["https://www.youtube.com/playlist?list=PLxyz"], { projectDir: join(dir, "yt-pl"), noCache: true, env: ytEnv(), lookup: PUBLIC_DNS }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect((err as IngestError).failures[0]!.error).toMatch(/is a playlist; ingest the videos one URL at a time/);
  }, 60_000);

  it("refuses oversize videos: from the metadata estimate, and when yt-dlp skips the file", async () => {
    const e1 = await ingest(["https://youtu.be/huge1234567"], { projectDir: join(dir, "yt-huge"), noCache: true, env: ytEnv(), lookup: PUBLIC_DNS }).catch((e) => e);
    expect((e1 as IngestError).failures[0]!.error).toMatch(/is about 2861 MB; video URLs are limited to 2048 MB\. Download a shorter or lower-resolution copy yourself/);
    const tiny = createVideoUrlExtractor({ env: ytEnv(), lookup: PUBLIC_DNS, maxBytes: 1000 });
    // Estimate over the cap: refused before any download.
    let before = readArgvLog().length;
    const e2 = await ingest(["https://youtu.be/small123456"], { projectDir: join(dir, "yt-cap"), noCache: true, env: ytEnv(), lookup: PUBLIC_DNS, extractors: { video_url: tiny } }).catch((e) => e);
    expect((e2 as IngestError).failures[0]!.error).toMatch(/limited to 1000 bytes/);
    expect(readArgvLog().slice(before).some((r) => r.argv.includes("--max-filesize"))).toBe(false);
    // No estimate: yt-dlp's --max-filesize skips the file (exit 0) and ingest reports it.
    before = readArgvLog().length;
    const e3 = await ingest(["https://youtu.be/noest123456"], { projectDir: join(dir, "yt-cap"), noCache: true, env: ytEnv(), lookup: PUBLIC_DNS, extractors: { video_url: tiny } }).catch((e) => e);
    expect((e3 as IngestError).failures[0]!.error).toMatch(/is larger than the limit; video URLs are limited to 1000 bytes/);
    const dl = readArgvLog().slice(before).find((r) => r.argv.includes("--max-filesize"))!;
    expect(dl.argv[dl.argv.indexOf("--max-filesize") + 1]).toBe("1000");
    expect(existsSync(join(dir, "yt-cap", "source", "assets"))).toBe(false);
  }, 60_000);

  it("explains how to get yt-dlp when it is missing", async () => {
    const emptyPath = join(dir, "empty-bin");
    await mkdir(emptyPath, { recursive: true });
    const err = await ingest(["https://youtu.be/abcdefghijk"], { projectDir: join(dir, "yt-missing"), noCache: true, env: { PATH: emptyPath }, lookup: PUBLIC_DNS }).catch((e) => e);
    expect((err as IngestError).failures[0]!.error).toBe(
      "yt-dlp is not installed: brew install yt-dlp (or pipx install yt-dlp), then ingest again; or download the video yourself and ingest the file",
    );
    const bad = await ingest(["https://youtu.be/abcdefghijk"], { projectDir: join(dir, "yt-missing2"), noCache: true, env: { PATH: emptyPath, YT_DLP_PATH: join(dir, "nope") }, lookup: PUBLIC_DNS }).catch((e) => e);
    expect((bad as IngestError).failures[0]!.error).toMatch(/YT_DLP_PATH points at .*nope, which is not an executable file/);
  });

  it("checks the host with the SSRF guard before starting yt-dlp", async () => {
    const before = readArgvLog().length;
    const privateDns: LookupFn = async () => [{ address: "10.0.0.5", family: 4 }];
    const err = await ingest(["https://www.youtube.com/watch?v=abc123XYZ00"], { projectDir: join(dir, "yt-ssrf"), noCache: true, env: ytEnv(), lookup: privateDns }).catch((e) => e);
    expect((err as IngestError).failures[0]!.error).toMatch(/private or local address \(10\.0\.0\.5\)/);
    expect(readArgvLog().length).toBe(before);
  });

  it("restores the subtitles from the extraction cache in another project", async () => {
    const cacheDir = join(dir, "cache");
    const url = "https://www.youtube.com/watch?v=cachedvideo1";
    await ingest([url], { projectDir: join(dir, "yt-c1"), cacheDir, env: ytEnv(), lookup: PUBLIC_DNS });
    const runs = readArgvLog().length;
    const { ir, summary } = await ingest([url], { projectDir: join(dir, "yt-c2"), cacheDir, env: ytEnv(), lookup: PUBLIC_DNS });
    expect(summary.sources[0]!.cache_hit).toBe(true);
    expect(readArgvLog().length).toBe(runs);
    const sub = ir.assets.find((a) => a.kind === "video")!.media!.subtitles![0]!;
    expect(readFileSync(join(dir, "yt-c2", sub.path), "utf8")).toBe(VTT_MANUAL);
  }, 60_000);
});

describe("ingest a direct media URL", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const bytes = readFileSync(clip);
    server = createServer((req, res) => {
      if (req.url === "/media/talk.mp4" || req.url === "/stream") {
        res.writeHead(200, { "content-type": "video/mp4", "content-length": String(bytes.length) });
        res.end(bytes);
      } else if (req.url === "/moved.mp4") {
        res.writeHead(302, { location: "/media/talk.mp4" });
        res.end();
      } else if (req.url === "/page.mp4") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>login</body></html>");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  it("downloads, ingests as video and records the URL, final URL, bytes and sha256 (VS_ALLOW_PRIVATE_URLS=1)", async () => {
    const projectDir = join(dir, "direct1");
    const url = `${base}/moved.mp4`;
    const { ir, provenance } = await ingest([url], { projectDir, noCache: true, env: { VS_ALLOW_PRIVATE_URLS: "1" } });
    const src = ir.sources[0]!;
    expect(src.kind).toBe("video");
    expect(src.uri).toBe(url);
    expect(src.title).toBe("talk");
    expect(src.remote).toEqual({ url, via: "direct", final_url: `${base}/media/talk.mp4`, bytes: statSync(clip).size, content_type: "video/mp4" });
    const video = ir.assets.find((a) => a.kind === "video")!;
    expect(video.sha256).toBe(src.sha256);
    expect(readFileSync(join(projectDir, video.path)).equals(readFileSync(clip))).toBe(true);
    expect(video.source_ref).toBe(`video:${url}`);
    expect(provenance.sources[0]!.remote?.final_url).toBe(`${base}/media/talk.mp4`);
    expect(readdirSync(join(projectDir, "source"))).not.toContain(".downloads");
  }, 60_000);

  it("retries a URL that serves video/* without a media extension as a video URL", async () => {
    const { ir } = await ingest([`${base}/stream`], { projectDir: join(dir, "direct-sniff"), noCache: true, env: { VS_ALLOW_PRIVATE_URLS: "1" } });
    expect(ir.sources[0]!.kind).toBe("video");
    expect(ir.sources[0]!.remote?.via).toBe("direct");
  }, 60_000);

  it("is refused by the SSRF guard without the user's override", async () => {
    const err = await ingest([`${base}/media/talk.mp4`], { projectDir: join(dir, "direct-ssrf"), noCache: true, env: {} }).catch((e) => e);
    expect((err as IngestError).failures[0]!.error).toMatch(/resolves to a private or local address/);
  });

  it("refuses non-media content and files over the cap", async () => {
    const html = await ingest([`${base}/page.mp4`], { projectDir: join(dir, "direct-html"), noCache: true, env: { VS_ALLOW_PRIVATE_URLS: "1" } }).catch((e) => e);
    expect((html as IngestError).failures[0]!.error).toMatch(/returned text\/html, not a video or audio file/);
    const tiny = createVideoUrlExtractor({ allowPrivateAddresses: true, maxBytes: 1000 });
    const big = await ingest([`${base}/media/talk.mp4`], { projectDir: join(dir, "direct-big"), noCache: true, env: {}, extractors: { video_url: tiny } }).catch((e) => e);
    expect((big as IngestError).failures[0]!.error).toMatch(/video URLs are limited to 1000 bytes/);
    expect(existsSync(join(dir, "direct-big", "source", "assets"))).toBe(false);
  });
});
