import type { CreativeBrief, VideoSpec } from "@video-studio/schema";

/**
 * Deterministic social copy from the spec and brief: a title, a short description and hashtags.
 * Lives apart from the pipeline so lint (title checks) and export can both use it without an
 * import cycle.
 */

const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from how in into is it its of on or so that the their this to what when where which who why with without you your in 30s seconds explain explained actually".split(
    " ",
  ),
);

const PLATFORM_TAGS: Record<string, string[]> = {
  youtube_shorts: ["shorts"],
  instagram_reels: ["reels"],
  tiktok: ["fyp"],
  linkedin: [],
  youtube: [],
  x: [],
  generic: [],
};

function hashtag(word: string): string {
  return word.replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function firstSentence(text: string): string {
  return (text.split(/(?<=[.!?])\s/)[0] ?? text).trim();
}

/** Deterministic social copy (title, 2–3 line description, hashtags). Claude refines it in the skill. */
export function socialCopy(spec: VideoSpec, brief?: CreativeBrief): string {
  const { title, lines, hashtags } = socialCopyParts(spec, brief);
  return [
    "<!-- Generated deterministically from the spec and brief by video-studio. Refine the wording before posting; keep every claim grounded in the sources. -->",
    `# ${title}`,
    "",
    ...lines,
    "",
    hashtags.join(" "),
    "",
  ].join("\n");
}

/** The pieces of {@link socialCopy}: title, up to 3 description lines and up to 7 hashtags (with `#`). */
export function socialCopyParts(spec: VideoSpec, brief?: CreativeBrief): { title: string; lines: string[]; hashtags: string[] } {
  const title = spec.title?.trim() || brief?.chosen_hook || firstSentence(spec.scenes[0]?.voiceover ?? "") || "New video";
  const lines: string[] = [];
  const hook = spec.scenes.find((s) => s.purpose === "hook");
  if (hook?.voiceover.trim()) lines.push(hook.voiceover.trim());
  const messages = brief?.key_messages?.length
    ? brief.key_messages
    : spec.scenes.filter((s) => !["hook", "cta", "end_card"].includes(s.purpose) && s.voiceover.trim()).map((s) => firstSentence(s.voiceover));
  if (messages[0] && !lines.includes(messages[0])) lines.push(messages[0]);
  const action = brief?.desired_action ?? spec.scenes.find((s) => s.purpose === "cta")?.voiceover.trim();
  if (action) lines.push(action);
  const contentWords = (text: string) =>
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  // Title words first, then words the narration repeats across scenes (most frequent first).
  const freq = new Map<string, number>();
  for (const sc of spec.scenes) for (const w of new Set(contentWords(sc.voiceover))) freq.set(w, (freq.get(w) ?? 0) + 1);
  const repeated = [...freq].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);
  const tags: string[] = [];
  const add = (w: string) => {
    const t = hashtag(w);
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase() || x.toLowerCase() === `${t.toLowerCase()}s` || `${x.toLowerCase()}s` === t.toLowerCase())) tags.push(t);
  };
  for (const w of contentWords(title)) add(w);
  for (const w of repeated.slice(0, 3)) add(w);
  for (const w of [...(PLATFORM_TAGS[spec.platform] ?? []), spec.goal === "explain" ? "explained" : spec.goal]) add(w);
  return { title, lines: lines.slice(0, 3), hashtags: tags.slice(0, 7).map((t) => `#${t}`) };
}
