// s01 (hook, 0-4 s on the reel): three scribbled note slips tumble in, jostle on beat 2, snap
// into a tidy checklist on the bar, and tick one by one. Headline: "Meeting notes in." then
// "Action list out." (props.text 0-1). The slips' scribbles are shapes, not words.
(function () {
  var vs = window.vs, CM = window.CM, T0 = 0;
  var bg = CM.background();
  var h0 = CM.masked("headline", CM.text(0)), h1 = CM.masked("headline", CM.text(1));
  [h0, h1].forEach(function (x) { x.style.color = CM.ink; });
  var list = CM.el("div", "layer");
  var rng = vs.rng(11);
  var slips = [0, 1, 2].map(function () {
    var s = CM.el("div", "slip", list), bx = CM.box(s), st = CM.el("div", "st", s);
    // Two strokes of "handwriting" per slip: rounded bars of seeded widths.
    var bars = [0, 1].map(function (k) {
      var b = CM.el("div", "", st);
      b.style.position = "absolute";
      b.style.left = "0px";
      b.style.top = 44 + k * 42 + "px";
      b.style.height = "20px";
      b.style.borderRadius = "10px";
      b.style.width = Math.round(k === 0 ? 480 + rng() * 180 : 220 + rng() * 200) + "px";
      b.style.background = k === 0 ? CM.ink : CM.muted;
      return b;
    });
    return { el: s, box: bx, st: st, bars: bars };
  });
  // Scattered (x, y, deg), jostled on beat 2, then the list on the bar.
  var SCAT = [[150, 640, -7], [80, 880, 5], [170, 1120, -3]];
  var JOST = [[110, 660, 6], [150, 860, -6], [120, 1140, 4]];
  var LIST = [[130, 640, 0], [130, 820, 0], [130, 1000, 0]];

  window.seek = function (t) {
    CM.drift(bg, T0 + t);
    var B2 = CM.beat(2), BAR = CM.beat(4), B6 = CM.beat(6);
    CM.line(t, h0, 0.12, BAR - 0.3);
    CM.line(t, h1, Math.max(vs.revealAt(1), BAR + 0.1), null);
    var squeeze = vs.tween(t, BAR, 0.4, 0, 1, vs.easeOutQuint);
    slips.forEach(function (s, i) {
      var d = 0.09 * i, o = CM.feel;
      var x = vs.springs(t, SCAT[i][0], [{ at: B2 + d, to: JOST[i][0] }, { at: BAR + d, to: LIST[i][0] }], o);
      var y = vs.springs(t, 2100, [{ at: d, to: SCAT[i][1] }, { at: B2 + d, to: JOST[i][1] }, { at: BAR + d, to: LIST[i][1] }], o);
      var r = vs.springs(t, SCAT[i][2] * 3, [{ at: d, to: SCAT[i][2] }, { at: B2 + d, to: JOST[i][2] }, { at: BAR + d, to: 0 }], o);
      s.el.style.transform = "translate(" + x + "px," + y + "px) rotate(" + r + "deg)";
      // On the bar the checkbox grows in and the scribbles make room for it.
      var bi = vs.tween(t, BAR + 0.1 + d, 0.3, 0, 1, vs.easeOutQuint);
      s.box.el.style.opacity = String(bi);
      s.st.style.left = 36 + 94 * squeeze + "px";
      s.bars.forEach(function (b) { b.style.transform = "scaleX(" + (1 - 0.18 * squeeze) + ")"; b.style.transformOrigin = "0 50%"; });
      CM.tick(s.box, t, B6 + 0.1 * i);
      if (bi < 1) s.box.el.style.transform = "scale(" + bi + ")";
    });
    list.style.transform = "scale(" + CM.breath(t, 0.02) + ")";
  };
  window.readyForCapture = CM.ready();
})();
