import type { Classification, DataClass, SourceKind } from "@video-studio/schema";

/**
 * Heuristic ingestion security label. Findings never contain the matched
 * secret itself, only a redacted preview, so notes are safe to persist.
 */

export interface Finding {
  category: "secret" | "pii";
  type: string;
  /** Redacted preview, e.g. `AKIA…MPLE`. */
  preview: string;
}

export interface ClassifyOptions {
  kind?: SourceKind;
  /** Set by the caller when extracted images were flagged as containing faces. */
  imagesWithFaces?: boolean;
}

export interface ClassifyResult {
  classification: Classification;
  findings: Finding[];
}

const DATA_CLASS_ORDER: readonly DataClass[] = ["public", "internal", "confidential", "restricted"];

export function maxDataClass(...classes: DataClass[]): DataClass {
  let best = 0;
  for (const c of classes) best = Math.max(best, DATA_CLASS_ORDER.indexOf(c));
  return DATA_CLASS_ORDER[best]!;
}

/** url → public; everything else (text, markdown, documents, repos, video) → internal. */
export function defaultDataClass(kind?: SourceKind): DataClass {
  return kind === "url" ? "public" : "internal";
}

interface SecretPattern {
  type: string;
  re: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { type: "private_key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  { type: "aws_access_key_id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  { type: "github_token", re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { type: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g },
  { type: "anthropic_api_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { type: "openai_style_api_key", re: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { type: "stripe_secret_key", re: /\b[rs]k_live_[A-Za-z0-9]{16,}\b/g },
  { type: "slack_token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { type: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

/** `FOO_KEY = "…"`, `api_secret: …`, `GITHUB_TOKEN=…`, `password=…` */
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)[A-Za-z0-9_]*)["']?\s*(?:=|:|=>)\s*["'`]?([^\s"'`,;]{12,})/gi;

const PLACEHOLDER = /^(?:\[REDACTED[:\]].*|x+|\*+|\.+|<.*>|\{.*\}|\$\{?.*|%.*%|your[_-]?.*|changeme|example.*|placeholder.*|redacted|null|none|undefined|true|false|process\.env.*|os\.environ.*|env\(.*)$/i;

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function redact(s: string): string {
  if (s.length <= 8) return "…";
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

const EMAIL = /\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,24}\b/g;
const SAFE_EMAIL_DOMAIN = /@(?:(?:[\w-]+\.)*example\.(?:com|org|net)|localhost|test|invalid)$/i;
/** North-American style or international (+CC) numbers with separators. */
const PHONE = /(?<![\w.+/-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}(?![\w.-]*\d)/g;

function scanSecrets(text: string, findings: Finding[]): void {
  const seen: string[] = [];
  for (const { type, re } of SECRET_PATTERNS) {
    for (const m of text.matchAll(re)) {
      seen.push(m[0]);
      findings.push({ category: "secret", type, preview: redact(m[0]) });
    }
  }
  for (const m of text.matchAll(ASSIGNMENT)) {
    const value = m[2]!;
    if (PLACEHOLDER.test(value)) continue;
    if (seen.some((v) => value.includes(v) || v.includes(value))) continue;
    if (shannonEntropy(value) < 3.5 || !/\d/.test(value) || !/[A-Za-z]/.test(value)) continue;
    findings.push({ category: "secret", type: `high_entropy_assignment:${m[1]!.toUpperCase()}`, preview: redact(value) });
  }
}

/** A secret's position in a string (for redaction). Never persisted with the text. */
export interface SecretSpan {
  start: number;
  end: number;
  /** Finding type, e.g. `aws_access_key_id`, `private_key`, `high_entropy_assignment`. */
  type: string;
}

const PEM_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g;

/**
 * Positions of the secrets {@link classifyText} reports, widened to what must be hidden: a
 * private key covers its whole PEM block (from BEGIN to END, or to the end of the string when the
 * block was split; an END with no BEGIN before it covers from the string start), and a
 * high-entropy assignment covers only its value (`API_TOKEN=[REDACTED:…]`).
 */
export function secretSpans(text: string): SecretSpan[] {
  const spans: SecretSpan[] = [];
  let lastBlockEnd = 0;
  for (const m of text.matchAll(PEM_BEGIN)) {
    if (m.index < lastBlockEnd) continue;
    PEM_END.lastIndex = m.index + m[0].length;
    const end = PEM_END.exec(text);
    const stop = end ? end.index + end[0].length : text.length;
    spans.push({ start: m.index, end: stop, type: "private_key" });
    lastBlockEnd = stop;
  }
  PEM_END.lastIndex = 0;
  for (const m of text.matchAll(PEM_END)) {
    const inside = spans.some((s) => m.index >= s.start && m.index < s.end);
    if (!inside) spans.push({ start: 0, end: m.index + m[0].length, type: "private_key" });
  }
  for (const { type, re } of SECRET_PATTERNS) {
    if (type === "private_key") continue;
    for (const m of text.matchAll(re)) spans.push({ start: m.index, end: m.index + m[0].length, type });
  }
  const assignment = new RegExp(ASSIGNMENT.source, "gid");
  for (const m of text.matchAll(assignment)) {
    const value = m[2]!;
    if (PLACEHOLDER.test(value)) continue;
    if (shannonEntropy(value) < 3.5 || !/\d/.test(value) || !/[A-Za-z]/.test(value)) continue;
    const [start, end] = m.indices![2]!;
    spans.push({ start, end, type: "high_entropy_assignment" });
  }
  return spans;
}

function scanPii(text: string, findings: Finding[]): void {
  for (const m of text.matchAll(EMAIL)) {
    if (SAFE_EMAIL_DOMAIN.test(m[0])) continue;
    findings.push({ category: "pii", type: "email", preview: redact(m[0]) });
  }
  for (const m of text.matchAll(PHONE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) continue;
    // Skip ISO dates like 2024-10-12 and version-ish sequences.
    if (/^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(m[0].trim())) continue;
    findings.push({ category: "pii", type: "phone", preview: redact(m[0].trim()) });
  }
}

/** Scan text for secrets and PII and derive the Classification. */
export function classifyText(texts: string | readonly string[], opts: ClassifyOptions = {}): ClassifyResult {
  const findings: Finding[] = [];
  for (const t of typeof texts === "string" ? [texts] : texts) {
    scanSecrets(t, findings);
    scanPii(t, findings);
  }
  const secrets = findings.filter((f) => f.category === "secret");
  const pii = findings.filter((f) => f.category === "pii");
  const likeness = opts.imagesWithFaces === true;

  const notes: string[] = [];
  const summarize = (list: Finding[], label: string) => {
    const byType = new Map<string, number>();
    for (const f of list) byType.set(f.type, (byType.get(f.type) ?? 0) + 1);
    for (const [type, n] of [...byType].sort(([a], [b]) => a.localeCompare(b))) notes.push(`${label}: ${type} ×${n}`);
  };
  summarize(secrets, "possible secret");
  summarize(pii, "possible PII");
  if (likeness) notes.push("likeness: images flagged as containing faces");

  let dataClass = defaultDataClass(opts.kind);
  if (pii.length) dataClass = maxDataClass(dataClass, "confidential");
  if (secrets.length) dataClass = maxDataClass(dataClass, "restricted");

  return {
    classification: {
      contains_secrets: secrets.length > 0,
      contains_pii: pii.length > 0,
      contains_likeness: likeness,
      data_class: dataClass,
      notes,
    },
    findings,
  };
}

/** Combine classifications: OR the flags, max data_class, de-duplicated notes. */
export function mergeClassifications(list: readonly Classification[], fallback: DataClass = "internal"): Classification {
  if (list.length === 0) {
    return { contains_secrets: false, contains_pii: false, contains_likeness: false, data_class: fallback, notes: [] };
  }
  return {
    contains_secrets: list.some((c) => c.contains_secrets),
    contains_pii: list.some((c) => c.contains_pii),
    contains_likeness: list.some((c) => c.contains_likeness),
    data_class: maxDataClass(...list.map((c) => c.data_class)),
    notes: [...new Set(list.flatMap((c) => c.notes))],
  };
}
