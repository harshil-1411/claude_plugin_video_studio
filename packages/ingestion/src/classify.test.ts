import { describe, expect, it } from "vitest";
import { Classification } from "@video-studio/schema";
import { classifyText, maxDataClass, mergeClassifications, shannonEntropy } from "./classify.js";

// Obviously fake credentials, assembled at runtime so repo secret scanners stay quiet.
const FAKE = {
  aws: "AKIA" + "IOSFODNN7EXAMPLE",
  github: "ghp_" + "FAKEfake0123456789FAKEfake0123456789ab",
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----",
  anthropic: "sk-ant-" + "api03-FAKE0000fake1111FAKE2222",
  openai: "sk-" + "proj-FAKE0000fake1111FAKE2222",
  assignment: "STRIPE_WEBHOOK_SECRET=" + "whsec_9fK2mQ7xL4pZ8vR1tB6nC3",
};

describe("classifyText", () => {
  it("defaults by kind", () => {
    expect(classifyText("hello world", { kind: "url" }).classification).toEqual({
      contains_secrets: false,
      contains_pii: false,
      contains_likeness: false,
      data_class: "public",
      notes: [],
    });
    expect(classifyText("hello", { kind: "markdown" }).classification.data_class).toBe("internal");
    expect(classifyText("hello", { kind: "text" }).classification.data_class).toBe("internal");
  });

  it.each(Object.entries(FAKE))("detects %s", (_name, secret) => {
    const r = classifyText(`config:\n${secret}\n`, { kind: "url" });
    expect(r.classification.contains_secrets).toBe(true);
    expect(r.classification.data_class).toBe("restricted");
    // Notes and findings never echo the secret.
    expect(JSON.stringify(r)).not.toContain(secret.split("\n")[0]!.slice(6));
  });

  it("does not double-count a known key inside an assignment", () => {
    const r = classifyText(`AWS_ACCESS_KEY_ID=${FAKE.aws}`);
    expect(r.findings.map((f) => f.type)).toEqual(["aws_access_key_id"]);
    expect(r.classification.notes).toEqual(["possible secret: aws_access_key_id ×1"]);
  });

  it("ignores placeholders and low-entropy assignments", () => {
    const r = classifyText(
      ["API_KEY=your_api_key_here", "GITHUB_TOKEN=${{ secrets.GITHUB_TOKEN }}", "SECRET_KEY=xxxxxxxxxxxxxxxx", "token: process.env.TOKEN", "max_tokens: 1024"].join("\n"),
    );
    expect(r.classification.contains_secrets).toBe(false);
  });

  it("detects PII (emails, phones) but not example addresses, dates or versions", () => {
    const r = classifyText("Contact jane.doe@acme-corp.io or call +1 415-555-0132. Docs: user@example.com. Released 2024-10-12, v1.2.3.");
    expect(r.findings.map((f) => f.type)).toEqual(["email", "phone"]);
    expect(r.classification).toMatchObject({ contains_pii: true, data_class: "confidential" });
    expect(classifyText("Released 2024-10-12 with 1,234,567 downloads and version 10.2.3").classification.contains_pii).toBe(false);
  });

  it("sets likeness only when the caller flags faces", () => {
    expect(classifyText("A photo of Ada Lovelace").classification.contains_likeness).toBe(false);
    expect(classifyText("x", { imagesWithFaces: true }).classification).toMatchObject({ contains_likeness: true });
  });

  it("merges classifications", () => {
    const a = classifyText("hi", { kind: "url" }).classification;
    const b = classifyText(FAKE.aws, { kind: "markdown" }).classification;
    const m = mergeClassifications([a, b]);
    expect(Classification.parse(m)).toEqual(m);
    expect(m).toMatchObject({ contains_secrets: true, data_class: "restricted" });
    expect(maxDataClass("public", "confidential", "internal")).toBe("confidential");
    expect(shannonEntropy("aaaa")).toBe(0);
  });
});
