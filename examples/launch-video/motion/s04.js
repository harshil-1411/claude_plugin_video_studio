// s04 (step 3, result, 12-16 s): opens on s03's last frame (the card, empty). The three actions
// slide in on beats 1, 2 and 3, each with its owner and due date; on the bar the card pulls back,
// the count lands and the first box ticks; the others tick on beats 5 and 6. On beat 7 the last
// ticked box grows into a full mint frame, which s05 opens on.
// Text: 0 label, 1 wordmark, 2 count, 3-5 actions, 6-8 owners, 9-11 due days.
(function () {
  var vs = window.vs, CM = window.CM, T0 = 12;
  var bg = CM.background();
  var label = CM.masked("label", CM.text(0));
  var card = CM.card(CM.text(1));
  var list = CM.rows(card, CM.text(2), [0, 1, 2].map(function (i) { return [CM.text(3 + i), CM.text(6 + i), CM.text(9 + i)]; }));
  var fill = CM.el("div", "");
  fill.style.position = "absolute";
  fill.style.background = CM.mint;
  var dots = CM.dots(bg);
  // Row 3's box on the stage once the card rests at scale 1: card (90, 560) + border 3 + row
  // (45, 250 + 2 * 190) + box top 10. s05 starts on the full frame this grows into.
  var BOX = { x: 138, y: 1203, s: 64 };

  window.seek = function (t) {
    CM.drift(bg, T0 + t);
    var B1 = CM.beat(1), STEP = CM.beat(2) - CM.beat(1), BAR = CM.beat(4), B7 = CM.beat(7);
    CM.line(t, label, 0.12, null);
    var y = vs.springs(t, -20, [{ at: BAR, to: 0 }], CM.feel);
    var s = vs.springs(t, 1.06, [{ at: BAR, to: 1 }], CM.feel);
    CM.pose(card, t, y, s);
    list.rows.forEach(function (r, i) {
      var x = vs.spring(t, { from: 960, to: 0, delay: B1 + i * STEP, stiffness: 190, damping: 28 });
      r.el.style.transform = "translateX(" + x + "px)";
      CM.tick(r.box, t, BAR + i * STEP);
    });
    list.count.style.opacity = String(vs.progress(t, BAR + 0.1, 0.2));
    list.count.style.transform = "translateY(" + vs.tween(t, BAR + 0.1, 0.4, 30, 0, vs.easeOutQuint) + "px)";
    // The last box grows to fill the frame (a shape growing, never a fade into the accent).
    var g = vs.tween(t, B7, 0.45, 0, 1, vs.easeInOutQuint);
    fill.style.opacity = t < B7 ? "0" : "1";
    fill.style.left = vs.lerp(BOX.x, -20, g) + "px";
    fill.style.top = vs.lerp(BOX.y, -20, g) + "px";
    fill.style.width = vs.lerp(BOX.s, 1120, g) + "px";
    fill.style.height = vs.lerp(BOX.s, 1960, g) + "px";
    fill.style.borderRadius = vs.lerp(16, 0, g) + "px";
    dots.style.opacity = String(0.1 * g);
  };
  window.readyForCapture = CM.ready();
})();
