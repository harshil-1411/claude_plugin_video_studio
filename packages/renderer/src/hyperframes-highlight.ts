/**
 * Tiny deterministic syntax highlighter for the HyperFrames `code` scene kind.
 * Hand-rolled regex tokenizers for common languages; no network, no dependencies.
 * Output is HTML with every character of the source escaped, wrapped in `<span class="tk-*">`.
 */

export type TokenClass = "kw" | "str" | "num" | "com" | "fn" | "lit" | "key";

export interface Token {
  text: string;
  cls?: TokenClass;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

interface LangDef {
  /** Comment patterns (regex sources, no flags). */
  comments: string[];
  /** String patterns (regex sources). */
  strings: string[];
  keywords: ReadonlySet<string>;
  literals: ReadonlySet<string>;
  caseInsensitive?: boolean;
  /** Highlight the first word of each line as a command (shells). */
  firstWordIsCommand?: boolean;
  /** Treat `word(` as a function call. */
  calls?: boolean;
  /** YAML/JSON-style `key:` highlighting. */
  keys?: "yaml" | "json";
}

const words = (s: string): ReadonlySet<string> => new Set(s.split(/\s+/).filter(Boolean));

const DQ = String.raw`"(?:[^"\\\n]|\\.)*"?`;
const SQ = String.raw`'(?:[^'\\\n]|\\.)*'?`;
const BT = String.raw`\x60(?:[^\x60\\]|\\.)*\x60?`;
const SLASH_COMMENTS = [String.raw`//[^\n]*`, String.raw`/\*[\s\S]*?(?:\*/|$)`];
const HASH_COMMENT = String.raw`#[^\n]*`;

const JS_KW = words(`
  abstract as async await break case catch class const continue debugger declare default delete do else enum export
  extends finally for from function get if implements import in instanceof interface let new of package private
  protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield
`);
const C_LIKE_KW = words(`
  auto break case catch char class const continue default delete do double else enum extern final finally float for
  goto if implements import int interface long namespace new package private protected public return short signed
  sizeof static struct super switch template this throw throws try typedef union unsigned using var virtual void
  volatile while bool boolean byte string fn func go chan defer select map range struct type impl trait pub use mod
  let mut match loop where crate self Self async await move ref dyn unsafe val fun object when is override open data
  sealed companion lateinit internal suspend guard extension protocol init deinit var let
`);
const PY_KW = words(`
  and as assert async await break class continue def del elif else except finally for from global if import in is
  lambda nonlocal not or pass raise return try while with yield match case self
`);
const SH_KW = words(`if then else elif fi for while until do done case esac function in select return export local readonly unset`);
const SQL_KW = words(`
  select from where and or not insert into values update set delete create table index view drop alter add join inner
  left right outer full on group by order having limit offset as distinct union all exists in is like between case
  when then else end primary key foreign references default unique with returning asc desc
`);
const COMMON_LIT = words(`true false null undefined None True False nil NaN Infinity`);

const LANGS: Record<string, LangDef> = {
  js: { comments: SLASH_COMMENTS, strings: [DQ, SQ, BT], keywords: JS_KW, literals: COMMON_LIT, calls: true },
  py: {
    comments: [HASH_COMMENT],
    strings: [String.raw`"""[\s\S]*?(?:"""|$)`, String.raw`'''[\s\S]*?(?:'''|$)`, DQ, SQ],
    keywords: PY_KW,
    literals: COMMON_LIT,
    calls: true,
  },
  sh: {
    comments: [String.raw`(?<![^\s])#[^\n]*`],
    strings: [DQ, SQ],
    keywords: SH_KW,
    literals: words(""),
    firstWordIsCommand: true,
  },
  json: { comments: [], strings: [DQ], keywords: words(""), literals: words("true false null"), keys: "json" },
  yaml: { comments: [HASH_COMMENT], strings: [DQ, SQ], keywords: words(""), literals: words("true false null yes no on off ~"), keys: "yaml" },
  c: { comments: SLASH_COMMENTS, strings: [DQ, SQ], keywords: C_LIKE_KW, literals: COMMON_LIT, calls: true },
  sql: {
    comments: [String.raw`--[^\n]*`, String.raw`/\*[\s\S]*?(?:\*/|$)`],
    strings: [SQ, DQ],
    keywords: SQL_KW,
    literals: words("null true false"),
    caseInsensitive: true,
    calls: true,
  },
  plain: { comments: [], strings: [DQ, SQ], keywords: words(""), literals: words("") },
};

const ALIASES: Record<string, keyof typeof LANGS> = {
  js: "js", javascript: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", typescript: "js", tsx: "js", node: "js",
  py: "py", python: "py", python3: "py",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", console: "sh", terminal: "sh", shellsession: "sh",
  json: "json", jsonc: "json",
  yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml",
  c: "c", h: "c", cpp: "c", "c++": "c", cc: "c", cs: "c", csharp: "c", java: "c", kotlin: "c", kt: "c", go: "c",
  golang: "c", rust: "c", rs: "c", swift: "c", scala: "c", dart: "c", php: "c",
  sql: "sql", postgres: "sql", postgresql: "sql", mysql: "sql", sqlite: "sql",
};

/** Language tags that mean "no language": the code panel shows no label for them. */
const PLAIN_TAGS = new Set(["", "text", "txt", "plain", "plaintext"]);

/** The label a code panel shows for a language tag, or undefined for plain text. */
export function codeLabel(language: string | undefined): string | undefined {
  const tag = language?.trim() ?? "";
  return PLAIN_TAGS.has(tag.toLowerCase()) ? undefined : tag;
}

/** The highlighter family used for a language tag (`plain` when unknown). */
export function languageFamily(language: string): keyof typeof LANGS {
  return ALIASES[language.trim().toLowerCase()] ?? "plain";
}

const compiled = new Map<string, RegExp>();

function tokenRegex(family: keyof typeof LANGS): RegExp {
  let re = compiled.get(family);
  if (!re) {
    const d = LANGS[family]!;
    const parts = [
      // Always four capture groups (comment, string, number, word); "(?!)" never matches.
      `(${d.comments.length ? d.comments.join("|") : "(?!)"})`,
      `(${d.strings.length ? d.strings.join("|") : "(?!)"})`,
      String.raw`(\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)`,
      family === "sh" || family === "yaml" ? String.raw`([A-Za-z_$][\w$.-]*)` : String.raw`([A-Za-z_$][\w$]*)`,
    ];
    re = new RegExp(parts.join("|"), "gy");
    compiled.set(family, re);
  }
  return re;
}

/** Tokenize source code. Pure and deterministic; concatenating `text` reproduces the input exactly. */
export function tokenize(code: string, language: string): Token[] {
  const family = languageFamily(language);
  const def = LANGS[family]!;
  const re = tokenRegex(family);
  const out: Token[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ text: plain });
    plain = "";
  };
  let atLineStart = true;
  let i = 0;
  while (i < code.length) {
    re.lastIndex = i;
    const m = re.exec(code);
    if (!m || m[0].length === 0) {
      const ch = code[i]!;
      plain += ch;
      if (ch === "\n") atLineStart = true;
      else if (!/\s/.test(ch)) atLineStart = false;
      i++;
      continue;
    }
    const [text, com, str, num, word] = m;
    let cls: TokenClass | undefined;
    if (com !== undefined) cls = "com";
    else if (str !== undefined) {
      cls = "str";
      if (def.keys === "json" && /^\s*:/.test(code.slice(i + text.length))) cls = "key";
    } else if (num !== undefined) cls = "num";
    else if (word !== undefined) {
      const w = def.caseInsensitive ? word.toLowerCase() : word;
      const next = code.slice(i + text.length);
      if (def.keys === "yaml" && atLineStart && /^\s*:/.test(next)) cls = "key";
      else if (def.firstWordIsCommand && atLineStart && !def.keywords.has(w)) cls = "fn";
      else if (def.keywords.has(w)) cls = "kw";
      else if (def.literals.has(word)) cls = "lit";
      else if (def.calls && /^\(/.test(next)) cls = "fn";
    }
    if (cls) {
      flush();
      out.push({ text, cls });
    } else plain += text;
    atLineStart = /\n\s*$/.test(text) ? true : false;
    i += text.length;
  }
  flush();
  return out;
}

/** Highlight into escaped HTML, split per source line (so each line can be its own element). */
export function highlightLines(code: string, language: string): string[] {
  const lines: string[] = [""];
  for (const tok of tokenize(code, language)) {
    const parts = tok.text.split("\n");
    parts.forEach((part, idx) => {
      if (idx > 0) lines.push("");
      if (part) lines[lines.length - 1] += tok.cls ? `<span class="tk-${tok.cls}">${escapeHtml(part)}</span>` : escapeHtml(part);
    });
  }
  return lines;
}
