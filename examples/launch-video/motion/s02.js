// s02 (step 1, entry, 4-8 s): the Checkmint card rises in, the notes are pasted in on beat 2
// (the box takes focus), the card pushes in on the bar, and the Tidy it button arrives on beat 6.
// Text: 0 label, 1 wordmark, 2-4 the pasted notes, 5 the button.
(function () {
  var vs = window.vs, CM = window.CM, T0 = 4;
  var bg = CM.background();
  var label = CM.masked("label", CM.text(0));
  var card = CM.card(CM.text(1));
  var notes = CM.notes(card, [CM.text(2), CM.text(3), CM.text(4)]);
  var btn = CM.button(card, CM.text(5));
  btn.el.style.background = CM.mint;
  btn.el.style.color = CM.ink;

  window.seek = function (t) {
    CM.drift(bg, T0 + t);
    var B2 = CM.beat(2), BAR = CM.beat(4), B6 = CM.beat(6);
    CM.line(t, label, 0.12, null);
    var y = vs.springs(t, 1500, [{ at: 0, to: 0 }, { at: BAR, to: -20 }], CM.feel);
    var s = vs.springs(t, 1, [{ at: BAR, to: 1.06 }], CM.feel);
    CM.pose(card, t, y, s);
    card.head.style.transform = "translateY(" + vs.tween(t, 0.12, 0.4, 40, 0, vs.easeOutQuint) + "px)";
    card.head.style.opacity = String(vs.progress(t, 0.12, 0.25));
    // Paste: the three lines drop in together, the box takes focus.
    var f = vs.tween(t, B2, 0.25, 0, 1, vs.easeOut);
    notes.box.style.borderColor = CM.mix(CM.muted, CM.mint, f);
    notes.box.style.borderStyle = f > 0.5 ? "solid" : "dashed";
    notes.box.style.background = CM.mix(CM.paper, CM.white, f);
    notes.lines.forEach(function (L, i) {
      var at = B2 + 0.07 * i;
      L.el.style.opacity = String(vs.progress(t, at, 0.18));
      L.el.style.transform = "translateY(" + vs.tween(t, at, 0.4, 28, 0, vs.easeOutQuint) + "px)";
    });
    CM.mark(notes, t, null, null);
    notes.band.style.opacity = "0";
    // Caret: blinks on the beat, at the start before the paste and on a fresh line after it.
    var pasted = t >= B2;
    notes.caret.style.left = "40px";
    notes.caret.style.top = (pasted ? 396 : 42) + "px";
    notes.caret.style.opacity = t % 0.5 < 0.3 ? "1" : "0";
    // The button arrives on beat 6 and glows with the bed.
    var b = vs.spring(t, { from: 0.4, to: 1, delay: B6, stiffness: 220, damping: 30 });
    btn.el.style.opacity = String(vs.progress(t, B6, 0.15));
    btn.el.style.transform = "scale(" + b + ")";
    btn.el.style.boxShadow = "0 0 " + Math.round(12 + 36 * vs.energy(t)) + "px " + CM.rgba(CM.mint, 0.7);
    btn.ripple.style.opacity = "0";
  };
  window.readyForCapture = CM.ready();
})();
