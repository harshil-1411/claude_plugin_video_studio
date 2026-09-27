/**
 * Every credential the plugin knows about, as data: the `userConfig` key a user fills in
 * (`/plugin` → video-studio → Configure, stored in the OS keychain when sensitive), the env var
 * `.mcp.json` passes it to the engine as, and what it is for. Most are placeholders for provider
 * (Phase 7) and publishing (Phase 9) integrations that are not built yet: setting them is safe
 * and has no effect until then. `.claude-plugin/plugin.json` and `.mcp.json` must list exactly
 * these (a test checks it). Env var names for unbuilt integrations are re-verified against each
 * provider's docs when that integration is built.
 */

export type CredentialUse = "voice" | "generation" | "publishing";

export interface Credential {
  /** `userConfig` key in `.claude-plugin/plugin.json`. */
  user_config: string;
  /** Env var the engine reads (`${user_config.<key>}` in `.mcp.json`). */
  env: string;
  /** Title shown in the plugin's Configure screen. */
  title: string;
  /** Service it authenticates. */
  service: string;
  use: CredentialUse;
  /** Whether the engine uses it today; false = a placeholder for a planned integration. */
  active: boolean;
  /** The planned phase for placeholders. */
  phase?: 7 | 9;
  /** Secret (keychain) or a non-secret identifier (e.g. an OAuth client id). */
  sensitive: boolean;
  /** What it unlocks. */
  purpose: string;
}

export const CREDENTIALS: readonly Credential[] = [
  // Voice (in use).
  { user_config: "elevenlabs_key", env: "ELEVENLABS_API_KEY", title: "ElevenLabs API key", service: "ElevenLabs", use: "voice", active: true, sensitive: true, purpose: "voiceover and word timings" },
  // Generation providers (Phase 7).
  { user_config: "runway_key", env: "RUNWAYML_API_SECRET", title: "Runway API key", service: "Runway", use: "generation", active: false, phase: 7, sensitive: true, purpose: "Runway Gen-4 / Gen-4.5 generative video" },
  { user_config: "heygen_key", env: "HEYGEN_API_KEY", title: "HeyGen API key", service: "HeyGen", use: "generation", active: false, phase: 7, sensitive: true, purpose: "HeyGen v3 presenter videos" },
  { user_config: "fal_key", env: "FAL_KEY", title: "fal.ai API key", service: "fal.ai", use: "generation", active: false, phase: 7, sensitive: true, purpose: "Kling, Veo, Hailuo, Seedance and Wan through fal.ai" },
  { user_config: "kling_key", env: "KLINGAI_API_KEY", title: "Kling API key", service: "Kling", use: "generation", active: false, phase: 7, sensitive: true, purpose: "direct Kling API" },
  { user_config: "google_key", env: "GEMINI_API_KEY", title: "Google Gemini API key", service: "Google (Veo)", use: "generation", active: false, phase: 7, sensitive: true, purpose: "direct Veo through the Gemini API" },
  { user_config: "ark_key", env: "ARK_API_KEY", title: "BytePlus ModelArk API key", service: "BytePlus ModelArk (Seedance)", use: "generation", active: false, phase: 7, sensitive: true, purpose: "direct Seedance API" },
  { user_config: "dashscope_key", env: "DASHSCOPE_API_KEY", title: "Alibaba DashScope API key", service: "Alibaba Model Studio (Wan)", use: "generation", active: false, phase: 7, sensitive: true, purpose: "direct Wan API" },
  { user_config: "minimax_key", env: "MINIMAX_API_KEY", title: "MiniMax API key", service: "MiniMax (Hailuo)", use: "generation", active: false, phase: 7, sensitive: true, purpose: "direct Hailuo API" },
  // Publishing platforms (Phase 9).
  { user_config: "youtube_client_id", env: "YOUTUBE_CLIENT_ID", title: "YouTube OAuth client ID", service: "YouTube Data API", use: "publishing", active: false, phase: 9, sensitive: false, purpose: "uploading to YouTube and YouTube Shorts" },
  { user_config: "youtube_client_secret", env: "YOUTUBE_CLIENT_SECRET", title: "YouTube OAuth client secret", service: "YouTube Data API", use: "publishing", active: false, phase: 9, sensitive: true, purpose: "uploading to YouTube and YouTube Shorts" },
  { user_config: "meta_access_token", env: "META_ACCESS_TOKEN", title: "Meta (Instagram) access token", service: "Instagram Graph API", use: "publishing", active: false, phase: 9, sensitive: true, purpose: "publishing Instagram Reels" },
  { user_config: "linkedin_access_token", env: "LINKEDIN_ACCESS_TOKEN", title: "LinkedIn access token", service: "LinkedIn API", use: "publishing", active: false, phase: 9, sensitive: true, purpose: "posting videos to LinkedIn" },
  { user_config: "tiktok_client_key", env: "TIKTOK_CLIENT_KEY", title: "TikTok client key", service: "TikTok Content Posting API", use: "publishing", active: false, phase: 9, sensitive: false, purpose: "TikTok Direct Post (not available in India)" },
  { user_config: "tiktok_client_secret", env: "TIKTOK_CLIENT_SECRET", title: "TikTok client secret", service: "TikTok Content Posting API", use: "publishing", active: false, phase: 9, sensitive: true, purpose: "TikTok Direct Post (not available in India)" },
];

/** An unset `${user_config.X}` can reach the env as the literal placeholder text: that is not a value. */
export function isUnexpandedPlaceholder(v: string): boolean {
  return /^\$\{[^}]*\}$/.test(v.trim());
}

/** Whether a credential env var holds a real value (not empty, not an unexpanded placeholder). */
export function hasCredential(env: Readonly<Record<string, string | undefined>>, envVar: string): boolean {
  const v = env[envVar]?.trim();
  return Boolean(v) && !isUnexpandedPlaceholder(v!);
}

/** The credential behind an env var, if any. */
export function credentialForEnv(envVar: string): Credential | undefined {
  return CREDENTIALS.find((c) => c.env === envVar);
}
