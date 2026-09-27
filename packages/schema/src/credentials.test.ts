import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./emit.js";
import { CREDENTIALS, credentialForEnv, hasCredential, isUnexpandedPlaceholder } from "./credentials.js";

const pluginJson = JSON.parse(readFileSync(join(REPO_ROOT, ".claude-plugin/plugin.json"), "utf8")) as {
  userConfig: Record<string, { type: string; title: string; description: string; sensitive: boolean; required: boolean }>;
};
const mcpJson = JSON.parse(readFileSync(join(REPO_ROOT, ".mcp.json"), "utf8")) as { mcpServers: { engine: { env: Record<string, string> } } };

describe("credential registry", () => {
  it("plugin.json userConfig lists exactly the registry, optional, with matching sensitivity", () => {
    expect(Object.keys(pluginJson.userConfig).sort()).toEqual(CREDENTIALS.map((c) => c.user_config).sort());
    for (const c of CREDENTIALS) {
      const u = pluginJson.userConfig[c.user_config]!;
      expect(u.required, c.user_config).toBe(false);
      expect(u.sensitive, c.user_config).toBe(c.sensitive);
      expect(u.description, c.user_config).toContain(c.env);
      if (!c.active) expect(u.description, c.user_config).toMatch(/^Not used yet \(Phase \d/);
    }
  });

  it(".mcp.json passes every credential to the engine under its env var", () => {
    expect(mcpJson.mcpServers.engine.env).toEqual(Object.fromEntries(CREDENTIALS.map((c) => [c.env, `\${user_config.${c.user_config}}`])));
  });

  it("keys and env vars are unique; placeholders name their phase", () => {
    expect(new Set(CREDENTIALS.map((c) => c.user_config)).size).toBe(CREDENTIALS.length);
    expect(new Set(CREDENTIALS.map((c) => c.env)).size).toBe(CREDENTIALS.length);
    for (const c of CREDENTIALS) if (!c.active) expect(c.phase, c.env).toBeDefined();
  });

  it("an unexpanded ${user_config.x} or blank value is not a credential", () => {
    expect(isUnexpandedPlaceholder("${user_config.fal_key}")).toBe(true);
    expect(hasCredential({ FAL_KEY: "${user_config.fal_key}" }, "FAL_KEY")).toBe(false);
    expect(hasCredential({ FAL_KEY: "  " }, "FAL_KEY")).toBe(false);
    expect(hasCredential({ FAL_KEY: "abc" }, "FAL_KEY")).toBe(true);
    expect(credentialForEnv("FAL_KEY")?.user_config).toBe("fal_key");
  });
});
