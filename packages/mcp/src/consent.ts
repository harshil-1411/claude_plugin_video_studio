import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalJson, projectPaths, readJson, sha256Hex, writeJsonAtomic } from "@video-studio/core";
import type { DemoScript } from "@video-studio/schema";
import type { PaidVoiceDecision } from "./policy.js";

/**
 * Consent the model cannot grant alone. When the connected client supports MCP elicitation, the
 * engine asks the USER directly (an approval dialog in the client) and proceeds only on an
 * explicit accept. Clients without elicitation fall back to an explicit tool flag the skills set
 * only after asking the user in chat. Every grant is recorded in `<project>/project/consent.json`
 * and re-used for the same subject (same model file, same demo script, same paid synthesis).
 */

export type ConsentAction = "model_download" | "demo_capture" | "paid_voice";

export interface ConsentRecord {
  action: ConsentAction;
  /** What exactly was approved (model file + sha256, demo script hash, paid synthesis digest). */
  subject: string;
  granted_at: string;
  via: "elicitation" | "tool_flag";
  detail: string;
}

export const CONSENT_FILE = "consent.json";

export function consentPath(projectDir: string): string {
  return join(projectPaths(projectDir).project, CONSENT_FILE);
}

export async function readConsents(projectDir: string): Promise<ConsentRecord[]> {
  const data = await readJson<unknown>(consentPath(projectDir)).catch(() => undefined);
  return Array.isArray(data) ? (data as ConsentRecord[]).filter((r) => r && typeof r.action === "string" && typeof r.subject === "string") : [];
}

/** A recorded consent for `action` + `subject` (optionally only one given through a given channel). */
export async function findConsent(projectDir: string, action: ConsentAction, subject: string, via?: ConsentRecord["via"]): Promise<ConsentRecord | undefined> {
  return (await readConsents(projectDir)).find((r) => r.action === action && r.subject === subject && (!via || r.via === via));
}

export async function recordConsent(projectDir: string, rec: Omit<ConsentRecord, "granted_at"> & { granted_at?: string }): Promise<ConsentRecord> {
  const full: ConsentRecord = { action: rec.action, subject: rec.subject, granted_at: rec.granted_at ?? new Date().toISOString(), via: rec.via, detail: rec.detail };
  const all = await readConsents(projectDir);
  await writeJsonAtomic(consentPath(projectDir), [...all, full]);
  return full;
}

/** True when the connected client declared the MCP elicitation capability. */
export function supportsElicitation(server: McpServer): boolean {
  return !!server.server.getClientCapabilities()?.elicitation;
}

export interface ConsentRequest {
  action: ConsentAction;
  subject: string;
  /** Recorded with the grant. */
  detail: string;
  /** Shown to the user in the approval dialog: what, how big / how much, where it goes. */
  message: string;
  /** Title of the approve checkbox. */
  approveTitle: string;
  /** The fallback tool flag's value and name, for clients without elicitation. */
  flag: boolean | undefined;
  flagName: string;
}

export type ConsentOutcome =
  | { granted: true; via: ConsentRecord["via"]; reused: boolean; record: ConsentRecord }
  | { granted: false; asked: boolean; reason: string };

/**
 * Obtain consent for an action with external effects.
 *
 * - elicitation supported: re-use an elicitation grant for the same subject, else ask the user; a
 *   tool flag set by the model is not enough.
 * - no elicitation: the tool flag is required (the skill asks the user in chat first); recorded as
 *   `tool_flag`.
 */
export async function obtainConsent(server: McpServer, projectDir: string, req: ConsentRequest): Promise<ConsentOutcome> {
  if (supportsElicitation(server)) {
    const prior = await findConsent(projectDir, req.action, req.subject, "elicitation");
    if (prior) return { granted: true, via: "elicitation", reused: true, record: prior };
    let res: Awaited<ReturnType<McpServer["server"]["elicitInput"]>>;
    try {
      res = await server.server.elicitInput({
        message: req.message,
        requestedSchema: {
          type: "object",
          properties: { approve: { type: "boolean", title: req.approveTitle } },
          required: ["approve"],
        },
      });
    } catch (e) {
      return { granted: false, asked: false, reason: `could not ask the user for approval (${e instanceof Error ? e.message : String(e)}); nothing was done` };
    }
    if (res.action === "accept" && res.content?.approve === true) {
      const record = await recordConsent(projectDir, { action: req.action, subject: req.subject, via: "elicitation", detail: req.detail });
      return { granted: true, via: "elicitation", reused: false, record };
    }
    const how = res.action === "accept" ? "did not approve" : res.action === "decline" ? "declined" : "cancelled the approval dialog";
    return { granted: false, asked: true, reason: `the user ${how}; nothing was done. Do not retry unless the user asks for it` };
  }
  if (req.flag === true) {
    const prior = await findConsent(projectDir, req.action, req.subject, "tool_flag");
    if (prior) return { granted: true, via: "tool_flag", reused: true, record: prior };
    const record = await recordConsent(projectDir, { action: req.action, subject: req.subject, via: "tool_flag", detail: req.detail });
    return { granted: true, via: "tool_flag", reused: false, record };
  }
  return {
    granted: false,
    asked: false,
    reason: `this needs the user's approval and the client cannot show an approval dialog: ask the user (${req.message}) and call again with ${req.flagName}: true only if they agree`,
  };
}

// ------------------------------------------------------------------------------------ requests

function describeStep(s: DemoScript["steps"][number]): string {
  switch (s.action) {
    case "goto":
      return `open ${s.url}`;
    case "click":
      return `click ${s.selector}`;
    case "type":
      return `type ${s.text.length} character(s) into ${s.selector} (blurred)`;
    case "hover":
      return `hover ${s.selector}`;
    case "scroll":
      return `scroll ${s.y}px`;
    case "zoom":
      return `zoom into ${s.selector}`;
    case "wait":
      return `wait ${s.ms} ms`;
  }
}

/** Demo capture: approve this exact script (URL + steps). */
export function demoConsentRequest(script: DemoScript, flag: boolean | undefined): ConsentRequest {
  const subject = `demo:${script.id}:${sha256Hex(canonicalJson(script))}`;
  const steps = script.steps.map((s, i) => `${i + 1}. ${describeStep(s)}`);
  const shown = steps.length > 12 ? [...steps.slice(0, 12), `… and ${steps.length - 12} more`] : steps;
  return {
    action: "demo_capture",
    subject,
    detail: `${script.url}, ${script.steps.length} step(s)`,
    message:
      `Record a screen capture of ${script.url} with a headless Chrome, driving it with these ${script.steps.length} step(s):\n${shown.join("\n")}\n` +
      `Form fields${script.mask_selectors?.length ? ` and ${script.mask_selectors.length} extra selector(s)` : ""} are blurred; any other text on screen is recorded. ` +
      `The video is saved in this project (source/assets/demo-${script.id}.mp4). Only approve if you started this app and the URL is yours.`,
    approveTitle: "Approve recording this URL",
    flag,
    flagName: "confirm",
  };
}

/** The whisper model download (plugin data dir, shared by all projects). */
export function modelDownloadConsentRequest(m: { file: string; url: string; sha256: string; approx_mb: number; dest: string }, flag: boolean | undefined): ConsentRequest {
  return {
    action: "model_download",
    subject: `${m.file}@sha256:${m.sha256}`,
    detail: `${m.url} → ${m.dest}`,
    message:
      `Download the whisper speech-recognition model ${m.file} (about ${m.approx_mb} MB) from ${new URL(m.url).host} into ${m.dest} ` +
      `(the plugin's data folder, shared by all projects; checked against its published sha256)? It is used for local transcription only; no audio leaves this machine.`,
    approveTitle: `Download ${m.file} (~${m.approx_mb} MB)`,
    flag,
    flagName: "download_model",
  };
}

/** Paid voice above the approval threshold (or with no price estimate). */
export function paidVoiceConsentRequest(d: PaidVoiceDecision, flag: boolean | undefined): ConsentRequest {
  const est = d.plan.estimated_usd;
  const cost = est !== null ? `an estimated $${est.toFixed(2)} (at $${d.plan.usd_per_1k_chars}/1k characters; your plan's billing may differ)` : "an unknown amount (no price estimate for this model)";
  const scenes = d.plan.scenes.filter((s) => !s.cached).length;
  return {
    action: "paid_voice",
    subject: d.subject,
    detail: `${d.backend}: ${d.plan.chars_uncached} chars, ${scenes} scene(s), est ${est === null ? "unknown" : `$${est}`}`,
    message:
      `This render sends ${d.plan.chars_uncached} characters of narration (${scenes} scene(s)) to ${d.backend === "elevenlabs" ? "ElevenLabs" : d.backend}, a paid text-to-speech API, costing ${cost}. ` +
      `Estimated spend recorded for this project so far: $${d.spent_usd.toFixed(2)}. ${d.reason}. Approve this charge? (Decline to use the free system voice.)`,
    approveTitle: "Approve the paid voice charge",
    flag,
    flagName: "approve_paid_voice",
  };
}
