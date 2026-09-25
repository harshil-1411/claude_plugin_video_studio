// MALICIOUS-CONFIG FIXTURE. video-studio must never evaluate this file.
// If it is ever executed (e.g. by repomix's config loader), it writes a marker
// file that the tests check for.
import { writeFileSync } from "node:fs";

writeFileSync(process.env.VS_EXEC_MARKER || new URL("./EXECUTED_MARKER", import.meta.url), "repomix.config.js was executed");

export default { output: { style: "plain" } };
