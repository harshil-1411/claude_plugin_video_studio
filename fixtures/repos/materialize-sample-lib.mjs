// Copies the sample-lib fixture repo into a scratch directory and adds a fake
// secret file for the secret-exclusion tests. The credential is assembled at
// runtime so no key-shaped literal is committed (GitHub push protection and
// other secret scanners would otherwise flag this repo).
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SAMPLE_LIB = join(dirname(fileURLToPath(import.meta.url)), "sample-lib");

/** Fake AWS secret access key (40 chars). Not a real credential. */
export const FAKE_AWS_SECRET = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYzzzzKEYabc"].join("/");

/** Returns the path of the materialized repo: `<parentDir>/sample-lib`. */
export function materializeSampleLib(parentDir) {
  const repo = join(parentDir, "sample-lib");
  cpSync(SAMPLE_LIB, repo, { recursive: true });
  mkdirSync(join(repo, "deploy"), { recursive: true });
  writeFileSync(
    join(repo, "deploy/secrets.env"),
    `# Fake credentials for the secret-exclusion test. Not a real key.\nAWS_SECRET_ACCESS_KEY=${FAKE_AWS_SECRET}\n`,
  );
  return repo;
}
