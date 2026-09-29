// s05 (end card, 16-20 s): opens on s04's last frame, a full mint frame. The app icon springs in,
// the name rises on beat 1, the call to action lands on the bar and the address on beat 5; then
// a long hold while the icon breathes with the kick (at most 3 %) and the dots drift.
// Text: 0 name, 1 call to action, 2 address.
(function () {
  var vs = window.vs, CM = window.CM, T0 = 16;
  var bg = CM.background();
  var fill = CM.el("div", "layer");
  fill.style.background = CM.mint;
  var dots = CM.dots(bg);
  var icon = CM.el("div", "logo"), img = CM.el("img", "", icon);
  img.src = "logo-mark.png";
  img.alt = "";
  icon.style.background = CM.white;
  icon.style.borderRadius = "72px";
  icon.style.boxShadow = "0 30px 70px " + CM.rgba(CM.ink, 0.18);
  img.style.position = "absolute";
  img.style.left = "30px";
  img.style.top = "30px";
  img.style.width = "220px";
  img.style.height = "220px";
  var name = CM.masked("brandname", CM.text(0)), url = CM.masked("url", CM.text(2));
  var cta = CM.el("div", "cta");
  cta.textContent = CM.text(1);
  cta.style.background = CM.ink;
  cta.style.color = CM.paper;

  window.seek = function (t) {
    CM.drift(bg, T0 + t);
    var B1 = CM.beat(1), BAR = CM.beat(4), B5 = CM.beat(5);
    dots.style.opacity = "0.1";
    var ic = vs.spring(t, { from: 0, to: 1, delay: 0.08, stiffness: 200, damping: 29 });
    icon.style.opacity = String(vs.progress(t, 0.08, 0.12));
    icon.style.transform = "scale(" + ic * CM.breath(t, 0.03) + ") rotate(" + (1 - ic) * -16 + "deg)";
    CM.line(t, name, B1, null);
    var c = vs.spring(t, { from: 0.5, to: 1, delay: BAR, stiffness: 220, damping: 30 });
    cta.style.opacity = String(vs.progress(t, BAR, 0.12));
    cta.style.transform = "scale(" + c + ")";
    CM.line(t, url, B5, null);
  };
  window.readyForCapture = CM.ready();
})();
