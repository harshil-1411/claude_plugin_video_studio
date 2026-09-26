import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { credentialReason, detectKind, expandHome, isPathLike } from "./detect.js";
import { ingest, resolveIngestInput } from "./ingest.js";

const root = mkdtempSync(join(tmpdir(), "vs-guards-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

describe("isPathLike", () => {
  it("flags single tokens with an extension or a separator, and explicit paths with spaces", () => {
    for (const p of ["notes.txt", "docs/missing.md", "~/file.pdf", "./a", "../b.md", "report.PDF", "/Users/me/My Notes.md", "~/My Docs/deck.pptx", "file:///tmp/x.md"]) {
      expect(isPathLike(p), p).toBe(true);
    }
  });
  it("leaves inline text alone", () => {
    for (const t of ["Explain vector databases in 30 seconds", "see file.pdf for details", "# Title\n\nBody", "hello", "3.14", "e.g.", "Launch notes: we cut p95 by 40%.", "a/b\nsecond line"]) {
      expect(isPathLike(t), t).toBe(false);
    }
  });
});

describe("missing paths are errors, not inline text", () => {
  it.each(["notes.txt", "docs/missing.md", "~/vs-surely-missing-file.pdf", "/nope/My Notes.md"])("%s", (p) => {
    expect(() => resolveIngestInput(p, root)).toThrow(/^file not found: .* \(resolved to \//);
  });
  it("expands ~ against the home directory", () => {
    expect(() => resolveIngestInput("~/vs-surely-missing-file.pdf", root)).toThrow(join(homedir(), "vs-surely-missing-file.pdf"));
    expect(expandHome("~/a/b", "/h")).toBe("/h/a/b");
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("a~/b", "/h")).toBe("a~/b");
  });
  it("still ingests genuine inline text", () => {
    expect(resolveIngestInput("Explain vector databases in 30 seconds", root)).toMatchObject({ kind: "text", content: "Explain vector databases in 30 seconds" });
    expect(resolveIngestInput("see notes.txt for details", root)).toMatchObject({ kind: "text" });
    expect(resolveIngestInput("hello", root)).toMatchObject({ kind: "text", content: "hello" });
  });
  it("fails the whole ingest instead of writing the path as text", async () => {
    await expect(ingest(["notes.txt"], { projectDir: join(root, "p-missing"), noCache: true, cwd: root })).rejects.toThrow(/file not found: notes.txt/);
  });
});

describe("binary and unsupported files are refused", () => {
  const f = (name: string, data: string | Buffer) => {
    const p = join(root, name);
    writeFileSync(p, data);
    return p;
  };
  it("refuses images with a message naming the supported types", () => {
    const p = f("photo.png", PNG);
    expect(() => detectKind(p)).toThrow(/images are not a supported source type yet: photo\.png\. Supported: Markdown/);
    expect(() => resolveIngestInput(p, root)).toThrow(/images are not a supported source type/);
  });
  it("refuses archives, executables and unknown extensions", () => {
    expect(() => detectKind(f("bundle.zip", Buffer.from([0x50, 0x4b, 3, 4, 0, 0])))).toThrow(/unsupported file type "\.zip": bundle\.zip\. Supported:/);
    expect(() => detectKind(f("tool.exe", "MZ\0\0"))).toThrow(/unsupported file type "\.exe"/);
    expect(() => detectKind(f("data.weird", "text"))).toThrow(/unsupported file type "\.weird"/);
  });
  it("sniffs extension-less files: NUL bytes or invalid UTF-8 are binary, text is text", () => {
    expect(() => detectKind(f("blob", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2])))).toThrow(/not a text file: blob \(it contains NUL bytes\)/);
    expect(() => detectKind(f("latin", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x21])))).toThrow(/not valid UTF-8/);
    expect(detectKind(f("LICENSE", "MIT License\n\nPermission is hereby granted…\n"))).toBe("text");
    expect(detectKind(f("config.yaml", "a: 1\n"))).toBe("text");
  });
  it("refuses a binary file even under a text extension or an explicit text kind", () => {
    const fake = f("fake.txt", PNG);
    expect(() => resolveIngestInput(fake, root)).toThrow(/not a text file: fake\.txt/);
    const png = join(root, "photo.png");
    expect(() => resolveIngestInput({ uri: png, kind: "text" }, root)).toThrow(/not a text file/);
  });
});

describe("credential files are refused", () => {
  it.each([
    ["/home/u/.ssh/id_rsa"],
    ["/home/u/.ssh/config"],
    ["/home/u/.ssh"],
    ["/home/u/.aws/credentials"],
    ["/home/u/.gnupg/secring.gpg"],
    ["/home/u/.config/gcloud/application_default_credentials.json"],
    ["/Users/u/Library/Keychains/login.keychain-db"],
    ["/work/app/.env"],
    ["/work/app/.env.production"],
    ["/work/cert.pem"],
    ["/work/server.key"],
    ["/work/id_ed25519.pub"],
    ["/home/u/.netrc"],
    ["/home/u/.npmrc"],
  ])("%s", (p) => {
    expect(credentialReason(p)).toBeTruthy();
  });
  it("does not flag ordinary files", () => {
    for (const p of ["/work/README.md", "/work/env.md", "/work/keys.md", "/work/.environment/notes.md", "/work/ssh-guide.pdf"]) expect(credentialReason(p), p).toBeUndefined();
  });
  it("refuses them in resolveIngestInput, existing or not, whatever the kind or link", () => {
    const dir = join(root, "fakehome", ".ssh");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    writeFileSync(join(root, ".env"), "TOKEN=abc\n");
    symlinkSync(join(dir, "id_rsa"), join(root, "innocent.txt"));
    expect(() => resolveIngestInput(join(dir, "id_rsa"), root)).toThrow(/^refusing to ingest a credential file/);
    expect(() => resolveIngestInput({ uri: join(dir, "id_rsa"), kind: "text" }, root)).toThrow(/refusing to ingest a credential file/);
    expect(() => resolveIngestInput(".env", root)).toThrow(/refusing to ingest a credential file: \.env/);
    expect(() => resolveIngestInput("~/.aws/credentials", root)).toThrow(/refusing to ingest a credential file/);
    expect(() => resolveIngestInput("innocent.txt", root)).toThrow(/refusing to ingest a credential file/);
    expect(() => resolveIngestInput(dir, root)).toThrow(/refusing/);
  });
});

describe("media that is not media", () => {
  it("refuses a PNG renamed .mp4 instead of ingesting a 0-second video", async () => {
    const png = join(root, "still.png");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=red:size=16x16", "-frames:v", "1", png]);
    const fake = join(root, "still.mp4");
    writeFileSync(fake, readFileSync(png));
    await expect(ingest([fake], { projectDir: join(root, "p-fake"), noCache: true })).rejects.toThrow(/still\.mp4 is a still image/);
  });
  it("refuses garbage bytes under a media extension", async () => {
    const junk = join(root, "junk.mp4");
    writeFileSync(junk, "definitely not a video");
    await expect(ingest([junk], { projectDir: join(root, "p-junk"), noCache: true })).rejects.toThrow(/junk\.mp4 (is not a readable video or audio file|has no video or audio stream|has zero duration)/);
  });
});
