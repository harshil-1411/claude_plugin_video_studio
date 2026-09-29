import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Brand } from "@video-studio/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  BRAND_CSS_MAX_BYTES,
  BRAND_DRAFT_PATH,
  brandFamily,
  bundledFontFor,
  contrastRatioHex,
  draftBrand,
  formatBrandDraft,
  parseColor,
  scanConfigText,
  scanCss,
  toHex,
} from "./brand-source.js";
import type { LookupFn } from "./net-guard.js";
import type { FetchImpl } from "./url.js";

const BENCH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/launch-bench");
const site = (n: string) => join(BENCH, "sites", n);

let work: string;
let n = 0;
const project = async () => {
  const dir = join(work, `p${++n}`);
  await mkdir(dir, { recursive: true });
  return dir;
};
const readDraft = async (dir: string) => Brand.parse(parse(await readFile(join(dir, BRAND_DRAFT_PATH), "utf8")));

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "vs-brand-"));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("colour, CSS and config parsing (pure)", () => {
  it("parses hex, rgb[a], hsl[a] and oklch colours", () => {
    expect(toHex(parseColor("#abc")!)).toBe("#AABBCC");
    expect(toHex(parseColor("#2ec4b6")!)).toBe("#2EC4B6");
    expect(parseColor("#2ec4b680")!.a).toBeCloseTo(0.5, 1);
    expect(toHex(parseColor("rgb(88, 62, 124)")!)).toBe("#583E7C");
    expect(toHex(parseColor("rgb(88 62 124 / 50%)")!)).toBe("#583E7C");
    expect(parseColor("rgba(242, 95, 92, 0.15)")!.a).toBeCloseTo(0.15, 2);
    expect(toHex(parseColor("hsl(0, 100%, 50%)")!)).toBe("#FF0000");
    expect(toHex(parseColor("hsl(210 27% 18%)")!)).toBe("#222E3A");
    // oklch white and a mid red, within rounding.
    expect(toHex(parseColor("oklch(1 0 0)")!)).toBe("#FFFFFF");
    expect(toHex(parseColor("oklch(62.8% 0.2577 29.23)")!)).toBe("#FF0000");
    expect(parseColor("not-a-colour")).toBeUndefined();
    expect(contrastRatioHex("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
  });

  it("scans custom properties, declarations and @font-face with file:line evidence and dark contexts", () => {
    const css = [
      "/* a comment; with { braces } */",
      ":root {",
      "  --bg: #fff;",
      "  --logo: url(data:image/svg+xml;base64,AAAA);",
      "}",
      "@font-face { font-family: 'Brandish'; src: url('./f/B.woff2') format('woff2'), url(./f/B.ttf); font-weight: bold; }",
      "@media (prefers-color-scheme: dark) { :root { --bg: #000; } }",
      "body { color: #111 !important; }",
    ].join("\n");
    const s = scanCss(css, "a.css");
    expect(s.vars.map((v) => [v.name, v.value, v.evidence, v.dark, v.root])).toEqual([
      ["--bg", "#fff", "a.css:3", false, true],
      ["--logo", "url(data:image/svg+xml;base64,AAAA)", "a.css:4", false, true],
      ["--bg", "#000", "a.css:7", true, true],
    ]);
    expect(s.decls.find((d) => d.prop === "color")).toMatchObject({ selector: "body", value: "#111", evidence: "a.css:8" });
    expect(s.fontFaces).toEqual([{ family: "Brandish", weight: 700, src: ["./f/B.woff2", "./f/B.ttf"], file: "a.css", evidence: "a.css:6" }]);
  });

  it("reads a Tailwind-style config as text: key paths, strings and arrays, never evaluated", () => {
    const cfg = [
      "const extra = require('./never-loaded');",
      "module.exports = {",
      "  theme: { extend: {",
      "    colors: { brand: { DEFAULT: '#e4572e', 600: \"#c2410c\" }, ...extra },",
      "    fontFamily: { display: ['Fraunces', 'serif'] },",
      "  } },",
      "};",
    ].join("\n");
    const e = scanConfigText(cfg, "tailwind.config.js");
    expect(e).toContainEqual({ path: ["theme", "extend", "colors", "brand", "DEFAULT"], value: "#e4572e", evidence: "tailwind.config.js:4" });
    expect(e).toContainEqual({ path: ["theme", "extend", "colors", "brand", "600"], value: "#c2410c", evidence: "tailwind.config.js:4" });
    expect(e).toContainEqual({ path: ["theme", "extend", "fontFamily", "display"], value: ["Fraunces", "serif"], evidence: "tailwind.config.js:5" });
  });

  it("picks the brand family of a stack and the bundled stand-in", () => {
    expect(brandFamily(["-apple-system", "Segoe UI", "Roboto", "sans-serif"])).toBeUndefined();
    expect(brandFamily(["Space Grotesk", "system-ui"])).toBe("Space Grotesk");
    expect(bundledFontFor("Lora", "heading")).toBe("Inter");
    expect(bundledFontFor("Fira Code", "mono")).toBe("JetBrains Mono");
    expect(bundledFontFor("Noto Sans JP", "body")).toBe("Noto Sans");
  });
});

describe("brand_draft from a repo folder", () => {
  it("mini repo: package.json name, CSS variables, the self-hosted font copied with its licence, the logo", async () => {
    // A copy with a dependency folder that must be skipped (its magenta would otherwise win).
    const repo = join(work, "fieldnote-repo");
    await cp(join(BENCH, "repo"), repo, { recursive: true });
    await mkdir(join(repo, "node_modules", "dep"), { recursive: true });
    await writeFile(join(repo, "node_modules", "dep", "theme.css"), ":root { --primary: #ff00ff; }\nhtml { background: #ff00ff; }\n");
    const dir = await project();
    await mkdir(join(dir, "project"), { recursive: true });
    await writeFile(join(dir, "project", "brand.yaml"), "brand: { name: Keep me }\n");
    const r = await draftBrand(dir, { source: repo });
    expect(r.name).toEqual({ value: "fieldnote", evidence: "package.json (name)" });
    expect(r.palette.background).toMatchObject({ value: "#F4F7F5", evidence: "src/styles.css:17", how: "html background (--color-background)" });
    expect(r.palette.text).toMatchObject({ value: "#1B2B24", evidence: "src/styles.css:18" });
    expect(r.palette.accent).toMatchObject({ value: "#2F9E44", how: "custom property --color-brand", evidence: "src/styles.css:12" });
    expect(r.palette.secondary?.value).toBe("#1971C2");
    expect(r.contrast.ok).toBe(true);
    expect(r.fonts.body).toMatchObject({ family: "Field Sans", substituted: false, files: ["fonts/FieldSans/FieldSans-Regular.ttf"], license: "fonts/FieldSans/OFL.txt" });
    expect(existsSync(join(dir, "fonts", "FieldSans", "FieldSans-Regular.ttf"))).toBe(true);
    expect(r.fonts.mono).toMatchObject({ family: "JetBrains Mono", substituted: false });
    expect(r.substitutions).toContain("heading font: none found → the body font (Field Sans)");
    expect(r.logo).toMatchObject({ path: "assets/brand/logo.svg", from: "public/logo.svg" });
    expect(await readFile(join(dir, "assets", "brand", "logo.svg"), "utf8")).toContain("<svg");
    expect(r.warnings.some((w) => /needs a PNG/.test(w))).toBe(true);
    // The draft validates as Brand v2, carries its evidence as comments, and brand.yaml is untouched.
    const draft = await readDraft(dir);
    expect(draft).toMatchObject({ version: 2, brand: { name: "fieldnote" }, visual: { palette: { background: "#F4F7F5", text: "#1B2B24", primary: "#2F9E44", secondary: "#1971C2" }, logo: "assets/brand/logo.svg" } });
    const text = await readFile(join(dir, BRAND_DRAFT_PATH), "utf8");
    expect(text).toMatch(/^# Brand draft from the repo /);
    // The source path is shown relative to the project: no home folder in a file that gets shared.
    expect(text.split("\n")[0]).toMatch(/^# Brand draft from the repo fieldnote-repo \(/);
    expect(text).toContain("# primary: #2F9E44 from custom property --color-brand (src/styles.css:12)");
    expect(await readFile(join(dir, "project", "brand.yaml"), "utf8")).toBe("brand: { name: Keep me }\n");
    expect(formatBrandDraft(r)).toMatch(/primary: #2F9E44 \(custom property --color-brand; src\/styles\.css:12\)/);
  });

  it("tidepool (CSS variables): roles from body's var() references, fonts substituted with evidence", async () => {
    const dir = await project();
    const r = await draftBrand(dir, { source: site("tidepool") });
    // A static site without package.json is named by its page, not its folder.
    expect(r.name).toEqual({ value: "Tidepool", evidence: "index.html (og:site_name)" });
    expect([r.palette.background.value, r.palette.text.value, r.palette.accent?.value, r.palette.secondary?.value]).toEqual(["#0B1D2A", "#E6F1F7", "#2EC4B6", "#FF9F1C"]);
    expect(r.palette.background.how).toBe("body background (--bg)");
    expect(r.fonts.heading).toMatchObject({ family: "Inter", source_family: "Space Grotesk", substituted: true, evidence: "styles.css:21" });
    expect(r.fonts.body).toMatchObject({ family: "Inter", source_family: "Source Sans 3", substituted: true });
    expect(r.substitutions).toContain('heading font "Space Grotesk" → Inter (bundled; no font file for it in the repo)');
    expect(r.brand.visual?.weights).toEqual({ heading: 700 });
    expect(r.logo?.path).toBe("assets/brand/logo.svg");
  });

  it("emberly (Tailwind-style config): named colours and fontFamily from the config text", async () => {
    const dir = await project();
    const r = await draftBrand(dir, { source: site("emberly") });
    expect(r.palette.background).toMatchObject({ value: "#FFF8F0", how: "Tailwind colour paper", evidence: "tailwind.config.js:13" });
    expect(r.palette.text).toMatchObject({ value: "#1D1A17", how: "Tailwind colour ink" });
    expect(r.palette.accent).toMatchObject({ value: "#E4572E", how: "Tailwind colour brand", evidence: "tailwind.config.js:9" });
    // brand-600 is a shade of the accent, not a second colour.
    expect(r.palette.secondary?.value).toBe("#4C6B3C");
    expect(r.fonts.heading).toMatchObject({ family: "Inter", source_family: "Fraunces", evidence: "tailwind.config.js:17" });
    expect(r.fonts.body.source_family).toBe("Manrope");
    expect(r.fonts.mono).toMatchObject({ family: "JetBrains Mono", source_family: "IBM Plex Mono", substituted: true });
    expect(r.logo?.from).toBe("emberly-mark.svg");
  });

  it("quillmark (literal colours only): roles from body declarations and usage counts", async () => {
    const dir = await project();
    const r = await draftBrand(dir, { source: site("quillmark") });
    expect(r.palette.background).toMatchObject({ value: "#FDFCF7", evidence: "css/site.css:3" });
    expect(r.palette.text.value).toBe("#22303C");
    expect(r.palette.accent).toMatchObject({ value: "#6A4C93", how: expect.stringMatching(/^most used colourful colour/) });
    expect(r.palette.secondary?.value).toBe("#F25F5C");
    expect(r.fonts.heading.source_family).toBe("Lora");
    expect(r.fonts.body.source_family).toBe("Nunito Sans");
    expect(r.fonts.mono?.family).toBe("JetBrains Mono");
    expect(r.logo?.from).toBe("quillmark-logo.svg");
  });

  it("replaces a text colour that fails 4.5:1 and says so", async () => {
    const repo = join(work, "low-contrast");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "app.css"), "body { background: #999999; color: #aaaaaa; }\n.btn { background: #d9480f; }\n");
    const r = await draftBrand(await project(), { source: repo });
    expect(r.palette.text.value).toBe("#111111");
    expect(r.contrast.ok).toBe(true);
    expect(r.warnings.find((w) => /below 4\.5:1/.test(w))).toMatch(/#AAAAAA on background #999999/);
    expect(r.warnings).toContain("no logo found; set visual.logo by hand");
  });

  it("defaults to the project's ingested repo source", async () => {
    const dir = await project();
    await mkdir(join(dir, "source"), { recursive: true });
    await writeFile(join(dir, "source", "content-ir.json"), JSON.stringify({ sources: [{ kind: "markdown", uri: "notes.md" }, { kind: "repo", uri: site("quillmark") }] }));
    expect((await draftBrand(dir)).source).toMatchObject({ kind: "repo" });
    await expect(draftBrand(await project())).rejects.toThrow(/no source given/);
  });
});

// ---------------------------------------------------------------------------------- URL mode

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".js": "text/javascript" };

describe("brand_draft from a URL (local server)", () => {
  let server: Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      hits.push(url.pathname);
      if (url.pathname === "/hostile/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><head><title>Hostile</title><link rel="stylesheet" href="/hostile/huge.css"><link rel="stylesheet" href="/hostile/ok.css"><script>document.body.style.background = "#ff00ff"</script></head><body><img class="logo" src="/hostile/logo.txt"></body></html>`);
        return;
      }
      if (url.pathname === "/hostile/huge.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end(`body { background: #ff00ff; }\n${"/* padding */\n".repeat(Math.ceil((BRAND_CSS_MAX_BYTES + 1024) / 14))}`);
        return;
      }
      if (url.pathname === "/hostile/ok.css") {
        res.writeHead(200, { "content-type": "text/css" });
        res.end("body { background: #ffffff; color: #1a1a1a; }\n.cta { background: #0b7285; }\n");
        return;
      }
      if (url.pathname === "/hostile/logo.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("not an image");
        return;
      }
      // Static files: /quillmark/… and /emberly/… from their fixture folders, everything else from tidepool (which links from the root).
      const [, first, ...rest] = url.pathname.split("/");
      const named = first === "quillmark" || first === "emberly";
      const root = site(named ? first! : "tidepool");
      const file = normalize(join(root, (named ? rest : [first, ...rest]).join("/") || "index.html"));
      if (!file.startsWith(root) || !existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const env = { VS_ALLOW_PRIVATE_URLS: "1" };

  it("tidepool: linked same-site stylesheet, og:site_name, the logo downloaded into assets/brand/", async () => {
    const dir = await project();
    const r = await draftBrand(dir, { source: `${base}/`, env });
    expect(r.name).toEqual({ value: "Tidepool", evidence: `${base}/ (og:site_name)` });
    expect(r.source.kind).toBe("url");
    expect([r.palette.background.value, r.palette.text.value, r.palette.accent?.value, r.palette.secondary?.value]).toEqual(["#0B1D2A", "#E6F1F7", "#2EC4B6", "#FF9F1C"]);
    expect(r.palette.accent).toMatchObject({ how: "custom property --primary", evidence: `${base}/styles.css:7` });
    expect(r.fonts.heading).toMatchObject({ family: "Inter", source_family: "Space Grotesk", substituted: true });
    expect(r.substitutions[0]).toMatch(/is read from a URL/);
    expect(r.logo).toMatchObject({ path: "assets/brand/logo.svg", why: "an <img> named logo" });
    expect(existsSync(join(dir, "assets", "brand", "logo.svg"))).toBe(true);
  });

  it("quillmark: relative stylesheet, inline <style>, the <img> logo; page scripts never run", async () => {
    const dir = await project();
    const r = await draftBrand(dir, { source: `${base}/quillmark/`, env });
    expect(r.name.value).toBe("Quillmark");
    expect(r.palette.background).toMatchObject({ value: "#FDFCF7", evidence: `${base}/quillmark/css/site.css:3` });
    expect(r.palette.text.value).toBe("#22303C");
    expect(r.palette.accent?.value).toBe("#6A4C93");
    expect(r.palette.secondary?.value).toBe("#F25F5C");
    expect(r.fonts.heading.source_family).toBe("Lora");
    expect(r.logo).toMatchObject({ path: "assets/brand/quillmark-logo.svg", from: `${base}/quillmark/quillmark-logo.svg`, why: "an <img> named logo" });
    expect(r.logo_candidates.at(-1)?.why).toMatch(/og:image/);
    expect(await readFile(join(dir, "assets", "brand", "quillmark-logo.svg"), "utf8")).toContain("<svg");
    expect((await readDraft(dir)).visual?.palette.primary).toBe("#6A4C93");
  });

  it("emberly: the built stylesheet read through the body's utility classes", async () => {
    const dir = await project();
    const html = (await readFile(join(site("emberly"), "index.html"), "utf8")).replaceAll('"/', '"/emberly/');
    // Serve a copy whose absolute links point inside /emberly/.
    const copy = createServer(async (req, res) => {
      const p = (req.url ?? "/").replace(/^\/emberly/, "");
      if (p === "/" || p === "") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html);
        return;
      }
      const file = join(site("emberly"), p);
      if (!existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(file));
    });
    copy.listen(0, "127.0.0.1");
    await once(copy, "listening");
    try {
      const url = `http://127.0.0.1:${(copy.address() as AddressInfo).port}/emberly/`;
      const r = await draftBrand(dir, { source: url, env });
      expect(r.palette.background).toMatchObject({ value: "#FFF8F0", how: ".bg-paper background" });
      expect(r.palette.text).toMatchObject({ value: "#1D1A17", how: ".text-ink color" });
      expect(r.palette.accent?.value).toBe("#E4572E");
      expect(r.palette.secondary?.value).toBe("#4C6B3C");
      expect(r.fonts.body.source_family).toBe("Manrope");
      expect(r.fonts.heading.source_family).toBe("Fraunces");
      expect(r.fonts.mono?.source_family).toBe("IBM Plex Mono");
      expect(r.logo?.path).toBe("assets/brand/emberly-mark.svg");
    } finally {
      await new Promise<void>((r) => copy.close(() => r()));
    }
  });

  it("refuses a local URL without the user's VS_ALLOW_PRIVATE_URLS=1", async () => {
    await expect(draftBrand(await project(), { source: `${base}/quillmark/`, env: {} })).rejects.toThrow(/private or local address/);
  });

  it("caps a huge stylesheet, never runs page JS, and refuses a non-image logo", async () => {
    const dir = await project();
    const r = await draftBrand(dir, { source: `${base}/hostile/`, env });
    expect(r.warnings.find((w) => w.includes("/hostile/huge.css"))).toMatch(/too_large/);
    expect(r.palette.background.value).toBe("#FFFFFF");
    expect(r.palette.accent?.value).toBe("#0B7285");
    expect(r.warnings.find((w) => w.includes("logo.txt"))).toMatch(/not an image/);
    expect(r.logo).toBeUndefined();
    expect(existsSync(join(dir, "assets", "brand"))).toBe(false);
  });
});

describe("brand_draft SSRF guard on linked stylesheets", () => {
  const PUBLIC = "93.184.216.34";
  const lookup: LookupFn = async (host) => {
    const table: Record<string, string> = { "public.example": PUBLIC, "cdn.public.example": PUBLIC, "other.example": PUBLIC, "inside.public.example": "10.0.0.5" };
    const ip = table[host];
    if (!ip) throw new Error(`ENOTFOUND ${host}`);
    return [{ address: ip, family: 4 }];
  };

  it("refuses a same-site stylesheet on a private address, skips other sites, and never contacts them", async () => {
    const calls: string[] = [];
    const page = `<html><head><title>Guarded</title>
      <link rel="stylesheet" href="http://10.0.0.5/internal.css">
      <link rel="stylesheet" href="https://inside.public.example/rebind.css">
      <link rel="stylesheet" href="https://other.example/theirs.css">
      <link rel="stylesheet" href="https://cdn.public.example/site.css">
      </head><body></body></html>`;
    const fetch: FetchImpl = async (url) => {
      calls.push(url);
      if (url === "https://public.example/") return new Response(page, { headers: { "content-type": "text/html" } });
      if (url === "https://cdn.public.example/site.css") return new Response("body { background: #fafafa; color: #222222; }", { headers: { "content-type": "text/css" } });
      return new Response("body { background: #ff00ff; }", { headers: { "content-type": "text/css" } });
    };
    const r = await draftBrand(await project(), { source: "https://public.example/", fetch, lookup, env: {} });
    // A private IP literal is another site (never fetched); a same-site name resolving to a private address is refused by the guard.
    expect(r.warnings.find((w) => w.includes("10.0.0.5"))).toMatch(/another site/);
    expect(r.warnings.find((w) => w.includes("inside.public.example"))).toMatch(/blocked_address: refusing to fetch .*private or local address \(10\.0\.0\.5\)/);
    expect(r.warnings.find((w) => w.includes("other.example"))).toMatch(/another site/);
    expect(calls).toEqual(["https://public.example/", "https://cdn.public.example/site.css"]);
    expect(r.palette.background.value).toBe("#FAFAFA");
  });
});
