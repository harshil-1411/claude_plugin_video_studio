#!/usr/bin/env node
// Synthesize the bundled sound effects in sfx/ with ffmpeg only (aevalsrc expressions: sines,
// chirps and inharmonic sine sums for noise-like texture; no samples, no downloads, no random
// noise), so they are CC0 by construction and reproducible, then MEASURE each file and write
// sfx/catalog.json (duration, peak, spectral character, high-frequency risk, default level, sha256).
// Usage: node scripts/generate-sfx.mjs [--out sfx] [--only pop,tick]
//
// Format: 48 kHz mono 16-bit PCM WAV. The mixer (mixSceneAudio) decodes any file, but PCM has no
// encoder priming delay (AAC adds ~21 ms of silence, which would move the measured peak), is
// byte-identical across runs, and one-shots this short are only a few kB each.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const outDir = resolve(arg("--out") ?? "sfx");
const only = arg("--only")?.split(",").filter(Boolean);
mkdirSync(outDir, { recursive: true });

const SR = 48_000;
/** Every file is peak-normalized to this level before it is measured. */
const PEAK_DBFS = -1;
/** Short-term (50 ms RMS) level an effect should reach in the mix at its default gain: about 10 dB under narration. */
const TARGET_RMS_DBFS = -28;

// ------------------------------------------------------------------------------------ building blocks

const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89];
const n4 = (x) => x.toFixed(4);
/** Fractional part of √p: fixed irrational jitter, so partials never line up into a pitch. */
const jitter = (k) => Math.sqrt(PRIMES[k % PRIMES.length]) % 1;

/**
 * Noise-like texture: `n` sines spread geometrically over lo..hi Hz with irrational jitter and
 * phases, summed and scaled by 1/√n. `glide` sweeps every partial by (1 + glide·t/T) over T seconds
 * (phase = 2π f (t + glide t² / 2T)), which reads as air moving past.
 */
function texture(lo, hi, n, { glide = 0, T = 1 } = {}) {
  const terms = [];
  for (let k = 0; k < n; k++) {
    const f = lo * (hi / lo) ** ((k + jitter(k)) / n);
    const phase = n4(2 * Math.PI * jitter(k + 7));
    const time = glide ? `(t+${n4(glide / (2 * T))}*t*t)` : "t";
    terms.push(`sin(2*PI*${f.toFixed(2)}*${time}+${phase})`);
  }
  return `(${terms.join("+")})/${n4(Math.sqrt(n))}`;
}

/** Asymmetric bump peaking at `c` seconds with value 1; larger `a` is narrower. */
const bump = (c, a) => `pow(t/${c},${a})*exp(${a}*(1-t/${c}))`;
/** Linear attack over `ms`. */
const attack = (ms) => `min(1,t/${ms / 1000})`;
/** Linear release into the file end, so the last sample is silence (no click when trimmed). */
const release = (d, ms) => `min(1,(${d}-t)/${ms / 1000})`;
/** Sine whose pitch moves exponentially from f0 to f1 over T seconds, then holds f1. */
function sweep(f0, f1, T) {
  const k = Math.log(f1 / f0) / T;
  // phase = 2π f0 (e^{k t} − 1) / k while t < T, then continues at f1.
  const inside = `${n4(f0 / k)}*(exp(${n4(k)}*min(t,${T}))-1)`;
  return `sin(2*PI*(${inside}+${f1}*max(0,t-${T})))`;
}
/** Kick-style drop: pitch falls from `hi` towards `lo` at `rate`/s. */
const drop = (hi, lo, rate) => `sin(2*PI*(${lo}*t+${n4((hi - lo) / rate)}*(1-exp(-${rate}*t))))`;

/** A bell: inharmonic partials [ratio, gain, decay/s] on `f`, starting at `at` seconds. */
function bell(f, partials, at = 0) {
  const tt = at ? `(t-${at})` : "t";
  const body = partials.map(([r, g, dec]) => `${g}*sin(2*PI*${(f * r).toFixed(2)}*${tt})*exp(-${dec}*${tt})`).join("+");
  return `gte(t,${at})*min(1,${tt}/0.003)*(${body})`;
}

/** A keyboard key: contact click, the key's body, and the bottom-out a few ms later. */
const key = (body, lo, hi, second) =>
  `0.55*${texture(lo, hi, 12)}*exp(-220*t)+0.5*sin(2*PI*${body}*t)*exp(-70*t)+0.3*gte(t,${second})*${texture(lo * 1.3, hi, 10)}*exp(-260*(t-${second}))`;

// ------------------------------------------------------------------------------------ the library

const SOUNDS = [
  {
    id: "whoosh-soft",
    title: "Soft whoosh",
    family: "whoosh",
    uses: ["transition", "reveal"],
    d: 0.9,
    expr: (d) => `${bump(0.5, 4)}*${texture(250, 2200, 18, { glide: 0.6, T: d })}*${release(d, 60)}`,
    filters: "highpass=f=120,lowpass=f=2600,lowpass=f=2600",
  },
  {
    id: "whoosh-fast",
    title: "Fast whoosh",
    family: "whoosh",
    uses: ["transition"],
    d: 0.5,
    expr: (d) => `${bump(0.24, 5)}*${texture(400, 3600, 18, { glide: 1, T: d })}*${release(d, 40)}`,
    filters: "highpass=f=180,lowpass=f=4200,lowpass=f=4200",
  },
  {
    id: "swipe",
    title: "Swipe",
    family: "whoosh",
    uses: ["transition", "click"],
    d: 0.4,
    expr: (d) => `${bump(0.12, 3)}*${texture(700, 4800, 18, { glide: 1.2, T: d })}*${release(d, 40)}`,
    filters: "highpass=f=400,lowpass=f=5500",
  },
  {
    id: "riser-1s",
    title: "Riser, 1 s",
    family: "riser",
    uses: ["reveal", "transition"],
    d: 1.2,
    // Swells for 1 s (pitch climbs two octaves), then lets go quickly.
    expr: (d) => `(pow(min(t,1),3)*lt(t,1)+gte(t,1)*exp(-28*(t-1)))*(0.6*${sweep(220, 880, 1)}+0.3*${sweep(330, 1320, 1)}+0.5*${texture(300, 2400, 14, { glide: 1.5, T: 1 })})*${release(d, 30)}`,
    filters: "highpass=f=120,lowpass=f=3800,lowpass=f=3800",
  },
  {
    id: "riser-2s",
    title: "Riser, 2 s",
    family: "riser",
    uses: ["reveal", "transition"],
    d: 2.2,
    expr: (d) => `(pow(min(t,2)/2,3)*lt(t,2)+gte(t,2)*exp(-28*(t-2)))*(0.6*${sweep(165, 660, 2)}+0.3*${sweep(247.5, 990, 2)}+0.5*${texture(250, 2200, 14, { glide: 1.5, T: 2 })})*${release(d, 30)}`,
    filters: "highpass=f=100,lowpass=f=3500,lowpass=f=3500",
  },
  {
    id: "hit-soft",
    title: "Soft hit",
    family: "hit",
    uses: ["accent", "reveal", "count"],
    d: 0.9,
    expr: (d) => `${attack(2)}*(0.9*${drop(180, 95, 18)}*exp(-6*t)+0.25*${texture(200, 1600, 12)}*exp(-45*t))*${release(d, 80)}`,
    filters: "highpass=f=40,lowpass=f=1800,lowpass=f=1800",
  },
  {
    id: "hit-deep",
    title: "Deep hit",
    family: "hit",
    uses: ["accent", "reveal", "outro"],
    d: 1.8,
    expr: (d) => `${attack(2)}*(${drop(95, 42, 12)}*exp(-2.4*t)+0.4*sin(2*PI*42*t)*exp(-3*t)+0.12*${texture(120, 700, 10)}*exp(-30*t))*${release(d, 150)}`,
    filters: "highpass=f=28,lowpass=f=650,lowpass=f=650",
  },
  {
    id: "pop",
    title: "Pop",
    family: "ui",
    uses: ["click", "reveal", "count"],
    d: 0.25,
    expr: (d) => `${attack(2)}*${drop(950, 360, 32)}*exp(-24*t)*${release(d, 20)}`,
    filters: "highpass=f=80,lowpass=f=4500",
  },
  {
    id: "click",
    title: "Click",
    family: "ui",
    uses: ["click"],
    d: 0.08,
    expr: (d) => `${attack(0.5)}*(0.6*${texture(1200, 5000, 10)}*exp(-260*t)+0.6*sin(2*PI*1850*t)*exp(-140*t))*${release(d, 10)}`,
    filters: "highpass=f=300,lowpass=f=6500",
  },
  {
    id: "tick",
    title: "Tick",
    family: "ui",
    uses: ["count", "click"],
    d: 0.1,
    expr: (d) => `${attack(0.5)}*(sin(2*PI*3150*t)+0.4*sin(2*PI*4730*t))*exp(-110*t)*${release(d, 10)}`,
    filters: "highpass=f=500,lowpass=f=8000",
  },
  {
    id: "key-1",
    title: "Key press 1",
    family: "type",
    uses: ["type"],
    d: 0.14,
    expr: (d) => `${attack(0.5)}*(${key(360, 900, 4200, 0.032)})*${release(d, 15)}`,
    filters: "highpass=f=150,lowpass=f=4500",
  },
  {
    id: "key-2",
    title: "Key press 2",
    family: "type",
    uses: ["type"],
    d: 0.14,
    expr: (d) => `${attack(0.5)}*(${key(430, 1000, 4600, 0.027)})*${release(d, 15)}`,
    filters: "highpass=f=150,lowpass=f=4500",
  },
  {
    id: "key-3",
    title: "Key press 3",
    family: "type",
    uses: ["type"],
    d: 0.14,
    expr: (d) => `${attack(0.5)}*(${key(300, 800, 3800, 0.038)})*${release(d, 15)}`,
    filters: "highpass=f=150,lowpass=f=4500",
  },
  {
    id: "chime",
    title: "Chime",
    family: "chime",
    uses: ["reveal", "accent"],
    d: 2,
    expr: (d) => `${bell(880, [[1, 1, 2.6], [2, 0.35, 4.5], [2.76, 0.18, 6], [4.07, 0.06, 9]])}*${release(d, 200)}`,
    filters: "highpass=f=200,lowpass=f=6000",
  },
  {
    id: "bell-outro",
    title: "Outro bell",
    family: "chime",
    uses: ["outro"],
    d: 2.2,
    // Two soft bells a fifth apart, the second 120 ms later.
    expr: (d) => `(${bell(523.25, [[1, 0.8, 1.8], [2, 0.25, 3.2], [3, 0.08, 5]])}+${bell(783.99, [[1, 0.6, 2], [2, 0.18, 3.6]], 0.12)})*${release(d, 250)}`,
    filters: "highpass=f=150,lowpass=f=5000",
  },
  {
    id: "blip-up",
    title: "Blip up",
    family: "ui",
    uses: ["reveal", "click"],
    d: 0.18,
    expr: (d) => `${attack(4)}*(${sweep(520, 1040, 0.12)}+0.25*${sweep(1040, 2080, 0.12)})*exp(-12*t)*${release(d, 30)}`,
    filters: "highpass=f=200,lowpass=f=5000",
  },
  {
    id: "blip-down",
    title: "Blip down",
    family: "ui",
    uses: ["click", "outro"],
    d: 0.18,
    expr: (d) => `${attack(4)}*(${sweep(1040, 520, 0.12)}+0.25*${sweep(2080, 1040, 0.12)})*exp(-12*t)*${release(d, 30)}`,
    filters: "highpass=f=200,lowpass=f=5000",
  },
  {
    id: "glitch",
    title: "Glitch",
    family: "glitch",
    uses: ["transition", "accent"],
    d: 0.45,
    // A band-limited buzz and a bright texture chopped by two beating gates.
    expr: (d) =>
      `${attack(1)}*gt(sin(2*PI*17*t)+sin(2*PI*29*t+1),0.2)*exp(-4*t)*(0.5*(sin(2*PI*190*t)+sin(2*PI*570*t)/3+sin(2*PI*950*t)/5+sin(2*PI*1330*t)/7)+0.6*${texture(2000, 8000, 14)})*${release(d, 30)}`,
    filters: "highpass=f=100,lowpass=f=9000",
  },
];

// ------------------------------------------------------------------------------------ ffmpeg helpers

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return r.stderr;
}

function readF32(path) {
  const buf = readFileSync(path);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/** Overall RMS (dBFS) of `file` after `filters` (astats). */
function rmsDb(file, filters) {
  const err = ffmpeg(["-i", file, "-af", `${filters ? `${filters},` : ""}astats=metadata=0:measure_overall=RMS_level:measure_perchannel=none`, "-f", "null", "-"]);
  const m = /RMS level dB:\s*(-?[\d.]+|-inf)/.exec(err);
  if (!m) throw new Error(`no RMS level for ${file}`);
  return m[1] === "-inf" ? -200 : Number(m[1]);
}

/** Loudest 10 ms RMS window's centre at 16 kHz mono: the engine's own peak measure (SFX_PEAK_WINDOW_MS). */
function peakMs(pcm, sr = 16_000, windowMs = 10) {
  const w = Math.max(1, Math.round((sr * windowMs) / 1000));
  if (pcm.length < w) return 0;
  let e = 0;
  for (let i = 0; i < w; i++) e += pcm[i] * pcm[i];
  let best = e;
  let at = 0;
  for (let i = w; i < pcm.length; i++) {
    e += pcm[i] * pcm[i] - pcm[i - w] * pcm[i - w];
    if (e > best * (1 + 1e-9) + 1e-12) {
      best = e;
      at = i - w + 1;
    }
  }
  return best > 0 ? Math.round(((at + w / 2) * 1000) / sr) : 0;
}

/** Loudest 50 ms RMS window, dBFS. */
function maxShortRmsDb(pcm, sr = SR, windowMs = 50) {
  const w = Math.min(pcm.length, Math.round((sr * windowMs) / 1000));
  let e = 0;
  for (let i = 0; i < w; i++) e += pcm[i] * pcm[i];
  let best = e;
  for (let i = w; i < pcm.length; i++) {
    e += pcm[i] * pcm[i] - pcm[i - w] * pcm[i - w];
    if (e > best) best = e;
  }
  return 10 * Math.log10(Math.max(best / w, 1e-20));
}

// ------------------------------------------------------------------------------------ labels (thresholds)

/** Energy share below 400 Hz at which a sound reads as warm. */
const WARM_LOW_SHARE = 0.5;
/** Energy share above 2 kHz at which a sound reads as bright. */
const BRIGHT_HIGH_SHARE = 0.3;
/** Energy share above 4 kHz: under MED is low risk, from HIGH on it is high risk (harsh when repeated or loud). */
const HF_MED_SHARE = 0.03;
const HF_HIGH_SHARE = 0.12;
/** Extra attenuation of the default level for high-frequency risk, dB. */
const HF_PENALTY_DB = { low: 0, med: -2, high: -4 };

const share = (bandDb, fullDb) => 10 ** ((bandDb - fullDb) / 10);
const round3 = (n) => Math.round(n * 1000) / 1000;

// ------------------------------------------------------------------------------------ run

const version = /ffmpeg version (\S+)/.exec(spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout)?.[1] ?? "unknown";
const work = mkdtempSync(join(tmpdir(), "vs-gen-sfx-"));
const sounds = [];
try {
  for (const s of SOUNDS) {
    if (only && !only.includes(s.id)) continue;
    const raw = join(work, `${s.id}.f32`);
    const src = `aevalsrc=exprs='${s.expr(s.d)}':s=${SR}:d=${s.d}`;
    ffmpeg(["-y", "-f", "lavfi", "-i", `${src},${s.filters}`, "-ac", "1", "-f", "f32le", "-c:a", "pcm_f32le", raw]);
    const pcm = readF32(raw);
    let peak = 0;
    for (const x of pcm) peak = Math.max(peak, Math.abs(x));
    if (!(peak > 0)) throw new Error(`${s.id}: silent`);
    const gainDb = Math.round((PEAK_DBFS - 20 * Math.log10(peak)) * 100) / 100;
    const file = `${s.id}.wav`;
    const out = join(outDir, file);
    ffmpeg([
      "-y",
      "-f", "f32le", "-ar", String(SR), "-ac", "1", "-i", raw,
      "-af", `volume=${gainDb}dB`,
      "-c:a", "pcm_s16le", "-ar", String(SR), "-ac", "1",
      "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1",
      out,
    ]);
    // Measure the file as shipped.
    const full = rmsDb(out, "");
    const low = share(rmsDb(out, "lowpass=f=400,lowpass=f=400"), full);
    const high = share(rmsDb(out, "highpass=f=2000,highpass=f=2000"), full);
    const hf = share(rmsDb(out, "highpass=f=4000,highpass=f=4000"), full);
    const character = low >= WARM_LOW_SHARE ? "warm" : high >= BRIGHT_HIGH_SHARE ? "bright" : "balanced";
    const hf_risk = hf >= HF_HIGH_SHARE ? "high" : hf >= HF_MED_SHARE ? "med" : "low";
    const pcm16 = join(work, `${s.id}.16k.f32`);
    ffmpeg(["-y", "-i", out, "-ac", "1", "-ar", "16000", "-f", "f32le", "-c:a", "pcm_f32le", pcm16]);
    const pcm48 = join(work, `${s.id}.48k.f32`);
    ffmpeg(["-y", "-i", out, "-ac", "1", "-f", "f32le", "-c:a", "pcm_f32le", pcm48]);
    const shortRms = maxShortRmsDb(readF32(pcm48));
    const default_db = Math.max(-30, Math.min(-10, Math.round(TARGET_RMS_DBFS - shortRms + HF_PENALTY_DB[hf_risk])));
    const sha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
    const entry = {
      id: s.id,
      title: s.title,
      family: s.family,
      file,
      duration_ms: Math.round(s.d * 1000),
      peak_ms: peakMs(readF32(pcm16)),
      character,
      hf_risk,
      uses: s.uses,
      default_db,
      sha256,
      measured: { low_share: round3(low), high_share: round3(high), hf_share: round3(hf), short_rms_dbfs: Math.round(shortRms * 10) / 10 },
    };
    sounds.push(entry);
    console.log(JSON.stringify({ id: entry.id, character, hf_risk, default_db, peak_ms: entry.peak_ms, ...entry.measured }));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const catalog = {
  version: 1,
  generator: "scripts/generate-sfx.mjs",
  ffmpeg: version,
  license: {
    id: "CC0-1.0",
    source: "synthesized by video-studio with ffmpeg aevalsrc (scripts/generate-sfx.mjs); no samples or third-party recordings",
  },
  labels: {
    character: `warm: energy below 400 Hz >= ${WARM_LOW_SHARE * 100}%; bright: energy above 2 kHz >= ${BRIGHT_HIGH_SHARE * 100}%; else balanced`,
    hf_risk: `energy above 4 kHz: low < ${HF_MED_SHARE * 100}% <= med < ${HF_HIGH_SHARE * 100}% <= high`,
    default_db: `gain that brings the loudest 50 ms to ${TARGET_RMS_DBFS} dBFS (about 10 dB under narration), ${HF_PENALTY_DB.med} dB for med and ${HF_PENALTY_DB.high} dB for high hf_risk, within -30..-10`,
  },
  sounds,
};
writeFileSync(join(outDir, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
