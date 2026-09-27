// A shape that morphs through three states on springs, in the brand's primary colour.
// Every value is computed from t alone (window.seek), so any frame can be drawn in any order.
(function () {
  var vs = window.vs;
  var data = window.__vs;
  var palette = data.tokens.palette;
  var fonts = data.tokens.fonts;
  var shape = document.getElementById("shape");
  var copy = document.getElementById("copy");
  var lines = data.text.length ? data.text : [""];

  document.body.style.background = palette.background || "#0B0F19";
  copy.style.color = palette.text || "#F5F7FA";
  copy.style.fontFamily = fonts.heading || "sans-serif";
  shape.setAttribute("fill", palette.primary || "#4F8CFF");

  // Square, then circle, then a wide pill; land each change on a downbeat when there is one.
  var d = data.duration;
  var marks = [0, d * 0.33, d * 0.66].map(function (m) {
    var b = vs.downbeatAt(m);
    return b !== null && m - b < 0.25 ? b : m;
  });
  var states = [
    { w: 220, h: 220, r: 12, rot: 0 },
    { w: 340, h: 340, r: 170, rot: 90 },
    { w: 620, h: 200, r: 100, rot: 180 }
  ];
  var feel = { stiffness: 140, damping: 16, mass: 1 };
  function value(t, key) {
    return vs.springs(t, states[0][key], [
      { at: marks[1], to: states[1][key] },
      { at: marks[2], to: states[2][key] }
    ], feel);
  }

  window.seek = function (t) {
    var w = value(t, "w");
    var h = value(t, "h");
    var r = vs.clamp(value(t, "r"), 0, Math.min(w, h) / 2);
    shape.setAttribute("x", String(500 - w / 2));
    shape.setAttribute("y", String(460 - h / 2));
    shape.setAttribute("width", String(w));
    shape.setAttribute("height", String(h));
    shape.setAttribute("rx", String(r));
    shape.setAttribute("transform", "rotate(" + value(t, "rot") + " 500 460)");
    var i = t < marks[1] ? 0 : t < marks[2] ? 1 : 2;
    var line = lines[Math.min(i, lines.length - 1)];
    var p = vs.easeOut(vs.progress(t, marks[i], 0.35));
    copy.textContent = line;
    copy.style.opacity = String(p);
    copy.style.transform = "translateY(" + vs.lerp(24, 0, p) + "px)";
  };

  window.readyForCapture = document.fonts ? document.fonts.ready : Promise.resolve();
})();
