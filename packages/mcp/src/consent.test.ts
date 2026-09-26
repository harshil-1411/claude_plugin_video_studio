import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type CallToolResult, ElicitRequestSchema, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initProject } from "@video-studio/core";
import { ingest } from "@video-studio/ingestion";
import { type VoiceBackend, createSilentBackend } from "@video-studio/voice";
import { type ConsentRecord, readConsents } from "./consent.js";
import type { RenderProjectResult } from "./pipeline.js";
import { RenderJobManager } from "./render-jobs.js";
import { createServer } from "./server.js";

const examples = resolve(import.meta.dirname, "../../schema/examples");

let tmp: string;
let n = 0;
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "vs-consent-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const env = () => ({ PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: join(tmp, "data"), CHROME_PATH: join(tmp, "no-chrome") });

const backend = (id: string, extra: Partial<VoiceBackend> = {}): VoiceBackend => ({
  id,
  available: () => ({ ok: true, reason: `${id} ready` }),
  synthesize: async () => Promise.reject(new Error("not used: the render is faked")),
  ...extra,
});

/** A server + client pair. `answer` set: the client declares elicitation and answers with it. */
async function connect(answer?: ElicitResult | (() => ElicitResult)) {
  const submitted: string[] = [];
  const jobs = new RenderJobManager({
    env: env(),
    ledgerPath: null,
    run: async (dir) => {
      submitted.push(dir);
      return {} as RenderProjectResult;
    },
  });
  const server = createServer({
    cwd: () => tmp,
    env: env(),
    jobs,
    renderDefaults: {
      voiceBackends: { elevenlabs: backend("elevenlabs", { paid: true, usdPer1kChars: () => 0.1 }), system: backend("system"), silent: createSilentBackend() },
      voiceCacheDir: join(tmp, "voice-cache"),
    },
  });
  const client = new Client({ name: "test", version: "0.0.0" }, answer ? { capabilities: { elicitation: {} } } : {});
  const asked: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req.params.message);
      return typeof answer === "function" ? answer() : answer;
    });
  }
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { call, asked, submitted, close: async () => (await client.close(), await jobs.close()) };
}

const accept: ElicitResult = { action: "accept", content: { approve: true } };
const decline: ElicitResult = { action: "decline" };
const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const structured = (r: CallToolResult) => r.structuredContent as Record<string, unknown>;

async function renderProjectDir(policy: string): Promise<string> {
  const dir = join(tmp, `render-${++n}`);
  await initProject(dir, { name: "r" });
  await copyFile(join(examples, "explain-vector-db.video-spec.json"), join(dir, "project", "video-spec.json"));
  await copyFile(join(examples, "explain-vector-db.content-ir.json"), join(dir, "source", "content-ir.json"));
  await writeFile(join(dir, "project", "policy.yaml"), policy);
  return dir;
}

const APPROVAL = "version: 1\nproviders: {allow: [elevenlabs]}\nspend: {approval_above_usd: 0.001}\n";

describe("paid voice consent (render_submit)", () => {
  it("asks the user through elicitation, records the grant and re-uses it for the same synthesis", async () => {
    const dir = await renderProjectDir(APPROVAL);
    const c = await connect(accept);
    try {
      const r = await c.call("render_submit", { project_dir: dir });
      expect(r.isError).toBeFalsy();
      expect(c.asked).toHaveLength(1);
      expect(c.asked[0]).toMatch(/sends \d+ characters of narration .* to ElevenLabs, a paid text-to-speech API, costing an estimated \$\d/);
      expect(text(r)).toMatch(/paid voice approved \(elicitation\)/);
      const recs = await readConsents(dir);
      expect(recs).toEqual([expect.objectContaining<Partial<ConsentRecord>>({ action: "paid_voice", via: "elicitation" })]);
      expect(recs[0]!.subject).toMatch(/^elevenlabs:[0-9a-f]{64}$/);

      const again = await c.call("render_submit", { project_dir: dir });
      expect(again.isError).toBeFalsy();
      expect(c.asked).toHaveLength(1); // re-used, not asked again
      expect(text(again)).toMatch(/approved by the user \(elicitation, /);
    } finally {
      await c.close();
    }
  });

  it("a decline keeps auto on the free voice and refuses an explicit elevenlabs request", async () => {
    const dir = await renderProjectDir(APPROVAL);
    const c = await connect(decline);
    try {
      const auto = await c.call("render_submit", { project_dir: dir, approve_paid_voice: true });
      expect(auto.isError).toBeFalsy();
      expect(text(auto)).toMatch(/paid voice not approved \(the user declined.*system voice/);
      const explicit = await c.call("render_submit", { project_dir: dir, voice: "elevenlabs" });
      expect(explicit.isError).toBe(true);
      expect(structured(explicit)).toMatchObject({ code: "REFUSED", asked_user: true });
      expect(await readConsents(dir)).toEqual([]); // the model's flag does not override the user's answer
    } finally {
      await c.close();
    }
  });

  it("without elicitation, needs approve_paid_voice (recorded as tool_flag)", async () => {
    const dir = await renderProjectDir(APPROVAL);
    const c = await connect();
    try {
      const r = await c.call("render_submit", { project_dir: dir });
      expect(r.isError).toBe(true);
      expect(structured(r)).toMatchObject({ code: "REFUSED", consent_required: true });
      expect(text(r)).toMatch(/call again with approve_paid_voice: true only if they agree/);
      expect(c.submitted).toEqual([]);
      const ok = await c.call("render_submit", { project_dir: dir, approve_paid_voice: true });
      expect(ok.isError).toBeFalsy();
      expect((await readConsents(dir)).map((x) => x.via)).toEqual(["tool_flag"]);
    } finally {
      await c.close();
    }
  });

  it("an explicit request refused by providers.deny or the project limit fails before a job starts", async () => {
    const c = await connect(accept);
    try {
      const denied = await c.call("render_submit", { project_dir: await renderProjectDir("version: 1\nproviders: {deny: ['eleven*']}\n"), voice: "elevenlabs" });
      expect(structured(denied)).toMatchObject({ code: "REFUSED" });
      expect(text(denied)).toMatch(/denied by policy/);
      const limited = await c.call("render_submit", { project_dir: await renderProjectDir("version: 1\nspend: {project_limit_usd: 0.0001}\n"), voice: "elevenlabs" });
      expect(text(limited)).toMatch(/above spend\.project_limit_usd/);
      expect(c.asked).toEqual([]);
    } finally {
      await c.close();
    }
  });
});

describe("demo capture consent", () => {
  async function demoProject(): Promise<string> {
    const dir = join(tmp, `demo-${++n}`);
    await initProject(dir, { name: "d" });
    await writeFile(
      join(dir, "project", "demo.json"),
      JSON.stringify({ schema_version: "1.0", id: "tour", url: "http://localhost:3000", viewport: { width: 640, height: 360 }, steps: [{ action: "click", selector: "#go" }, { action: "wait", ms: 10 }] }),
    );
    return dir;
  }

  it("asks with the URL and steps; an accept is recorded and re-used, a decline stops it", async () => {
    const dir = await demoProject();
    const c = await connect(accept);
    try {
      const r = await c.call("demo", { project_dir: dir });
      // Consent granted, so the capture itself was attempted (no Chrome in this test).
      expect(text(r)).toMatch(/needs Google Chrome/);
      expect(c.asked[0]).toMatch(/http:\/\/localhost:3000.*\n1\. click #go\n2\. wait 10 ms/s);
      expect((await readConsents(dir)).map((x) => [x.action, x.via])).toEqual([["demo_capture", "elicitation"]]);
      await c.call("demo", { project_dir: dir });
      expect(c.asked).toHaveLength(1);
      // A changed script is a new subject: asked again.
      await writeFile(join(dir, "project", "demo.json"), JSON.stringify({ schema_version: "1.0", id: "tour", url: "http://localhost:3001", viewport: { width: 640, height: 360 }, steps: [{ action: "wait", ms: 10 }] }));
      await c.call("demo", { project_dir: dir });
      expect(c.asked).toHaveLength(2);
    } finally {
      await c.close();
    }
    const d = await connect(decline);
    try {
      const other = await demoProject();
      const r = await d.call("demo", { project_dir: other, confirm: true });
      expect(structured(r)).toMatchObject({ code: "REFUSED", asked_user: true });
      expect(text(r)).toMatch(/demo capture not started: the user declined/);
    } finally {
      await d.close();
    }
  });

  it("without elicitation, confirm: true is required and recorded as tool_flag", async () => {
    const dir = await demoProject();
    const c = await connect();
    try {
      const r = await c.call("demo", { project_dir: dir });
      expect(structured(r)).toMatchObject({ code: "REFUSED", consent_required: true });
      const ok = await c.call("demo", { project_dir: dir, confirm: true });
      expect(text(ok)).toMatch(/needs Google Chrome/);
      expect((await readConsents(dir)).map((x) => x.via)).toEqual(["tool_flag"]);
    } finally {
      await c.close();
    }
  });
});

describe("whisper model download consent (transcribe)", () => {
  let dir: string;
  let assetId: string;
  beforeAll(async () => {
    const audio = join(tmp, "talk.m4a");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a", "aac", audio]);
    dir = join(tmp, "asr");
    const { ir } = await ingest([audio], { projectDir: dir, noCache: true });
    assetId = ir.assets.find((a) => a.kind === "audio")!.id;
  }, 60_000);

  it("asks before downloading; a decline downloads nothing", async () => {
    const c = await connect(decline);
    try {
      const r = await c.call("transcribe", { project_dir: dir, asset: assetId, download_model: true });
      expect(structured(r)).toMatchObject({ code: "REFUSED", asked_user: true });
      expect(c.asked[0]).toMatch(/Download the whisper speech-recognition model ggml-base\.en\.bin \(about 148 MB\) from huggingface\.co into .*models/);
      expect(await readConsents(dir)).toEqual([]);
      // An unknown asset fails before anyone is asked.
      const bad = await c.call("transcribe", { project_dir: dir, asset: "nope" });
      expect(bad.isError).toBe(true);
      expect(c.asked).toHaveLength(1);
    } finally {
      await c.close();
    }
  });

  it("asks for the model the language or speakers option needs, per model file", async () => {
    const c = await connect(decline);
    try {
      await c.call("transcribe", { project_dir: dir, asset: assetId, language: "es" });
      expect(c.asked[0]).toMatch(/model ggml-base\.bin \(about 148 MB\) from huggingface\.co into .*ggml-base\.bin/);
      await c.call("transcribe", { project_dir: dir, asset: assetId, speakers: true });
      expect(c.asked[1]).toMatch(/model ggml-small\.en-tdrz\.bin \(about 488 MB\) from huggingface\.co/);
      // An impossible combination fails before anyone is asked.
      const bad = await c.call("transcribe", { project_dir: dir, asset: assetId, speakers: true, language: "hi" });
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/speaker turns work only for English/);
      expect(c.asked).toHaveLength(2);
    } finally {
      await c.close();
    }
  });

  it("without elicitation and without the flag it reports the missing model (MODEL_MISSING)", async () => {
    const c = await connect();
    try {
      const r = await c.call("transcribe", { project_dir: dir, asset: assetId });
      expect(structured(r)).toMatchObject({ code: "MODEL_MISSING" });
      expect(await readFile(join(dir, "project", "consent.json"), "utf8").catch(() => "none")).toBe("none");
    } finally {
      await c.close();
    }
  });
});
