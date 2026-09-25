import { propsText } from "@video-studio/schema";

/**
 * Lines for drawing a deterministic kind as a plain typography card, used while a renderer does
 * not implement that kind yet. The renderer adds a warning so QA reports the stand-in.
 */
export function fallbackLines(props: Record<string, unknown>): string[] {
  const lines = propsText(props)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines : [" "];
}
