// Render button loop: one shape, six states, 6 s (three bars of synth:pulse at 120 BPM).
//
//   pill "Render" -> frame fill + progress ring -> card (reel.mp4) -> toast "Link copied"
//   -> end card "video-studio" -> pill "Render" (the last frame is the first frame)
//
// Every value is a pure function of t (window.seek), so any frame can be drawn in any order,
// and every moving value is a sum of changes that cancel out, so seek(0) and seek(6) draw
// exactly the same frame.
(function () {
  var vs = window.vs;
  var v = window.__vs;
  var pal = v.tokens.palette;
  var $ = function (id) { return document.getElementById(id); };

  // --------------------------------------------------------------------------- brand
  var paper = pal.background || "#F6F5F2";
  var ink = pal.text || "#1C1F24";
  var accent = pal.primary || "#2F55C8"; // the one accent colour: the shape
  var font = v.tokens.fonts.heading ? '"' + v.tokens.fonts.heading + '", sans-serif' : "Inter, sans-serif";

  // Copy comes from props.text (window.__vs.text), in order.
  var copy = function (i) { return v.text[i] || ""; };
  $("pill-label").textContent = copy(0); // Render
  $("title").textContent = copy(1); // reel.mp4
  $("sub").textContent = copy(2); // Ready to post
  $("share-label").textContent = copy(3); // Share
  $("toast-text").textContent = copy(4); // Link copied
  $("end-title").textContent = copy(5); // video-studio

  document.body.style.background = paper;
  document.body.style.fontFamily = font;
  $("bg").style.background = paper;
  $("shape").style.background = accent;
  $("content").style.color = paper;
  $("ring-track").style.stroke = paper;
  $("ring-track").style.strokeOpacity = "0.24";
  $("ring-arc").style.stroke = paper;
  $("tile").style.background = paper;
  $("play").style.fill = accent;
  $("share").style.background = paper;
  $("share-label").style.color = accent;
  $("toast-disc").style.fill = paper;
  $("toast-check").style.stroke = accent;
  $("cursor").firstElementChild.style.fill = ink;
  $("cursor").firstElementChild.style.stroke = paper;

  // --------------------------------------------------------------------------- timing
  // Land each change on the measured beat grid of the score: the planned time snaps to the
  // nearest measured beat (downbeat for bar changes) within 120 ms; without a grid it stays
  // on the 120 BPM plan. Changes at 1, 3 and 5 s are beats; 2 and 4 s are bar starts.
  function snap(planned, grid) {
    var best = planned, dist = 0.12;
    for (var i = 0; i < grid.length; i++) {
      var d = Math.abs(grid[i] - planned);
      if (d <= dist) { best = grid[i]; dist = d; }
    }
    return best;
  }
  var T = [
    snap(1, v.beats), // click Render: the pill fills the frame
    snap(2, v.downbeats), // ring done: the frame becomes the card
    snap(3, v.beats), // click Share: the card becomes the toast
    snap(4, v.downbeats), // click the toast: it becomes the end card
    snap(5, v.beats) // the end card becomes the pill again
  ];

  // --------------------------------------------------------------------------- the shape
  // Resting geometry of each state (canvas px): centre, size, corner radius.
  var PILL = { x: 540, y: 540, w: 400, h: 128, r: 64 };
  var FILL = { x: 540, y: 540, w: 1080, h: 1080, r: 0 };
  var CARD = { x: 540, y: 540, w: 820, h: 392, r: 44 };
  var TOAST = { x: 540, y: 850, w: 560, h: 128, r: 64 };
  var STATES = [PILL, FILL, CARD, TOAST, FILL, PILL];

  // A fast-out curve: most of the move happens in the first frames, so the change reads on
  // the beat (and scores as a big change), then it settles without overshoot.
  var MORPH = 0.38;
  var out = vs.easeOutQuint;

  // Each key is its first value plus one eased step per change; the steps sum to zero over the
  // loop, so the value at the end is exactly the value at the start.
  function morph(t, key) {
    var value = STATES[0][key];
    for (var i = 0; i < T.length; i++) value += vs.tween(t, T[i], MORPH, 0, STATES[i + 1][key] - STATES[i][key], out);
    return value;
  }

  // A click: 0 -> 1 in the 80 ms before `at`, back to 0 after it (critically damped spring,
  // no overshoot). Exactly 0 outside that window.
  var RELEASE = { stiffness: 900, damping: 60 };
  function press(t, at) {
    if (t < at - 0.08) return 0;
    if (t < at) return vs.easeOut(vs.progress(t, at - 0.08, 0.08));
    return vs.spring(t, { from: 1, to: 0, delay: at, stiffness: RELEASE.stiffness, damping: RELEASE.damping });
  }

  // --------------------------------------------------------------------------- content
  // Content enters ~100 ms after its container starts moving and leaves before the next change.
  var IN = 0.42;
  var OUT_DUR = 0.12;
  function r2(n) { return Math.round(n * 100) / 100; }

  // A masked line: slides up into its box at `inAt`, out of the top at `outAt`. Outside that
  // window it rests in one canonical hidden state (below the mask, not drawn).
  function line(el, t, inAt, outAt) {
    var shown = inAt <= outAt ? t >= inAt && t < outAt + OUT_DUR : t >= inAt || t < outAt + OUT_DUR;
    if (!shown) {
      el.style.transform = "translateY(105%)";
      el.style.visibility = "hidden";
      return;
    }
    var leaving = inAt <= outAt ? t >= outAt : t >= outAt && t < inAt;
    // (A line that wraps across the seam is at rest between the seam and its exit.)
    var y = leaving ? vs.tween(t, outAt, OUT_DUR, 0, -105, vs.easeIn) : t >= inAt ? vs.tween(t, inAt, IN, 105, 0, out) : 0;
    el.style.transform = "translateY(" + r2(y) + "%)";
    el.style.visibility = "visible";
  }

  // A block that scales up into place and fades out when it leaves (same canonical hidden state).
  function pop(el, t, inAt, outAt, from) {
    if (t < inAt || t >= outAt + OUT_DUR) {
      el.style.opacity = "0";
      el.style.transform = "scale(1)";
      el.style.visibility = "hidden";
      return;
    }
    var o = vs.tween(t, inAt, IN * 0.6, 0, 1, out) - vs.tween(t, outAt, OUT_DUR, 0, 1, vs.easeIn);
    var s = vs.tween(t, inAt, IN, from, 1, out);
    el.style.opacity = String(r2(o));
    el.style.transform = "scale(" + r2(s * 1000) / 1000 + ")";
    el.style.visibility = "visible";
  }

  // The progress ring (circumference of r = 150).
  var C = 2 * Math.PI * 150;
  $("ring-arc").style.strokeDasharray = r2(C) + "px";

  // --------------------------------------------------------------------------- the cursor
  // It rests at REST, visits each click target and comes back, landing each click on T[i].
  var REST = { x: 780, y: 690 };
  var MOVES = [
    { at: 0.2, dur: 0.62, to: { x: 590, y: 566 } }, // to Render
    { at: T[0] + 0.12, dur: 0.5, to: REST }, // out of the way of the ring
    { at: T[1] + 0.1, dur: 0.5, to: { x: 636, y: 646 } }, // to Share, while the card fills in
    { at: T[2] + 0.3, dur: 0.46, to: { x: 704, y: 866 } }, // to the toast
    { at: T[3] + 0.24, dur: 0.56, to: REST } // home, still from here to the end of the loop
  ];
  function cursorAxis(t, key) {
    var value = REST[key], prev = REST[key];
    for (var i = 0; i < MOVES.length; i++) {
      value += vs.tween(t, MOVES[i].at, MOVES[i].dur, 0, MOVES[i].to[key] - prev, vs.easeInOut);
      prev = MOVES[i].to[key];
    }
    return value;
  }

  // --------------------------------------------------------------------------- seek
  window.seek = function (t) {
    // Clicks: Render (T0), Share (T2), the toast (T3).
    var clickPill = press(t, T[0]), clickShare = press(t, T[2]), clickToast = press(t, T[3]);

    // The shape; a click presses it in by 3%.
    var squeeze = 1 - 0.03 * (clickPill + clickToast);
    var w = morph(t, "w") * squeeze, h = morph(t, "h") * squeeze;
    var x = morph(t, "x"), y = morph(t, "y");
    var r = Math.min(morph(t, "r"), w / 2, h / 2);
    var left = x - w / 2, top = y - h / 2;
    var s = $("shape").style;
    s.left = r2(left) + "px";
    s.top = r2(top) + "px";
    s.width = r2(w) + "px";
    s.height = r2(h) + "px";
    s.borderRadius = r2(r) + "px";
    // Content never spills outside the shape, even mid-morph.
    $("content").style.clipPath = "inset(" + r2(top) + "px " + r2(1080 - left - w) + "px " + r2(1080 - top - h) + "px " + r2(left) + "px round " + r2(r) + "px)";

    // 1. Pill: the label leaves on the click and comes back after the last morph (across the seam).
    line($("pill-label"), t, T[4] + 0.1, T[0] - 0.06);

    // 2. Frame fill: the ring enters, fills, and leaves before the card.
    var ring = $("ring");
    pop(ring, t, T[0] + 0.1, T[1] - 0.16, 0.9);
    var fill = t >= T[0] && t < T[1] ? vs.easeInOut(vs.progress(t, T[0] + 0.16, 0.62)) : 0;
    $("ring-arc").style.strokeDashoffset = r2(C * (1 - fill)) + "px";

    // 3. Card: tile, title, status and button, staggered; gone as Share is clicked.
    pop($("tile"), t, T[1] + 0.1, T[2] - 0.06, 0.92);
    line($("title"), t, vs.stagger(1, 0.06, T[1] + 0.1), T[2] - 0.06);
    line($("sub"), t, vs.stagger(2, 0.06, T[1] + 0.1), T[2] - 0.06);
    pop($("share"), t, vs.stagger(3, 0.06, T[1] + 0.1), T[2] - 0.06, 0.9);
    if (t >= T[1] && t < T[2] + OUT_DUR) {
      $("share").style.transform += " scale(" + r2((1 - 0.06 * clickShare) * 1000) / 1000 + ")";
    }

    // 4. Toast: check, then text; gone as the toast is clicked.
    pop($("toast-icon"), t, T[2] + 0.1, T[3] - 0.06, 0.6);
    line($("toast-text"), t, T[2] + 0.16, T[3] - 0.06);

    // 5. End card: the product name; gone before the frame shrinks back into the pill.
    line($("end-title"), t, T[3] + 0.12, T[4] - 0.16);

    // The cursor, pressed on each click.
    var c = $("cursor").style;
    var cs = 1 - 0.14 * (clickPill + clickShare + clickToast);
    c.transform = "translate(" + r2(cursorAxis(t, "x") - 3) + "px, " + r2(cursorAxis(t, "y") - 3) + "px) scale(" + r2(cs * 1000) / 1000 + ")";
  };

  window.readyForCapture = document.fonts ? document.fonts.ready : Promise.resolve();
})();
