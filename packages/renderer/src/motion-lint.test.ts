import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type MotionFile, lintMotionPage, loadMotionPage } from "./motion-lint.js";

const FIXTURES = fileURLToPath(new URL("./__fixtures__/motion/", import.meta.url));

/** A temp project with the motion fixtures under motion/. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "vs-motion-lint-"));
  cpSync(FIXTURES, join(root, "motion"), { recursive: true });
  return root;
}

const page = (script: string, extra = "") => `<!doctype html><html><head>${extra}</head><body><div id="a"></div><script>${script}
window.seek = function (t) {};</script></body></html>`;
const ids = (html: string, files?: ReadonlyMap<string, MotionFile>) =>
  lintMotionPage(html, files ? { files } : {}).findings.filter((f) => f.severity === "error").map((f) => f.id);
const text = (s: string): MotionFile => ({ bytes: new TextEncoder().encode(s) });

describe("lintMotionPage: scripts", () => {
  it("rejects network access, clocks, randomness, timers, eval and window.open", () => {
    const cases: Array<[string, string]> = [
      ['fetch("/x")', "motion_network"],
      ['window.fetch("x")', "motion_network"],
      ["new XMLHttpRequest()", "motion_network"],
      ['new WebSocket("ws://x")', "motion_network"],
      ['new EventSource("x")', "motion_network"],
      ['navigator.sendBeacon("x", "y")', "motion_network"],
      ['import("./x.js")', "motion_network"],
      ["Date.now()", "motion_clock"],
      ["new Date()", "motion_clock"],
      ["Date()", "motion_clock"],
      ["performance.now()", "motion_clock"],
      ["window.performance.now()", "motion_clock"],
      ["Math.random()", "motion_random"],
      ["setTimeout(function () {}, 10)", "motion_timer"],
      ["setInterval(function () {}, 10)", "motion_timer"],
      ["requestAnimationFrame(function () {})", "motion_timer"],
      ['eval("1")', "motion_eval"],
      ['new Function("return 1")', "motion_eval"],
      ['window.open("https://x")', "motion_network"],
    ];
    for (const [code, id] of cases) expect(ids(page(code)), code).toEqual([id]);
  });

  it("tells the author to use vs.rng for randomness", () => {
    const f = lintMotionPage(page("var x = Math.random();")).findings.find((x) => x.id === "motion_random");
    expect(f?.fix).toMatch(/vs\.rng\(seed\)/);
    expect(f?.line).toBe(1);
  });

  it("allows look-alikes: seeded dates, own properties and object keys", () => {
    expect(ids(page('var d = new Date(2020, 0, 1); var api = { fetch: 1, setTimeout: 2 }; api.fetch; var o = { now: 1 }; o.now; var r = vs.rng(3);'))).toEqual([]);
  });

  it("follows static imports of local modules and rejects packages and URLs", () => {
    const html = `<script type="module">import { a } from "./lib/a.js"; import "https://cdn.example/x.js"; window.seek = (t) => a(t);</script>`;
    const files = new Map([["lib/a.js", text('import { b } from "./b.js"; export const a = (t) => fetch("x");')], ["lib/b.js", text("export const b = 1;")]]);
    const r = lintMotionPage(html, { files });
    expect(r.refs).toEqual(["lib/a.js", "lib/b.js"]);
    expect(r.findings.map((f) => [f.id, f.file ?? "page"])).toEqual([
      ["motion_network", "page"],
      ["motion_network", "lib/a.js"],
    ]);
  });

  it("reports unparseable scripts as errors (they cannot be checked)", () => {
    expect(ids("<script>window.seek = function (</script>")).toContain("motion_parse_error");
  });

  it("lints inline event handlers", () => {
    expect(ids(page("", "") + '<img src="a.png" onerror="fetch(1)">')).toContain("motion_network");
  });

  it("warns when nothing assigns window.seek, and accepts the usual ways to define it", () => {
    const warn = lintMotionPage("<script>var x = 1;</script>").findings;
    expect(warn.map((f) => [f.id, f.severity])).toEqual([["motion_no_seek", "warning"]]);
    expect(warn[0]!.fix).toMatch(/window\.seek/);
    for (const s of ["function seek(t) {}", "var seek = function (t) {};", "globalThis.seek = (t) => {};", "Object.assign(window, { seek: function (t) {} });"]) {
      expect(lintMotionPage(`<script>${s}</script>`).findings, s).toEqual([]);
    }
  });
});

describe("lintMotionPage: markup and CSS", () => {
  it("rejects remote references in src, href, srcset, url() and @import", () => {
    const html = page(
      "",
      `<link rel="stylesheet" href="https://fonts.example/css"><style>@import url("//cdn.example/a.css"); .x { background: url(http://x/y.png); }</style>`,
    ) + `<img src="https://example.com/a.png"><img srcset="a.png 1x, https://x/b.png 2x"><svg><image href="javascript:alert(1)"/></svg><img src="/etc/passwd">`;
    const errs = lintMotionPage(html).findings.filter((f) => f.id === "motion_remote_ref");
    expect(errs.length).toBe(7);
    // Entities cannot hide a scheme.
    expect(ids(page("") + '<img src="http&#58;//x/a.png">')).toEqual(["motion_remote_ref"]);
  });

  it("allows data: URLs, fragments and local files, and returns the local files", () => {
    const html = page("", '<link rel="stylesheet" href="./css/site.css">') + '<img src="img/a.png?v=1"><svg><use href="#s"/></svg><img src="data:image/png;base64,AAAA">';
    const r = lintMotionPage(html, { files: new Map([["css/site.css", text('.a { background: url("../img/b.png") }')]]) });
    expect(r.findings).toEqual([]);
    expect(r.refs).toEqual(["css/site.css", "img/a.png", "img/b.png"]);
  });

  it("rejects frames, plugins, base, meta refresh and import maps", () => {
    const tags = ['<iframe src="a.html"></iframe>', '<object data="a.swf"></object>', '<embed src="a.swf">', '<base href="https://x/">', '<meta http-equiv="refresh" content="0; url=https://x">', '<script type="importmap">{}</script>'];
    for (const t of tags) expect(ids(page("") + t), t).toContain("motion_forbidden_tag");
  });

  it("rejects CSS transitions, animations and keyframes (in <style>, style= and stylesheets)", () => {
    expect(ids(page("", "<style>.a { transition: opacity 1s; }</style>"))).toEqual(["motion_css_animation"]);
    expect(ids(page("", "<style>@keyframes spin { to { transform: rotate(1turn); } }</style>"))).toEqual(["motion_css_animation"]);
    expect(ids(page("") + '<div style="animation-name: x"></div>')).toEqual(["motion_css_animation"]);
    expect(ids(page("", '<link rel="stylesheet" href="a.css">'), new Map([["a.css", text(".a { -webkit-transition-duration: 1s }")]]))).toEqual(["motion_css_animation"]);
    // Class names that merely contain the words are fine.
    expect(ids(page("", "<style>.transition, .animation-box { opacity: 1; }</style>"))).toEqual([]);
  });

  it("ignores markup inside scripts and comments", () => {
    expect(ids(page('var s = "<iframe src=https://x>";', "<!-- <img src='https://x/a.png'> -->"))).toEqual([]);
  });

  it("rejects references that leave the page's folder", () => {
    const r = lintMotionPage(page("") + '<img src="../secret.png"><img src="a/../../b.png">');
    expect(r.findings.filter((f) => f.id === "motion_asset_outside").length).toBe(2);
    expect(r.refs).toEqual([]);
  });
});

describe("loadMotionPage", () => {
  it("passes the example page (springs, brand colour, local script and style)", async () => {
    const root = project();
    const p = await loadMotionPage(root, "motion/morph.html");
    expect(p.findings).toEqual([]);
    expect(p.html).toContain("morph.js");
    expect(p.files.map((f) => f.ref)).toEqual(["morph.css", "morph.js"]);
    expect(p.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
  });

  it("rejects the unsafe fixture: fetch, a remote image and Date.now", async () => {
    const p = await loadMotionPage(project(), "motion/unsafe.html");
    const errs = p.findings.filter((f) => f.severity === "error");
    expect(errs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(errs.map((f) => f.id))).toEqual(new Set(["motion_network", "motion_remote_ref", "motion_clock"]));
    for (const f of errs) expect(f.fix.length).toBeGreaterThan(10);
  });

  it("reports a missing page, a missing asset and paths outside the project", async () => {
    const root = project();
    expect((await loadMotionPage(root, "motion/nope.html")).findings.map((f) => f.id)).toEqual(["motion_page_missing"]);
    expect((await loadMotionPage(root, "../outside.html")).findings.map((f) => f.id)).toEqual(["motion_page_outside"]);
    writeFileSync(join(root, "motion", "gone.html"), page("") + '<img src="missing.png">');
    const gone = await loadMotionPage(root, "motion/gone.html");
    expect(gone.findings.map((f) => f.id)).toEqual(["motion_asset_missing"]);
  });

  it("rejects a symlink that leaves the project, for the page and for its files", async () => {
    const root = project();
    const outside = mkdtempSync(join(tmpdir(), "vs-motion-outside-"));
    writeFileSync(join(outside, "secret.png"), "secret");
    writeFileSync(join(outside, "page.html"), page(""));
    symlinkSync(join(outside, "secret.png"), join(root, "motion", "linked.png"));
    symlinkSync(join(outside, "page.html"), join(root, "motion", "linked.html"));
    writeFileSync(join(root, "motion", "uses-link.html"), page("") + '<img src="linked.png">');
    const viaAsset = await loadMotionPage(root, "motion/uses-link.html");
    expect(viaAsset.findings.map((f) => f.id)).toEqual(["motion_asset_outside"]);
    expect(viaAsset.files).toEqual([]);
    expect((await loadMotionPage(root, "motion/linked.html")).findings.map((f) => f.id)).toEqual(["motion_page_outside"]);
  });

  it("hashes change when a local file changes", async () => {
    const root = project();
    mkdirSync(join(root, "motion", "sub"));
    const a = await loadMotionPage(root, "motion/morph.html");
    writeFileSync(join(root, "motion", "morph.css"), "#copy { color: red; }");
    const b = await loadMotionPage(root, "motion/morph.html");
    expect(b.sha256).toBe(a.sha256);
    expect(b.files.find((f) => f.ref === "morph.css")!.sha256).not.toBe(a.files.find((f) => f.ref === "morph.css")!.sha256);
  });
});
