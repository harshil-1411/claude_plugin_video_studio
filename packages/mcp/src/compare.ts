import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { projectPaths } from "@video-studio/core";
import { ffprobe } from "@video-studio/media";
import { type Quality, resolveRender } from "./golden.js";

/**
 * compare: a before/after page for two videos. Each side is a render of this project (preview or
 * final), another project's render (a variant, a short) or a project-relative video file (e.g. an
 * asset and its `tighten`ed copy). Writes qa/compare/index.html with both videos copied next to it,
 * so the folder is self-contained: one HTML file with inline CSS and JS, no network requests.
 * Side-by-side, stacked and wipe views share one clock, scrubber, frame step and speed control.
 */

export type CompareSide =
  | { quality: Quality; label?: string }
  | { project_dir: string; quality?: Quality; label?: string }
  | { file: string; label?: string };

export interface CompareOptions {
  /** Default: this project's preview render. */
  a?: CompareSide;
  /** Default: this project's final render. */
  b?: CompareSide;
}

export interface CompareSideResult {
  label: string;
  /** The source video (absolute). */
  path: string;
  /** The copy next to the page (absolute): qa/compare/a.mp4 or b.mp4. */
  copy: string;
  /** Where it came from, for reports: `renders/<q>`, `dist`, `<project> renders/<q>` or the file. */
  source: string;
  duration_sec: number;
  width: number;
  height: number;
  fps?: number;
  has_audio: boolean;
}

export interface CompareResult {
  /** Absolute path of qa/compare/index.html. */
  html: string;
  /** Project-relative path of the page. */
  html_rel: string;
  dir: string;
  a: CompareSideResult;
  b: CompareSideResult;
  notes: string[];
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function resolveSide(root: string, side: CompareSide, which: "a" | "b"): Promise<Omit<CompareSideResult, "copy">> {
  if ("file" in side) {
    const abs = resolve(root, side.file);
    if (!inside(root, abs)) throw new Error(`${which}.file "${side.file}" is outside the project ${root}; give a project-relative path such as assets/supplied/talk.mp4`);
    if (!existsSync(abs)) throw new Error(`${which}.file "${side.file}" not found in ${root}`);
    // A symlink must not lead out of the project either.
    if (!inside(realpathSync(root), realpathSync(abs))) throw new Error(`${which}.file "${side.file}" resolves outside the project ${root}`);
    const p = await ffprobe(abs);
    if (!p.has_video || !p.width || !p.height) throw new Error(`${which}.file "${side.file}" has no video stream`);
    return {
      label: side.label ?? basename(abs),
      path: abs,
      source: relative(root, abs).split("\\").join("/"),
      duration_sec: round3(p.duration_s),
      width: p.width,
      height: p.height,
      ...(p.fps ? { fps: p.fps } : {}),
      has_audio: p.has_audio,
    };
  }
  const other = "project_dir" in side ? resolve(root, side.project_dir) : root;
  const r = await resolveRender(other, side.quality).catch((err: unknown) => {
    throw new Error(`${which}: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (side.quality && r.quality && r.quality !== side.quality) throw new Error(`${which}: no ${side.quality} render in ${other}`);
  const p = await ffprobe(r.reel);
  const name = other === root ? "" : `${basename(other)} `;
  return {
    label: side.label ?? `${name}${r.quality ?? "render"}`,
    path: r.reel,
    source: `${name}${r.source}`,
    duration_sec: round3(p.duration_s || r.duration_ms / 1000),
    width: p.width ?? r.width,
    height: p.height ?? r.height,
    ...(p.fps || r.fps ? { fps: p.fps ?? r.fps } : {}),
    has_audio: p.has_audio,
  };
}

/** Build qa/compare/ for two videos (default: this project's preview against its final render). */
export async function compareVideos(projectDir: string, opts: CompareOptions = {}): Promise<CompareResult> {
  const paths = projectPaths(projectDir);
  const root = paths.root;
  const notes: string[] = [];
  if (!opts.a && !opts.b) {
    const have = (["preview", "final"] as const).filter((q) => existsSync(join(paths.renders, q, "render-state.json")) || existsSync(join(paths.renders, q, "reel.mp4")));
    if (have.length < 2) {
      throw new Error(
        `nothing to compare by default: the default is this project's preview against its final render, and ${have.length ? `only a ${have[0]} render` : "no render"} exists in ${root}. Pass a and b: {quality}, {project_dir, quality?} or {file} (project-relative)`,
      );
    }
  }
  const a = await resolveSide(root, opts.a ?? { quality: "preview" }, "a");
  const b = await resolveSide(root, opts.b ?? { quality: "final" }, "b");
  if (a.path === b.path) notes.push("both sides are the same video");
  if (a.label === b.label) {
    a.label = `A: ${a.label}`;
    b.label = `B: ${b.label}`;
  }
  if (Math.abs(a.duration_sec - b.duration_sec) > 0.05) notes.push(`durations differ (${a.duration_sec}s vs ${b.duration_sec}s): the shorter side holds its last frame`);
  if (a.width * b.height !== b.width * a.height) notes.push(`aspect ratios differ (${a.width}x${a.height} vs ${b.width}x${b.height}): the wipe view letterboxes b`);

  const dir = join(paths.qa, "compare");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const fileA = `a${extname(a.path).toLowerCase() || ".mp4"}`;
  const fileB = `b${extname(b.path).toLowerCase() || ".mp4"}`;
  await copyFile(a.path, join(dir, fileA));
  await copyFile(b.path, join(dir, fileB));
  const html = join(dir, "index.html");
  const sideA: CompareSideResult = { ...a, copy: join(dir, fileA) };
  const sideB: CompareSideResult = { ...b, copy: join(dir, fileB) };
  await writeFile(html, comparePage({ a: { ...sideA, file: fileA }, b: { ...sideB, file: fileB } }));
  return { html, html_rel: relative(root, html), dir, a: sideA, b: sideB, notes };
}

export function formatCompare(r: CompareResult): string {
  const side = (k: string, s: CompareSideResult) => `${k}: ${s.label} (${s.source}; ${s.width}x${s.height}, ${s.duration_sec}s${s.fps ? `, ${s.fps} fps` : ""}${s.has_audio ? "" : ", no audio"})`;
  return [
    `compare page → ${r.html}`,
    side("a", r.a),
    side("b", r.b),
    ...r.notes.map((n) => `note: ${n}`),
    `You can't open a browser from here: give the user this path to open (e.g. \`open "${r.html}"\` on macOS). The folder ${r.dir} is self-contained (page + both videos) and can be zipped and shared. Views: side by side, stacked, wipe; space plays, ←/→ step a frame.`,
  ].join("\n");
}

// ------------------------------------------------------------------------------------ page

interface PageSide extends CompareSideResult {
  file: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The self-contained page: inline CSS and JS only, videos by relative path. */
export function comparePage(d: { a: PageSide; b: PageSide }): string {
  const data = {
    a: { label: d.a.label, file: d.a.file, duration: d.a.duration_sec, width: d.a.width, height: d.a.height, fps: d.a.fps ?? null },
    b: { label: d.b.label, file: d.b.file, duration: d.b.duration_sec, width: d.b.width, height: d.b.height, fps: d.b.fps ?? null },
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const meta = (s: PageSide) => `${s.width}×${s.height} · ${s.duration_sec.toFixed(2)}s${s.fps ? ` · ${Math.round(s.fps * 100) / 100} fps` : ""}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compare: ${esc(d.a.label)} vs ${esc(d.b.label)}</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #14171c; --muted: #5d6572; --line: #d9dde3;
  --accent: #2f6fed; --accent-ink: #ffffff; --stage: #0c0e12; --a: #2f6fed; --b: #d9480f;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1115; --panel: #171a20; --ink: #e8eaee; --muted: #9aa3b1; --line: #2a2f38; --accent: #5b8cff; --accent-ink: #0f1115; --stage: #000000; --a: #5b8cff; --b: #ff8a4c; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 16px; }
h1 { font-size: 18px; margin: 0 0 12px; font-weight: 600; overflow-wrap: anywhere; }
.bar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-bottom: 12px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; }
.seg button + button { border-left: 1px solid var(--line); }
button, select { font: inherit; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; min-height: 36px; cursor: pointer; }
button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.stage { background: var(--stage); border-radius: 10px; padding: 8px; }
.grid { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
.stage[data-mode="stacked"] .grid { grid-template-columns: minmax(0, 1fr); }
.cell { position: relative; min-width: 0; }
.cell video { display: block; width: 100%; height: auto; max-height: 72vh; object-fit: contain; background: #000; border-radius: 6px; }
.stage[data-mode="stacked"] .cell video { max-height: 60vh; }
.tag { position: absolute; top: 6px; left: 6px; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; color: #fff; background: var(--a); pointer-events: none; max-width: calc(100% - 12px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag.b { background: var(--b); }
.wipe { position: relative; margin: 0 auto; max-height: 72vh; overflow: hidden; border-radius: 6px; background: #000; touch-action: none; user-select: none; }
.wipe video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.wipe .tag.b { left: auto; right: 6px; }
.divider { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.4); cursor: ew-resize; }
.divider::after { content: "⟷"; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 32px; height: 32px; border-radius: 50%; background: #fff; color: #000; display: grid; place-items: center; font-size: 16px; }
[hidden] { display: none !important; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; }
.scrub { flex: 1 1 100%; display: flex; gap: 10px; align-items: center; }
.scrub input { flex: 1; min-width: 0; accent-color: var(--accent); }
.time { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
label.inline { display: inline-flex; gap: 6px; align-items: center; color: var(--muted); }
.cards { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-top: 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--a); border-radius: 8px; padding: 10px 12px; }
.card.b { border-left-color: var(--b); }
.card strong { display: block; overflow-wrap: anywhere; }
.card span { color: var(--muted); font-variant-numeric: tabular-nums; }
.hint { color: var(--muted); font-size: 12px; margin-top: 10px; }
@media (max-width: 560px) {
  h1 { font-size: 16px; }
  .stage[data-mode="side"] .grid { gap: 4px; }
}
</style>
</head>
<body>
<main>
<h1>${esc(d.a.label)} <span style="color:var(--muted)">vs</span> ${esc(d.b.label)}</h1>
<div class="bar">
  <div class="seg" role="group" aria-label="View">
    <button type="button" data-mode="side" aria-pressed="true">Side by side</button>
    <button type="button" data-mode="stacked" aria-pressed="false">Stacked</button>
    <button type="button" data-mode="wipe" aria-pressed="false">Wipe</button>
  </div>
</div>
<div class="stage" id="stage" data-mode="side">
  <div class="grid" id="grid">
    <div class="cell" id="cellA"><video id="va" src="${esc(d.a.file)}" preload="auto" playsinline muted></video><span class="tag">A · ${esc(d.a.label)}</span></div>
    <div class="cell" id="cellB"><video id="vb" src="${esc(d.b.file)}" preload="auto" playsinline></video><span class="tag b">B · ${esc(d.b.label)}</span></div>
  </div>
  <div class="wipe" id="wipe" hidden>
    <div id="wipeA"></div><div id="wipeB"></div>
    <span class="tag">A · ${esc(d.a.label)}</span><span class="tag b">B · ${esc(d.b.label)}</span>
    <div class="divider" id="divider" role="slider" tabindex="0" aria-label="Wipe position" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div>
  </div>
</div>
<div class="controls">
  <div class="scrub">
    <button type="button" id="play" aria-label="Play">▶</button>
    <input type="range" id="scrub" min="0" max="1" step="0.001" value="0" aria-label="Position">
    <span class="time" id="time">0:00.00 / 0:00.00</span>
  </div>
  <button type="button" id="back" aria-label="Previous frame">◀ frame</button>
  <button type="button" id="fwd" aria-label="Next frame">frame ▶</button>
  <label class="inline">Speed <select id="speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
  <button type="button" id="muteA" aria-pressed="true">A muted</button>
  <button type="button" id="muteB" aria-pressed="false">B sound on</button>
</div>
<div class="cards">
  <div class="card"><strong>A · ${esc(d.a.label)}</strong><span id="metaA">${esc(meta(d.a))}</span></div>
  <div class="card b"><strong>B · ${esc(d.b.label)}</strong><span id="metaB">${esc(meta(d.b))}</span></div>
</div>
<p class="hint">Space plays and pauses, ← and → step one frame. Both videos share one clock (the longer one drives it, and the shorter one holds its last frame).</p>
</main>
<script>
(function () {
  "use strict";
  var D = ${json};
  var va = document.getElementById("va"), vb = document.getElementById("vb");
  var stage = document.getElementById("stage"), grid = document.getElementById("grid"), wipe = document.getElementById("wipe");
  var cellA = document.getElementById("cellA"), cellB = document.getElementById("cellB");
  var wipeA = document.getElementById("wipeA"), wipeB = document.getElementById("wipeB"), divider = document.getElementById("divider");
  var play = document.getElementById("play"), scrub = document.getElementById("scrub"), time = document.getElementById("time");
  var speed = document.getElementById("speed"), muteA = document.getElementById("muteA"), muteB = document.getElementById("muteB");
  var fps = D.a.fps || D.b.fps || 30, frame = 1 / fps;
  var durA = D.a.duration || 0, durB = D.b.duration || 0;
  var playing = false, t = 0, wipePos = 0.5;

  function total() { return Math.max(durA, durB); }
  // The longer video drives the clock (A when they match); the other follows, clamped to its own end.
  function driver() { return durA >= durB ? va : vb; }
  function follower() { return durA >= durB ? vb : va; }
  function durOf(v) { return v === va ? durA : durB; }
  function lastT(v) { return Math.max(0, durOf(v) - frame / 2); }
  function fmt(s) { s = Math.max(0, s); var m = Math.floor(s / 60), r = s - m * 60; return m + ":" + (r < 10 ? "0" : "") + r.toFixed(2); }
  function show() {
    scrub.max = String(total());
    scrub.value = String(t);
    time.textContent = fmt(t) + " / " + fmt(total());
  }
  function seekOne(v, x) {
    var c = Math.min(x, lastT(v));
    if (Math.abs(v.currentTime - c) > 0.001) v.currentTime = c;
  }
  function seek(x) {
    t = Math.min(Math.max(0, x), total());
    seekOne(va, t); seekOne(vb, t);
    show();
  }
  function pause() {
    playing = false; va.pause(); vb.pause();
    play.textContent = "▶"; play.setAttribute("aria-label", "Play");
    t = driver().currentTime; show();
  }
  function start() {
    if (t >= total() - frame) seek(0);
    playing = true;
    play.textContent = "❚❚"; play.setAttribute("aria-label", "Pause");
    var p = driver().play(); if (p && p.catch) p.catch(function () { pause(); });
    var f = follower();
    if (t < lastT(f)) { var q = f.play(); if (q && q.catch) q.catch(function () {}); }
    requestAnimationFrame(tick);
  }
  function tick() {
    if (!playing) return;
    var d = driver(), f = follower();
    t = d.currentTime;
    var target = Math.min(t, lastT(f));
    if (t >= lastT(f)) { if (!f.paused) f.pause(); seekOne(f, target); }
    else {
      if (f.paused && !d.paused) f.play().catch(function () {});
      // Re-lock the follower when it drifts more than a frame.
      if (Math.abs(f.currentTime - target) > Math.max(frame, 0.04)) f.currentTime = target;
    }
    show();
    if (d.ended || d.paused) { pause(); return; }
    requestAnimationFrame(tick);
  }
  function step(n) {
    if (playing) pause();
    seek((Math.round(t * fps) + n) / fps);
  }

  play.addEventListener("click", function () { playing ? pause() : start(); });
  scrub.addEventListener("input", function () { if (playing) pause(); seek(parseFloat(scrub.value)); });
  document.getElementById("back").addEventListener("click", function () { step(-1); });
  document.getElementById("fwd").addEventListener("click", function () { step(1); });
  speed.addEventListener("change", function () { va.playbackRate = vb.playbackRate = parseFloat(speed.value); });
  function setMute(v, btn, name, muted) {
    v.muted = muted;
    btn.setAttribute("aria-pressed", String(muted));
    btn.textContent = name + (muted ? " muted" : " sound on");
  }
  muteA.addEventListener("click", function () { setMute(va, muteA, "A", !va.muted); });
  muteB.addEventListener("click", function () { setMute(vb, muteB, "B", !vb.muted); });
  setMute(va, muteA, "A", true); setMute(vb, muteB, "B", false);

  document.addEventListener("keydown", function (e) {
    var tag = e.target && e.target.tagName;
    if (tag === "SELECT" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target === divider) return;
    if (e.key === " " || e.key === "k") { if (tag === "BUTTON" && e.key === " ") return; e.preventDefault(); playing ? pause() : start(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); step(1); }
  });

  // Durations and sizes from the files themselves, when the browser knows them.
  function meta(v, which) {
    if (isFinite(v.duration) && v.duration > 0) { if (which === "a") durA = v.duration; else durB = v.duration; }
    show();
    if (which === "a") fitWipe();
  }
  va.addEventListener("loadedmetadata", function () { meta(va, "a"); });
  vb.addEventListener("loadedmetadata", function () { meta(vb, "b"); });
  va.addEventListener("ended", function () { if (driver() === va) pause(); });
  vb.addEventListener("ended", function () { if (driver() === vb) pause(); });

  // Views. Wipe overlays B on A and reveals B right of the divider.
  function fitWipe() {
    var w = D.a.width || va.videoWidth || 16, h = D.a.height || va.videoHeight || 9;
    var maxH = window.innerHeight * 0.72, avail = stage.clientWidth - 16;
    var width = Math.min(avail, maxH * w / h);
    wipe.style.width = width + "px";
    wipe.style.height = (width * h / w) + "px";
  }
  function setWipe(p) {
    wipePos = Math.min(1, Math.max(0, p));
    vb.style.clipPath = stage.dataset.mode === "wipe" ? "inset(0 0 0 " + (wipePos * 100) + "%)" : "";
    divider.style.left = (wipePos * 100) + "%";
    divider.setAttribute("aria-valuenow", String(Math.round(wipePos * 100)));
  }
  function setMode(m) {
    stage.dataset.mode = m;
    document.querySelectorAll(".seg button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.mode === m)); });
    if (m === "wipe") {
      wipeA.appendChild(va); wipeB.appendChild(vb);
      grid.hidden = true; wipe.hidden = false; fitWipe();
    } else {
      cellA.insertBefore(va, cellA.firstChild); cellB.insertBefore(vb, cellB.firstChild);
      grid.hidden = false; wipe.hidden = true;
    }
    setWipe(wipePos);
    // Moving a video element can reset its position: put both back on the shared clock.
    seek(t);
    if (playing) { pause(); start(); }
  }
  document.querySelectorAll(".seg button").forEach(function (b) { b.addEventListener("click", function () { setMode(b.dataset.mode); }); });
  var dragging = false;
  function fromEvent(e) { var r = wipe.getBoundingClientRect(); setWipe((e.clientX - r.left) / r.width); }
  wipe.addEventListener("pointerdown", function (e) { dragging = true; wipe.setPointerCapture(e.pointerId); fromEvent(e); });
  wipe.addEventListener("pointermove", function (e) { if (dragging) fromEvent(e); });
  wipe.addEventListener("pointerup", function () { dragging = false; });
  wipe.addEventListener("pointercancel", function () { dragging = false; });
  divider.addEventListener("keydown", function (e) {
    if (e.key === "ArrowLeft") { e.preventDefault(); setWipe(wipePos - 0.05); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setWipe(wipePos + 0.05); }
  });
  window.addEventListener("resize", function () { if (stage.dataset.mode === "wipe") fitWipe(); });
  setWipe(0.5);
  show();
})();
</script>
</body>
</html>
`;
}
