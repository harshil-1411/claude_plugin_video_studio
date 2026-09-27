/**
 * The runtime helpers injected inline into every `motion` page (Phase 6.5), as `window.vs`.
 *
 * Every helper is a pure function of its arguments (and of the injected `window.__vs`), so a
 * page built on them stays a pure function of time: `seek(t)` can jump anywhere, in any order,
 * and draw the same frame. No clocks, timers or unseeded randomness.
 *
 * - `vs.spring(t, { from, to, stiffness, damping, mass, delay })`: the closed-form step response
 *   of a damped harmonic oscillator released at rest from `from` at `delay` seconds. It settles
 *   to exactly `to` (once the envelope is below 1e-4 of the distance). A value whose target
 *   changes several times is the sum of one spring per change (see `springs`).
 * - `vs.springs(t, from, steps, opts)`: `steps` = `[{ at, to }]`; the sum of one spring per change.
 * - Easings on 0..1: `linear`, `easeIn`, `easeOut`, `easeInOut` (cubic), `easeOutQuint`,
 *   `easeInOutQuint`; `vs.progress(t, start, dur)` and `vs.tween(t, start, dur, from, to, ease)`.
 * - `vs.lerp`, `vs.clamp`, `vs.stagger(i, stepS, startS)`.
 * - `vs.rng(seed)`: a mulberry32 generator (numbers or strings as seeds); same seed, same sequence.
 * - `vs.beatAt(t)` / `vs.downbeatAt(t)`: the latest beat (downbeat) at or before `t`, or null;
 *   `vs.beatIndex(t)`: its index, -1 before the first. Times are scene-local seconds from
 *   `window.__vs.beats` / `downbeats` (empty when the video has no beat grid).
 *
 * Bump MOTION_KIT_VERSION on any change to MOTION_KIT_SOURCE: it is part of each motion scene's
 * cache key, so pages re-render with the new helpers.
 */
export const MOTION_KIT_VERSION = "1.0.0";

export const MOTION_KIT_SOURCE = `/* video-studio motion kit ${MOTION_KIT_VERSION} | SPDX-License-Identifier: MIT */
(function (g) {
  "use strict";
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }
  function lerp(a, b, p) { return a + (b - a) * p; }
  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : d; }

  function spring(t, o) {
    o = o || {};
    var from = num(o.from, 0), to = num(o.to, 1);
    var k = Math.max(1e-6, num(o.stiffness, 170)), c = Math.max(0, num(o.damping, 26)), m = Math.max(1e-6, num(o.mass, 1));
    var s = num(t, 0) - num(o.delay, 0);
    var a = from - to;
    if (s <= 0 || a === 0) return s <= 0 ? from : to;
    var w0 = Math.sqrt(k / m), z = c / (2 * Math.sqrt(k * m));
    var x, env;
    if (z < 1) {
      var wd = w0 * Math.sqrt(1 - z * z), b = (z * w0 * a) / wd, e = Math.exp(-z * w0 * s);
      x = e * (a * Math.cos(wd * s) + b * Math.sin(wd * s));
      env = e * (Math.abs(a) + Math.abs(b));
    } else if (z === 1) {
      var e1 = Math.exp(-w0 * s);
      x = e1 * (a + w0 * a * s);
      env = Math.abs(x);
    } else {
      var q = Math.sqrt(z * z - 1), r1 = -w0 * (z - q), r2 = -w0 * (z + q);
      var c1 = (a * r2) / (r2 - r1), c2 = (-a * r1) / (r2 - r1);
      x = c1 * Math.exp(r1 * s) + c2 * Math.exp(r2 * s);
      env = Math.abs(c1) * Math.exp(r1 * s) + Math.abs(c2) * Math.exp(r2 * s);
    }
    return env < 1e-4 * Math.abs(a) ? to : to + x;
  }

  function springs(t, from, steps, o) {
    var v = num(from, 0), prev = v, list = steps || [];
    for (var i = 0; i < list.length; i++) {
      var st = list[i], opts = {};
      for (var key in o || {}) opts[key] = o[key];
      opts.from = 0; opts.to = num(st.to, prev) - prev; opts.delay = num(st.at, 0);
      v += spring(t, opts);
      prev = num(st.to, prev);
    }
    return v;
  }

  var ease = {
    linear: function (p) { return clamp(p, 0, 1); },
    easeIn: function (p) { p = clamp(p, 0, 1); return p * p * p; },
    easeOut: function (p) { p = 1 - clamp(p, 0, 1); return 1 - p * p * p; },
    easeInOut: function (p) { p = clamp(p, 0, 1); return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; },
    easeOutQuint: function (p) { p = 1 - clamp(p, 0, 1); return 1 - p * p * p * p * p; },
    easeInOutQuint: function (p) { p = clamp(p, 0, 1); return p < 0.5 ? 16 * p * p * p * p * p : 1 - Math.pow(-2 * p + 2, 5) / 2; }
  };
  function progress(t, start, dur) { return dur > 0 ? clamp((t - start) / dur, 0, 1) : t >= start ? 1 : 0; }
  function tween(t, start, dur, from, to, fn) { return lerp(from, to, (fn || ease.easeInOut)(progress(t, start, dur))); }
  function stagger(i, stepS, startS) { return num(startS, 0) + i * num(stepS, 0); }

  function seedOf(seed) {
    if (typeof seed === "number" && isFinite(seed)) return seed >>> 0;
    var h = 2166136261, str = String(seed);
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seedOf(seed);
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var r = Math.imul(a ^ (a >>> 15), a | 1);
      r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  function grid(name) { var v = g.__vs && g.__vs[name]; return Array.isArray(v) ? v : []; }
  function indexIn(list, t) {
    var lo = 0, hi = list.length - 1, at = -1;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (list[mid] <= t + 1e-9) { at = mid; lo = mid + 1; } else hi = mid - 1; }
    return at;
  }
  function beatIndex(t) { return indexIn(grid("beats"), t); }
  function beatAt(t) { var b = grid("beats"), i = indexIn(b, t); return i < 0 ? null : b[i]; }
  function downbeatAt(t) { var b = grid("downbeats"), i = indexIn(b, t); return i < 0 ? null : b[i]; }

  var vs = { version: "${MOTION_KIT_VERSION}", spring: spring, springs: springs, ease: ease, linear: ease.linear, easeIn: ease.easeIn, easeOut: ease.easeOut,
    easeInOut: ease.easeInOut, easeOutQuint: ease.easeOutQuint, easeInOutQuint: ease.easeInOutQuint, progress: progress, tween: tween,
    lerp: lerp, clamp: clamp, stagger: stagger, rng: rng, beatAt: beatAt, downbeatAt: downbeatAt, beatIndex: beatIndex };
  g.vs = Object.freeze(vs);
})(typeof window !== "undefined" ? window : globalThis);
`;
