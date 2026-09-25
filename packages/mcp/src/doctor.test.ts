import { describe, expect, it } from "vitest";
import {
  type DoctorDeps,
  type ExecResult,
  checkNode,
  formatDoctorReport,
  parseBuildconf,
  runDoctor,
  textShapingCheck,
} from "./doctor.js";

const FULL_BUILDCONF = "configuration:\n    --prefix=/opt/homebrew\n    --enable-gpl\n    --enable-libass\n    --enable-libx264\n";

interface FakeOptions {
  env?: Record<string, string | undefined>;
  executables?: string[];
  buildconf?: string;
  nodeVersion?: string;
  sqliteError?: string | null;
  writableError?: string | null;
}

function fakeDeps(o: FakeOptions = {}): DoctorDeps & { calls: string[][] } {
  const executables = new Set(o.executables ?? ["/usr/bin/ffmpeg", "/usr/bin/ffprobe"]);
  const calls: string[][] = [];
  return {
    calls,
    env: { PATH: "/usr/bin:/usr/local/bin", CLAUDE_PLUGIN_DATA: "/data/video-studio", ...o.env },
    platform: "linux",
    nodeVersion: o.nodeVersion ?? "24.15.0",
    home: "/home/u",
    isExecutable: async (p) => executables.has(p),
    exec: async (file, args): Promise<ExecResult | null> => {
      calls.push([file, ...args]);
      if (!executables.has(file)) return null;
      if (args.includes("-buildconf")) return { code: 0, stdout: o.buildconf ?? FULL_BUILDCONF, stderr: "" };
      const name = file.split("/").pop();
      return { code: 0, stdout: `${name} version 7.1.1 Copyright (c) 2000-2025\n`, stderr: "" };
    },
    loadSqlite: async () => o.sqliteError ?? null,
    probeWritable: async () => o.writableError ?? null,
  };
}

const byId = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) => r.checks.find((c) => c.id === id)!;

describe("doctor", () => {
  it("reports ok for a complete environment", async () => {
    const r = await runDoctor(fakeDeps({ executables: ["/usr/bin/ffmpeg", "/usr/bin/ffprobe", "/usr/bin/chromium", "/usr/local/bin/whisper-cli"] }));
    expect(r.overall).toBe("ok");
    expect(r.ok).toBe(true);
    expect(byId(r, "ffmpeg").detail).toContain("7.1.1");
    expect(byId(r, "chrome").detail).toBe("/usr/bin/chromium");
    expect(byId(r, "whisper_cpp").detail).toBe("/usr/local/bin/whisper-cli");
    expect(byId(r, "data_dir").detail).toContain("/data/video-studio");
  });

  it("includes the injected hyperframes check after chrome", async () => {
    const deps = { ...fakeDeps({ executables: ["/usr/bin/ffmpeg", "/usr/bin/ffprobe", "/usr/bin/chromium"] }), hyperframes: async () => ({ id: "hyperframes", status: "warn" as const, detail: "not installed", fix: "npm i" }) };
    const r = await runDoctor(deps);
    const ids = r.checks.map((c) => c.id);
    expect(ids.indexOf("hyperframes")).toBe(ids.indexOf("chrome") + 1);
    expect(byId(r, "hyperframes").status).toBe("warn");
  });

  it("fails with a fix when ffmpeg is missing, and skips buildconf", async () => {
    const r = await runDoctor(fakeDeps({ executables: ["/usr/bin/ffprobe"] }));
    const ff = byId(r, "ffmpeg");
    expect(ff.status).toBe("fail");
    expect(ff.fix).toMatch(/brew install ffmpeg/);
    expect(r.overall).toBe("fail");
    expect(r.ok).toBe(false);
    expect(byId(r, "ffmpeg_libass").status).toBe("warn");
    expect(formatDoctorReport(r)).toContain("fix: Install FFmpeg");
  });

  it("warns when ffmpeg lacks libass", async () => {
    const r = await runDoctor(fakeDeps({ buildconf: "configuration:\n  --enable-gpl\n  --enable-libx264\n" }));
    expect(byId(r, "ffmpeg_libass").status).toBe("warn");
    expect(byId(r, "ffmpeg_libass").fix).toBeDefined();
    expect(byId(r, "ffmpeg_libx264").status).toBe("ok");
    expect(r.overall).toBe("warn");
  });

  it("reports harfbuzz/fribidi for drawtext and how complex scripts are drawn", async () => {
    const ok = textShapingCheck("--enable-libass --enable-libharfbuzz --enable-libfreetype");
    expect(ok).toMatchObject({ id: "ffmpeg_text_shaping", status: "ok" });
    expect(ok.detail).toMatch(/drawtext: harfbuzz yes, fribidi no; libass yes.*through libass/);
    const bare = textShapingCheck("--enable-libharfbuzz --enable-libfreetype");
    expect(bare.status).toBe("warn");
    expect(bare.detail).toMatch(/join Arabic letters/);
    expect(bare.fix).toMatch(/HyperFrames/);
    expect(textShapingCheck("--enable-libfribidi").detail).toMatch(/fribidi yes/);
    const r = await runDoctor(fakeDeps({ buildconf: "configuration:\n  --enable-gpl\n  --enable-libx264\n" }));
    expect(byId(r, "ffmpeg_text_shaping").status).toBe("warn");
    const skipped = await runDoctor(fakeDeps({ executables: ["/usr/bin/ffprobe"] }));
    expect(byId(skipped, "ffmpeg_text_shaping").detail).toMatch(/skipped/);
  });

  it("honours FFMPEG_PATH and fails if it is not executable", async () => {
    const deps = fakeDeps({ env: { FFMPEG_PATH: "/opt/ff/ffmpeg" }, executables: ["/opt/ff/ffmpeg", "/usr/bin/ffprobe"] });
    const r = await runDoctor(deps);
    expect(byId(r, "ffmpeg").detail).toContain("/opt/ff/ffmpeg");
    expect(byId(r, "ffmpeg").detail).toContain("FFMPEG_PATH");
    expect(deps.calls.some((c) => c[0] === "/opt/ff/ffmpeg" && c.includes("-buildconf"))).toBe(true);

    const bad = await runDoctor(fakeDeps({ env: { FFMPEG_PATH: "/nope/ffmpeg" } }));
    expect(byId(bad, "ffmpeg").status).toBe("fail");
    expect(byId(bad, "ffmpeg").detail).toContain("FFMPEG_PATH");
  });

  it("reports provider keys as booleans and never echoes values", async () => {
    const secret = "sk-SUPER-SECRET-value-12345";
    const r = await runDoctor(
      fakeDeps({
        env: {
          RUNWAYML_API_SECRET: secret,
          ELEVENLABS_API_KEY: "",
          HEYGEN_API_KEY: "${user_config.heygen_key}",
          FAL_KEY: `${secret}-fal`,
        },
      }),
    );
    expect(r.provider_keys).toEqual({
      RUNWAYML_API_SECRET: true,
      ELEVENLABS_API_KEY: false,
      HEYGEN_API_KEY: false,
      FAL_KEY: true,
      KLINGAI_API_KEY: false,
    });
    const everything = JSON.stringify(r) + formatDoctorReport(r);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("SUPER-SECRET");
  });

  it("fails on old Node and missing sqlite", async () => {
    expect(checkNode("22.12.0").status).toBe("fail");
    expect(checkNode("22.13.0").status).toBe("ok");
    expect(checkNode("v23.0.1").status).toBe("ok");
    const r = await runDoctor(fakeDeps({ sqliteError: "No such built-in module: node:sqlite" }));
    expect(byId(r, "sqlite").status).toBe("fail");
  });

  it("fails when the data dir is not writable or is inside the plugin root", async () => {
    const r = await runDoctor(fakeDeps({ writableError: "EACCES" }));
    expect(byId(r, "data_dir").status).toBe("fail");
    const inside = await runDoctor(fakeDeps({ env: { CLAUDE_PLUGIN_ROOT: "/data", CLAUDE_PLUGIN_DATA: "/data/x" } }));
    expect(byId(inside, "data_dir").status).toBe("fail");
  });

  it("parses buildconf flags exactly", () => {
    expect(parseBuildconf("--enable-libass --enable-libx264")).toEqual({ libass: true, libx264: true });
    expect(parseBuildconf("--enable-libx265 --disable-libass")).toEqual({ libass: false, libx264: false });
  });
});
