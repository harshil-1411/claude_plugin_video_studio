import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { parse as parseJs } from "acorn";
import { projectPaths, resolveInsideProject, sha256Hex } from "@video-studio/core";

/**
 * Static lint for Claude-authored `motion` pages (Phase 6.5). The page is untrusted input, and
 * the producer launches Chrome without its sandbox, so a page must stay offline and be a pure
 * function of time:
 *
 * - no network: `fetch`, XHR, WebSocket, EventSource, `navigator.sendBeacon`, dynamic `import()`,
 *   non-relative `import`, remote `src`/`href`/`url()`/`@import`, `<iframe>`/`<object>`/`<embed>`,
 *   `<base>`, meta refresh, `window.open`;
 * - no clocks or unseeded randomness: `Date.now`, `new Date()`, `performance.now`, `Math.random`;
 * - no timer-, rAF- or CSS-driven state: `setTimeout`/`setInterval`/`requestAnimationFrame`,
 *   CSS `transition*`/`animation*` and `@keyframes`;
 * - no `eval`/`new Function`;
 * - local files only, next to the page (inside its folder, so the composition keeps the same
 *   relative paths), inside the project after resolving symlinks.
 *
 * This is static analysis: it cannot see every way script can reach a banned API (computed
 * names, aliases, CSS escapes). The composer's Content-Security-Policy (no `connect-src`, local
 * scripts, styles, images and fonts only) is the runtime backstop; the lint catches honest
 * mistakes early and with an actionable fix.
 *
 * `lintMotionPage` is pure; `loadMotionPage` reads the page and every local file it references
 * (for the renderer to copy and the cache key to hash).
 */

export interface MotionLintFinding {
  id: string;
  severity: "error" | "warning";
  message: string;
  fix: string;
  /** Page-relative path of the file (absent: the page itself). */
  file?: string;
  line?: number;
}

/** A referenced local file: its bytes, or why it cannot be used (missing, outside the project...). */
export type MotionFile = { bytes: Uint8Array } | { error: string };

export interface MotionLintResult {
  findings: MotionLintFinding[];
  /** Every local file the page references (directly or through its scripts and styles), page-relative, sorted. */
  refs: string[];
}

type RefKind = "script" | "module" | "style" | "asset";

const MAX_FILES = 256;
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self", "top", "parent", "frames"]);
const JS_TYPES = new Set(["", "text/javascript", "application/javascript", "module", "text/ecmascript", "application/ecmascript"]);
const DATA_TYPES = new Set(["application/json", "application/ld+json", "text/plain", "text/template", "text/html", "text/x-template"]);
const FORBIDDEN_TAGS = new Set(["iframe", "frame", "frameset", "object", "embed", "base", "portal", "applet"]);
const URL_ATTRS = new Set(["src", "href", "xlink:href", "poster", "data", "action", "formaction", "background", "srcset", "imagesrcset"]);

interface Rule {
  id: string;
  message: string;
  fix: string;
}
const NETWORK_FIX = "remove it: a motion page draws only from its own files and window.__vs (put data in props.text or a local .js file next to the page)";
const RULES = {
  fetch: { id: "motion_network", message: "uses fetch (network access)", fix: NETWORK_FIX },
  XMLHttpRequest: { id: "motion_network", message: "uses XMLHttpRequest (network access)", fix: NETWORK_FIX },
  WebSocket: { id: "motion_network", message: "uses WebSocket (network access)", fix: NETWORK_FIX },
  EventSource: { id: "motion_network", message: "uses EventSource (network access)", fix: NETWORK_FIX },
  "navigator.sendBeacon": { id: "motion_network", message: "uses navigator.sendBeacon (network access)", fix: NETWORK_FIX },
  "import()": { id: "motion_network", message: "uses dynamic import()", fix: "use a static import of a relative file (./x.js), or a <script src> next to the page" },
  "Date.now": { id: "motion_clock", message: "reads the wall clock (Date.now)", fix: "draw from the seek time t only; the page must be a pure function of time" },
  "new Date()": { id: "motion_clock", message: "reads the wall clock (new Date() without arguments)", fix: "draw from the seek time t only (a fixed date needs an explicit argument)" },
  "Date()": { id: "motion_clock", message: "reads the wall clock (Date() called as a function)", fix: "draw from the seek time t only" },
  "performance.now": { id: "motion_clock", message: "reads the clock (performance.now)", fix: "draw from the seek time t only; the page must be a pure function of time" },
  "Math.random": { id: "motion_random", message: "uses unseeded randomness (Math.random)", fix: "use vs.rng(seed) from the motion kit: const r = vs.rng(7); r() gives the same sequence every render" },
  setTimeout: { id: "motion_timer", message: "drives state with setTimeout", fix: "compute every value from t inside window.seek(t) (vs.spring, vs.tween); nothing may advance on its own" },
  setInterval: { id: "motion_timer", message: "drives state with setInterval", fix: "compute every value from t inside window.seek(t) (vs.spring, vs.tween); nothing may advance on its own" },
  requestAnimationFrame: { id: "motion_timer", message: "drives state with requestAnimationFrame", fix: "compute every value from t inside window.seek(t); the renderer seeks each frame" },
  eval: { id: "motion_eval", message: "uses eval", fix: "write the code directly; eval is blocked" },
  Function: { id: "motion_eval", message: "builds code with Function()", fix: "write the code directly; new Function is blocked" },
  "window.open": { id: "motion_network", message: "opens a window (window.open)", fix: "remove it" },
} as const satisfies Record<string, Rule>;
type RuleName = keyof typeof RULES;

// ------------------------------------------------------------------------------------ text helpers

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Replace a range with spaces, keeping newlines (so offsets and line numbers stay valid). */
function blank(s: string): string {
  return s.replace(/[^\n]/g, " ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&colon;/gi, ":")
    .replace(/&sol;/gi, "/")
    .replace(/&period;/gi, ".")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

/** Attributes of a start tag (names lower-cased, values entity-decoded). */
export function parseAttrs(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of src.matchAll(re)) {
    const name = m[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

// ------------------------------------------------------------------------------------ lint state

interface Ctx {
  findings: MotionLintFinding[];
  files: ReadonlyMap<string, MotionFile>;
  refs: Map<string, Set<RefKind>>;
  /** Files already linted as script or style. */
  done: Set<string>;
  seek: boolean;
}

function push(c: Ctx, f: MotionLintFinding): void {
  const key = `${f.id}\0${f.file ?? ""}\0${f.line ?? ""}\0${f.message}`;
  if (c.findings.some((x) => `${x.id}\0${x.file ?? ""}\0${x.line ?? ""}\0${x.message}` === key)) return;
  c.findings.push(f);
}

function rule(c: Ctx, name: RuleName, file: string | undefined, line: number | undefined): void {
  const r = RULES[name];
  push(c, { id: r.id, severity: "error", message: r.message, fix: r.fix, ...(file ? { file } : {}), ...(line ? { line } : {}) });
}

type UrlClass = { kind: "ignore" } | { kind: "remote"; why: string } | { kind: "local"; ref: string } | { kind: "outside"; ref: string };

/** Classify a URL written in `from` (page-relative path of the referencing file; "" = the page). */
function classifyUrl(raw: string, from: string): UrlClass {
  const u = raw.trim();
  if (u === "" || u.startsWith("#")) return { kind: "ignore" };
  if (/^data:/i.test(u)) return { kind: "ignore" };
  if (u.startsWith("//")) return { kind: "remote", why: "a protocol-relative (remote) URL" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  if (scheme) return { kind: "remote", why: `a ${scheme[1]!.toLowerCase()}: URL` };
  if (u.startsWith("/") || u.startsWith("\\")) return { kind: "remote", why: "an absolute path" };
  let path = u.replace(/[?#].*$/, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep it as written */
  }
  if (path === "") return { kind: "ignore" };
  const dir = from ? posix.dirname(from) : ".";
  const ref = posix.normalize(posix.join(dir, path.replace(/\\/g, "/")));
  if (ref === ".." || ref.startsWith("../") || posix.isAbsolute(ref) || ref.includes("\0")) return { kind: "outside", ref };
  return { kind: "local", ref };
}

function useUrl(c: Ctx, raw: string, as: RefKind, from: string, line: number | undefined, what: string): void {
  const u = classifyUrl(raw, from);
  const file = from || undefined;
  if (u.kind === "ignore") return;
  if (u.kind === "remote") {
    push(c, {
      id: "motion_remote_ref",
      severity: "error",
      message: `${what} "${raw.trim().slice(0, 120)}" is ${u.why}; the page may load only its own files`,
      fix: "copy the file next to the page and reference it with a relative path (e.g. ./logo.png), or inline it as a data: URL",
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
    });
    return;
  }
  if (u.kind === "outside") {
    push(c, {
      id: "motion_asset_outside",
      severity: "error",
      message: `${what} "${raw.trim()}" points outside the page's folder`,
      fix: "move the file into the page's folder (or a subfolder) and reference it relatively",
      ...(file ? { file } : {}),
      ...(line ? { line } : {}),
    });
    return;
  }
  const kinds = c.refs.get(u.ref) ?? new Set<RefKind>();
  kinds.add(as);
  c.refs.set(u.ref, kinds);
}

// ------------------------------------------------------------------------------------ JS

interface JsNode {
  type: string;
  start: number;
  loc?: { start: { line: number } };
  [k: string]: unknown;
}

function isNode(v: unknown): v is JsNode {
  return typeof v === "object" && v !== null && typeof (v as { type?: unknown }).type === "string";
}

function walk(node: JsNode, visit: (n: JsNode, parent: JsNode | undefined, key: string | undefined) => void, parent?: JsNode, key?: string): void {
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === "loc") continue;
    const v = node[k];
    if (Array.isArray(v)) {
      for (const x of v) if (isNode(x)) walk(x, visit, node, k);
    } else if (isNode(v)) walk(v, visit, node, k);
  }
}

function propName(m: JsNode): string | undefined {
  const p = m.property as JsNode;
  if (!m.computed && p.type === "Identifier") return p.name as string;
  if (m.computed && p.type === "Literal" && typeof p.value === "string") return p.value;
  return undefined;
}

/** Dotted name of an identifier or member chain, with any global-object prefix dropped (`window.Date.now` → `Date.now`). */
function qualified(n: JsNode): string | undefined {
  if (n.type === "Identifier") return n.name as string;
  if (n.type === "ChainExpression") return qualified(n.expression as JsNode);
  if (n.type !== "MemberExpression") return undefined;
  const prop = propName(n);
  if (prop === undefined) return undefined;
  const obj = n.object as JsNode;
  if (obj.type === "Identifier" && GLOBAL_OBJECTS.has(obj.name as string)) return prop;
  if (obj.type === "ThisExpression") return undefined;
  const base = qualified(obj);
  return base === undefined ? undefined : `${base}.${prop}`;
}

/** An identifier that reads a variable (not a property name, label or declared name). */
function isReference(n: JsNode, parent: JsNode | undefined, key: string | undefined): boolean {
  if (!parent) return true;
  if (key === "property" && parent.type === "MemberExpression" && !parent.computed) return false;
  if (key === "key" && !parent.computed && (parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition")) return false;
  if (key === "label") return false;
  if (key === "id") return false;
  if (parent.type === "ImportSpecifier" || parent.type === "ExportSpecifier" || parent.type === "ImportDefaultSpecifier" || parent.type === "ImportNamespaceSpecifier") return false;
  return true;
}

function parseAny(code: string, module: boolean | undefined): { ast: JsNode; module: boolean } | { error: string; line?: number } {
  const tries = module === undefined ? [true, false] : [module];
  let last: { error: string; line?: number } = { error: "unparseable" };
  for (const m of tries) {
    try {
      const ast = parseJs(code, { ecmaVersion: "latest", sourceType: m ? "module" : "script", locations: true, allowReturnOutsideFunction: !m, allowHashBang: true }) as unknown as JsNode;
      return { ast, module: m };
    } catch (e) {
      const err = e as { message?: string; loc?: { line: number } };
      last = { error: err.message ?? String(e), ...(err.loc ? { line: err.loc.line } : {}) };
    }
  }
  return last;
}

/**
 * Lint one script. `file` is its page-relative path (undefined: inline in the page, starting at
 * `lineBase` + 1); `classic` means a non-module <script>, whose top-level declarations are globals.
 */
function lintScript(c: Ctx, code: string, o: { file?: string; lineBase?: number; module?: boolean; classic: boolean; handler?: boolean }): void {
  const parsed = parseAny(code, o.module);
  const at = (n: JsNode | undefined, line?: number) => (line ?? n?.loc?.start.line ?? 1) + (o.lineBase ?? 0);
  if ("error" in parsed) {
    push(c, {
      id: "motion_parse_error",
      severity: "error",
      message: `script could not be parsed (${parsed.error}), so it cannot be checked`,
      fix: "fix the syntax error (standard modern JavaScript only)",
      ...(o.file ? { file: o.file } : {}),
      line: at(undefined, parsed.line),
    });
    return;
  }
  const from = o.file ?? "";
  const hit = (name: RuleName, n: JsNode) => rule(c, name, o.file, at(n));
  const top = parsed.ast.body as JsNode[];
  if (o.classic) {
    for (const s of top) {
      if (s.type === "FunctionDeclaration" && (s.id as JsNode | null)?.name === "seek") c.seek = true;
      if (s.type === "VariableDeclaration" && s.kind === "var") {
        for (const d of s.declarations as JsNode[]) if ((d.id as JsNode).type === "Identifier" && (d.id as JsNode).name === "seek") c.seek = true;
      }
    }
  }
  walk(parsed.ast, (n, parent, key) => {
    switch (n.type) {
      case "Identifier": {
        if (!isReference(n, parent, key)) return;
        const name = n.name as string;
        if (name === "fetch" || name === "XMLHttpRequest" || name === "WebSocket" || name === "EventSource" || name === "setTimeout" || name === "setInterval" || name === "requestAnimationFrame" || name === "eval") hit(name, n);
        return;
      }
      case "MemberExpression": {
        const q = qualified(n);
        if (q === undefined) return;
        if (q === "fetch" || q === "XMLHttpRequest" || q === "WebSocket" || q === "EventSource" || q === "setTimeout" || q === "setInterval" || q === "requestAnimationFrame" || q === "eval") hit(q, n);
        else if (q === "navigator.sendBeacon" || q === "Date.now" || q === "performance.now" || q === "Math.random") hit(q, n);
        else if (q === "open" && (n.object as JsNode).type === "Identifier") hit("window.open", n);
        return;
      }
      case "NewExpression":
      case "CallExpression": {
        const callee = qualified(n.callee as JsNode);
        if (callee === "Function") hit("Function", n);
        if (callee === "Date" && n.type === "NewExpression" && (n.arguments as unknown[]).length === 0) hit("new Date()", n);
        if (callee === "Date" && n.type === "CallExpression") hit("Date()", n);
        if (n.type === "CallExpression" && (n.callee as JsNode).type === "Identifier" && (n.callee as JsNode).name === "open") hit("window.open", n);
        if (n.type === "CallExpression" && callee === "Object.assign") {
          const [target, src] = n.arguments as JsNode[];
          if (target?.type === "Identifier" && GLOBAL_OBJECTS.has(target.name as string) && src?.type === "ObjectExpression") {
            for (const p of src.properties as JsNode[]) if (p.type === "Property" && ((p.key as JsNode).name === "seek" || (p.key as JsNode).value === "seek")) c.seek = true;
          }
        }
        return;
      }
      case "ImportExpression":
        hit("import()", n);
        return;
      case "ImportDeclaration":
      case "ExportAllDeclaration":
      case "ExportNamedDeclaration": {
        const src = n.source as JsNode | null | undefined;
        if (!src || typeof src.value !== "string") return;
        const spec = src.value;
        if (spec.startsWith("./") || spec.startsWith("../")) useUrl(c, spec, "module", from, at(n), "import");
        else {
          push(c, {
            id: "motion_network",
            severity: "error",
            message: `imports "${spec.slice(0, 120)}", which is not a relative file`,
            fix: "import only files next to the page (./x.js); packages and URLs cannot be loaded",
            ...(o.file ? { file: o.file } : {}),
            line: at(n),
          });
        }
        return;
      }
      case "AssignmentExpression": {
        const left = n.left as JsNode;
        if (left.type === "MemberExpression" && (left.object as JsNode).type === "Identifier" && GLOBAL_OBJECTS.has((left.object as JsNode).name as string) && propName(left) === "seek") c.seek = true;
        return;
      }
      default:
        return;
    }
  });
}

// ------------------------------------------------------------------------------------ CSS

function lintCss(c: Ctx, css: string, o: { file?: string; lineBase?: number; decls?: boolean }): void {
  const from = o.file ?? "";
  let text = css.replace(/\/\*[\s\S]*?\*\//g, blank);
  const line = (off: number) => lineOf(text, off) + (o.lineBase ?? 0);
  const where = (off: number) => ({ ...(o.file ? { file: o.file } : {}), line: line(off) });
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)'|([^\s;)"']+))/gi)) {
    useUrl(c, m[1] ?? m[2] ?? m[3] ?? "", "style", from, line(m.index), "@import");
  }
  text = text.replace(/@import\s+[^;]*;?/gi, blank);
  for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s"']*))\s*\)/gi)) {
    useUrl(c, m[1] ?? m[2] ?? m[3] ?? "", "asset", from, line(m.index), "url()");
  }
  for (const m of text.matchAll(/@(?:-[a-z]+-)?keyframes\b/gi)) {
    push(c, {
      id: "motion_css_animation",
      severity: "error",
      message: "defines CSS @keyframes; CSS animations run on the browser clock, not on seek(t)",
      fix: "animate from window.seek(t): compute the value (vs.spring, vs.tween) and set the style there",
      ...where(m.index),
    });
  }
  const propRe = o.decls ? /(?:^|[;\s])(-(?:webkit|moz|ms|o)-)?(transition|animation)(-[a-z-]+)?\s*:/gi : /(?:^|[{;\s])(-(?:webkit|moz|ms|o)-)?(transition|animation)(-[a-z-]+)?\s*:/gi;
  for (const m of text.matchAll(propRe)) {
    const prop = `${m[1] ?? ""}${m[2]!.toLowerCase()}${m[3] ?? ""}`;
    push(c, {
      id: "motion_css_animation",
      severity: "error",
      message: `uses the CSS ${prop} property; transitions and animations run on the browser clock, not on seek(t)`,
      fix: "remove it and set the animated value from window.seek(t) instead",
      ...where(m.index),
    });
  }
}

// ------------------------------------------------------------------------------------ HTML

const RAW_BLOCK = /<(script|style)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

function lintHtml(c: Ctx, html: string): void {
  // Comments first, then raw-text blocks: their contents are linted as JS/CSS, never as markup.
  let masked = html.replace(/<!--[\s\S]*?-->/g, blank);
  const blocks: Array<{ tag: string; attrs: string; body: string; bodyAt: number }> = [];
  masked = masked.replace(RAW_BLOCK, (whole, tag: string, attrs: string, body: string, off: number) => {
    const bodyAt = off + whole.indexOf(">") + 1;
    blocks.push({ tag: tag.toLowerCase(), attrs, body, bodyAt });
    return whole.slice(0, bodyAt - off) + blank(body) + whole.slice(bodyAt - off + body.length);
  });
  for (const m of masked.matchAll(/<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g)) {
    const tag = m[1]!.toLowerCase();
    const attrs = parseAttrs(m[2] ?? "");
    const line = lineOf(masked, m.index);
    if (FORBIDDEN_TAGS.has(tag)) {
      push(c, { id: "motion_forbidden_tag", severity: "error", message: `uses <${tag}>`, fix: `remove the <${tag}>; a motion page draws everything itself`, line });
      continue;
    }
    if (tag === "meta" && /refresh/i.test(attrs.get("http-equiv") ?? "")) {
      push(c, { id: "motion_forbidden_tag", severity: "error", message: "uses <meta http-equiv=refresh>", fix: "remove the refresh meta", line });
    }
    if (tag === "script") {
      const type = (attrs.get("type") ?? "").trim().toLowerCase();
      if (!JS_TYPES.has(type) && !DATA_TYPES.has(type)) {
        push(c, { id: "motion_forbidden_tag", severity: "error", message: `uses <script type="${type}">`, fix: "use plain <script> or <script type=\"module\"> with local files only", line });
      }
      const src = attrs.get("src");
      if (src !== undefined && JS_TYPES.has(type)) useUrl(c, src, type === "module" ? "module" : "script", "", line, "script src");
    } else if (tag === "link") {
      const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
      const href = attrs.get("href");
      if (href !== undefined) {
        const as: RefKind = rel.includes("stylesheet") ? "style" : rel.includes("modulepreload") ? "module" : "asset";
        useUrl(c, href, as, "", line, `<link rel="${rel.join(" ")}"> href`);
      }
    }
    for (const [name, value] of attrs) {
      if (tag === "link" && name === "href") continue;
      if (tag === "script" && name === "src") continue;
      if (URL_ATTRS.has(name)) {
        const urls = name.endsWith("srcset") ? value.split(",").map((s) => s.trim().split(/\s+/)[0] ?? "") : [value];
        for (const u of urls) useUrl(c, u, "asset", "", line, `${name}`);
      } else if (name === "style") {
        lintCss(c, value, { lineBase: line - 1, decls: true });
      } else if (/^on[a-z]+$/.test(name) && value.trim()) {
        lintScript(c, value, { lineBase: line - 1, classic: false, handler: true, module: false });
      }
    }
  }
  for (const b of blocks) {
    const lineBase = lineOf(html, b.bodyAt) - 1;
    if (b.tag === "style") {
      lintCss(c, b.body, { lineBase });
      continue;
    }
    const attrs = parseAttrs(b.attrs);
    const type = (attrs.get("type") ?? "").trim().toLowerCase();
    if (!JS_TYPES.has(type) || attrs.has("src") || !b.body.trim()) continue;
    lintScript(c, b.body, { lineBase, classic: type !== "module", ...(type === "module" ? { module: true } : {}) });
  }
}

function lintFiles(c: Ctx): void {
  // Linting a file can reference more files: repeat until nothing new is readable.
  for (let pass = 0; pass < MAX_FILES; pass++) {
    let progressed = false;
    for (const [ref, kinds] of [...c.refs]) {
      if (c.done.has(ref)) continue;
      const f = c.files.get(ref);
      if (!f) continue;
      c.done.add(ref);
      if ("error" in f) {
        const missing = /not found|missing|ENOENT/i.test(f.error);
        push(c, {
          id: missing ? "motion_asset_missing" : "motion_asset_outside",
          severity: "error",
          message: `${ref}: ${f.error}`,
          fix: missing ? `create ${ref} next to the page, or remove the reference` : "keep every file the page uses as a regular file inside the page's folder (no symlinks out of the project)",
          file: ref,
        });
        continue;
      }
      progressed = true;
      const text = new TextDecoder().decode(f.bytes);
      if (kinds.has("style")) lintCss(c, text, { file: ref });
      if (kinds.has("script") || kinds.has("module")) lintScript(c, text, { file: ref, classic: kinds.has("script") && !kinds.has("module"), ...(kinds.has("module") ? { module: true } : {}) });
    }
    if (!progressed) break;
  }
}

/**
 * Lint a motion page. `files` maps page-relative paths of referenced local files to their bytes
 * (or why they are unusable); referenced scripts and stylesheets found there are linted too.
 * References not in `files` are returned in `refs` unchecked (the caller loads them and lints again).
 */
export function lintMotionPage(html: string, opts: { files?: ReadonlyMap<string, MotionFile> } = {}): MotionLintResult {
  const c: Ctx = { findings: [], files: opts.files ?? new Map(), refs: new Map(), done: new Set(), seek: false };
  lintHtml(c, html);
  lintFiles(c);
  if (!c.seek) {
    push(c, {
      id: "motion_no_seek",
      severity: "warning",
      message: "no script assigns window.seek, so every frame will look the same",
      fix: "define window.seek = function (t) { ... } that draws the whole frame from t (seconds), e.g. with vs.spring(t, {...})",
    });
  }
  const order = (f: MotionLintFinding) => (f.severity === "error" ? 0 : 1);
  c.findings.sort((a, b) => order(a) - order(b) || (a.file ?? "").localeCompare(b.file ?? "") || (a.line ?? 0) - (b.line ?? 0));
  return { findings: c.findings, refs: [...c.refs.keys()].sort() };
}

// ------------------------------------------------------------------------------------ fs wrapper

export interface MotionPageFile {
  /** Page-relative path (where the composition references it). */
  ref: string;
  abs: string;
  sha256: string;
}

export interface MotionPage {
  /** Project-relative path of the page, as in `props.html`. */
  html_path: string;
  /** Page source, when it could be read. */
  html?: string;
  sha256?: string;
  /** Every readable local file the page references, sorted by `ref`. */
  files: MotionPageFile[];
  findings: MotionLintFinding[];
}

/** One-line summary of a finding (`id file:line: message`). */
export function formatMotionFinding(f: MotionLintFinding): string {
  return `${f.id}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ""}` : f.line ? ` line ${f.line}` : ""}: ${f.message}`;
}

/**
 * Read a motion page (`htmlPath`, project-relative) and every local file it references, confined
 * to the project after resolving symlinks, and lint them all. Never throws for page problems:
 * they come back as findings.
 */
export async function loadMotionPage(projectDir: string, htmlPath: string): Promise<MotionPage> {
  const paths = projectPaths(projectDir);
  const out: MotionPage = { html_path: htmlPath, files: [], findings: [] };
  let pageAbs: string;
  try {
    pageAbs = await resolveInsideProject(paths, htmlPath);
  } catch (e) {
    out.findings.push({
      id: "motion_page_outside",
      severity: "error",
      message: `html "${htmlPath}" is not a path inside the project (${e instanceof Error ? e.message : String(e)})`,
      fix: "write the page inside the project (e.g. motion/s01.html) and set props.html to that relative path",
    });
    return out;
  }
  let bytes: Buffer;
  try {
    if (!(await stat(pageAbs)).isFile()) throw new Error("not a file");
    bytes = await readFile(pageAbs);
  } catch {
    out.findings.push({ id: "motion_page_missing", severity: "error", message: `html "${htmlPath}" does not exist`, fix: `write the page to ${htmlPath} (see the motion authoring contract), or fix props.html` });
    return out;
  }
  out.html = bytes.toString("utf8");
  out.sha256 = sha256Hex(bytes);
  const dir = posix.dirname(htmlPath.replace(/\\/g, "/"));
  const files = new Map<string, MotionFile>();
  const abs = new Map<string, string>();
  let result = lintMotionPage(out.html, { files });
  while (result.refs.some((r) => !files.has(r))) {
    for (const ref of result.refs) {
      if (files.has(ref)) continue;
      if (files.size >= MAX_FILES) {
        files.set(ref, { error: `too many files (more than ${MAX_FILES})` });
        continue;
      }
      try {
        const p = await resolveInsideProject(paths, posix.join(dir, ref));
        let st;
        try {
          st = await stat(p);
        } catch {
          files.set(ref, { error: "file not found" });
          continue;
        }
        if (!st.isFile()) {
          files.set(ref, { error: "not a regular file" });
          continue;
        }
        files.set(ref, { bytes: await readFile(p) });
        abs.set(ref, p);
      } catch (e) {
        files.set(ref, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    result = lintMotionPage(out.html, { files });
  }
  out.findings.push(...result.findings);
  for (const ref of result.refs) {
    const f = files.get(ref);
    const p = abs.get(ref);
    if (f && "bytes" in f && p) out.files.push({ ref, abs: p, sha256: sha256Hex(f.bytes) });
  }
  return out;
}

/** What a motion scene's clip depends on besides the spec: the page and file hashes (cache key input). */
export function motionPageDigest(page: MotionPage): { html: string; sha256: string | null; files: Array<{ ref: string; sha256: string }> } {
  return { html: page.html_path, sha256: page.sha256 ?? null, files: page.files.map((f) => ({ ref: f.ref, sha256: f.sha256 })) };
}

// ------------------------------------------------------------------------------------ usage

/**
 * Whether any script of a motion page names one of `names` (a variable, or a property such as
 * `vs.revealAt` / `vs["revealAt"]`): the inline classic and module scripts of `html` plus the
 * script files in `scripts` (page-relative path → source). Static and conservative: a name built
 * at run time is not seen. Scripts that do not parse are skipped (the lint reports them).
 */
export function motionScriptsReference(html: string, scripts: ReadonlyMap<string, string>, names: readonly string[]): boolean {
  const wanted = new Set(names);
  const sources: string[] = [];
  const masked = html.replace(/<!--[\s\S]*?-->/g, blank);
  for (const m of masked.matchAll(RAW_BLOCK)) {
    if (m[1]!.toLowerCase() !== "script") continue;
    const attrs = parseAttrs(m[2] ?? "");
    const type = (attrs.get("type") ?? "").trim().toLowerCase();
    if (JS_TYPES.has(type) && !attrs.has("src") && m[3]!.trim()) sources.push(m[3]!);
  }
  sources.push(...scripts.values());
  for (const code of sources) {
    const parsed = parseAny(code, undefined);
    if ("error" in parsed) continue;
    let found = false;
    walk(parsed.ast, (n, parent, key) => {
      if (found) return;
      if (n.type === "Identifier" && isReference(n, parent, key) && wanted.has(n.name as string)) found = true;
      else if (n.type === "MemberExpression") {
        const p = propName(n);
        if (p !== undefined && wanted.has(p)) found = true;
      }
    });
    if (found) return true;
  }
  return false;
}

/** {@link motionScriptsReference} for a loaded page: reads its local `.js`/`.mjs` files. */
export async function motionPageReferences(page: MotionPage, names: readonly string[]): Promise<boolean> {
  if (page.html === undefined) return false;
  const scripts = new Map<string, string>();
  for (const f of page.files) {
    if (!/\.(?:m?js)$/i.test(f.ref)) continue;
    try {
      scripts.set(f.ref, await readFile(f.abs, "utf8"));
    } catch {
      // unreadable now: the lint already reported it when it was loaded
    }
  }
  return motionScriptsReference(page.html, scripts, names);
}
