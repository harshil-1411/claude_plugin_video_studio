// s03 (step 2, key action, 8-12 s): opens on s02's last frame (card pushed in, notes pasted).
// The cursor glides to Tidy it and clicks on beat 2; the button turns ink, a mint band reads down
// the notes and marks each owner (coral) and due date (mint underline) on beats 3, 4 and 5; a
// 600 ms hold; on beat 7 the marked notes slide out and the button drops, leaving the card empty
// for s04. Text: 0 label, 1 wordmark, 2-4 notes, 5 the button.
(function () {
  var vs = window.vs, CM = window.CM, T0 = 8;
  var bg = CM.background();
  var label = CM.masked("label", CM.text(0));
  var card = CM.card(CM.text(1));
  var notes = CM.notes(card, [CM.text(2), CM.text(3), CM.text(4)]);
  var btn = CM.button(card, CM.text(5));
  var cursor = CM.el("div", "cursor");
  cursor.style.background = CM.ink;
  // Button centre on the stage with the card at translateY(-20px) scale(1.06) about (540, 1000).
  var BX = 540 + (90 + 3 + 549 + 150 - 540) * 1.06, BY = 1000 + (560 + 3 + 722 + 55 - 1000) * 1.06 - 20;

  window.seek = function (t) {
    CM.drift(bg, T0 + t);
    var B2 = CM.beat(2), B3 = CM.beat(3), BAR = CM.beat(4), B5 = CM.beat(5), B6 = CM.beat(6), B7 = CM.beat(7);
    CM.line(t, label, 0.12, null);
    CM.pose(card, t, -20, 1.06);
    card.head.style.transform = "none";
    notes.box.style.borderColor = CM.mint;
    notes.box.style.borderStyle = "solid";
    notes.box.style.background = CM.white;
    notes.caret.style.left = "40px";
    notes.caret.style.top = "396px";
    notes.caret.style.opacity = t < B2 && t % 0.5 < 0.3 ? "1" : "0";
    // Cursor: in from the bottom right, onto the button by beat 2, clicks, then leaves.
    var p = vs.progress(t, 0.05, B2 - 0.1);
    var e = vs.easeInOut(p);
    var cx = vs.lerp(1000, BX - 8, e) + vs.tween(t, B2 + 0.4, 0.7, 0, 420, vs.easeIn);
    var cy = vs.lerp(1780, BY - 6, e) - 90 * Math.sin(Math.PI * e) + vs.tween(t, B2 + 0.4, 0.7, 0, 380, vs.easeIn);
    var press = vs.springs(t, 1, [{ at: B2, to: 0.82 }, { at: B2 + 0.12, to: 1 }], { stiffness: 400, damping: 40 });
    cursor.style.transform = "translate(" + cx + "px," + cy + "px) scale(" + press + ")";
    // Click: the button dips, a ripple spreads from the tip, the button turns ink.
    var dip = vs.springs(t, 1, [{ at: B2, to: 0.93 }, { at: B2 + 0.12, to: 1 }], { stiffness: 400, damping: 40 });
    btn.el.style.opacity = "1";
    btn.el.style.transform = "translateY(" + vs.tween(t, B7, 0.35, 0, 320, vs.easeIn) + "px) scale(" + dip + ")";
    var inked = vs.tween(t, B2 + 0.15, 0.25, 0, 1, vs.easeInOut);
    btn.el.style.background = CM.mix(CM.mint, CM.ink, inked);
    btn.el.style.color = CM.mix(CM.ink, CM.paper, inked);
    btn.el.style.boxShadow = "0 0 " + Math.round(12 + 36 * vs.energy(t)) + "px " + CM.rgba(CM.mint, 0.7 * (1 - inked));
    var rr = vs.tween(t, B2, 0.45, 0, 700, vs.easeOut);
    btn.ripple.style.width = rr + "px";
    btn.ripple.style.height = rr + "px";
    btn.ripple.style.left = 150 - rr / 2 + "px";
    btn.ripple.style.top = 55 - rr / 2 + "px";
    btn.ripple.style.opacity = String(t < B2 ? 0 : 0.8 * (1 - vs.progress(t, B2 + 0.1, 0.4)));
    // The reading band sweeps the lines, passing line i on beat 3 + i.
    var bandY = 4 + (t - B3) * 280;
    notes.band.style.top = bandY + "px";
    notes.band.style.opacity = String(vs.progress(t, B2 + 0.1, 0.15) * (1 - vs.progress(t, B5 + 0.1, 0.3)));
    CM.mark(notes, t, [B3, BAR, B5], null);
    notes.box.style.transform = "translateX(" + vs.tween(t, B7, 0.4, 0, -960, vs.easeIn) + "px)";
  };
  window.readyForCapture = CM.ready();
})();
