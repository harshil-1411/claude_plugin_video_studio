// Shared builders for Checkmint's motion pages (s01-s05). Every page builds its DOM once at load,
// then its own window.seek(t) sets styles from t alone. G = the scene's start on the reel + t, so
// the background drifts continuously across cuts.
(function () {
  var vs = window.vs, v = window.__vs, tok = v.tokens || {}, pal = tok.palette || {}, fonts = tok.fonts || {};
  var CM = {};
  CM.ink = pal.text || "#14211C";
  CM.paper = pal.background || "#F6F3EA";
  CM.mint = pal.primary || "#2BD49A";
  CM.coral = pal.secondary || "#FF7A59";
  CM.muted = "#5D6B64";
  CM.white = "#FFFFFF";
  CM.face = '"' + (fonts.heading || "Checkmint Sans") + '", "Inter", sans-serif';
  // Critically damped (2 * sqrt(190) = 27.6): settles fast, no overshoot on type.
  CM.feel = { stiffness: 190, damping: 28 };
  CM.text = function (i) { return v.text[i] || ""; };
  // Beat n of this scene: the measured grid when there is one, else 120 BPM (synth:pulse).
  CM.beat = function (n) { return v.beats.length > n ? v.beats[n] : n * 0.5; };
  // Breathing with the kick, at most 1.5 % on the card and 3 % on the logo.
  CM.breath = function (t, amt) { return 1 + (amt || 0.015) * vs.bass(t); };

  function rgb(hex) {
    var h = String(hex).replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  CM.rgba = function (hex, a) { var c = rgb(hex); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; };
  CM.mix = function (a, b, p) {
    var x = rgb(a), y = rgb(b);
    return "rgb(" + Math.round(vs.lerp(x[0], y[0], p)) + "," + Math.round(vs.lerp(x[1], y[1], p)) + "," + Math.round(vs.lerp(x[2], y[2], p)) + ")";
  };

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    (parent || document.getElementById("stage")).appendChild(e);
    return e;
  }
  CM.el = el;

  // Layer 1-3: paper, two soft brand-colour blobs, a dot grid.
  CM.background = function () {
    var stage = document.getElementById("stage");
    stage.style.background = CM.paper;
    stage.style.color = CM.ink;
    stage.style.fontFamily = CM.face;
    var a = el("div", "blob"), b = el("div", "blob"), d = el("div", "layer");
    d.id = "dots";
    a.style.background = "radial-gradient(circle, " + CM.rgba(CM.mint, 0.34) + " 0%, " + CM.rgba(CM.mint, 0) + " 66%)";
    b.style.background = "radial-gradient(circle, " + CM.rgba(CM.coral, 0.24) + " 0%, " + CM.rgba(CM.coral, 0) + " 66%)";
    return { a: a, b: b, dots: [d] };
  };
  CM.dots = function (bg) { var d = el("div", "layer"); d.id = "dots2"; d.className = "layer"; bg.dots.push(d); return d; };
  CM.drift = function (bg, G) {
    var TAU = Math.PI * 2;
    bg.a.style.transform = "translate(" + (-440 + 170 * Math.sin(TAU * G / 11)) + "px," + (-300 + 240 * Math.cos(TAU * G / 14)) + "px)";
    bg.b.style.transform = "translate(" + (360 + 190 * Math.cos(TAU * G / 13)) + "px," + (1100 + 220 * Math.sin(TAU * G / 9)) + "px)";
    bg.dots.forEach(function (d) { d.style.backgroundPosition = (G * 8) + "px " + (-G * 24) + "px"; });
  };

  // A line of display type in an overflow-hidden mask: slides up in at inAt, out of the top at outAt.
  CM.masked = function (cls, str) {
    var m = el("div", "mask " + cls), x = el("div", "txt", m);
    x.textContent = str;
    return x;
  };
  CM.line = function (t, x, inAt, outAt) {
    var y = vs.tween(t, inAt, 0.45, 110, 0, vs.easeOutQuint);
    if (outAt != null) y += vs.tween(t, outAt, 0.3, 0, -110, vs.easeIn);
    x.style.transform = "translateY(" + y + "%)";
  };

  // The check mark: a stroked polyline whose length is about 52 px.
  var CHECK = '<svg viewBox="0 0 42 38"><polyline points="4,20 16,32 38,6" fill="none" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="52" stroke-dashoffset="52"/></svg>';
  CM.box = function (parent) {
    var b = el("div", "box", parent);
    b.innerHTML = CHECK;
    return { el: b, poly: b.querySelector("polyline") };
  };
  // Checkbox state: 0 empty (ink outline), 1 ticked (mint fill, ink check drawn).
  CM.tick = function (bx, t, at) {
    var p = vs.tween(t, at, 0.22, 0, 1, vs.easeOutQuint);
    var d = vs.tween(t, at + 0.06, 0.3, 0, 1, vs.easeOutQuint);
    bx.el.style.borderColor = CM.mix(CM.ink, CM.mint, p);
    bx.el.style.background = p > 0 ? CM.rgba(CM.mint, p) : "transparent";
    bx.el.style.transform = "scale(" + (1 + 0.12 * Math.sin(Math.PI * p)) + ")";
    bx.poly.setAttribute("stroke", CM.ink);
    bx.poly.setAttribute("stroke-dashoffset", String(52 * (1 - d)));
  };

  // The app card with its header (logo mark and wordmark).
  CM.card = function (wordmark) {
    var c = el("div", "card");
    c.style.color = CM.ink;
    var head = el("div", "card-head", c);
    var img = el("img", "", head);
    img.src = "logo-mark.png";
    img.alt = "";
    el("div", "wordmark", head).textContent = wordmark;
    return { el: c, head: head };
  };
  // Card pose: rises in, then pushes in on the notes (scale about the card centre).
  CM.pose = function (card, t, y, s) {
    card.el.style.transform = "translateY(" + y + "px) scale(" + s * CM.breath(t) + ")";
  };

  // Step 1: the notes box. Each word is a span so owners and due dates can be marked later.
  CM.notes = function (card, lines) {
    var box = el("div", "notes", card.el);
    box.style.background = CM.paper;
    var band = el("div", "band", box);
    band.style.background = CM.rgba(CM.mint, 0.3);
    band.style.borderRadius = "20px";
    var caret = el("div", "caret", box);
    caret.style.background = CM.ink;
    var tops = [36, 176, 316];
    var out = { box: box, band: band, caret: caret, lines: [] };
    lines.forEach(function (s, i) {
      var ln = el("div", "note", box);
      ln.style.top = tops[i] + "px";
      var words = s.split(/\s+/), dated = /\b(by|before)\b/i.test(s);
      out.lines.push({ el: ln, words: words.map(function (w, j) {
        var sp = el("span", "w", ln), hl = el("span", "hl", sp), ul = el("span", "ul", sp), wt = el("span", "wt", sp);
        wt.textContent = w;
        hl.style.background = CM.coral;
        ul.style.background = CM.mint;
        ul.style.transformOrigin = "0 50%";
        return { sp: sp, hl: hl, ul: ul, role: j === 0 ? "owner" : dated && j === words.length - 1 ? "due" : "" };
      }) });
    });
    return out;
  };
  // Mark who (coral, first word) and by when (mint underline, last word after "by"/"before");
  // at[i] = when line i is marked; dimAt = when the other words fade back and the marks lift.
  CM.mark = function (n, t, at, dimAt) {
    n.lines.forEach(function (L, i) {
      var p = at ? vs.tween(t, at[i], 0.3, 0, 1, vs.easeOutQuint) : 0;
      var dim = dimAt == null ? 0 : vs.tween(t, dimAt, 0.35, 0, 1, vs.easeInOut);
      L.words.forEach(function (w) {
        if (w.role === "owner") {
          w.hl.style.clipPath = "inset(0 " + (100 - 100 * p) + "% 0 0 round 12px)";
          w.sp.style.transform = "translateY(" + (-8 * dim) + "px)";
        } else if (w.role === "due") {
          w.ul.style.transform = "scaleX(" + p + ")";
          w.sp.style.transform = "translateY(" + (-8 * dim) + "px)";
        } else {
          w.hl.style.clipPath = "inset(0 100% 0 0)";
          w.ul.style.transform = "scaleX(0)";
          w.sp.style.opacity = String(1 - 0.68 * dim);
        }
      });
    });
  };

  // Step 2: the Tidy it button, in the card.
  CM.button = function (card, label) {
    var b = el("div", "tidy", card.el), r = el("div", "ripple", b), x = el("span", "", b);
    x.textContent = label;
    x.style.position = "relative";
    r.style.background = CM.rgba(CM.white, 0.55);
    return { el: b, ripple: r, label: x };
  };

  // Step 3: the action list rows (the site's table), in the card.
  CM.rows = function (card, count, data) {
    var c = el("div", "count", card.el);
    c.textContent = count;
    c.style.color = CM.muted;
    var rows = data.map(function (d, i) {
      var r = el("div", "row", card.el);
      r.style.top = 250 + i * 190 + "px";
      var bx = CM.box(r);
      el("div", "task", r).textContent = d[0];
      var chips = el("div", "chips", r), ow = el("div", "owner", chips), du = el("div", "due", chips);
      ow.textContent = d[1];
      du.textContent = d[2];
      ow.style.background = CM.coral;
      du.style.borderColor = CM.ink;
      return { el: r, box: bx };
    });
    return { count: c, rows: rows };
  };

  CM.ready = function () {
    var imgs = Array.prototype.slice.call(document.querySelectorAll("img")).map(function (i) { return i.decode ? i.decode().catch(function () {}) : null; });
    return Promise.all([document.fonts ? document.fonts.ready : null].concat(imgs));
  };

  window.CM = CM;
})();
