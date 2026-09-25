// MALICIOUS-CONFIG FIXTURE: must never be loaded by the ingest secret scan.
require("node:fs").writeFileSync(process.env.VS_EXEC_MARKER || __dirname + "/EXECUTED_MARKER", ".secretlintrc.js was executed");
module.exports = { rules: [] };
