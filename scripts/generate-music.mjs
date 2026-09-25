#!/usr/bin/env node
// Synthesize the bundled music beds in music/ with ffmpeg only (aevalsrc expressions), so they
// are CC0 by construction and reproducible. Usage: node scripts/generate-music.mjs [--out music]
// Prints the sha256 of each file; copy them into music/catalog.json and music/README.md.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const outDir = resolve(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "music");
mkdirSync(outDir, { recursive: true });

const NOTE = { C3: 130.81, D3: 146.83, E3: 164.81, F3: 174.61, G3: 196.0, A3: 220.0, B3: 246.94, C4: 261.63, D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0 };
const PROGRESSION = [
  ["A3", "C4", "E4", "G4"], // Am7
  ["D3", "F3", "A3", "C4"], // Dm7
  ["G3", "B3", "D4", "F4"], // G7
  ["C3", "E3", "G3", "B3"], // Cmaj7
];

/** Sum of the current chord's sines; the chord changes every `chordSec` and loops seamlessly. */
function chord(chordSec, gain, detune = 0) {
  const idx = `mod(floor(t/${chordSec}),4)`;
  const terms = PROGRESSION.map((notes, i) => {
    const sines = notes.map((n) => `sin(2*PI*${(NOTE[n] * (1 + detune)).toFixed(3)}*t)`).join("+");
    return `eq(${idx},${i})*(${sines})`;
  });
  // Soft attack/release inside each chord so changes don't click.
  const env = `min(1,mod(t,${chordSec})/0.4)*min(1,(${chordSec}-mod(t,${chordSec}))/0.4)`;
  return `${gain}*${env}*(${terms.join("+")})`;
}

// Kick: a 110→50 Hz sweep whose phase restarts at each beat (integral of the frequency), so it never clicks.
const kick = (beat, gain) => {
  const tau = `mod(t,${beat})`;
  return `${gain}*sin(2*PI*(50*${tau}+2*(1-exp(-30*${tau}))))*exp(-9*${tau})*min(1,${tau}/0.002)`;
};
// Hi-hat: bright pseudo-noise from high inharmonic sines (aevalsrc has no seeded noise), on off-beats.
const hat = (beat, gain) => `${gain}*gte(mod(t,${beat}),${beat}/2)*exp(-60*(mod(t,${beat})-${beat}/2))*(sin(2*PI*7919*t)*sin(2*PI*5387*t)+sin(2*PI*9103*t)*0.5)`;

const TRACKS = [
  {
    id: "ambient",
    title: "Ambient pad",
    bpm: 60,
    // Slow chords with a gentle tremolo; no drums.
    expr: (b) => `${chord(b * 8, 0.12)}*(0.8+0.2*sin(2*PI*0.25*t))+${chord(b * 8, 0.05, 0.003)}`,
  },
  {
    id: "lofi",
    title: "Lo-fi beat",
    bpm: 80,
    expr: (b) => `${chord(b * 8, 0.09)}+${kick(b, 0.5)}+${hat(b, 0.05)}`,
  },
  {
    id: "upbeat",
    title: "Upbeat pulse",
    bpm: 120,
    expr: (b) => `${chord(b * 8, 0.08)}*(0.6+0.4*gte(mod(t,${b / 2}),0.05))+${kick(b, 0.55)}+${hat(b / 2, 0.05)}`,
  },
  {
    id: "minimal",
    title: "Minimal pulse",
    bpm: 90,
    expr: (b) => `0.15*sin(2*PI*${NOTE.A3}*t)*exp(-4*mod(t,${b}))+0.08*sin(2*PI*${NOTE.E4}*t)*exp(-6*mod(t+${b / 2},${b}))`,
  },
];

/** 32 beats (8 bars): whole chord cycles, so a loop repeats without a seam. */
const BEATS = 32;

for (const t of TRACKS) {
  const beat = 60 / t.bpm;
  const dur = beat * BEATS;
  const out = join(outDir, `${t.id}.m4a`);
  const graph = `aevalsrc=exprs='${t.expr(beat)}|${t.expr(beat)}':s=48000:d=${dur},lowpass=f=9000,loudnorm=I=-20:TP=-2:LRA=11,aresample=48000`;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", graph, "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", out], { encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  const sha = createHash("sha256").update(readFileSync(out)).digest("hex");
  console.log(JSON.stringify({ id: t.id, title: t.title, bpm: t.bpm, duration_sec: Math.round(dur * 1000) / 1000, file: `${t.id}.m4a`, sha256: sha }));
}
