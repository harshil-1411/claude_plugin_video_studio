import { createHash } from "node:crypto";
import { lintSource } from "@secretlint/core";
import { creator as secretlintPresetRecommend } from "@secretlint/secretlint-rule-preset-recommend";
import { secretSpans, type SecretSpan } from "./classify.js";
import type { ExtractedSource } from "./types.js";

/**
 * Secret redaction for every extracted source (S3). The repo extractor excludes secret-bearing
 * files; everything else (text, markdown, PDF, DOCX, PPTX, HTML, URL pages, transcripts) used to
 * keep a matched secret verbatim in `content-ir.json` and the ingest cache. {@link redactPart}
 * runs the same detection (secretlint's recommend preset, passed in memory, plus the heuristic
 * patterns of classify.ts) over the extracted title, headings, section text and evidence text and
 * replaces each match with `[REDACTED:<rule>]`. The part records a `secret_redacted` warning per
 * rule and a `contains_secrets` classification hint; neither carries any secret text.
 */

const SECRETLINT_CONFIG = {
  rules: [{ id: "@secretlint/secretlint-rule-preset-recommend", rule: secretlintPresetRecommend }],
} as unknown as Parameters<typeof lintSource>[0]["options"]["config"];

export const REDACTION_WARNING = "secret_redacted";

/** secretlint (recommend preset, in-memory config: no rc file is ever loaded) + classify.ts patterns. */
export async function findSecretSpans(text: string): Promise<SecretSpan[]> {
  const spans = secretSpans(text);
  if (text.trim()) {
    const result = await lintSource({
      source: { filePath: "extracted.txt", content: text, ext: ".txt", contentType: "text" },
      options: { config: SECRETLINT_CONFIG, maskSecrets: true, noPhysicFilePath: true },
    });
    for (const m of result.messages) {
      if ((m as { type?: string }).type === "ignore") continue;
      const [start, end] = m.range;
      if (end > start) spans.push({ start, end, type: m.ruleId.replace(/^@secretlint\/secretlint-rule-/, "secretlint-") });
    }
  }
  return mergeSpans(spans);
}

/** Sort and merge overlapping spans; a merged span keeps the rule of its earliest (then longest) member. */
function mergeSpans(spans: SecretSpan[]): SecretSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: SecretSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

export const redactionMarker = (rule: string) => `[REDACTED:${rule}]`;

interface Edit {
  start: number;
  end: number;
  /** Length of the replacement marker. */
  len: number;
}

interface Redaction {
  text: string;
  edits: Edit[];
  /** rule → hashes of the matched values (in memory only, for counting distinct secrets). */
  found: Array<{ rule: string; digest: string }>;
}

async function redactString(text: string): Promise<Redaction> {
  const spans = await findSecretSpans(text);
  if (spans.length === 0) return { text, edits: [], found: [] };
  let out = "";
  let pos = 0;
  const edits: Edit[] = [];
  const found: Redaction["found"] = [];
  for (const s of spans) {
    const marker = redactionMarker(s.type);
    out += text.slice(pos, s.start) + marker;
    edits.push({ start: s.start, end: s.end, len: marker.length });
    found.push({ rule: s.type, digest: createHash("sha256").update(text.slice(s.start, s.end)).digest("hex") });
    pos = s.end;
  }
  out += text.slice(pos);
  return { text: out, edits, found };
}

/**
 * Map an offset in the original string to the redacted one. An offset inside a redacted range
 * snaps to the marker's start (`side: "start"`) or end (`side: "end"`).
 */
export function mapOffset(edits: readonly Edit[], i: number, side: "start" | "end"): number {
  let delta = 0;
  for (const e of edits) {
    if (i <= e.start) break;
    if (i < e.end) return e.start + delta + (side === "start" ? 0 : e.len);
    delta += e.len - (e.end - e.start);
  }
  return i + delta;
}

/**
 * Redact secrets in one extracted source. Returns the same object when nothing matched (so
 * already-redacted cache entries are a no-op).
 *
 * Evidence offsets: a span whose `char_start`/`char_end` index into one of the part's section
 * texts (DOCX) is re-sliced from the redacted section and its offsets are remapped, so
 * `section.text.slice(char_start, char_end) === evidence.text` still holds. Offsets that index the
 * original source file (text, markdown) are left alone: they still locate the span in that file;
 * only the stored excerpt is redacted.
 */
export async function redactPart(part: ExtractedSource): Promise<ExtractedSource> {
  const memo = new Map<string, Promise<Redaction>>();
  const red = (t: string) => {
    let p = memo.get(t);
    if (!p) memo.set(t, (p = redactString(t)));
    return p;
  };
  const title = part.source.title !== undefined ? await red(part.source.title) : undefined;
  const sections = await Promise.all(
    part.sections.map(async (s) => ({ heading: s.heading !== undefined ? await red(s.heading) : undefined, text: await red(s.text) })),
  );
  const evidence = await Promise.all(part.evidence.map((e) => red(e.text)));
  const all = [title, ...sections.flatMap((s) => [s.heading, s.text]), ...evidence].filter((r): r is Redaction => r !== undefined);
  if (all.every((r) => r.edits.length === 0)) return part;

  const newEvidence = part.evidence.map((e, k) => {
    const r = evidence[k]!;
    const { char_start: cs, char_end: ce } = e.locator;
    if (cs !== undefined && ce !== undefined) {
      const idx = part.sections.findIndex((s, j) => sections[j]!.text.edits.length > 0 && s.text.slice(cs, ce) === e.text);
      if (idx >= 0) {
        const sec = sections[idx]!.text;
        const ns = mapOffset(sec.edits, cs, "start");
        const ne = mapOffset(sec.edits, ce, "end");
        return { ...e, text: sec.text.slice(ns, ne), locator: { ...e.locator, char_start: ns, char_end: ne } };
      }
    }
    return r.edits.length ? { ...e, text: r.text } : e;
  });

  const byRule = new Map<string, Set<string>>();
  for (const r of all) for (const f of r.found) (byRule.get(f.rule) ?? byRule.set(f.rule, new Set()).get(f.rule)!).add(f.digest);
  const rules = [...byRule].sort(([a], [b]) => a.localeCompare(b));
  const warnings = [
    ...part.warnings,
    ...rules.map(([rule, set]) => ({
      code: REDACTION_WARNING,
      message: `${set.size} possible secret(s) matching rule ${rule} were redacted from the extracted text (shown as ${redactionMarker(rule)}).`,
    })),
  ];
  const hints = part.classificationHints ?? {};
  return {
    ...part,
    source: { ...part.source, ...(title ? { title: title.text } : {}) },
    sections: part.sections.map((s, j) => ({
      ...s,
      ...(s.heading !== undefined ? { heading: sections[j]!.heading!.text } : {}),
      text: sections[j]!.text.text,
    })),
    evidence: newEvidence,
    warnings,
    classificationHints: {
      ...hints,
      contains_secrets: true,
      notes: [...(hints.notes ?? []), ...rules.map(([rule, set]) => `secret redacted: ${rule} ×${set.size}`)],
    },
  };
}
